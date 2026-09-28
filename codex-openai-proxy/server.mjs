import http from 'node:http';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getModel, getModels, stream as piStream } from '@mariozechner/pi-ai';
import { getOAuthApiKey } from '@mariozechner/pi-ai/oauth';

const PORT = Number(process.env.PORT || 11435);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_PATH = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), '.codex', 'auth.json');
const DEFAULT_MODEL = process.env.DEFAULT_CODEX_MODEL || 'gpt-5.5';
const SHARED_SECRET = process.env.CODEX_PROXY_SHARED_SECRET || '';
const MAX_BODY_BYTES = Number(process.env.CODEX_PROXY_MAX_BODY_BYTES || 8 * 1024 * 1024);
const PROVIDER_ID = 'openai-codex';

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

if (!isLoopbackHost(HOST) && !SHARED_SECRET) {
  throw new Error('CODEX_PROXY_SHARED_SECRET is required when HOST is not loopback');
}

const TRANSIENT_FILE_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);

export class CodexAuthManager {
  constructor(authPath, {
    fileSystem = fs,
    getOAuth = getOAuthApiKey,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    this.authPath = authPath;
    this.fileSystem = fileSystem;
    this.getOAuth = getOAuth;
    this.sleep = sleep;
    this.pendingAccessToken = null;
  }

  parseJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    const payload = parts[1] + '='.repeat((4 - (parts[1].length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  }

  async loadCreds(attempts = 4, authPath = this.authPath) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const rawText = await this.fileSystem.readFile(authPath, 'utf8');
        const raw = JSON.parse(rawText);
        const access = raw?.tokens?.access_token;
        const refresh = raw?.tokens?.refresh_token;
        const accountId = raw?.tokens?.account_id;
        if (!access || !refresh) {
          throw new Error(`Missing access_token/refresh_token in ${authPath}`);
        }
        const payload = this.parseJwtPayload(access);
        const expires = typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now() + 30 * 60 * 1000;
        return {
          raw,
          creds: {
            access,
            refresh,
            expires,
            accountId,
          },
        };
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await this.sleep(25 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async publishCredentialExclusive(source, label) {
    try {
      await this.fileSystem.link(source, this.authPath);
    } catch (error) {
      if (error?.code === 'EEXIST') return this.loadCreds();
      const linkError = error;
      try {
        // Hard links are supported on the target APFS/NTFS filesystems. Keep
        // an exclusive-copy fallback for unusual mount or policy failures.
        await this.fileSystem.copyFile(source, this.authPath, fsConstants.COPYFILE_EXCL);
      } catch (copyError) {
        if (copyError?.code === 'EEXIST') return this.loadCreds();
        throw new AggregateError(
          [linkError, copyError],
          `Could not publish ${label} auth credential: ${linkError.message}; ${copyError.message}`,
          { cause: linkError },
        );
      }
    }
    // A concurrent writer can replace or corrupt the canonical path after the
    // exclusive create. Publication is not complete until that path parses as
    // a full credential.
    return this.loadCreds();
  }

  async restoreParkedCredential(parked) {
    return this.publishCredentialExclusive(parked, 'parked');
  }

  async writeAuthFile(next, expectedRefresh) {
    const temporary = `${this.authPath}.tmp-${process.pid}-${randomUUID()}`;
    const parked = `${this.authPath}.parked-${process.pid}-${randomUUID()}`;
    let ownsParked = false;
    let needsRecovery = false;
    let operationSucceeded = false;
    let temporaryWritten = false;
    let parkedCredential = null;
    let primaryError;
    try {
      await this.fileSystem.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      temporaryWritten = true;

      let lastError;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          // Moving the canonical path out of the way reserves the publication
          // slot. A concurrent atomic writer will either be captured in
          // `parked`, or recreate authPath and make the hard-link below fail
          // with EEXIST. Unlike check-then-rename, this never overwrites a
          // credential that appeared after the comparison.
          await this.fileSystem.rename(this.authPath, parked);
          ownsParked = true;
          needsRecovery = true;
          break;
        } catch (error) {
          lastError = error;
          if (error?.code === 'ENOENT') {
            // Another publisher may currently own the short reservation gap.
            // Wait for its canonical file to reappear, then either yield to
            // its rotated refresh token or retry reserving the unchanged one.
            const latest = await this.loadCreds().catch(() => null);
            if (latest && latest.creds.refresh !== expectedRefresh) {
              operationSucceeded = true;
              return latest.creds.access;
            }
          } else if (!TRANSIENT_FILE_ERRORS.has(error?.code)) {
            throw error;
          }
          if (attempt === 4) throw lastError;
          await this.sleep(50 * (attempt + 1));
        }
      }

      if (!ownsParked) throw lastError;
      const reserved = await this.loadCreds(4, parked);
      parkedCredential = reserved;
      if (reserved.creds.refresh !== expectedRefresh) {
        // The external writer completed just before our reservation. Restore
        // it only if no newer writer has already recreated the canonical path.
        const winner = await this.restoreParkedCredential(parked);
        if (winner.creds.refresh === expectedRefresh) {
          throw new Error('Canonical auth credential did not preserve the externally rotated refresh token');
        }
        needsRecovery = false;
        operationSucceeded = true;
        return winner.creds.access;
      }

      // link() is an atomic create-if-absent on NTFS and APFS. EEXIST is only a
      // candidate external winner: publishCredentialExclusive validates the
      // canonical JSON before returning it.
      const published = await this.publishCredentialExclusive(temporary, 'refreshed');
      const isOurCandidate =
        published.creds.access === next.tokens.access_token
        && published.creds.refresh === next.tokens.refresh_token;
      const isExternalWinner = published.creds.refresh !== expectedRefresh;
      if (!isOurCandidate && !isExternalWinner) {
        throw new Error('Canonical auth credential is valid but its refresh generation is ambiguous');
      }
      needsRecovery = false;
      operationSucceeded = true;
      return published.creds.access;
    } catch (error) {
      primaryError = error;
    } finally {
      let recoveryError;
      let canonicalCredential = null;
      if (ownsParked && needsRecovery) {
        try {
          // On a failed publication, put the known-good parked credential back
          // only when the canonical path is still absent. Never overwrite a
          // concurrent external writer during recovery.
          canonicalCredential = await this.restoreParkedCredential(parked);
        } catch (error) {
          recoveryError = error;
        }
      }

      if (primaryError && !canonicalCredential && !recoveryError) {
        canonicalCredential = await this.loadCreds().catch(() => null);
      }

      const canonicalIsCandidate = canonicalCredential
        && canonicalCredential.creds.access === next.tokens.access_token
        && canonicalCredential.creds.refresh === next.tokens.refresh_token;
      const canonicalIsExternalWinner = canonicalCredential
        && canonicalCredential.creds.refresh !== expectedRefresh;
      const canonicalIsSafeWinner = Boolean(canonicalIsCandidate || canonicalIsExternalWinner);
      const canonicalMatchesParked = canonicalCredential && parkedCredential
        && canonicalCredential.creds.access === parkedCredential.creds.access
        && canonicalCredential.creds.refresh === parkedCredential.creds.refresh;

      const cleanupTemporary = operationSucceeded || canonicalIsSafeWinner;
      const cleanupParked = operationSucceeded || canonicalIsSafeWinner || canonicalMatchesParked;
      const retained = [];
      if (temporaryWritten) {
        if (cleanupTemporary) {
          await this.fileSystem.rm(temporary, { force: true }).catch(() => {});
        } else {
          retained.push(temporary);
        }
      } else {
        await this.fileSystem.rm(temporary, { force: true }).catch(() => {});
      }
      if (ownsParked) {
        if (cleanupParked) {
          await this.fileSystem.rm(parked, { force: true }).catch(() => {});
        } else {
          retained.push(parked);
        }
      } else {
        await this.fileSystem.rm(parked, { force: true }).catch(() => {});
      }

      if (primaryError) {
        const errors = recoveryError ? [primaryError, recoveryError] : [primaryError];
        const retainedMessage = retained.length
          ? ` Recovery credential retained at: ${retained.join(', ')}`
          : '';
        throw new AggregateError(
          errors,
          `Auth publication failed: ${primaryError.message}.${retainedMessage}`,
          { cause: primaryError },
        );
      }
    }
  }

  async persistCreds(updatedCreds, loaded) {
    const latest = await this.loadCreds();
    if (latest.creds.refresh !== loaded.creds.refresh) return latest.creds.access;
    const next = {
      ...latest.raw,
      tokens: {
        ...(latest.raw.tokens || {}),
        access_token: updatedCreds.access,
        refresh_token: updatedCreds.refresh,
        account_id: updatedCreds.accountId || latest.raw?.tokens?.account_id || null,
      },
      last_refresh: new Date().toISOString(),
    };
    return this.writeAuthFile(next, loaded.creds.refresh);
  }

  async requestAccessToken(loaded) {
    return this.getOAuth(PROVIDER_ID, { [PROVIDER_ID]: loaded.creds });
  }

  async refreshAccessToken() {
    let loaded = await this.loadCreds();
    let result;
    try {
      result = await this.requestAccessToken(loaded);
    } catch (error) {
      const latest = await this.loadCreds();
      if (latest.creds.refresh === loaded.creds.refresh) throw error;
      loaded = latest;
      result = await this.requestAccessToken(loaded);
    }
    if (!result?.apiKey) {
      throw new Error('Failed to obtain Codex access token from OAuth credentials');
    }
    const newCreds = result.newCredentials || loaded.creds;
    const changed =
      newCreds.access !== loaded.creds.access ||
      newCreds.refresh !== loaded.creds.refresh ||
      newCreds.expires !== loaded.creds.expires ||
      newCreds.accountId !== loaded.creds.accountId;
    if (changed) {
      return this.persistCreds(newCreds, loaded);
    }
    return result.apiKey;
  }

  async getAccessToken() {
    if (!this.pendingAccessToken) {
      const pending = this.refreshAccessToken();
      const tracked = pending.finally(() => {
        if (this.pendingAccessToken === tracked) this.pendingAccessToken = null;
      });
      this.pendingAccessToken = tracked;
    }
    return this.pendingAccessToken;
  }
}

const authManager = new CodexAuthManager(AUTH_PATH);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(req) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function authorized(req) {
  if (!SHARED_SECRET) return true;
  const header = String(req.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBuffer = Buffer.from(SHARED_SECRET);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function extractTextFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        if (item.type === 'text') return item.text || '';
        if (item.type === 'input_text') return item.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function convertUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    return extractTextFromContent(content);
  }
  const parts = [];
  for (const item of content) {
    if (!item) continue;
    if (item.type === 'text' || item.type === 'input_text') {
      parts.push({ type: 'text', text: item.text || '' });
      continue;
    }
    if (item.type === 'image_url' && typeof item.image_url?.url === 'string') {
      const url = item.image_url.url;
      if (url.startsWith('data:')) {
        const match = url.match(/^data:(.+?);base64,(.+)$/);
        if (match) {
          parts.push({ type: 'image', mimeType: match[1], data: match[2] });
        }
      }
    }
  }
  if (parts.length === 0) return '';
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('\n');
  }
  return parts;
}

function normalizeToolArgs(argumentsText) {
  if (!argumentsText) return {};
  if (typeof argumentsText === 'object') return argumentsText;
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { _raw: String(argumentsText) };
  }
}

