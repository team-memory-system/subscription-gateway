import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  createHandler,
  createRegistry,
  createRoutingState,
  lookupCandidates,
  normalizeConfig,
  QUOTA_PATTERN,
  redact,
  rewriteEmbeddingsBody,
} from './server.mjs';

// The default logger writes to stdout and would interleave with the reporter;
// the log-hygiene test injects its own collector instead.
process.env.ROUTER_REQUEST_LOG = '0';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fake backend: records every call (raw bytes included) and lets the test drive
// the response. Nothing here talks to a real proxy or to the network.
async function startBackend(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const call = { method: req.method, url: req.url, headers: req.headers, raw, body: raw.toString('utf8') };
    calls.push(call);
    try {
      await handler(req, res, call);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return { calls, port, baseUrl: `http://127.0.0.1:${port}/v1` };
}

// Answers /v1/models with the given ids and echoes chat/embeddings requests.
function modelsBackend(ids, { requireAuth = null } = {}) {
  return (req, res) => {
    if (requireAuth && req.headers.authorization !== `Bearer ${requireAuth}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'library' })) }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'chat.completion', model: 'echo' }));
  };
}

async function startRouter(t, config, options = {}) {
  const server = http.createServer(createHandler({ config, env: {}, ...options }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${port}`;
}

// A port nothing listens on: the "backend is down" fixture.
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function post(url, body, init = {}) {
  const { headers, ...rest } = init;
  return fetch(url, {
    method: 'POST',
    body,
    ...rest,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
  });
}

test('dispatches by model id and forwards the body byte for byte', async (t) => {
  const codex = await startBackend(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-1', model: 'gpt-6-luna', choices: [] }));
  });
  const claude = await startBackend(t, modelsBackend(['claude-opus-5-5']));
  const url = await startRouter(t, {
    listen: { host: '127.0.0.1', port: 0 },
    backends: [
      { name: 'codex', baseUrl: codex.baseUrl, models: ['gpt-6-luna'] },
      { name: 'claude', baseUrl: claude.baseUrl, discoverModels: true },
    ],
  });

  // Hand-written body: unknown top-level fields, a non-standard
  // reasoning_effort value, and a key order no serializer would reproduce.
  const raw = '{"reasoning_effort":"xhigh","model":"gpt-6-luna","zz_unknown":{"nested":[1,2,null]},"messages":[{"role":"user","content":"hi"}],"stream":false}';
  const response = await post(`${url}/v1/chat/completions`, raw, {
    headers: { authorization: 'Bearer client-token-should-not-travel', 'x-session-id': 'abc-123' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'chatcmpl-1', model: 'gpt-6-luna', choices: [] });
  assert.equal(codex.calls.length, 1);
  assert.equal(claude.calls.filter((call) => call.method === 'POST').length, 0);
  const [call] = codex.calls;
  assert.equal(call.url, '/v1/chat/completions');
  assert.equal(call.method, 'POST');
  assert.equal(call.body, raw, 'upstream must receive the exact bytes the client sent');
  assert.equal(call.headers['content-length'], String(Buffer.byteLength(raw)));
  assert.equal(call.headers['content-type'], 'application/json');
  // Unknown client headers ride along; the client's own bearer token does not.
  assert.equal(call.headers['x-session-id'], 'abc-123');
  assert.equal(call.headers.authorization, undefined);
});

test('routes legacy display suffixes and ollama tags without rewriting the body', async (t) => {
  const claude = await startBackend(t, modelsBackend([]));
  const ollama = await startBackend(t, modelsBackend(['qwen3-embedding-honcho-8192:latest', 'gpt-oss:20b']));
  const url = await startRouter(t, {
    backends: [
      { name: 'claude', baseUrl: claude.baseUrl, models: ['claude-opus-5', 'claude-opus-5-5'], aliases: ['opus'] },
      { name: 'ollama', baseUrl: ollama.baseUrl, discoverModels: true },
    ],
  });

  const legacy = '{"model":"claude-opus-5-5 [low] vision","messages":[]}';
  assert.equal((await post(`${url}/v1/chat/completions`, legacy)).status, 200);
  assert.equal(claude.calls.at(-1).body, legacy, 'the legacy suffix must survive the hop');

  const alias = '{"model":"opus","messages":[]}';
  assert.equal((await post(`${url}/v1/chat/completions`, alias)).status, 200);
  assert.equal(claude.calls.at(-1).body, alias);

  // Clients ask for the untagged name; ollama lists it as `name:latest`.
  const embed = '{"model":"qwen3-embedding-honcho-8192","input":["a","b"]}';
  const response = await post(`${url}/v1/embeddings`, embed);
  assert.equal(response.status, 200);
  const embedCall = ollama.calls.at(-1);
  assert.equal(embedCall.url, '/v1/embeddings');
  assert.equal(embedCall.body, embed);
});

test('an unknown model is a 404 that names the model and the available ids', async (t) => {
  const claude = await startBackend(t, modelsBackend(['claude-opus-5-5']));
  const url = await startRouter(t, {
    backends: [
      { name: 'codex', baseUrl: 'http://127.0.0.1:1/v1', models: ['gpt-6-luna'] },
      { name: 'claude', baseUrl: claude.baseUrl, discoverModels: true, aliases: ['opus'] },
    ],
  });

  const response = await post(`${url}/v1/chat/completions`, '{"model":"gpt-4o","messages":[]}');
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.error.type, 'invalid_request_error');
  assert.equal(payload.error.code, 'model_not_found');
  assert.equal(payload.error.param, 'model');
  assert.match(payload.error.message, /gpt-4o/);
  assert.match(payload.error.message, /gpt-6-luna/);
  assert.match(payload.error.message, /claude-opus-5-5/);
  // Embeddings dispatch reports the same way.
  assert.equal((await post(`${url}/v1/embeddings`, '{"model":"nope","input":"x"}')).status, 404);
});

test('a request without a model is a 400', async (t) => {
  const url = await startRouter(t, {
    backends: [{ name: 'codex', baseUrl: 'http://127.0.0.1:1/v1', models: ['gpt-6-luna'] }],
  });
  const missing = await post(`${url}/v1/chat/completions`, '{"messages":[]}');
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'model_required');
  assert.equal((await post(`${url}/v1/chat/completions`, 'not json')).status, 400);
});

test('/v1/models merges every backend and survives a dead one', async (t) => {
  const claude = await startBackend(t, modelsBackend(['claude-opus-5', 'claude-opus-5-5']));
  const deadPort = await closedPort();
  const url = await startRouter(t, {
    modelsTtlMs: 30000,
    backends: [
      { name: 'codex', baseUrl: 'http://127.0.0.1:1/v1', models: ['gpt-6-luna'] },
      { name: 'claude', baseUrl: claude.baseUrl, discoverModels: true, aliases: ['opus'] },
      { name: 'ollama', baseUrl: `http://127.0.0.1:${deadPort}/v1`, discoverModels: true },
    ],
  });

  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.object, 'list');
  assert.deepEqual(payload.data, [
    { id: 'gpt-6-luna', object: 'model', owned_by: 'codex' },
    { id: 'claude-opus-5', object: 'model', owned_by: 'claude' },
    { id: 'claude-opus-5-5', object: 'model', owned_by: 'claude' },
  ]);
});

