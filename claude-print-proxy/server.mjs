// OpenAI-compatible /v1/chat/completions proxy backed by `claude -p`.
//
// Every request runs a fresh `claude -p` child process in a "clean" state:
// no CLAUDE.md discovery, no settings sources, no MCP servers, no tools, no
// session persistence. Conversation history and OpenAI tool calling are
// emulated through the prompt, the system prompt and `--json-schema`.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { commandInvocation, invocationOptions } from '../gateway/command.mjs';

const PORT = Number(process.env.PORT || 11436);
const HOST = process.env.HOST || '127.0.0.1';
const SHARED_SECRET = process.env.CLAUDE_PROXY_SHARED_SECRET || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MAX_CONCURRENCY = Math.max(1, Number(process.env.CLAUDE_PROXY_MAX_CONCURRENCY || 4));
const REQUEST_TIMEOUT_MS = Number(process.env.CLAUDE_PROXY_REQUEST_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_BODY_BYTES = Number(process.env.CLAUDE_PROXY_MAX_BODY_BYTES || 8 * 1024 * 1024);

const DEFAULT_MODEL = process.env.CLAUDE_PROXY_MODEL || 'claude-opus-5-5';
// The CLI has no command that lists models, so this list is kept by hand. Each id
// answered `claude -p --model <id>` on a Max and on a Team login on 2026-09-30.
// Newest first within a family; `/v1/models` lists them in this order.
const SUPPORTED_MODELS = new Set([
  'claude-opus-5-5', 'claude-opus-5',
  'claude-sonnet-5-5', 'claude-sonnet-5',
  'claude-fable-5-1', 'claude-fable-5',
  'claude-haiku-4-5',
]);
if (!SUPPORTED_MODELS.has(DEFAULT_MODEL)) {
  throw new Error('CLAUDE_PROXY_MODEL must be a supported canonical model ID');
}

export function resolveModel(value) {
  if (!value || value === 'opus') return DEFAULT_MODEL;
  const model = String(value).replace(/\s+\[(?:low|medium|high|xhigh|max)\](?: vision)?$/, '');
  if (SUPPORTED_MODELS.has(model)) return model;
  throw httpError(400, `Unsupported model: ${model}`);
}

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';
const STDERR_TAIL_BYTES = 2048;

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 10;

// Read from the environment on every call so tests (and a restart-free config
// change) can move the limits without reloading the module.
function positiveEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function maxImageBytes() {
  return positiveEnvNumber('CLAUDE_PROXY_MAX_IMAGE_BYTES', DEFAULT_MAX_IMAGE_BYTES);
}

function maxImages() {
  return positiveEnvNumber('CLAUDE_PROXY_MAX_IMAGES', DEFAULT_MAX_IMAGES);
}

export const ALLOWED_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = process.env.CLAUDE_PROXY_EFFORT || 'low';

if (!ALLOWED_EFFORTS.includes(DEFAULT_EFFORT)) {
  throw new Error(`CLAUDE_PROXY_EFFORT must be one of ${ALLOWED_EFFORTS.join(', ')} (got "${DEFAULT_EFFORT}")`);
}

function modelLabel(effort) {
  return `${DEFAULT_MODEL}-${effort}`;
}

// Models are explicitly selected and validated; effort comes from the server
// default or reasoning_effort. temperature and max_tokens are ignored.
//
// Text-only requests run with every tool disabled and a single turn. `claude -p`
// cannot take images on stdin, so an image request instead writes the images to
// a private directory, runs there, and gets `Read` (and only `Read`) enabled so
// it can open them. Each Read costs a turn, hence `images + 2`. A text-only
// request with a schema gets a second turn, for the CLI to ask again when the
// model wrote its JSON as text (see STRUCTURED_OUTPUT_INSTRUCTION).
export function claudeArgsFor(imageCount = 0, model = DEFAULT_MODEL, withSchema = false) {
  const withImages = imageCount > 0;
  return [
    '-p',
    '--model', model,
    ...(withImages ? ['--tools', 'Read', '--allowedTools', 'Read'] : ['--tools', '']),
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--max-turns', String(withImages ? imageCount + 2 : (withSchema ? 2 : 1)),
    '--output-format', 'json',
  ];
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

if (!isLoopbackHost(HOST) && !SHARED_SECRET) {
  throw new Error('CLAUDE_PROXY_SHARED_SECRET is required when HOST is not loopback');
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: { message: String(message), type: 'claude_print_proxy_error' } });
}

// ---------------------------------------------------------------------------
// Usage-limit detection
// ---------------------------------------------------------------------------

