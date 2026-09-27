// OpenRouter-style dispatcher in front of the local OpenAI-compatible backends.
//
// One endpoint, several backends, routing decided by the request's `model`
// field alone. The request body is forwarded as the exact bytes that arrived:
// the backends accept non-standard fields (`reasoning_effort`, legacy display
// suffixes such as ` [low] vision`) that any normalization here would destroy.
// Streaming responses are piped through as bytes, never parsed and re-emitted.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROUTER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(ROUTER_DIR, 'config.json');
export const EXAMPLE_CONFIG_PATH = path.join(ROUTER_DIR, 'config.example.json');

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 11400,
  // These backends spawn CLIs; a single answer can take many minutes. The
  // upstream socket timeout is an inactivity guard, not a deadline.
  upstreamTimeoutMs: 15 * 60 * 1000,
  // /health is polled by proxyctl with a 1s timeout, so probes stay well under it.
  probeTimeoutMs: 750,
  discoverTimeoutMs: 3000,
  modelsTtlMs: 30 * 1000,
  maxBodyBytes: 8 * 1024 * 1024,
  clientAuthEnv: 'ROUTER_PROXY_SHARED_SECRET',
});

const LEGACY_LABEL_SUFFIX = /\s+\[(?:low|medium|high|xhigh|max)\](?:\s+vision)?$/i;
const OLLAMA_DEFAULT_TAG = ':latest';

// Hop-by-hop headers, plus the ones we must own ourselves. `authorization` is
// dropped deliberately: a backend key only ever comes from its `apiKeyEnv`, so
// a client token is never relayed to an upstream that did not issue it.
const DROPPED_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', 'accept-encoding', 'expect', 'authorization', 'cookie',
]);

// Everything else (content-length, content-encoding, connection) is re-derived
// by node; copying it would mislabel a body we may have already decoded.
const PASSED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'x-request-id'];

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /\b(?:bearer|basic|token)\s+[\w.~+/=-]+/gi,
  /\b(?:sk|hch|pk|rk|xox[abps])-[\w.~/-]{6,}/gi,
  /\beyJ[\w-]{6,}\.[\w-]{4,}(?:\.[\w-]+)?/g,
];

// Nothing leaves this process through a log line or an error body without
// passing through here first.
export function redact(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  return text;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const INLINE_SECRET_KEYS = ['apiKey', 'api_key', 'key', 'token', 'secret', 'password', 'authorization'];

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// env wins over the config file, which wins over the default. An env var that
// is set but empty (a LaunchAgent can do that) falls through instead of winning.
function numberSetting(fromEnv, fromConfig, fallback) {
  return positiveNumber(fromEnv, positiveNumber(fromConfig, fallback));
}

function stringList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`backend ${field} must be an array of model ids`);
  return value.map((id) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error(`backend ${field} entries must be non-empty strings`);
    return id.trim();
  });
}