test('/health says which backend refused the key on model discovery', async (t) => {
  // An adapter an earlier install left on the port: it answers /health and
  // refuses this router's key, so it lists nothing.
  const stale = await startBackend(t, modelsBackend(['gpt-5.5'], { requireAuth: 'old-install-key' }));
  const good = await startBackend(t, modelsBackend(['claude-opus-5-5']));
  const url = await startRouter(t, {
    backends: [
      { name: 'codex-1', baseUrl: stale.baseUrl, discoverModels: true, apiKeyEnv: 'CODEX_KEY' },
      { name: 'claude-1', baseUrl: good.baseUrl, discoverModels: true },
      { name: 'static', baseUrl: 'http://127.0.0.1:1/v1', models: ['x'] },
    ],
  }, { env: { CODEX_KEY: 'new-install-key' } });

  const before = await (await fetch(`${url}/health`)).json();
  assert.equal(before.backends[0].discovery, null, 'nothing is known before the first listing');

  const listed = await (await fetch(`${url}/v1/models`)).json();
  assert.deepEqual(listed.data.map((entry) => entry.id), ['claude-opus-5-5', 'x']);

  const after = await (await fetch(`${url}/health`)).json();
  const [codex, claude, fixed] = after.backends;
  assert.equal(codex.reachable, true, 'the port answers; only the key is refused');
  assert.deepEqual({ ...codex.discovery, at: null }, { ok: false, status: 401, reason: 'HTTP 401', models: 0, at: null });
  assert.deepEqual({ ...claude.discovery, at: null }, { ok: true, status: 200, reason: null, models: 1, at: null });
  assert.equal(fixed.discovery, null, 'a backend with a static list is not discovered');
  assert.equal(JSON.stringify(after).includes('new-install-key'), false);
});

test('the merged model list is cached', async (t) => {
  const claude = await startBackend(t, modelsBackend(['claude-opus-5-5']));
  const url = await startRouter(t, {
    modelsTtlMs: 60000,
    backends: [{ name: 'claude', baseUrl: claude.baseUrl, discoverModels: true }],
  });
  await fetch(`${url}/v1/models`);
  await fetch(`${url}/v1/models`);
  await post(`${url}/v1/chat/completions`, '{"model":"claude-opus-5-5","messages":[]}');
  assert.equal(claude.calls.filter((call) => call.url === '/v1/models').length, 1);
});

test('streaming responses are piped through as bytes, not re-assembled', async (t) => {
  let firstChunkSeen;
  const clientGotFirstChunk = new Promise((resolve) => { firstChunkSeen = resolve; });
  let firstArrivedBeforeSecond = null;
  const CHUNKS = [
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const codex = await startBackend(t, async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(CHUNKS[0]);
    firstArrivedBeforeSecond = await Promise.race([
      clientGotFirstChunk.then(() => true),
      delay(2000).then(() => false),
    ]);
    res.write(CHUNKS[1]);
    res.write(CHUNKS[2]);
    res.end();
  });
  const url = await startRouter(t, {
    backends: [{ name: 'codex', baseUrl: codex.baseUrl, models: ['gpt-6-luna'] }],
  });

  const response = await post(`${url}/v1/chat/completions`, '{"model":"gpt-6-luna","stream":true,"messages":[]}');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const received = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received.push(decoder.decode(value, { stream: true }));
    firstChunkSeen();
  }
  assert.equal(firstArrivedBeforeSecond, true, 'the first SSE chunk must reach the client before the backend writes the second');
  assert.equal(received.join(''), CHUNKS.join(''));
  assert.ok(received.length >= 2, 'the stream must arrive in pieces, not as one buffered body');
});

test('upstream status codes and error bodies pass through untouched', async (t) => {
  const codex = await startBackend(t, (req, res) => {
    // The codex proxy answers with a bare string error, not the OpenAI shape.
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"error":"No assistant response received from Codex proxy"}\n');
  });
  const url = await startRouter(t, {
    backends: [{ name: 'codex', baseUrl: codex.baseUrl, models: ['gpt-6-luna'] }],
  });
  const response = await post(`${url}/v1/chat/completions`, '{"model":"gpt-6-luna","messages":[]}');
  assert.equal(response.status, 502);
  assert.equal(await response.text(), '{"error":"No assistant response received from Codex proxy"}\n');
});