// A router in front of this adapter fails over to another account when the
// answer is 429 with code `usage_limit_reached`. The exact text `claude -p`
// prints for an exhausted subscription is not pinned down, so detection is
// tolerant. QUOTA_PATTERN is the pattern shared with the Codex adapter. It
// covers CLI 2.1.284's own "You've hit your session limit · resets 5pm" family
// (session, weekly, Opus, Sonnet, usage credit ...) and older "Weekly limit
// reached" wording, but not a bare "limit reached": "Context limit reached" is a
// prompt that is too big, and a router would rest every account for it.
const QUOTA_PATTERN = /usage.?limit|rate.?limit|(?:hit|reached) your [^\n.]{0,40}?\blimit\b|\b(?!(?:context|tokens?|output|input|length|size|max)\b)[\w-]+ limit reached|rate_limit_error|usage_limit_reached|\b429\b/i;

function parseRetryAfterSeconds(text, now) {
  const epoch = /\|\s*(\d{9,11})(?!\d)/.exec(text);
  if (epoch) return Math.max(0, Number(epoch[1]) - Math.floor(now / 1000));
  const tryAgain = /try again in\s*~?\s*(\d+)\s*min/i.exec(text);
  if (tryAgain) return Number(tryAgain[1]) * 60;
  const resetsIn = /resets? in\s*~?\s*(\d+)\s*(seconds?|secs?|minutes?|mins?)\b/i.exec(text);
  if (resetsIn) return Number(resetsIn[1]) * (/^s/i.test(resetsIn[2]) ? 1 : 60);
  return undefined;
}

export function classifyUpstreamError(message, now = Date.now()) {
  const text = String(message ?? '');
  if (!QUOTA_PATTERN.test(text)) return { quota: false };
  const retryAfterSeconds = parseRetryAfterSeconds(text, now);
  return retryAfterSeconds === undefined ? { quota: true } : { quota: true, retryAfterSeconds };
}

function usageLimitError(message, retryAfterSeconds) {
  const error = httpError(429, message);
  error.usageLimit = true;
  if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function sendUsageLimit(res, error) {
  sendJson(
    res,
    429,
    { error: { message: String(error.message), type: 'usage_limit_reached', code: 'usage_limit_reached' } },
    Number.isInteger(error.retryAfterSeconds) ? { 'retry-after': String(error.retryAfterSeconds) } : {},
  );
}

async function readJsonBody(req) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      throw httpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw httpError(400, `Invalid JSON body: ${error.message}`);
  }
}

function authorized(req, sharedSecret) {
  if (!sharedSecret) return true;
  const header = String(req.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBuffer = Buffer.from(sharedSecret);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export function createSemaphore(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  const waiters = [];
  return {
    get active() { return active; },
    async acquire() {
      if (active < max) {
        active += 1;
        return;
      }
      await new Promise((resolve) => { waiters.push(resolve); });
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      const next = waiters.shift();
      if (next) next();
    },
  };
}

// ---------------------------------------------------------------------------
// Request flattening
// ---------------------------------------------------------------------------

// --- image parts -----------------------------------------------------------

const IMAGE_MEDIA_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
});

