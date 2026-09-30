// OpenRouter-style dispatcher in front of the local OpenAI-compatible backends.
//
// One endpoint, several backends, routing decided by the request's `model`
// field alone. The request body is forwarded as the exact bytes that arrived:
// the backends accept non-standard fields (`reasoning_effort`, legacy display
// suffixes such as ` [low] vision`) that any normalization here would destroy.
// Streaming responses are piped through as bytes, never parsed and re-emitted.
// When several backends (accounts) serve one model, in-memory per-account state
// picks among them and a usage limit fails over; see "Account routing".
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

// Account selection when several backends serve one model (e.g. `codex-1`,
// `codex-2`: accounts of one subscription). `drain` keeps today's behavior for
// a single backend: the first one in config order takes every request.
export const ROUTING_DEFAULTS = Object.freeze({
  mode: 'drain',
  windowMs: 5 * 60 * 60 * 1000,
  defaultCooldownMs: 15 * 60 * 1000,
  maxCooldownMs: 6 * 60 * 60 * 1000,
  unreachableCooldownMs: 30 * 1000,
});
const ROUTING_MODES = ['drain', 'balance'];

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

function normalizeRouting(raw, env) {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('config.routing must be an object');
  const routing = raw || {};
  // Same convention as the numeric settings: a set-but-empty env var falls through.
  const envMode = typeof env.ROUTER_ROUTING_MODE === 'string' ? env.ROUTER_ROUTING_MODE.trim() : '';
  const mode = envMode || (routing.mode == null ? ROUTING_DEFAULTS.mode : routing.mode);
  if (!ROUTING_MODES.includes(mode)) {
    throw new Error(`routing.mode must be one of ${ROUTING_MODES.map((m) => `"${m}"`).join(', ')}; got ${JSON.stringify(mode)}`);
  }
  return {
    mode,
    windowMs: positiveNumber(routing.windowMs, ROUTING_DEFAULTS.windowMs),
    defaultCooldownMs: positiveNumber(routing.defaultCooldownMs, ROUTING_DEFAULTS.defaultCooldownMs),
    maxCooldownMs: positiveNumber(routing.maxCooldownMs, ROUTING_DEFAULTS.maxCooldownMs),
    unreachableCooldownMs: positiveNumber(routing.unreachableCooldownMs, ROUTING_DEFAULTS.unreachableCooldownMs),
  };
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
    routing: normalizeRouting(raw.routing, env),
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

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers });
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