function augmentSystemPrompt(systemPrompt, body) {
  const extras = [];
  let basePrompt = systemPrompt?.trim() || 'You are a helpful assistant. Reply in concise plain text.';
  const rf = body.response_format;
  if (rf?.type === 'json_object') {
    extras.push('Return only a valid JSON object. Do not wrap it in markdown fences.');
  } else if (rf?.type === 'json_schema') {
    const schema = rf?.json_schema?.schema || rf?.json_schema;
    if (schema) {
      extras.push(`Return only JSON matching this schema:\n${JSON.stringify(schema)}`);
    }
  }

  if (body.tool_choice === 'required' || body.tool_choice === 'any') {
    extras.push('You must call at least one available tool before giving a final answer.');
  } else if (body.tool_choice && typeof body.tool_choice === 'object') {
    const forcedName = body.tool_choice?.function?.name || body.tool_choice?.name;
    if (forcedName) {
      extras.push(`You must call the tool \"${forcedName}\" before giving a final answer.`);
    }
  }

  const combined = [basePrompt, ...extras].filter(Boolean).join('\n\n').trim();
  return combined || undefined;
}

function convertTools(bodyTools, toolChoice) {
  if (toolChoice === 'none') return undefined;
  if (!Array.isArray(bodyTools) || bodyTools.length === 0) return undefined;
  return bodyTools
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {} },
    }));
}