test('an unreachable backend answers 502 without taking down the router', async (t) => {
  const deadPort = await closedPort();
  const url = await startRouter(t, {
    backends: [{ name: 'codex', baseUrl: `http://127.0.0.1:${deadPort}/v1`, models: ['gpt-6-luna'] }],
  });
  const response = await post(`${url}/v1/chat/completions`, '{"model":"gpt-6-luna","messages":[]}');
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.error.code, 'upstream_unavailable');
  assert.match(payload.error.message, /codex/);
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test('the client bearer token is required only when it is configured', async (t) => {
  const codex = await startBackend(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const config = { backends: [{ name: 'codex', baseUrl: codex.baseUrl, models: ['gpt-6-luna'] }] };
  const body = '{"model":"gpt-6-luna","messages":[]}';

  const open = await startRouter(t, config);
  assert.equal((await post(`${open}/v1/chat/completions`, body)).status, 200);
  assert.equal((await fetch(`${open}/v1/models`)).status, 200);

  const guarded = await startRouter(t, config, { sharedSecret: 'router-secret' });
  const anonymous = await post(`${guarded}/v1/chat/completions`, body);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.type, 'authentication_error');
  assert.equal((await post(`${guarded}/v1/chat/completions`, body, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${guarded}/v1/models`)).status, 401);
  // /health stays public so the service manager can poll it.
  assert.equal((await fetch(`${guarded}/health`)).status, 200);
  assert.equal((await post(`${guarded}/v1/chat/completions`, body, { headers: { authorization: 'Bearer router-secret' } })).status, 200);
});

test('a backend key comes from the environment named in the config and never reaches a log', async (t) => {
  const secret = 'hch-backend-secret-value';
  const claude = await startBackend(t, modelsBackend(['claude-opus-5-5'], { requireAuth: secret }));
  const entries = [];
  const url = await startRouter(t, {
    backends: [{ name: 'claude', baseUrl: claude.baseUrl, discoverModels: true, apiKeyEnv: 'CLAUDE_KEY' }],
  }, {
    env: { CLAUDE_KEY: secret },
    sharedSecret: 'router-secret',
    log: (entry) => entries.push(entry),
  });

  const list = await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer router-secret' } });
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).data, [{ id: 'claude-opus-5-5', object: 'model', owned_by: 'claude' }]);
  const response = await post(`${url}/v1/chat/completions`, '{"model":"claude-opus-5-5","messages":[]}', {
    headers: { authorization: 'Bearer router-secret' },
  });
  assert.equal(response.status, 200);
  // Discovery and the forward both carry the backend key, never the client one.
  assert.deepEqual([...new Set(claude.calls.map((call) => call.headers.authorization))], [`Bearer ${secret}`]);

  const logged = JSON.stringify(entries);
  assert.ok(entries.length > 0);
  assert.equal(logged.includes(secret), false, 'no backend key in the logs');
  assert.equal(logged.includes('router-secret'), false, 'no client key in the logs');
  assert.equal(logged.includes('authorization'), false, 'headers are not logged at all');
  assert.deepEqual(
    Object.keys(entries.at(-1)).sort(),
    ['at', 'attempts', 'backend', 'duration_ms', 'event', 'method', 'model', 'path', 'status'],
  );
});

test('/health stays ok and fast while a backend is down', async (t) => {
  const claude = await startBackend(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
  });
  const deadPort = await closedPort();
  const url = await startRouter(t, {
    probeTimeoutMs: 400,
    backends: [
      { name: 'claude', baseUrl: claude.baseUrl, discoverModels: true },
      { name: 'ollama', baseUrl: `http://127.0.0.1:${deadPort}/v1`, discoverModels: true },
    ],
  });

  const startedAt = Date.now();
  const response = await fetch(`${url}/health`);
  const elapsed = Date.now() - startedAt;
  assert.equal(response.status, 200);
  const payload = await response.json();
  // proxyctl's install check polls with a 1s timeout and requires status ok.
  assert.equal(payload.status, 'ok');
  assert.ok(elapsed < 1000, `health took ${elapsed}ms`);
  assert.equal(payload.client_auth, false);
  assert.deepEqual(payload.backends.map((b) => [b.name, b.reachable]), [['claude', true], ['ollama', false]]);
  assert.equal(claude.calls.at(-1).url, '/health');
});

test('unknown endpoints are OpenAI-shaped 404s', async (t) => {
  const url = await startRouter(t, {
    backends: [{ name: 'codex', baseUrl: 'http://127.0.0.1:1/v1', models: ['gpt-6-luna'] }],
  });
  const response = await fetch(`${url}/v1/nonsense`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'unknown_endpoint');
});

test('the embeddings rewrite hook is an identity function today', () => {
  const raw = Buffer.from('{"model":"m","input":"text"}');
  const out = rewriteEmbeddingsBody(raw, { model: 'm', input: 'text' }, { name: 'ollama' });
  assert.equal(out, raw);
  assert.equal(out.toString('utf8'), '{"model":"m","input":"text"}');
});

test('lookup candidates only ever rewrite the routing key', () => {
  assert.deepEqual(lookupCandidates('claude-opus-5-5 [xhigh] vision'), [
    'claude-opus-5-5 [xhigh] vision',
    'claude-opus-5-5',
    'claude-opus-5-5 [xhigh] vision:latest',
    'claude-opus-5-5:latest',
  ]);
  assert.deepEqual(lookupCandidates('qwen3-embedding-honcho-8192'), [
    'qwen3-embedding-honcho-8192',
    'qwen3-embedding-honcho-8192:latest',
  ]);
  assert.deepEqual(lookupCandidates('gpt-oss:20b'), ['gpt-oss:20b', 'gpt-oss:20b:latest']);
});

test('redact removes bearer tokens, api keys and JWTs', () => {
  assert.equal(redact('Authorization: Bearer abc.def-123'), 'Authorization: [redacted]');
  assert.equal(redact('key hch-1234567890 used'), 'key [redacted] used');
  assert.equal(redact('sk-proj-ABCDEFGHIJ failed'), '[redacted] failed');
  assert.equal(
    redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc'),
    '[redacted]',
  );
  assert.equal(redact('model gpt-6-luna is unknown'), 'model gpt-6-luna is unknown');
});

test('the config rejects inline secrets and other invalid shapes', () => {
  const backend = { name: 'codex', baseUrl: 'http://127.0.0.1:11435/v1', models: ['gpt-6-luna'] };
  assert.throws(
    () => normalizeConfig({ backends: [{ ...backend, apiKey: 'sk-inline' }] }),
    /must not be in the config file/,
  );
  assert.throws(() => normalizeConfig({ backends: [] }), /at least one backend/);
  assert.throws(() => normalizeConfig({ backends: [backend, backend] }), /duplicate backend name/);
  assert.throws(() => normalizeConfig({ backends: [{ name: 'x', baseUrl: 'notaurl', models: ['m'] }] }), /absolute http/);
  assert.throws(() => normalizeConfig({ backends: [{ name: 'x', baseUrl: 'http://127.0.0.1/v1' }] }), /discoverModels/);

  const config = normalizeConfig({ listen: { host: '127.0.0.1', port: 11400 }, backends: [backend] }, {});
  assert.equal(config.port, 11400);
  assert.equal(config.clientAuthEnv, 'ROUTER_PROXY_SHARED_SECRET');
  // proxyctl injects HOST/PORT into the LaunchAgent environment; env wins.
  assert.equal(normalizeConfig({ listen: { port: 11400 }, backends: [backend] }, { PORT: '11500' }).port, 11500);
  // An env var that is set but empty must not erase the configured value.
  assert.equal(normalizeConfig({ listen: { port: 11400 }, backends: [backend] }, { PORT: '' }).port, 11400);
  assert.equal(normalizeConfig({ upstreamTimeoutMs: 60000, backends: [backend] }, { ROUTER_UPSTREAM_TIMEOUT_MS: '' }).upstreamTimeoutMs, 60000);
});

test('a non-loopback listen host requires the client token', () => {
  const config = { listen: { host: '0.0.0.0', port: 11400 }, backends: [{ name: 'codex', baseUrl: 'http://127.0.0.1:11435/v1', models: ['gpt-6-luna'] }] };
  assert.throws(() => createHandler({ config, env: {} }), /ROUTER_PROXY_SHARED_SECRET is required/);
  assert.doesNotThrow(() => createHandler({ config, env: {}, sharedSecret: 'set' }));
});

// ---------------------------------------------------------------------------
// Account routing: several backends serving one model
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();
// The request log line is written after the response finishes; give it a tick.
const settle = () => delay(20);

function fakeClock(start = Date.UTC(2026, 8, 29, 0, 0, 0)) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; };
  return now;
}