const SUPPORTED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// The declared media type is only a hint (clients mislabel jpegs as png), so the
// extension always comes from the bytes.
export function sniffImageExtension(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const DATA_URL_RE = /^data:([a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*)((?:;[^,;]*)*),([\s\S]*)$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function parseImageDataUrl(url) {
  const match = DATA_URL_RE.exec(url);
  if (!match) throw httpError(400, 'Malformed image data URL');
  const mediaType = match[1].toLowerCase();
  const isBase64 = match[2].toLowerCase().split(';').includes('base64');
  if (!isBase64) throw httpError(400, `Image data URL must be base64-encoded (got "${mediaType}" without ;base64)`);
  if (!IMAGE_MEDIA_TYPES[mediaType]) {
    throw httpError(400, `Unsupported image media type "${mediaType}" (supported: ${SUPPORTED_IMAGE_TYPES.join(', ')})`);
  }

  const payload = match[3].replace(/\s+/g, '');
  if (!payload || payload.length % 4 !== 0 || !BASE64_RE.test(payload)) {
    throw httpError(400, 'Image data URL payload is not valid base64');
  }
  const limit = maxImageBytes();
  if ((payload.length / 4) * 3 > limit + 3) {
    throw httpError(400, `Image exceeds CLAUDE_PROXY_MAX_IMAGE_BYTES (${limit} bytes)`);
  }

  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0) throw httpError(400, 'Image data URL decodes to an empty image');
  if (buffer.length > limit) {
    throw httpError(400, `Image exceeds CLAUDE_PROXY_MAX_IMAGE_BYTES (${limit} bytes)`);
  }

  const extension = sniffImageExtension(buffer);
  if (!extension) {
    throw httpError(400, `Image data URL does not contain a supported image (supported: ${SUPPORTED_IMAGE_TYPES.join(', ')})`);
  }
  return { kind: 'data', extension, buffer };
}

function parseImageUrl(url) {
  if (typeof url !== 'string' || !url) throw httpError(400, 'Image part is missing `image_url.url`');
  if (url.startsWith('data:')) return parseImageDataUrl(url);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw httpError(400, `Unsupported image URL: ${url.slice(0, 80)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw httpError(400, `Unsupported image URL scheme "${parsed.protocol}" (use a data:, http: or https: URL)`);
  }
  return { kind: 'remote', url: parsed.href };
}

// OpenAI sends `{type:"image_url", image_url:{url, detail?}}`; `detail` is
// meaningless here and ignored. The Responses-style `input_image` spelling and a
// bare string `image_url` are accepted too.
function imagePartUrl(item) {
  if (item.type !== 'image_url' && item.type !== 'input_image') return undefined;
  const raw = item.image_url ?? item.imageUrl ?? item.url;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.url === 'string') return raw.url;
  return null;
}

// Collects every image of a request in order, so the prompt can refer to them as
// "Image 1", "Image 2", ... no matter which message they came from.
export function createImageCollector(limit = maxImages()) {
  const images = [];
  return {
    images,
    add(url) {
      if (images.length >= limit) {
        throw httpError(400, `Request carries more than ${limit} images (CLAUDE_PROXY_MAX_IMAGES)`);
      }
      const index = images.length + 1;
      images.push({ index, ...parseImageUrl(url) });
      return `[Image ${index}]`;
    },
  };
}

const NO_IMAGES = Object.freeze({ images: [], add() { return '[unsupported content part omitted]'; } });

function extractContent(content, collector = NO_IMAGES) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        if (item.type === 'text' || item.type === 'input_text') return item.text || '';
        const url = imagePartUrl(item);
        if (url === undefined) return '[unsupported content part omitted]';
        return collector.add(url);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

export function extractTextFromContent(content) {
  return extractContent(content);
}

// Rendered once the images are on disk: `paths` is index-aligned with `images`.
export function renderImageSection(images, paths) {
  const lines = [
    '# Images',
    'The image files listed below are part of this request. Read every one of them with the Read tool before you answer, and describe or use what you actually see. The Read tool is the only tool available; do not write, edit or run anything.',
  ];
  for (const image of images) {
    lines.push(`Image ${image.index}: ${paths[image.index - 1]}`);
  }
  return lines.join('\n');
}

function stringifyToolArguments(rawArguments) {
  if (rawArguments == null) return '{}';
  if (typeof rawArguments === 'string') return rawArguments;
  try {
    return JSON.stringify(rawArguments);
  } catch {
    return String(rawArguments);
  }
}

function renderTranscript(messages, collector) {
  const lines = ['<conversation>'];
  for (const message of messages) {
    const role = message?.role;
    const text = extractContent(message?.content, collector);
    if (role === 'assistant') {
      if (text) lines.push('[assistant]', text);
      for (const toolCall of message?.tool_calls || []) {
        const id = toolCall?.id || 'unknown';
        const name = toolCall?.function?.name || toolCall?.name || 'tool';
        lines.push(`[assistant tool_call id=${id} name=${name}]`);
        lines.push(stringifyToolArguments(toolCall?.function?.arguments ?? toolCall?.arguments));
      }
      continue;
    }
    if (role === 'tool' || role === 'function') {
      const id = message?.tool_call_id || message?.name || 'unknown';
      lines.push(`[tool id=${id}]`, text || 'No result provided');
      continue;
    }
    lines.push(`[${role || 'user'}]`, text);
  }
  lines.push('</conversation>');
  lines.push("Continue the conversation: produce the assistant's next reply to the latest turn above.");
  return lines.join('\n');
}

export function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw httpError(400, '`messages` must be a non-empty array');
  }

  const systemParts = [];
  const rest = [];
  for (const message of messages) {
    const role = message?.role;
    if (role === 'system' || role === 'developer') {
      // Images in a system message are dropped: the system prompt is a CLI
      // argument, not a turn the model can call Read from.
      const text = extractTextFromContent(message?.content);
      if (text) systemParts.push(text);
      continue;
    }
    rest.push(message);
  }

  if (rest.length === 0) {
    throw httpError(400, '`messages` must contain at least one non-system message');
  }

  const systemPrompt = systemParts.join('\n\n').trim() || DEFAULT_SYSTEM_PROMPT;
  const collector = createImageCollector();

  const body = rest.length === 1 && rest[0]?.role === 'user'
    ? extractContent(rest[0].content, collector)
    : renderTranscript(rest, collector);

  return { systemPrompt, body, images: collector.images };
}

// ---------------------------------------------------------------------------
// Tool-call emulation
// ---------------------------------------------------------------------------

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      const fn = tool?.function || (tool?.name ? tool : null);
      if (!fn?.name) return null;
      return {
        name: String(fn.name),
        description: String(fn.description || ''),
        parameters: fn.parameters || { type: 'object', properties: {} },
      };
    })
    .filter(Boolean);
}

function forcedToolName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return '';
  return toolChoice?.function?.name || toolChoice?.name || '';
}

export function buildToolEmulation(bodyTools, toolChoice) {
  if (toolChoice === 'none') return null;
  const tools = normalizeTools(bodyTools);
  if (tools.length === 0) return null;

  const forced = forcedToolName(toolChoice);
  const allowedNames = forced && tools.some((tool) => tool.name === forced)
    ? [forced]
    : tools.map((tool) => tool.name);
  const mustCall = forced ? true : (toolChoice === 'required' || toolChoice === 'any');

  const toolCallsSchema = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: allowedNames },
        // Each tool has its own parameter schema, so `arguments` stays an open
        // object here; the per-tool schema is enforced through the prompt.
        arguments: { type: 'object' },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    },
  };
  if (mustCall) toolCallsSchema.minItems = 1;

  const schema = {
    type: 'object',
    properties: {
      content: { type: 'string' },
      tool_calls: toolCallsSchema,
    },
    required: ['content', 'tool_calls'],
    additionalProperties: false,
  };

  const sections = ['# Available tools', '', 'You can call the following tools.', ''];
  for (const tool of tools) {
    sections.push(`## ${tool.name}`);
    if (tool.description) sections.push(tool.description);
    sections.push(`Parameters (JSON Schema): ${JSON.stringify(tool.parameters)}`);
    sections.push('');
  }
  sections.push('# Response format');
  sections.push('Reply with a JSON object holding exactly two keys: "content" and "tool_calls".');
  sections.push('- If you can answer directly, put the answer in "content" and set "tool_calls" to an empty array.');
  sections.push('- If you need a tool, put one entry per call in "tool_calls" (each with "name" and an "arguments" object matching that tool\'s parameter schema) and set "content" to an empty string.');
  if (forced) {
    sections.push(`- You must call the tool "${forced}" at least once; no other tool is available.`);
  } else if (mustCall) {
    sections.push('- You must call at least one tool: "tool_calls" cannot be empty.');
  }

  return { schema, systemSection: sections.join('\n').trim(), toolNames: allowedNames };
}

// ---------------------------------------------------------------------------
// Request -> claude invocation plan
// ---------------------------------------------------------------------------

export function resolveEffort(body, defaultEffort = DEFAULT_EFFORT) {
  const requested = body?.reasoning_effort;
  if (requested == null) return defaultEffort;
  if (typeof requested !== 'string' || !ALLOWED_EFFORTS.includes(requested)) {
    throw httpError(400, `\`reasoning_effort\` must be one of ${ALLOWED_EFFORTS.join(', ')} (got ${JSON.stringify(requested)})`);
  }
  return requested;
}

// `--json-schema` gives the model a StructuredOutput tool and takes the answer
// only from a call to it. A caller's system prompt such as "Return exactly one
// JSON object" can lead the model to write the JSON as text instead. CLI 2.1.285
// then asks for the call in another turn; past --max-turns the run ends as
// error_max_turns with no result, a 502 here. On the meeting assistant's prompts
// Sonnet 5.5 did that in 20 of 28 tries and Opus 5.5 in 2 of 273 logged
// requests. With this line Sonnet called the tool in 32 of 32.
const STRUCTURED_OUTPUT_INSTRUCTION = 'Give your answer by calling the StructuredOutput tool with the JSON object as its input. Do not write the JSON as text.';

export function buildInvocation(body, defaultEffort = DEFAULT_EFFORT) {
  const effort = resolveEffort(body, defaultEffort);
  const { systemPrompt, body: promptBody, images } = flattenMessages(body?.messages);
  const emulation = buildToolEmulation(body?.tools, body?.tool_choice);

  const systemParts = [systemPrompt];
  let schema = null;
  let mode = 'text';

  if (emulation) {
    systemParts.push(emulation.systemSection);
    schema = emulation.schema;
    mode = 'tools';
  } else {
    const rf = body?.response_format;
    if (rf?.type === 'json_schema') {
      const candidate = rf.json_schema?.schema || rf.json_schema;
      if (candidate) {
        schema = candidate;
        mode = 'json_schema';
      }
    } else if (rf?.type === 'json_object') {
      systemParts.push('Respond with a single valid JSON object only. Do not wrap it in markdown fences and do not add commentary.');
      mode = 'json_object';
    }
  }
  if (schema) systemParts.push(STRUCTURED_OUTPUT_INSTRUCTION);

  const finalSystemPrompt = systemParts.filter(Boolean).join('\n\n').trim();
  const args = [...claudeArgsFor(images.length, resolveModel(body?.model), Boolean(schema)), '--effort', effort, '--system-prompt', finalSystemPrompt];
  if (schema) args.push('--json-schema', JSON.stringify(schema));

  // The image paths only exist once the files are on disk, so the prompt is
  // finished after materializeImages(); a text-only request is complete already.
  const renderPrompt = (paths = []) => (images.length === 0
    ? promptBody
    : `${promptBody}\n\n${renderImageSection(images, paths)}`);

  return {
    args,
    prompt: images.length === 0 ? promptBody : null,
    renderPrompt,
    images,
    systemPrompt: finalSystemPrompt,
    schema,
    mode,
    effort,
  };
}

// ---------------------------------------------------------------------------
// claude result -> OpenAI response
// ---------------------------------------------------------------------------

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function newToolCallId() {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function formatUsage(usage) {
  const input = Number(usage?.input_tokens || 0);
  const cacheCreation = Number(usage?.cache_creation_input_tokens || 0);
  const cacheRead = Number(usage?.cache_read_input_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  const promptTokens = input + cacheCreation + cacheRead;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
  };
}

export function buildCompletionParts(payload, mode) {
  const result = typeof payload?.result === 'string' ? payload.result : '';
  const structured = payload?.structured_output ?? tryParseJson(result);

  if (mode === 'tools') {
    const rawCalls = Array.isArray(structured?.tool_calls) ? structured.tool_calls : [];
    const toolCalls = rawCalls
      .filter((call) => call && typeof call.name === 'string' && call.name)
      .map((call) => ({
        id: newToolCallId(),
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      }));
    if (toolCalls.length > 0) {
      return { content: null, toolCalls, finishReason: 'tool_calls' };
    }
    const text = typeof structured?.content === 'string' ? structured.content : result;
    return { content: text, toolCalls: [], finishReason: 'stop' };
  }

  if (mode === 'json_schema') {
    const content = structured != null ? JSON.stringify(structured) : result;
    return { content, toolCalls: [], finishReason: 'stop' };
  }

  return { content: result, toolCalls: [], finishReason: 'stop' };
}

function chunkBase(id, model, created) {
  return { id, object: 'chat.completion.chunk', created, model };
}

// ---------------------------------------------------------------------------
// Default runner: spawn `claude -p`
// ---------------------------------------------------------------------------

let workdirPromise = null;

async function resolveWorkdir() {
  const configured = process.env.CLAUDE_PROXY_WORKDIR;
  if (configured) {
    await fs.mkdir(configured, { recursive: true });
    return configured;
  }
  if (!workdirPromise) {
    workdirPromise = fs.mkdtemp(path.join(os.tmpdir(), 'claude-print-proxy-'));
  }
  return workdirPromise;
}

function removeDir(dir) {
  return fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function fetchRemoteImage(url, { signal, limit }) {
  let response;
  try {
    response = await fetch(url, { signal, redirect: 'follow' });
  } catch (error) {
    if (signal?.aborted) throw httpError(499, 'Client closed the request');
    throw httpError(400, `Could not fetch image ${url}: ${error.message}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw httpError(400, `Could not fetch image ${url}: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw httpError(400, `Image ${url} exceeds CLAUDE_PROXY_MAX_IMAGE_BYTES (${limit} bytes)`);
  }

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > limit) {
        throw httpError(400, `Image ${url} exceeds CLAUDE_PROXY_MAX_IMAGE_BYTES (${limit} bytes)`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.statusCode) throw error;
    if (signal?.aborted) throw httpError(499, 'Client closed the request');
    throw httpError(400, `Could not fetch image ${url}: ${error.message}`);
  }

  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) throw httpError(400, `Image ${url} is empty`);
  const extension = sniffImageExtension(buffer);
  if (!extension) {
    throw httpError(400, `Image ${url} is not a supported image (supported: ${SUPPORTED_IMAGE_TYPES.join(', ')})`);
  }
  return { extension, buffer };
}

// Writes every image of one request into a private directory under the workdir.
// The caller must always call `cleanup()` — success, failure or timeout.
export async function materializeImages(images, { signal, baseDir } = {}) {
  const parent = baseDir || await resolveWorkdir();
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'req-'));
  const limit = maxImageBytes();
  const paths = [];
  try {
    for (const image of images) {
      const { extension, buffer } = image.kind === 'data'
        ? { extension: image.extension, buffer: image.buffer }
        : await fetchRemoteImage(image.url, { signal, limit });
      const filePath = path.join(dir, `image-${image.index}.${extension}`);
      await fs.writeFile(filePath, buffer, { mode: 0o600 });
      paths.push(filePath);
    }
  } catch (error) {
    await removeDir(dir);
    throw error;
  }
  return { dir, paths, cleanup: () => removeDir(dir) };
}

