import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  createHandler,
  lookupCandidates,
  normalizeConfig,
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
    ['at', 'backend', 'duration_ms', 'event', 'method', 'model', 'path', 'status'],
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