const answerOk = (name) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: `chatcmpl-${name}`, object: 'chat.completion', model: 'gpt-6-luna', choices: [] }));
};

// The adapter contract: 429 usage_limit_reached before any body byte.
const answerLimited = ({ retryAfter, message = 'You have hit your usage limit.' } = {}) => (req, res) => {
  const headers = { 'content-type': 'application/json' };
  if (retryAfter != null) headers['retry-after'] = String(retryAfter);
  res.writeHead(429, headers);
  res.end(JSON.stringify({ error: { message, type: 'usage_limit_reached', code: 'usage_limit_reached' } }));
};

const answerStatus = (status, body, contentType = 'application/json') => (req, res) => {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
};

// A fake OpenAI-shaped account whose answer the test swaps via `respond`
// (null means healthy).
async function startAccount(t, name) {
  const account = { name, respond: null };
  const backend = await startBackend(t, (req, res, call) => (account.respond || answerOk(name))(req, res, call));
  return Object.assign(account, backend);
}

function accountsConfig(accounts, routing) {
  return {
    ...(routing ? { routing } : {}),
    backends: accounts.map((account) => ({ name: account.name, baseUrl: account.baseUrl, models: ['gpt-6-luna'] })),
  };
}

async function startAccountsRouter(t, accounts, { routing, clock = fakeClock() } = {}) {
  const entries = [];
  const url = await startRouter(t, accountsConfig(accounts, routing), { now: clock, log: (entry) => entries.push(entry) });
  const chat = (body = '{"model":"gpt-6-luna","messages":[]}') => post(`${url}/v1/chat/completions`, body);
  const failovers = () => entries.filter((entry) => entry.event === 'failover');
  const lastRequest = () => entries.filter((entry) => entry.event === 'request').at(-1);
  const health = async () => (await fetch(`${url}/health`)).json();
  return { url, clock, entries, chat, failovers, lastRequest, health };
}

test('candidates() lists every backend serving a model, static or discovered, in config order', async () => {
  const config = normalizeConfig({
    backends: [
      { name: 'codex-1', baseUrl: 'http://127.0.0.1:1/v1', models: ['gpt-6-luna'], aliases: ['gpt-6-luna:latest'] },
      { name: 'claude', baseUrl: 'http://127.0.0.1:2/v1', models: ['claude-opus-5-5'] },
      { name: 'codex-2', baseUrl: 'http://127.0.0.1:3/v1', discoverModels: true },
    ],
  }, {});
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-6-luna:latest' }] }) });
  const registry = createRegistry(config, { fetchImpl, env: {} });
  const names = async (model) => (await registry.candidates(model)).map((backend) => backend.name);

  assert.deepEqual(await names('gpt-6-luna'), ['codex-1', 'codex-2'], 'static and discovered, each once, config order');
  assert.deepEqual(await names('gpt-6-luna [low] vision'), ['codex-1', 'codex-2'], 'same lookup rules as dispatch');
  assert.deepEqual(await names('claude-opus-5-5'), ['claude']);
  assert.deepEqual(await names('gpt-4o'), []);
  assert.equal((await registry.resolve('gpt-6-luna')).name, 'codex-1', 'resolve() is the first candidate');
  assert.equal(await registry.resolve('gpt-4o'), null);
});