function sendError(res, statusCode, message, extra = {}, headers = {}) {
  sendJson(res, statusCode, {
    error: {
      message: redact(message),
      type: errorType(statusCode, extra.type),
      param: extra.param ?? null,
      code: extra.code ?? null,
    },
  }, headers);
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
  // How each backend's last discovery went, for /health. A backend that lists
  // nothing because it refused this router's key (an adapter left behind by an
  // earlier install, holding its old key) must be told apart from one that has
  // no account behind it.
  const outcomes = new Map();

  async function fetchModels(backend) {
    const headers = { accept: 'application/json' };
    const auth = backendAuthHeader(backend, env);
    if (auth) headers.authorization = auth;
    const response = await fetchImpl(`${backend.baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(config.discoverTimeoutMs),
    });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
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
        outcomes.set(backend.name, { ok: true, status: 200, reason: null, models: ids.length, at: new Date(now()).toISOString() });
        return ids;
      })
      .catch((error) => {
        const ids = cached?.ids ?? [];
        cache.set(backend.name, { ids, fetchedAt: now(), ok: false });
        outcomes.set(backend.name, {
          ok: false,
          status: Number.isInteger(error?.status) ? error.status : null,
          reason: redact(error?.message || error).slice(0, 200),
          models: ids.length,
          at: new Date(now()).toISOString(),
        });
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

  // Every backend that serves the model, statically or by discovery, in config
  // order (the user's priority order), each once. With no discovering backend
  // this makes no upstream call; otherwise it waits on the cached discovery
  // (at most one call per backend per modelsTtlMs), because an account that
  // only discovers a model is still a failover target for it.
  async function candidates(model) {
    const keys = new Set(lookupCandidates(model));
    const serving = new Set();
    for (const row of await table()) if (keys.has(row.id)) serving.add(row.backend);
    return config.backends.filter((backend) => serving.has(backend));
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
    candidates,
    /** The last discovery of one backend: { ok, status, reason, models, at }, or null before any. */
    discovery(name) {
      return outcomes.get(name) ?? null;
    },
    async resolve(model) {
      return (await candidates(model))[0] ?? null;
    },
    async knownIds() {
      return (await this.list()).map((entry) => entry.id);
    },
  };
}

// ---------------------------------------------------------------------------
// Account routing
// ---------------------------------------------------------------------------

// A 5xx answer whose body says the account ran out. The adapters answer 429
// `usage_limit_reached`; older ones still wrap the CLI's text in a 500/502.
// The same pattern the adapters use. A bare "limit reached" is not enough:
// "Context limit reached" means the prompt is too big, and failing that over
// would rest every account for nothing.
export const QUOTA_PATTERN = /usage.?limit|rate.?limit|(?:hit|reached) your [^\n.]{0,40}?\blimit\b|\b(?!(?:context|tokens?|output|input|length|size|max)\b)[\w-]+ limit reached|rate_limit_error|usage_limit_reached|\b429\b/i;
const QUOTA_BODY_CAP = 64 * 1024;
const LIMIT_REASON_MAX = 200;
const TRY_AGAIN = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/i;
const RESET_EPOCH = /\|(\d{9,11})(?!\d)/;
const UNIT_MS = { h: 60 * 60 * 1000, m: 60 * 1000, s: 1000 };

// A connection that never produced a response: the backend is down or gone,
// so the request cannot have run there and another account may take it.
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

function retryAfterMs(value) {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !/^\s*\d+\s*$/.test(text)) return null;
  const seconds = Number(text);
  return seconds > 0 ? seconds * 1000 : null;
}

function bodyCooldownMs(text, at) {
  const wait = TRY_AGAIN.exec(text);
  if (wait) {
    const ms = Number(wait[1]) * UNIT_MS[wait[2][0].toLowerCase()];
    if (ms > 0) return ms;
  }
  const epoch = RESET_EPOCH.exec(text);
  if (epoch) {
    const ms = Number(epoch[1]) * 1000 - at;
    if (ms > 0) return ms;
  }
  return null;
}

function limitReason(text, status) {
  let message = '';
  try {
    const payload = JSON.parse(text);
    const error = payload?.error;
    if (typeof error === 'string') message = error;
    else if (typeof error?.message === 'string') message = error.message;
    else if (typeof payload?.message === 'string') message = payload.message;
  } catch {
    // Not JSON: the text itself is the reason.
  }
  if (!message) message = text;
  // Redact the whole text before truncating, so a cut can't expose half a token.
  const clean = redact(message).replace(/\s+/g, ' ').trim();
  return (clean ? `HTTP ${status}: ${clean}` : `HTTP ${status}`).slice(0, LIMIT_REASON_MAX);
}

const isoOrNull = (ms) => (ms == null ? null : new Date(ms).toISOString());

// In-memory only: a router restart forgets every cooldown and counter.
export function createRoutingState(config, { now = () => Date.now() } = {}) {
  const routing = config.routing;
  const states = new Map();

  function stateOf(backend) {
    let state = states.get(backend.name);
    if (!state) {
      // cooldownKind: 'quota' | 'unreachable' | null - why cooldownUntil was set.
      state = { cooldownUntil: 0, cooldownKind: null, consecutiveLimits: 0, starts: [], lastUsedAt: null, lastLimitReason: null };
      states.set(backend.name, state);
    }
    return state;
  }

  function requestsInWindow(state, at) {
    const cutoff = at - routing.windowMs;
    const keep = state.starts.findIndex((start) => start > cutoff);
    state.starts.splice(0, keep === -1 ? state.starts.length : keep);
    return state.starts.length;
  }

  return {
    mode: routing.mode,

    // The next backend to try, or null. `candidates` is already in config order.
    pick(candidates, tried = new Set()) {
      const at = now();
      const untried = candidates.filter((backend) => !tried.has(backend));
      const open = untried.filter((backend) => stateOf(backend).cooldownUntil <= at);
      if (open.length === 0) {
        // Everything is cooling. A backend cooling only because it was
        // unreachable is still worth a try - a refused connection costs
        // nothing, and a single-backend config keeps answering a fresh 502
        // instead of a 429. Earliest release first. Only when every candidate
        // is cooling for quota does the caller answer all_accounts_limited.
        const unreachable = untried.filter((backend) => stateOf(backend).cooldownKind === 'unreachable');
        unreachable.sort((a, b) => stateOf(a).cooldownUntil - stateOf(b).cooldownUntil);
        return unreachable[0] ?? null;
      }
      if (routing.mode === 'balance') {
        const load = new Map(open.map((backend) => [backend, requestsInWindow(stateOf(backend), at)]));
        // Never used sorts first; equal times fall through to config order,
        // which the stable sort keeps.
        const lastUsed = (backend) => stateOf(backend).lastUsedAt ?? -Infinity;
        const byLastUsed = (a, b) => (lastUsed(a) < lastUsed(b) ? -1 : lastUsed(a) > lastUsed(b) ? 1 : 0);
        open.sort((a, b) => (load.get(a) - load.get(b)) || byLastUsed(a, b));
      }
      return open[0];
    },

    attempted(backend) {
      const state = stateOf(backend);
      const at = now();
      requestsInWindow(state, at);
      state.starts.push(at);
      state.lastUsedAt = at;
    },

    // The backend answered and the answer is being relayed. It is reachable, so
    // an unreachable cooldown no longer holds; only a 2xx resets the limit count.
    answered(backend, status) {
      const state = stateOf(backend);
      if (state.cooldownKind === 'unreachable') {
        state.cooldownUntil = 0;
        state.cooldownKind = null;
      }
      if (status >= 200 && status < 300) state.consecutiveLimits = 0;
    },

    // Returns the cooldown end. Every source is capped at maxCooldownMs: a
    // multi-day hint or a garbled epoch would otherwise park the account until
    // restart, and the cap costs one fast 429 per maxCooldownMs at worst.
    limited(backend, { status, headers, text }) {
      const state = stateOf(backend);
      const at = now();
      const ms = retryAfterMs(headers?.['retry-after'])
        ?? bodyCooldownMs(text, at)
        ?? routing.defaultCooldownMs * 2 ** state.consecutiveLimits;
      state.cooldownUntil = at + Math.min(ms, routing.maxCooldownMs);
      state.cooldownKind = 'quota';
      state.consecutiveLimits += 1;
      state.lastLimitReason = limitReason(text, status);
      return state.cooldownUntil;
    },

    unreachable(backend, error) {
      const state = stateOf(backend);
      state.cooldownUntil = now() + routing.unreachableCooldownMs;
      state.cooldownKind = 'unreachable';
      state.lastLimitReason = redact(`unreachable: ${error?.code || error?.message || error}`).slice(0, LIMIT_REASON_MAX);
      return state.cooldownUntil;
    },

    // Earliest moment any of `candidates` leaves its cooldown.
    earliestRelease(candidates) {
      const at = now();
      const ends = candidates.map((backend) => stateOf(backend).cooldownUntil).filter((until) => until > at);
      return ends.length ? Math.min(...ends) : at;
    },

    snapshot(backend) {
      const state = stateOf(backend);
      const at = now();
      return {
        cooldown_until: state.cooldownUntil > at ? isoOrNull(state.cooldownUntil) : null,
        consecutive_limits: state.consecutiveLimits,
        requests_in_window: requestsInWindow(state, at),
        last_used_at: isoOrNull(state.lastUsedAt),
        last_limit_reason: state.lastLimitReason,
      };
    },

    now,
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

function unreachableError(error) {
  // Keyed on the socket error code only. The inactivity timeout arrives here as
  // an error too (statusCode 504) and must stay a 504: like a generic 5xx, the
  // backend may have been working on the request, so it is not repeated.
  return !error?.statusCode && UNREACHABLE_CODES.has(error?.code);
}

// One upstream attempt. Resolves with what happened:
//   { kind: 'relayed', status, upstreamStatus } - the answer went (or is going)
//     to the client; nothing more may be tried for this request
//   { kind: 'failed', status } - an error was reported to the client
//   { kind: 'quota', status, headers, text } - account exhausted; the client
//     has been sent nothing
//   { kind: 'unreachable', error } - no connection; the client has been sent nothing
//
// A 2xx, and any status that cannot be a usage limit, is a byte-for-byte
// relay: the body goes out as it arrived and the response is piped, so SSE
// framing (including a backend that buffers and then flushes) survives
// untouched. A 429 or a 5xx is held back (up to 64 KB) only long enough to
// tell a usage limit from an ordinary error, and an ordinary error is then
// relayed with the same bytes.
function attempt({ req, res, backend, upstreamPath, body, config, env, onAbort, onRelay }) {
  return new Promise((resolve) => {
    const target = new URL(`${backend.baseUrl}${upstreamPath}`);
    const transport = target.protocol === 'https:' ? https : http;
    let settled = false;
    let upstream = null;
    const finish = (outcome) => {
      if (!settled) {
        settled = true;
        onAbort(null);
        resolve(outcome);
      }
    };

    // A client that hangs up must take the upstream request with it: these
    // backends spawn CLI processes that would otherwise run on for minutes.
    onAbort(() => {
      upstream?.destroy();
      finish({ kind: 'relayed', status: 499 });
    });

    // `fresh` forces a new connection (no agent pool) for the stale-socket retry.
    const send = (fresh) => {
      let responded = false;
      const request = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: upstreamHeaders(req.headers, body, backend, env),
        ...(fresh ? { agent: false } : {}),
      });
      upstream = request;
      // Events from a request this attempt has moved past (settled, or
      // replaced by the retry) are ignored, so an abandoned upstream can never
      // write to or destroy a response that something else now owns.
      const stale = () => settled || upstream !== request;

      request.setTimeout(config.upstreamTimeoutMs, () => {
        if (stale()) return;
        request.destroy(httpError(504, `backend ${backend.name} sent nothing for ${config.upstreamTimeoutMs} ms`));
      });

      const fail = (error) => {
        if (stale()) return;
        const status = Number(error?.statusCode) || 502;
        if (res.headersSent || res.writableEnded) {
          res.destroy();
          finish({ kind: 'relayed', status });
          return;
        }
        // A keep-alive socket the backend closed while it sat in the pool
        // resets on reuse before the request reaches the backend. That says
        // nothing about the backend, so try it once more on a new connection.
        if (!responded && !fresh && request.reusedSocket && error?.code === 'ECONNRESET') {
          send(true);
          return;
        }
        if (!responded && unreachableError(error)) {
          finish({ kind: 'unreachable', error });
          return;
        }
        sendError(res, status, `backend ${backend.name} request failed: ${error?.message || error}`, { type: 'api_error', code: status === 504 ? 'upstream_timeout' : 'upstream_unavailable' });
        finish({ kind: 'failed', status });
      };
      request.on('error', fail);

      request.on('response', (upstreamRes) => {
        responded = true;
        const status = upstreamRes.statusCode || 502;
        upstreamRes.on('error', (error) => {
          if (stale() || !res.headersSent) {
            fail(error);
            return;
          }
          res.destroy();
          finish({ kind: 'relayed', status, upstreamStatus: status });
        });

        const relay = (prefix, complete) => {
          const headers = {};
          for (const name of PASSED_RESPONSE_HEADERS) {
            if (upstreamRes.headers[name]) headers[name] = upstreamRes.headers[name];
          }
          onRelay(status);
          res.writeHead(status, headers);
          res.socket?.setNoDelay(true);
          upstreamRes.socket?.setNoDelay(true);
          res.on('finish', () => finish({ kind: 'relayed', status, upstreamStatus: status }));
          for (const chunk of prefix) res.write(chunk);
          if (complete) res.end();
          else upstreamRes.pipe(res);
        };

        // Only a usage limit fails over: a 429 always, a 5xx when its text says
        // so (older adapters wrap the CLI's limit message in a 500/502). A
        // generic 5xx is relayed as it is: it may be this request's own fault,
        // and repeating it on every account would burn all of them for
        // nothing. Any other 4xx is about the request itself, whatever its
        // text says, and is relayed without being inspected.
        if (status !== 429 && status < 500) {
          relay([], false);
          return;
        }

        const chunks = [];
        let size = 0;
        const decide = (complete) => {
          if (stale()) return;
          const text = Buffer.concat(chunks).subarray(0, QUOTA_BODY_CAP).toString('utf8');
          if (status === 429 || QUOTA_PATTERN.test(text)) {
            finish({ kind: 'quota', status, headers: upstreamRes.headers, text });
            if (!complete) upstreamRes.destroy();
            return;
          }
          relay(chunks, complete);
        };
        const onData = (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= QUOTA_BODY_CAP) {
            upstreamRes.pause();
            upstreamRes.off('data', onData);
            upstreamRes.off('end', onEnd);
            decide(false);
          }
        };
        const onEnd = () => decide(true);
        upstreamRes.on('data', onData);
        upstreamRes.on('end', onEnd);
      });

      request.end(body);
    };

    send(false);
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
  now = () => Date.now(),
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
  const registry = injectedRegistry || createRegistry(config, { fetchImpl, env, now, log: safeLog });
  const routing = createRoutingState(config, { now });

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
    const candidates = registry.candidates
      ? await registry.candidates(requested)
      : [await registry.resolve(requested)].filter(Boolean);
    if (candidates.length === 0) {
      const ids = await registry.knownIds();
      throw httpError(404, `Unknown model "${requested}". Available models: ${ids.join(', ') || '(none; every backend is unreachable)'}`, { param: 'model', code: 'model_not_found' });
    }

    // One close listener for the whole request, aimed at whichever upstream
    // attempt is in flight. `close` also fires after a normal finish.
    let abortInflight = null;
    let clientGone = false;
    const onClientClose = () => {
      if (res.writableFinished) return;
      clientGone = true;
      abortInflight?.();
    };
    res.on('close', onClientClose);

    try {
      const tried = new Set();
      let lastUnreachable = null;
      for (let backend = routing.pick(candidates, tried); backend; backend = routing.pick(candidates, tried)) {
        if (clientGone || res.destroyed) return 499;
        tried.add(backend);
        record.backend = backend.name;
        record.attempts += 1;
        routing.attempted(backend);
        // The same bytes on every attempt: the hook is an identity today.
        const body = kind === 'embeddings' ? rewriteEmbeddingsBody(raw, parsed, backend) : raw;
        const outcome = await attempt({
          req,
          res,
          backend,
          upstreamPath,
          body,
          config,
          env,
          onAbort: (abort) => { abortInflight = abort; },
          onRelay: (status) => routing.answered(backend, status),
        });
        if (outcome.kind === 'relayed' || outcome.kind === 'failed') return outcome.status;
        if (clientGone) return 499;

        const until = outcome.kind === 'quota'
          ? routing.limited(backend, outcome)
          : routing.unreachable(backend, outcome.error);
        if (outcome.kind === 'unreachable') lastUnreachable = { error: outcome.error, backend };
        // No upstream text here: the reason is on /health, redacted.
        safeLog({
          event: 'failover',
          at: new Date().toISOString(),
          model: record.model,
          from: backend.name,
          to: routing.pick(candidates, tried)?.name ?? null,
          reason: outcome.kind,
          cooldown_until: new Date(until).toISOString(),
        });
      }

      // pick() only runs dry once every untried candidate is cooling for quota,
      // so a candidate left cooling for `unreachable` was tried and refused in
      // this request: that is a 502 as it always was. all_accounts_limited is
      // for the case where every candidate is out of quota.
      if (lastUnreachable) {
        sendError(res, 502, `backend ${lastUnreachable.backend.name} request failed: ${lastUnreachable.error?.message || lastUnreachable.error}`, { type: 'api_error', code: 'upstream_unavailable' });
        return 502;
      }
      const release = routing.earliestRelease(candidates);
      const retryAfter = Math.max(1, Math.ceil((release - now()) / 1000));
      sendError(
        res,
        429,
        `All accounts for model ${requested} are limited until ${new Date(release).toISOString()}`,
        { type: 'usage_limit_reached', code: 'all_accounts_limited' },
        { 'retry-after': String(retryAfter) },
      );
      return 429;
    } finally {
      res.off('close', onClientClose);
    }
  }

  return async function handler(req, res) {
    const startedAt = Date.now();
    const pathname = new URL(req.url, 'http://router.invalid').pathname;
    const record = { model: null, backend: null, attempts: 0 };
    // `backend` is the last one tried: the one whose answer ended the request.
    const emit = (status) => safeLog({
      event: 'request',
      at: new Date().toISOString(),
      method: req.method,
      path: pathname,
      backend: record.backend,
      model: record.model,
      status,
      attempts: record.attempts,
      duration_ms: Date.now() - startedAt,
    });

    try {
      if (req.method === 'GET' && pathname === '/health') {
        const probes = await Promise.all(config.backends.map(probe));
        return sendJson(res, 200, {
          status: 'ok',
          listen: { host: config.host, port: config.port },
          client_auth: Boolean(secret),
          routing: { mode: config.routing.mode, window_ms: config.routing.windowMs },
          backends: probes.map((entry, index) => ({
            ...entry,
            routing: routing.snapshot(config.backends[index]),
            // Whether the last /models asked of it worked, and if not, its status:
            // a 401 here means the backend does not know this router's key.
            discovery: config.backends[index].discoverModels && registry.discovery
              ? registry.discovery(config.backends[index].name)
              : null,
          })),
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
      routing: config.routing.mode,
      backends: config.backends.map((backend) => ({
        name: backend.name,
        base_url: backend.baseUrl,
        models: backend.models.length,
        discover: backend.discoverModels,
      })),
    }));
  });
}