function normalizeBackend(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`backends[${index}] must be an object`);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new Error(`backends[${index}] requires a name`);
  for (const key of INLINE_SECRET_KEYS) {
    if (raw[key] != null) {
      throw new Error(`backend ${name}: "${key}" must not be in the config file; name an environment variable with "apiKeyEnv" instead`);
    }
  }
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '';
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`backend ${name}: baseUrl must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`backend ${name}: baseUrl must be an absolute http(s) URL`);
  }
  const models = stringList(raw.models, 'models');
  const aliases = stringList(raw.aliases, 'aliases');
  const discoverModels = Boolean(raw.discoverModels);
  if (!discoverModels && models.length === 0) {
    throw new Error(`backend ${name}: set "models" or "discoverModels"`);
  }
  const apiKeyEnv = typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : null;
  return { name, baseUrl, models, aliases, discoverModels, apiKeyEnv };
}

export function normalizeConfig(raw = {}, env = process.env) {
  const listen = raw.listen && typeof raw.listen === 'object' ? raw.listen : raw;
  const host = env.HOST || listen.host || DEFAULTS.host;
  const port = numberSetting(env.PORT, listen.port, DEFAULTS.port);
  const backends = (Array.isArray(raw.backends) ? raw.backends : []).map(normalizeBackend);
  if (backends.length === 0) throw new Error('config.backends must list at least one backend');
  const names = new Set();
  for (const backend of backends) {
    if (names.has(backend.name)) throw new Error(`duplicate backend name: ${backend.name}`);
    names.add(backend.name);
  }
  return {
    host,
    port,
    backends,
    upstreamTimeoutMs: numberSetting(env.ROUTER_UPSTREAM_TIMEOUT_MS, raw.upstreamTimeoutMs, DEFAULTS.upstreamTimeoutMs),
    probeTimeoutMs: numberSetting(env.ROUTER_PROBE_TIMEOUT_MS, raw.probeTimeoutMs, DEFAULTS.probeTimeoutMs),
    discoverTimeoutMs: numberSetting(env.ROUTER_DISCOVER_TIMEOUT_MS, raw.discoverTimeoutMs, DEFAULTS.discoverTimeoutMs),
    modelsTtlMs: numberSetting(env.ROUTER_MODELS_TTL_MS, raw.modelsTtlMs, DEFAULTS.modelsTtlMs),
    maxBodyBytes: numberSetting(env.ROUTER_MAX_BODY_BYTES, raw.maxBodyBytes, DEFAULTS.maxBodyBytes),
    clientAuthEnv: (typeof raw.clientAuthEnv === 'string' && raw.clientAuthEnv.trim()) || DEFAULTS.clientAuthEnv,
  };
}

export function resolveConfigPath(env = process.env, exists = fs.existsSync) {
  if (env.ROUTER_CONFIG) return { path: env.ROUTER_CONFIG, fallback: false };
  if (exists(DEFAULT_CONFIG_PATH)) return { path: DEFAULT_CONFIG_PATH, fallback: false };
  // Nothing installed yet: the committed example is a working loopback setup,
  // so `node server.mjs` and `proxyctl.py install router` come up regardless.
  return { path: EXAMPLE_CONFIG_PATH, fallback: true };
}

export function loadConfig(env = process.env) {
  const chosen = resolveConfigPath(env);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(chosen.path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read router config ${chosen.path}: ${error.message}`);
  }
  return { config: normalizeConfig(raw, env), source: chosen.path, fallback: chosen.fallback };
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpError(statusCode, message, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errorType = extra.type;
  error.param = extra.param;
  error.code = extra.code;
  return error;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload)}\n`);
}

function errorType(statusCode, explicit) {
  if (explicit) return explicit;
  if (statusCode === 401) return 'authentication_error';
  if (statusCode === 404) return 'invalid_request_error';
  if (statusCode === 413) return 'invalid_request_error';
  if (statusCode >= 500) return 'api_error';
  return 'invalid_request_error';
}

function sendError(res, statusCode, message, extra = {}) {
  sendJson(res, statusCode, {
    error: {
      message: redact(message),
      type: errorType(statusCode, extra.type),
      param: extra.param ?? null,
      code: extra.code ?? null,
    },
  });
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBytes) throw httpError(413, `Request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The parsed object is only ever read for `model`. The bytes are what travels.
function parseForDispatch(raw) {
  if (raw.length === 0) throw httpError(400, 'Request body is empty; a JSON body with a "model" field is required', { param: 'model' });
  try {
    return JSON.parse(raw.toString('utf8'));
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

function backendAuthHeader(backend, env) {
  if (!backend.apiKeyEnv) return null;
  const value = env[backend.apiKeyEnv];
  return value ? `Bearer ${value}` : null;
}

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

// A request may name a model the way its backend prints it rather than the way
// the backend lists it: claude accepts WeKnora's ` [low] vision` display
// suffixes, and ollama lists `name:latest` for a model clients call `name`.
// Only the lookup key is rewritten - never the body.
export function lookupCandidates(model) {
  const out = [];
  const push = (value) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  const exact = String(model ?? '').trim();
  push(exact);
  const stripped = exact.replace(LEGACY_LABEL_SUFFIX, '').trim();
  push(stripped);
  for (const base of [exact, stripped]) {
    if (!base) continue;
    if (base.endsWith(OLLAMA_DEFAULT_TAG)) push(base.slice(0, -OLLAMA_DEFAULT_TAG.length));
    else push(`${base}${OLLAMA_DEFAULT_TAG}`);
  }
  return out;
}

export function createRegistry(config, { fetchImpl = fetch, env = process.env, now = () => Date.now(), log = () => {} } = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function fetchModels(backend) {
    const headers = { accept: 'application/json' };
    const auth = backendAuthHeader(backend, env);
    if (auth) headers.authorization = auth;
    const response = await fetchImpl(`${backend.baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(config.discoverTimeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return data.map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : '')).filter(Boolean);
  }

  // A backend that is down keeps its last good list (stale-while-error) and,
  // failing that, contributes nothing. It never fails the whole listing.
  function discover(backend) {
    const cached = cache.get(backend.name);
    if (cached && now() - cached.fetchedAt < config.modelsTtlMs) return Promise.resolve(cached.ids);
    const pending = inflight.get(backend.name);
    if (pending) return pending;
    const task = fetchModels(backend)
      .then((ids) => {
        cache.set(backend.name, { ids, fetchedAt: now(), ok: true });
        return ids;
      })
      .catch((error) => {
        const ids = cached?.ids ?? [];
        cache.set(backend.name, { ids, fetchedAt: now(), ok: false });
        log({ event: 'model_discovery_failed', backend: backend.name, reason: redact(error?.message || error), retained: ids.length });
        return ids;
      })
      .finally(() => {
        if (inflight.get(backend.name) === task) inflight.delete(backend.name);
      });
    inflight.set(backend.name, task);
    return task;
  }

  async function table() {
    const discovering = config.backends.filter((backend) => backend.discoverModels);
    const discovered = new Map(await Promise.all(
      discovering.map(async (backend) => [backend.name, await discover(backend)]),
    ));
    const rows = [];
    for (const backend of config.backends) {
      for (const id of backend.models) rows.push({ id, backend, listed: true });
      for (const id of discovered.get(backend.name) || []) rows.push({ id, backend, listed: true });
      // Aliases route but are not advertised (e.g. claude's `opus`).
      for (const id of backend.aliases) rows.push({ id, backend, listed: false });
    }
    return rows;
  }

  // Static ids resolve with no upstream traffic at all, so a dispatch to a
  // configured model never waits on a discovery call.
  function resolveStatic(model) {
    const index = new Map();
    for (const backend of config.backends) {
      for (const id of [...backend.models, ...backend.aliases]) if (!index.has(id)) index.set(id, backend);
    }
    for (const candidate of lookupCandidates(model)) {
      const backend = index.get(candidate);
      if (backend) return backend;
    }
    return null;
  }

  return {
    async list() {
      const seen = new Set();
      const data = [];
      for (const row of await table()) {
        if (!row.listed || seen.has(row.id)) continue;
        seen.add(row.id);
        data.push({ id: row.id, object: 'model', owned_by: row.backend.name });
      }
      return data;
    },
    async resolve(model) {
      const fromConfig = resolveStatic(model);
      if (fromConfig) return fromConfig;
      const index = new Map();
      for (const row of await table()) if (!index.has(row.id)) index.set(row.id, row.backend);
      for (const candidate of lookupCandidates(model)) {
        const backend = index.get(candidate);
        if (backend) return backend;
      }
      return null;
    },
    async knownIds() {
      return (await this.list()).map((entry) => entry.id);
    },
  };
}

// ---------------------------------------------------------------------------
// HOOK POINT - embedding request rewriting (placeholder, does nothing)
// ---------------------------------------------------------------------------
//
// Retrieval quality often improves when an embedding request carries a short
// instruction prefix ("Represent this sentence for searching relevant
// passages: ..."), and that prefix has to differ between the query side and
// the document side. This is the single place where such a rewrite would
// happen: it sees the raw request bytes, the parsed body and the chosen
// backend, and returns the bytes to forward.
//
// It is deliberately an identity function today. Nothing in this router
// rewrites request content, and a future implementation must re-serialize here
// and nowhere else, so that the chat path keeps forwarding untouched bytes.
export function rewriteEmbeddingsBody(rawBody, parsedBody, backend) { // eslint-disable-line no-unused-vars
  return rawBody;
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

function upstreamHeaders(clientHeaders, body, backend, env) {
  const headers = {};
  for (const [name, value] of Object.entries(clientHeaders)) {
    if (value == null) continue;
    if (DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  // Identity encoding keeps the response bytes the ones the backend produced.
  headers['accept-encoding'] = 'identity';
  headers['content-length'] = String(body.length);
  const auth = backendAuthHeader(backend, env);
  if (auth) headers.authorization = auth;
  return headers;
}

// Byte-for-byte relay. The body goes out as it arrived and the response is
// piped, so SSE framing (including a backend that buffers and then flushes)
// survives untouched.
function forward({ req, res, backend, upstreamPath, body, config, env }) {
  return new Promise((resolve) => {
    const target = new URL(`${backend.baseUrl}${upstreamPath}`);
    const transport = target.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (status) => {
      if (!settled) {
        settled = true;
        resolve(status);
      }
    };

    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: upstreamHeaders(req.headers, body, backend, env),
    });

    // A client that hangs up must take the upstream request with it: these
    // backends spawn CLI processes that would otherwise run on for minutes.
    const onClientClose = () => {
      if (!res.writableFinished) {
        upstream.destroy();
        finish(499);
      }
    };
    res.on('close', onClientClose);

    upstream.setTimeout(config.upstreamTimeoutMs, () => {
      upstream.destroy(httpError(504, `backend ${backend.name} sent nothing for ${config.upstreamTimeoutMs} ms`));
    });

    upstream.on('error', (error) => {
      const status = Number(error?.statusCode) || 502;
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        finish(status);
        return;
      }
      sendError(res, status, `backend ${backend.name} request failed: ${error?.message || error}`, { type: 'api_error', code: status === 504 ? 'upstream_timeout' : 'upstream_unavailable' });
      finish(status);
    });

    upstream.on('response', (upstreamRes) => {
      const headers = {};
      for (const name of PASSED_RESPONSE_HEADERS) {
        if (upstreamRes.headers[name]) headers[name] = upstreamRes.headers[name];
      }
      const status = upstreamRes.statusCode || 502;
      res.writeHead(status, headers);
      res.socket?.setNoDelay(true);
      upstreamRes.socket?.setNoDelay(true);
      upstreamRes.on('error', () => {
        res.destroy();
        finish(status);
      });
      res.on('finish', () => finish(status));
      upstreamRes.pipe(res);
    });

    upstream.end(body);
  });
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

// Structured, one line, fixed fields. Headers, bodies and upstream error text
// never reach a log line; free-form strings go through redact() first.
export function defaultLog(entry) {
  if (process.env.ROUTER_REQUEST_LOG === '0') return;
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createHandler({
  config: rawConfig,
  env = process.env,
  sharedSecret,
  fetchImpl = fetch,
  log = defaultLog,
  registry: injectedRegistry,
} = {}) {
  const config = normalizeConfig(rawConfig ?? {}, env);
  const secret = sharedSecret !== undefined ? sharedSecret : (env[config.clientAuthEnv] || '');
  if (!isLoopbackHost(config.host) && !secret) {
    throw new Error(`${config.clientAuthEnv} is required when the listen host is not loopback`);
  }
  const safeLog = (entry) => {
    try {
      log(entry);
    } catch {
      // A broken stdout must never turn into a failed request.
    }
  };
  const registry = injectedRegistry || createRegistry(config, { fetchImpl, env, log: safeLog });

  async function probe(backend) {
    const startedAt = Date.now();
    const url = new URL('/health', backend.baseUrl);
    try {
      // Any HTTP status proves the port answers; ollama has no /health.
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(config.probeTimeoutMs) });
      return { name: backend.name, base_url: backend.baseUrl, reachable: true, status: response.status, latency_ms: Date.now() - startedAt };
    } catch (error) {
      return { name: backend.name, base_url: backend.baseUrl, reachable: false, status: null, latency_ms: Date.now() - startedAt, reason: redact(error?.message || error) };
    }
  }

  // `record` is filled in as dispatch progresses so a rejected request still
  // logs the model it asked for.
  async function handleProxy(req, res, upstreamPath, kind, record) {
    const raw = await readBody(req, config.maxBodyBytes);
    const parsed = parseForDispatch(raw);
    const requested = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
    if (!requested) {
      throw httpError(400, 'Request body must include a "model" string; the router has no default model', { param: 'model', code: 'model_required' });
    }
    record.model = requested;
    const backend = await registry.resolve(requested);
    if (!backend) {
      const ids = await registry.knownIds();
      throw httpError(404, `Unknown model "${requested}". Available models: ${ids.join(', ') || '(none; every backend is unreachable)'}`, { param: 'model', code: 'model_not_found' });
    }
    record.backend = backend.name;
    const body = kind === 'embeddings' ? rewriteEmbeddingsBody(raw, parsed, backend) : raw;
    return forward({ req, res, backend, upstreamPath, body, config, env });
  }

  return async function handler(req, res) {
    const startedAt = Date.now();
    const pathname = new URL(req.url, 'http://router.invalid').pathname;
    const record = { model: null, backend: null };
    const emit = (status) => safeLog({
      event: 'request',
      at: new Date().toISOString(),
      method: req.method,
      path: pathname,
      backend: record.backend,
      model: record.model,
      status,
      duration_ms: Date.now() - startedAt,
    });

    try {
      if (req.method === 'GET' && pathname === '/health') {
        const backends = await Promise.all(config.backends.map(probe));
        return sendJson(res, 200, {
          status: 'ok',
          listen: { host: config.host, port: config.port },
          client_auth: Boolean(secret),
          backends,
        });
      }

      if (req.method === 'GET' && pathname === '/v1/models') {
        if (!authorized(req, secret)) {
          emit(401);
          return sendError(res, 401, 'Unauthorized');
        }
        const data = await registry.list();
        emit(200);
        return sendJson(res, 200, { object: 'list', data });
      }

      const route = req.method === 'POST' ? ROUTES.get(pathname) : undefined;
      if (route) {
        if (!authorized(req, secret)) {
          emit(401);
          return sendError(res, 401, 'Unauthorized');
        }
        emit(await handleProxy(req, res, route.upstreamPath, route.kind, record));
        return undefined;
      }

      emit(404);
      return sendError(res, 404, `Not found: ${req.method} ${pathname}`, { code: 'unknown_endpoint' });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      emit(status);
      if (res.writableEnded) return undefined;
      if (res.headersSent) {
        res.end();
        return undefined;
      }
      return sendError(res, status, error?.message || error, {
        type: error?.errorType,
        param: error?.param,
        code: error?.code,
      });
    }
  };
}

const ROUTES = new Map([
  ['/v1/chat/completions', { upstreamPath: '/chat/completions', kind: 'chat' }],
  ['/v1/embeddings', { upstreamPath: '/embeddings', kind: 'embeddings' }],
]);

export function createServer(options = {}) {
  const config = normalizeConfig(options.config ?? {}, options.env ?? process.env);
  const server = http.createServer(createHandler(options));
  // Governs how long the client may take to deliver its request, not how long
  // a backend may take to answer; that guard is the upstream socket timeout.
  server.requestTimeout = config.upstreamTimeoutMs;
  server.headersTimeout = Math.min(60_000, config.upstreamTimeoutMs);
  server.timeout = 0;
  return server;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { config, source, fallback } = loadConfig();
  const server = createServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({
      status: 'listening',
      host: config.host,
      port: config.port,
      config: source,
      config_is_example: fallback,
      client_auth: Boolean(process.env[config.clientAuthEnv]),
      backends: config.backends.map((backend) => ({
        name: backend.name,
        base_url: backend.baseUrl,
        models: backend.models.length,
        discover: backend.discoverModels,
      })),
    }));
  });
}