test('drain: a usage-limited account hands the same bytes to the next one, then cools down', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  first.respond = answerLimited();
  const router = await startAccountsRouter(t, [first, second]);
  const start = router.clock();

  const raw = '{"reasoning_effort":"xhigh","model":"gpt-6-luna","zz_unknown":[1,null],"messages":[{"role":"user","content":"hi"}],"stream":false}';
  const response = await router.chat(raw);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'chatcmpl-codex-2');
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assert.equal(first.calls[0].body, raw);
  assert.ok(second.calls[0].raw.equals(first.calls[0].raw), 'every attempt carries identical body bytes');
  assert.equal(second.calls[0].headers['content-length'], String(Buffer.byteLength(raw)));

  await settle();
  assert.deepEqual(router.failovers().map(({ at, ...entry }) => entry), [{
    event: 'failover',
    model: 'gpt-6-luna',
    from: 'codex-1',
    to: 'codex-2',
    reason: 'quota',
    cooldown_until: iso(start + 15 * MINUTE),
  }]);
  assert.equal(router.lastRequest().backend, 'codex-2');
  assert.equal(router.lastRequest().attempts, 2);
  assert.equal(router.lastRequest().status, 200);
  assert.equal(JSON.stringify(router.entries).includes('usage limit'), false, 'upstream text never reaches a log line');

  // codex-1 is healthy again but still cooling: the next request skips it.
  first.respond = null;
  assert.equal((await router.chat()).status, 200);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 2);
  await settle();
  assert.equal(router.lastRequest().attempts, 1);

  router.clock.advance(15 * MINUTE - 1000);
  await router.chat();
  assert.equal(first.calls.length, 1, 'still cooling one second before the end');
  router.clock.advance(1000);
  const back = await router.chat();
  assert.equal((await back.json()).id, 'chatcmpl-codex-1', 'drain returns to the first account once it cools');
  assert.equal(first.calls.length, 2);
  assert.equal(second.calls.length, 3);
});

test('a failover after a 429 can still stream from the next account', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  first.respond = answerLimited();
  second.respond = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  };
  const router = await startAccountsRouter(t, [first, second]);
  const response = await router.chat('{"model":"gpt-6-luna","stream":true,"messages":[]}');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(await response.text(), 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n');
});

test('the cooldown follows retry-after, then the "Try again in ~N min" text', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  const router = await startAccountsRouter(t, [first, second]);
  const start = router.clock();

  first.respond = answerLimited({ retryAfter: 120 });
  assert.equal((await router.chat()).status, 200);
  await settle();
  assert.equal(router.failovers().at(-1).cooldown_until, iso(start + 120 * 1000));
  router.clock.advance(119 * 1000);
  await router.chat();
  assert.equal(first.calls.length, 1, 'retry-after 120 still holds at 119s');

  router.clock.advance(1000);
  first.respond = answerLimited({ message: 'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.' });
  assert.equal((await router.chat()).status, 200);
  assert.equal(first.calls.length, 2);
  await settle();
  assert.equal(router.failovers().at(-1).cooldown_until, iso(router.clock() + 42 * MINUTE));
  assert.equal(router.failovers().length, 2);
});

test('without a hint the cooldown doubles up to maxCooldownMs, and a 2xx resets it', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  const routing = { defaultCooldownMs: MINUTE, maxCooldownMs: 3 * MINUTE };
  const router = await startAccountsRouter(t, [first, second], { routing });
  first.respond = answerStatus(429, '{"error":{"message":"slow down"}}');

  const cooldowns = [];
  for (let i = 0; i < 3; i += 1) {
    await router.chat();
    await settle();
    const until = Date.parse(router.failovers().at(-1).cooldown_until);
    cooldowns.push(until - router.clock());
    router.clock.advance(until - router.clock());
  }
  assert.deepEqual(cooldowns, [MINUTE, 2 * MINUTE, 3 * MINUTE], '1m, 2m, then capped at 3m');

  // A hint longer than the cap is capped too.
  first.respond = answerLimited({ retryAfter: 24 * 60 * 60 });
  await router.chat();
  await settle();
  assert.equal(Date.parse(router.failovers().at(-1).cooldown_until) - router.clock(), 3 * MINUTE);

  router.clock.advance(3 * MINUTE);
  first.respond = null;
  assert.equal((await (await router.chat()).json()).id, 'chatcmpl-codex-1');
  assert.equal((await router.health()).backends[0].routing.consecutive_limits, 0);
});

test('a legacy 502 carrying usage-limit text fails over and honours the reset epoch', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  const router = await startAccountsRouter(t, [first, second]);
  const epoch = Math.floor(router.clock() / 1000) + 2 * 60 * 60;
  first.respond = answerStatus(502, `{"error":"Claude AI usage limit reached|${epoch}"}`);

  const response = await router.chat();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'chatcmpl-codex-2');
  await settle();
  assert.equal(router.failovers().at(-1).reason, 'quota');
  assert.equal(router.failovers().at(-1).cooldown_until, iso(epoch * 1000));
});