function convertChatRequest(body) {
  const toolNameById = new Map();
  const messages = [];
  const systemParts = [];
  let idx = 0;

  for (const message of body.messages || []) {
    const role = message?.role;
    if (role === 'system' || role === 'developer') {
      const text = extractTextFromContent(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'user') {
      messages.push({
        role: 'user',
        content: convertUserContent(message.content),
        timestamp: Date.now() + idx++,
      });
      continue;
    }

    if (role === 'assistant') {
      const content = [];
      const text = extractTextFromContent(message.content);
      if (text) content.push({ type: 'text', text });
      for (const toolCall of message.tool_calls || []) {
        const id = toolCall.id || `call_${randomUUID()}`;
        const name = toolCall.function?.name || 'tool';
        toolNameById.set(id, name);
        content.push({
          type: 'toolCall',
          id,
          name,
          arguments: normalizeToolArgs(toolCall.function?.arguments),
        });
      }
      if (content.length > 0) {
        messages.push({
          role: 'assistant',
          content,
          api: 'openai-codex-responses',
          provider: 'openai-codex',
          model: body.model || DEFAULT_MODEL,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp: Date.now() + idx++,
        });
      }
      continue;
    }

    if (role === 'tool') {
      const toolCallId = message.tool_call_id || '';
      const toolName = message.name || toolNameById.get(toolCallId) || 'tool';
      const text = extractTextFromContent(message.content) || 'No result provided';
      messages.push({
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text }],
        isError: false,
        timestamp: Date.now() + idx++,
      });
    }
  }

  const systemPrompt = augmentSystemPrompt(systemParts.join('\n\n'), body);
  return {
    systemPrompt,
    messages,
    tools: convertTools(body.tools, body.tool_choice),
  };
}