function childEnv() {
  const env = { ...process.env };
  // Prevent the child from deciding it is a nested Claude Code session.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// On Windows nothing taken from a request goes on a command line. The prompt is
// stdin on every platform already; the system prompt, which carries the request's
// system messages, is written to a private file there and handed over with
// --system-prompt-file, the CLI's own equivalent of --system-prompt. A Windows
// command line is also capped at 32,767 characters. What stays on it is fixed or
// validated (model, effort, flags) plus --json-schema, which has no file form; it
// reaches claude.exe or node directly, never cmd.exe.
export async function stageSystemPrompt(args, { baseDir } = {}) {
  const index = args.indexOf('--system-prompt');
  if (index === -1) return { args, file: null, cleanup: async () => {} };
  const parent = baseDir || await resolveWorkdir();
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'sys-'));
  const file = path.join(dir, 'system-prompt.txt');
  try {
    await fs.writeFile(file, args[index + 1] ?? '', { mode: 0o600 });
  } catch (error) {
    await removeDir(dir);
    throw error;
  }
  return {
    args: [...args.slice(0, index), '--system-prompt-file', file, ...args.slice(index + 2)],
    file,
    cleanup: () => removeDir(dir),
  };
}

export function createSpawnRunner({
  claudeBin = CLAUDE_BIN,
  timeoutMs = REQUEST_TIMEOUT_MS,
  spawnFn = spawn,
  platform = process.platform,
  resolveCommand = commandInvocation,
} = {}) {
  const windows = platform === 'win32';
  return async function runClaude({ args, prompt, cwd: cwdOverride, signal } = {}) {
    // An image request runs inside its own image directory, so `Read` stays
    // within the working directory and never triggers a permission prompt.
    const cwd = cwdOverride || await resolveWorkdir();
    if (!windows) return spawnClaude({ args, prompt, cwd, signal });
    let staged;
    try {
      staged = await stageSystemPrompt(args);
    } catch (error) {
      throw httpError(502, `Failed to write the system prompt for ${claudeBin}: ${error.message}`);
    }
    try {
      return await spawnClaude({ args: staged.args, prompt, cwd, signal });
    } finally {
      await staged.cleanup();
    }
  };

  function spawnClaude({ args, prompt, cwd, signal }) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        const env = childEnv();
        const options = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] };
        if (windows) {
          // The npm install is a .cmd shim spawn cannot start; run what it runs.
          const call = resolveCommand(claudeBin, args, { env, platform, allowShell: false });
          child = spawnFn(call.file, call.args, invocationOptions(call, options, platform));
        } else {
          child = spawnFn(claudeBin, args, options);
        }
      } catch (error) {
        reject(httpError(502, `Failed to start ${claudeBin}: ${error.message}`));
        return;
      }

      const stdoutChunks = [];
      let stderrTail = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;
      let aborted = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      const onAbort = () => {
        aborted = true;
        child.kill('SIGKILL');
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk) => {
        stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES);
      });

      child.on('error', (error) => {
        finish(reject, httpError(502, `Failed to run ${claudeBin}: ${error.message}`));
      });

      child.on('close', (code, killSignal) => {
        if (timedOut) {
          finish(reject, httpError(504, `claude timed out after ${timeoutMs}ms`));
          return;
        }
        if (aborted) {
          finish(reject, httpError(499, 'Client closed the request'));
          return;
        }
        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
        const parsed = tryParseJson(stdout);
        if (parsed && typeof parsed === 'object') {
          finish(resolve, parsed);
          return;
        }
        const stderrText = stderrTail.toString('utf8').trim();
        if (code !== 0 || killSignal) {
          // An exhausted subscription answers 429 with the CLI's own text, so a
          // router can fail over; every other failed exit stays a 502.
          const limitText = [stderrText, stdout].find((text) => text && classifyUpstreamError(text).quota);
          if (limitText) {
            const { retryAfterSeconds } = classifyUpstreamError(limitText);
            finish(reject, usageLimitError(limitText.slice(0, STDERR_TAIL_BYTES), retryAfterSeconds));
            return;
          }
          finish(reject, httpError(502, `claude exited with code ${code}${killSignal ? ` (signal ${killSignal})` : ''}: ${stderrText || '<no stderr>'}`));
          return;
        }
        finish(reject, httpError(502, `Could not parse claude JSON output: ${stdout.slice(0, 500) || '<empty>'}`));
      });

      child.stdin.on('error', () => {});
      child.stdin.end(prompt ?? '');
    });
  }
}