test('a generic 500 is relayed as it is and does not fail over', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  const router = await startAccountsRouter(t, [first, second]);
  const small = '{"error":{"message":"internal boom","type":"api_error"}}\n';
  first.respond = answerStatus(500, small);

  const response = await router.chat();
  assert.equal(response.status, 500);
  assert.equal(await response.text(), small);
  assert.equal(second.calls.length, 0);
  await settle();
  assert.equal(router.failovers().length, 0);
  assert.equal(router.lastRequest().attempts, 1);
  assert.equal(router.lastRequest().backend, 'codex-1');

  // A body past the 64 KB inspection cap is still relayed byte for byte.
  const large = `{"error":"${'x'.repeat(100 * 1024)}"}`;
  first.respond = answerStatus(500, large);
  const big = await router.chat();
  assert.equal(big.status, 500);
  assert.equal(await big.text(), large);

  assert.equal(first.calls.length, 2, 'no cooldown after a generic failure');
  assert.equal(second.calls.length, 0);
  assert.equal((await router.health()).backends[0].routing.cooldown_until, null);
});

test('a closed port fails over with the short unreachable cooldown', async (t) => {
  const deadPort = await closedPort();
  const dead = { name: 'codex-1', baseUrl: `http://127.0.0.1:${deadPort}/v1` };
  const second = await startAccount(t, 'codex-2');
  const router = await startAccountsRouter(t, [dead, second]);

  const response = await router.chat();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'chatcmpl-codex-2');
  await settle();
  assert.deepEqual(router.failovers().map(({ at, ...entry }) => entry), [{
    event: 'failover',
    model: 'gpt-6-luna',
    from: 'codex-1',
    to: 'codex-2',
    reason: 'unreachable',
    cooldown_until: iso(router.clock() + 30 * 1000),
  }]);
  assert.equal(router.lastRequest().attempts, 2);

  router.clock.advance(30 * 1000 - 1);
  await router.chat();
  await settle();
  assert.equal(router.lastRequest().attempts, 1, 'the dead port is skipped while cooling');
  router.clock.advance(1);
  await router.chat();
  await settle();
  assert.equal(router.lastRequest().attempts, 2, 'and retried once the 30s pass');
});

test('when the last account is unreachable the answer is the usual 502', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const deadPort = await closedPort();
  const dead = { name: 'codex-2', baseUrl: `http://127.0.0.1:${deadPort}/v1` };
  first.respond = answerLimited();
  const router = await startAccountsRouter(t, [first, dead]);
  const response = await router.chat();
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.error.code, 'upstream_unavailable');
  assert.match(payload.error.message, /codex-2/);
});

test('when every account is limited the router answers 429 all_accounts_limited with retry-after', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  first.respond = answerLimited({ retryAfter: 300 });
  second.respond = answerLimited({ retryAfter: 60 });
  const router = await startAccountsRouter(t, [first, second]);
  const start = router.clock();

  const response = await router.chat();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(await response.json(), {
    error: {
      message: `All accounts for model gpt-6-luna are limited until ${iso(start + 60 * 1000)}`,
      type: 'usage_limit_reached',
      param: null,
      code: 'all_accounts_limited',
    },
  });
  await settle();
  assert.deepEqual(router.failovers().map((entry) => [entry.from, entry.to]), [['codex-1', 'codex-2'], ['codex-2', null]]);
  assert.equal(router.lastRequest().attempts, 2);
  assert.equal(router.lastRequest().status, 429);

  // While both cool, nothing goes upstream at all.
  router.clock.advance(30 * 1000);
  const again = await router.chat();
  assert.equal(again.status, 429);
  assert.equal(again.headers.get('retry-after'), '30');
  assert.equal((await again.json()).error.code, 'all_accounts_limited');
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  await settle();
  assert.equal(router.lastRequest().attempts, 0);
  assert.equal(router.lastRequest().backend, null);
});

test('balance: requests alternate across healthy accounts', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  const router = await startAccountsRouter(t, [first, second], { routing: { mode: 'balance' } });

  const served = [];
  for (let i = 0; i < 4; i += 1) {
    served.push((await (await router.chat()).json()).id);
    router.clock.advance(1000);
  }
  assert.deepEqual(served, ['chatcmpl-codex-1', 'chatcmpl-codex-2', 'chatcmpl-codex-1', 'chatcmpl-codex-2']);
  assert.equal(first.calls.length, 2);
  assert.equal(second.calls.length, 2);

  // A limited account drops out of the rotation; the other takes everything.
  first.respond = answerLimited({ retryAfter: 600 });
  for (let i = 0; i < 3; i += 1) assert.equal((await router.chat()).status, 200);
  assert.equal(first.calls.length, 3);
  assert.equal(second.calls.length, 5);
});

test('/health shows the routing state per backend', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  const router = await startAccountsRouter(t, [first, second]);
  const start = router.clock();
  first.respond = answerLimited({
    retryAfter: 600,
    message: `You have hit your usage limit. key sk-proj-ABCDEFGHIJKLMNOP ${'x'.repeat(400)}`,
  });
  await router.chat();

  const payload = await router.health();
  assert.equal(payload.status, 'ok');
  assert.deepEqual(payload.routing, { mode: 'drain', window_ms: 5 * HOUR });
  const [one, two] = payload.backends;
  assert.equal(one.name, 'codex-1');
  assert.equal(one.reachable, true);
  const reason = one.routing.last_limit_reason;
  assert.deepEqual({ ...one.routing, last_limit_reason: null }, {
    cooldown_until: iso(start + 600 * 1000),
    consecutive_limits: 1,
    requests_in_window: 1,
    last_used_at: iso(start),
    last_limit_reason: null,
  });
  assert.match(reason, /^HTTP 429: You have hit your usage limit\. key \[redacted\] x+$/);
  assert.ok(reason.length <= 200, `reason is ${reason.length} chars`);
  assert.equal(reason.includes('sk-proj'), false);
  assert.deepEqual(two.routing, {
    cooldown_until: null,
    consecutive_limits: 0,
    requests_in_window: 1,
    last_used_at: iso(start),
    last_limit_reason: null,
  });

  router.clock.advance(5 * HOUR);
  const later = await router.health();
  assert.equal(later.backends[0].routing.cooldown_until, null, 'the cooldown has passed');
  assert.equal(later.backends[0].routing.requests_in_window, 0, 'the window has slid past the old requests');
  assert.equal(later.backends[0].routing.consecutive_limits, 1, 'only a 2xx resets the count');
});