function mapFinishReason(stopReason, toolCallCount) {
  if (stopReason === 'toolUse' || toolCallCount > 0) return 'tool_calls';
  if (stopReason === 'length') return 'length';
  return 'stop';
}

function formatAssistantMessage(assistant) {
  const text = assistant.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  const toolCalls = assistant.content
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(block.arguments ?? {}),
      },
    }));

  return {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function formatUsage(assistant, model) {
  const usage = {
    prompt_tokens: assistant.usage?.input ?? 0,
    completion_tokens: assistant.usage?.output ?? 0,
    total_tokens: assistant.usage?.totalTokens ?? ((assistant.usage?.input ?? 0) + (assistant.usage?.output ?? 0)),
  };
  // PROXY_USAGE_LOG가 설정돼 있으면 chat completion 1건마다 usage를 JSONL로 append(벤치 계측용).
  const usageLog = process.env.PROXY_USAGE_LOG;
  if (usageLog) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      model: model ?? null,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
    }) + '\n';
    fs.appendFile(usageLog, line).catch(() => {}); // fire-and-forget — 응답 지연 없음.
  }
  return usage;
}

function createChunkBase(id, model, created) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
  };
}

export function resolveReasoningEffort(modelId, body) {
  if (body.reasoning_effort != null) return body.reasoning_effort;
  const hasImage = body.messages?.some(message =>
    Array.isArray(message.content) && message.content.some(part =>
      part.type === 'image_url' && typeof part.image_url?.url === 'string'
      && part.image_url.url.length > 0));
  return modelId === 'gpt-6-astra' && hasImage ? 'low' : undefined;
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req);
  const modelId = body.model || DEFAULT_MODEL;
  // pi-ai's static catalog can lag newly released Codex models. The Codex
  // backend itself accepts the model id, so inherit the transport metadata
  // from the known default model when a new id is not catalogued yet.
  const catalogModel = getModel(PROVIDER_ID, modelId);
  const defaultModel = getModel(PROVIDER_ID, DEFAULT_MODEL)
    || getModel(PROVIDER_ID, 'gpt-5.5');
  if (!catalogModel && !defaultModel) {
    throw new Error(`Unknown Codex model: ${modelId}`);
  }
  const model = catalogModel || { ...defaultModel, id: modelId, name: modelId };
  const context = convertChatRequest({ ...body, model: modelId });
  const apiKey = await authManager.getAccessToken();
  const stream = piStream(model, context, {
    apiKey,
    transport: 'sse',
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    // Astra rejects temperature even when callers supply a conventional
    // summarization default. Preserve sampling settings for other models.
    temperature: modelId === 'gpt-6-astra' ? undefined : body.temperature,
    reasoningEffort: resolveReasoningEffort(modelId, body),
    sessionId: req.headers['x-session-id'] || body.user || undefined,
  });

  if (body.stream) {
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const includeUsage = Boolean(body.stream_options?.include_usage);
    let sentRole = false;
    let toolIndex = 0;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });

    const writeEvent = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      for await (const event of stream) {
        if (!sentRole && (event.type === 'text_start' || event.type === 'toolcall_start' || event.type === 'thinking_start')) {
          writeEvent({
            ...createChunkBase(id, modelId, created),
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          });
          sentRole = true;
        }

        if (event.type === 'text_delta') {
          writeEvent({
            ...createChunkBase(id, modelId, created),
            choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
          });
        }

        if (event.type === 'toolcall_end') {
          if (!sentRole) {
            writeEvent({
              ...createChunkBase(id, modelId, created),
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            });
            sentRole = true;
          }
          writeEvent({
            ...createChunkBase(id, modelId, created),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolIndex++,
                      id: event.toolCall.id,
                      type: 'function',
                      function: {
                        name: event.toolCall.name,
                        arguments: JSON.stringify(event.toolCall.arguments ?? {}),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }

        if (event.type === 'done') {
          const assistant = event.message;
          const finishReason = mapFinishReason(
            assistant.stopReason,
            assistant.content.filter((block) => block.type === 'toolCall').length,
          );
          writeEvent({
            ...createChunkBase(id, modelId, created),
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          });
          if (includeUsage) {
            writeEvent({
              ...createChunkBase(id, modelId, created),
              choices: [],
              usage: formatUsage(assistant, modelId),
            });
          }
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    } catch (error) {
      res.write(`data: ${JSON.stringify({ error: { message: String(error?.message || error) } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
  }

  let assistant = null;
  const seenEvents = [];
  for await (const event of stream) {
    seenEvents.push(event.type);
    if (event.type === 'done') {
      assistant = event.message;
    }
    if (event.type === 'error') {
      console.error('[codex-proxy] non-stream error event', {
        model: modelId,
        message_roles: (body.messages || []).map((msg) => msg.role),
        event,
      });
    }
  }
  if (!assistant) {
    console.error('[codex-proxy] no assistant response', {
      model: modelId,
      message_roles: (body.messages || []).map((msg) => msg.role),
      response_format: body.response_format || null,
      seenEvents,
    });
    throw new Error('No assistant response received from Codex proxy');
  }

  sendJson(res, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: formatAssistantMessage(assistant),
        finish_reason: mapFinishReason(
          assistant.stopReason,
          assistant.content.filter((block) => block.type === 'toolCall').length,
        ),
      },
    ],
    usage: formatUsage(assistant, modelId),
  });
}

// The models this adapter has metadata for, which is what a dispatcher in front of
// it can route by. A name outside this list is still forwarded when a request
// names it explicitly; handleChatCompletions falls back to the default model's
// shape. Listing only what is known keeps the reply from claiming more than it can
// describe.
export function listModels() {
  const catalog = getModels(PROVIDER_ID);
  const entries = Array.isArray(catalog) ? catalog : Object.values(catalog || {});
  const ids = new Set();
  for (const entry of entries) {
    const id = entry && (entry.id || entry.slug);
    if (typeof id === 'string' && id) ids.add(id);
  }
  ids.add(DEFAULT_MODEL);
  return [...ids].sort().map(id => ({ id, object: 'model', owned_by: PROVIDER_ID }));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { status: 'ok', provider: PROVIDER_ID, default_model: DEFAULT_MODEL });
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      return sendJson(res, 200, { object: 'list', data: listModels() });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      return await handleChatCompletions(req, res);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    return sendJson(res, Number(error?.statusCode) || 500, { error: String(error?.message || error) });
  }
});

server.requestTimeout = Number(process.env.CODEX_PROXY_REQUEST_TIMEOUT_MS || 10 * 60 * 1000);

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, HOST, () => {
    console.log(JSON.stringify({ status: 'listening', host: HOST, port: PORT, default_model: DEFAULT_MODEL }));
  });
}