// ---------------------------------------------------------------------------
// Request log
// ---------------------------------------------------------------------------

// One JSON line per /v1/chat/completions request, written to stdout (the
// LaunchAgent points that at ~/.hermes/logs/claude-print-proxy.log), so a
// benchmark run can count proxy calls and add up tokens from the log alone.
// Prompts, responses, headers and secrets are never logged.
const REQUEST_LOG_ERROR_TYPES = Object.freeze({
  400: 'bad_request',
  401: 'unauthorized',
  404: 'not_found',
  413: 'payload_too_large',
  // 499 is the nginx spelling of "client hung up before we answered"; nothing
  // is sent on the wire for it, it only ever shows up here.
  499: 'client_closed_request',
  502: 'upstream_error',
  504: 'timeout',
});

export function requestErrorType(statusCode) {
  const status = Number(statusCode) || 0;
  if (status < 400) return null;
  return REQUEST_LOG_ERROR_TYPES[status] || (status >= 500 ? 'server_error' : 'request_error');
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

// `record` is filled in as a request progresses, so every field is optional:
// a body that fails to parse only ever gets a status and a duration.
export function buildRequestLogEntry(record = {}) {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : null;
  const usage = payload?.usage;
  const status = Number(record.status) || null;
  return {
    event: 'request',
    at: record.at || new Date().toISOString(),
    status,
    model: typeof record.model === 'string' && record.model ? record.model : null,
    effort: typeof record.effort === 'string' && record.effort ? record.effort : null,
    images: finiteOrNull(record.images),
    tools: boolOrNull(record.tools),
    json_schema: boolOrNull(record.jsonSchema),
    num_turns: finiteOrNull(payload?.num_turns),
    duration_ms: finiteOrNull(record.durationMs),
    claude_duration_ms: finiteOrNull(payload?.duration_ms),
    usage: payload
      ? {
        ...formatUsage(usage),
        cache_read_input_tokens: Number(usage?.cache_read_input_tokens || 0),
        cache_creation_input_tokens: Number(usage?.cache_creation_input_tokens || 0),
      }
      : null,
    cost_usd: finiteOrNull(payload?.total_cost_usd),
    error: requestErrorType(status),
  };
}

// Read the switch on every call so it can be flipped per test (and per restart)
// without reloading the module. Anything but "0" keeps logging on.
export function requestLogEnabled() {
  return process.env.CLAUDE_PROXY_REQUEST_LOG !== '0';
}

export function logRequest(record) {
  if (!requestLogEnabled()) return null;
  const entry = buildRequestLogEntry(record);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  return entry;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export function createHandler({
  runClaude = createSpawnRunner(),
  sharedSecret = SHARED_SECRET,
  maxConcurrency = MAX_CONCURRENCY,
  effort = DEFAULT_EFFORT,
  logRequest: writeRequestLog = logRequest,
} = {}) {
  if (!ALLOWED_EFFORTS.includes(effort)) {
    throw new Error(`effort must be one of ${ALLOWED_EFFORTS.join(', ')} (got "${effort}")`);
  }
  const semaphore = createSemaphore(maxConcurrency);

  async function handleChatCompletions(req, res, record) {
    const body = await readJsonBody(req);
    const invocation = buildInvocation(body, effort);
    const model = typeof body?.model === 'string' && body.model
      ? body.model
      : modelLabel(invocation.effort);
    record.model = model;
    record.effort = invocation.effort;
    record.images = invocation.images.length;
    record.tools = invocation.mode === 'tools';
    record.jsonSchema = invocation.mode === 'json_schema';

    const controller = new AbortController();
    // `req`'s close event fires as soon as the body is consumed, so the abort
    // hook has to hang off the response instead.
    const onClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.on('close', onClose);

    let payload;
    let imageContext = null;
    await semaphore.acquire();
    try {
      if (invocation.images.length > 0) {
        imageContext = await materializeImages(invocation.images, { signal: controller.signal });
      }
      payload = await runClaude({
        args: invocation.args,
        prompt: imageContext ? invocation.renderPrompt(imageContext.paths) : invocation.prompt,
        cwd: imageContext?.dir,
        signal: controller.signal,
      });
      record.payload = payload;
    } finally {
      semaphore.release();
      res.off('close', onClose);
      // The images are only needed for the duration of the child process.
      if (imageContext) await imageContext.cleanup();
    }

    if (payload?.is_error) {
      // `claude -p` reports the HTTP status of an API error that ended the turn
      // as `api_error_status`; the text lives in `result` (or `errors`).
      const upstreamText = [payload.result, ...(Array.isArray(payload.errors) ? payload.errors : [])]
        .filter((text) => typeof text === 'string' && text)
        .join('\n');
      const verdict = classifyUpstreamError(upstreamText);
      if (verdict.quota || payload.api_error_status === 429) {
        throw usageLimitError(upstreamText || 'claude returned an error', verdict.retryAfterSeconds);
      }
      throw httpError(502, typeof payload.result === 'string' && payload.result
        ? payload.result
        : 'claude returned an error');
    }

    const { content, toolCalls, finishReason } = buildCompletionParts(payload, invocation.mode);
    const usage = formatUsage(payload?.usage);
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (body?.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const writeEvent = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

      const firstDelta = toolCalls.length > 0
        ? {
          role: 'assistant',
          tool_calls: toolCalls.map((call, index) => ({
            index,
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          })),
        }
        : { role: 'assistant', content: content ?? '' };

      writeEvent({
        ...chunkBase(id, model, created),
        choices: [{ index: 0, delta: firstDelta, finish_reason: null }],
      });
      writeEvent({
        ...chunkBase(id, model, created),
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(body?.stream_options?.include_usage ? { usage } : {}),
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage,
    });
  }

  return async function handler(req, res) {
    const startedAt = Date.now();
    // Only chat completions are logged: /health is polled by the LaunchAgent and
    // by callers, and would bury the request lines the benchmark counts.
    const isChatCompletions = req.method === 'POST'
      && (req.url === '/v1/chat/completions' || req.url === '/chat/completions');
    const record = isChatCompletions ? {} : null;
    let logged = false;
    const emitLog = (status) => {
      if (!record || logged) return;
      logged = true;
      record.status = status;
      record.at = new Date().toISOString();
      record.durationMs = Date.now() - startedAt;
      // A broken stdout must never turn into a failed request.
      try {
        writeRequestLog(record);
      } catch {
        // ignored
      }
    };

    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, {
          status: 'ok',
          model: DEFAULT_MODEL,
          effort,
          max_concurrency: maxConcurrency,
        });
      }

      if (req.method === 'GET' && req.url === '/v1/models') {
        if (!authorized(req, sharedSecret)) return sendError(res, 401, 'Unauthorized');
        return sendJson(res, 200, { object: 'list', data: [...SUPPORTED_MODELS].map(id => ({ id, object: 'model', owned_by: 'anthropic' })) });
      }

      if (isChatCompletions) {
        if (!authorized(req, sharedSecret)) {
          emitLog(401);
          return sendError(res, 401, 'Unauthorized');
        }
        await handleChatCompletions(req, res, record);
        emitLog(200);
        return undefined;
      }

      return sendError(res, 404, 'Not found');
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      emitLog(statusCode);
      if (statusCode === 499 || res.writableEnded) {
        if (!res.writableEnded) res.end();
        return undefined;
      }
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: { message: String(error?.message || error) } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return undefined;
      }
      if (error?.usageLimit) return sendUsageLimit(res, error);
      return sendError(res, statusCode, error?.message || error);
    }
  };
}

export function createServer(options = {}) {
  const server = http.createServer(createHandler(options));
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({
      status: 'listening',
      host: HOST,
      port: PORT,
      model: DEFAULT_MODEL,
      effort: DEFAULT_EFFORT,
      max_concurrency: MAX_CONCURRENCY,
    }));
  });
}