test('routing config: defaults, env override, and an unknown mode is rejected', () => {
  const backends = [{ name: 'codex-1', baseUrl: 'http://127.0.0.1:11435/v1', models: ['gpt-6-luna'] }];
  assert.deepEqual(normalizeConfig({ backends }, {}).routing, {
    mode: 'drain',
    windowMs: 5 * HOUR,
    defaultCooldownMs: 15 * MINUTE,
    maxCooldownMs: 6 * HOUR,
    unreachableCooldownMs: 30 * 1000,
  });
  assert.equal(normalizeConfig({ routing: { mode: 'balance' }, backends }, {}).routing.mode, 'balance');
  assert.equal(normalizeConfig({ routing: { mode: 'drain' }, backends }, { ROUTER_ROUTING_MODE: 'balance' }).routing.mode, 'balance');
  assert.equal(normalizeConfig({ routing: { mode: 'balance' }, backends }, { ROUTER_ROUTING_MODE: '' }).routing.mode, 'balance');
  assert.throws(
    () => normalizeConfig({ routing: { mode: 'round-robin' }, backends }, {}),
    /routing\.mode must be one of "drain", "balance"; got "round-robin"/,
  );
  assert.throws(() => normalizeConfig({ backends }, { ROUTER_ROUTING_MODE: 'fastest' }), /routing\.mode must be one of/);
  assert.throws(() => normalizeConfig({ routing: 'balance', backends }, {}), /config\.routing must be an object/);
  assert.throws(() => createHandler({ config: { routing: { mode: 'random' }, backends }, env: {} }), /routing\.mode/);
});

test('a client that hangs up aborts the in-flight upstream and does not fail over', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  let received;
  const arrived = new Promise((resolve) => { received = resolve; });
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  first.respond = (req, res) => {
    res.on('close', upstreamClosed);
    received();
    // Never answers: a CLI still working.
  };
  const router = await startAccountsRouter(t, [first, second]);
  const controller = new AbortController();
  const pending = post(`${router.url}/v1/chat/completions`, '{"model":"gpt-6-luna","messages":[]}', { signal: controller.signal });
  await arrived;
  controller.abort();
  await assert.rejects(pending);
  await Promise.race([closed, delay(2000).then(() => { throw new Error('upstream was not aborted'); })]);
  await settle();
  assert.equal(router.lastRequest().status, 499);
  assert.equal(router.lastRequest().attempts, 1);
  assert.equal(second.calls.length, 0);
  assert.equal(router.failovers().length, 0);
});

// The backend drops the connection without answering.
const hangUp = (req) => { req.socket.destroy(); };

test('a single backend on a closed port answers 502 on every request, not 429', async (t) => {
  const deadPort = await closedPort();
  const dead = { name: 'codex', baseUrl: `http://127.0.0.1:${deadPort}/v1` };
  const router = await startAccountsRouter(t, [dead]);
  for (let i = 0; i < 2; i += 1) {
    const response = await router.chat();
    assert.equal(response.status, 502, `request ${i + 1}`);
    assert.equal(response.headers.get('retry-after'), null);
    assert.equal((await response.json()).error.code, 'upstream_unavailable');
    await settle();
    assert.equal(router.lastRequest().attempts, 1, 'the cooling backend is still tried');
  }
});

test('with one account out of quota and one unreachable, the unreachable one is tried', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  first.respond = answerLimited({ retryAfter: 600 });
  second.respond = hangUp;
  const router = await startAccountsRouter(t, [first, second]);

  const response = await router.chat();
  assert.equal(response.status, 502, 'not all_accounts_limited: one account is only unreachable');
  assert.equal((await response.json()).error.code, 'upstream_unavailable');
  await settle();
  assert.deepEqual(router.failovers().map((entry) => [entry.from, entry.reason]), [['codex-1', 'quota'], ['codex-2', 'unreachable']]);
  const cooling = await router.health();
  assert.ok(cooling.backends.every((backend) => backend.routing.cooldown_until !== null), 'both are cooling now');

  // codex-2 comes back inside its 30s cooldown: it is tried and answers.
  second.respond = null;
  router.clock.advance(5 * 1000);
  const back = await router.chat();
  assert.equal(back.status, 200);
  assert.equal((await back.json()).id, 'chatcmpl-codex-2');
  assert.equal(first.calls.filter((call) => call.method === 'POST').length, 1, 'the quota-cooled account is left alone');
  await settle();
  assert.equal(router.lastRequest().attempts, 1);
  assert.equal((await router.health()).backends[1].routing.cooldown_until, null, 'an answer clears an unreachable cooldown');
});

test('while everything cools, unreachable accounts are tried earliest release first', () => {
  const config = normalizeConfig({
    backends: ['x', 'y', 'z'].map((name) => ({ name, baseUrl: 'http://127.0.0.1:1/v1', models: ['m'] })),
  }, {});
  const [x, y, z] = config.backends;
  const clock = fakeClock();
  const routing = createRoutingState(config, { now: clock });
  routing.limited(x, { status: 429, headers: { 'retry-after': '600' }, text: '' });
  clock.advance(1000);
  routing.unreachable(z, { code: 'ECONNREFUSED' });
  clock.advance(1000);
  routing.unreachable(y, { code: 'ECONNREFUSED' });
  assert.equal(routing.pick(config.backends), z, 'z releases first although it is last in config order');
  assert.equal(routing.pick(config.backends, new Set([z])), y);
  assert.equal(routing.pick(config.backends, new Set([y, z])), null, 'a quota cooldown is never tried early');
});

test('a 4xx other than 429 is relayed and never fails over, whatever its text says', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  const body = '{"error":{"message":"Request exceeds the rate limit for context length; limit reached","type":"invalid_request_error"}}';
  first.respond = answerStatus(400, body);
  const router = await startAccountsRouter(t, [first, second]);

  const response = await router.chat();
  assert.equal(response.status, 400);
  assert.equal(await response.text(), body);
  assert.equal(second.calls.length, 0);
  await settle();
  assert.equal(router.failovers().length, 0);
  assert.equal((await router.health()).backends[0].routing.cooldown_until, null);
});

test('a 500 carrying usage-limit text still fails over', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  first.respond = answerStatus(500, 'Claude AI usage limit reached', 'text/plain');
  const router = await startAccountsRouter(t, [first, second]);

  const response = await router.chat();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'chatcmpl-codex-2');
  await settle();
  assert.equal(router.failovers().at(-1).reason, 'quota');
  assert.equal(router.failovers().at(-1).cooldown_until, iso(router.clock() + 15 * MINUTE));
});

// The router's keep-alive agent reuses the connection of the first request; the
// backend resets the second request that arrives on it, as a backend does when
// it closes an idle socket just as the router picks it from the pool.
async function startStaleSocketAccount(t, name, { resetFreshToo = false } = {}) {
  const connections = new Set();
  let first = true;
  const account = await startAccount(t, name);
  account.connections = connections;
  account.respond = (req, res) => {
    connections.add(req.socket);
    req.socket.served = (req.socket.served || 0) + 1;
    if (first) {
      first = false;
      answerOk(name)(req, res);
      return;
    }
    if (req.socket.served > 1 || resetFreshToo) {
      req.socket.destroy();
      return;
    }
    answerOk(name)(req, res);
  };
  return account;
}

test('ECONNRESET on a reused keep-alive socket is retried once on a fresh connection', async (t) => {
  const first = await startStaleSocketAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  const router = await startAccountsRouter(t, [first, second]);

  assert.equal((await router.chat()).status, 200);
  const raw = '{"model":"gpt-6-luna","messages":[{"role":"user","content":"again"}]}';
  const response = await router.chat(raw);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'chatcmpl-codex-1', 'the same account answers on the retry');

  assert.equal(first.calls.length, 3, 'first request, the reset one, and the retry');
  assert.equal(first.calls[0].headers.connection, 'keep-alive', 'the router pools upstream connections');
  assert.equal(first.connections.size, 2, 'the retry used a new connection');
  assert.equal(first.calls[1].body, raw);
  assert.ok(first.calls[2].raw.equals(first.calls[1].raw), 'the retry carries the same bytes');
  assert.equal(second.calls.length, 0);
  await settle();
  assert.equal(router.failovers().length, 0);
  assert.equal(router.lastRequest().attempts, 1, 'the retry is part of the same attempt');
  assert.equal((await router.health()).backends[0].routing.cooldown_until, null);
});

test('when the fresh-connection retry resets too, the account is unreachable', async (t) => {
  const first = await startStaleSocketAccount(t, 'codex-1', { resetFreshToo: true });
  const second = await startAccount(t, 'codex-2');
  const router = await startAccountsRouter(t, [first, second]);

  assert.equal((await router.chat()).status, 200);
  const response = await router.chat();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'chatcmpl-codex-2');
  assert.equal(first.calls.length, 3, 'one retry, not more');
  assert.equal(first.connections.size, 2);
  await settle();
  assert.deepEqual(router.failovers().map((entry) => [entry.from, entry.to, entry.reason]), [['codex-1', 'codex-2', 'unreachable']]);
  assert.equal(router.failovers()[0].cooldown_until, iso(router.clock() + 30 * 1000));
});

test('a 500 saying "Context limit reached" is relayed and does not fail over', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  first.respond = answerStatus(500, 'Context limit reached', 'text/plain');
  const router = await startAccountsRouter(t, [first, second]);

  const response = await router.chat();
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Context limit reached');
  assert.equal(second.calls.length, 0);
  await settle();
  assert.equal(router.failovers().length, 0);
  assert.equal((await router.health()).backends[0].routing.cooldown_until, null);
});

test('a 500 saying "You\'ve hit your session limit" fails over', async (t) => {
  const first = await startAccount(t, 'codex-1');
  const second = await startAccount(t, 'codex-2');
  first.respond = answerStatus(500, "You've hit your session limit · resets 5pm", 'text/plain; charset=utf-8');
  const router = await startAccountsRouter(t, [first, second]);

  const response = await router.chat();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'chatcmpl-codex-2');
  await settle();
  assert.deepEqual(router.failovers().map((entry) => [entry.from, entry.to, entry.reason]), [['codex-1', 'codex-2', 'quota']]);
});

test('the quota pattern matches account limits and not prompt-size limits', () => {
  for (const text of [
    "You've hit your session limit · resets 5pm (Asia/Seoul)",
    'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.',
    'Weekly limit reached',
    '5-hour limit reached',
    'Claude AI usage limit reached|1759999999',
  ]) assert.match(text, QUOTA_PATTERN);
  for (const text of ['Context limit reached', 'output token limit reached', 'limit reached']) {
    assert.doesNotMatch(text, QUOTA_PATTERN);
  }
});
