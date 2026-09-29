import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CodexAuthManager,
  classifyUpstreamError,
  createModelLister,
  fetchAccountModels,
  handleChatCompletions,
  resolveReasoningEffort,
} from './server.mjs';

test('Astra defaults only image requests to low and honors explicit effort', () => {
  const imageRequest = { messages: [{ role: 'user', content: [
    { type: 'text', text: 'Read the image' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ] }] };
  assert.equal(resolveReasoningEffort('gpt-6-astra', imageRequest), 'low');
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    assert.equal(resolveReasoningEffort('gpt-6-astra', {
      ...imageRequest, reasoning_effort: effort,
    }), effort);
  }
  assert.equal(resolveReasoningEffort('gpt-5.5', imageRequest), undefined);
  assert.equal(resolveReasoningEffort('gpt-6-astra', {
    messages: [{ role: 'user', content: 'Summarize this text' }],
  }), undefined);
  assert.equal(resolveReasoningEffort('gpt-6-astra', {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'image_url' }] }],
  }), undefined);
});

async function authFixture(t, tokens = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authPath = path.join(root, 'auth.json');
  await fs.writeFile(authPath, `${JSON.stringify({
    tokens: {
      access_token: tokens.access || 'old-access',
      refresh_token: tokens.refresh || 'old-refresh',
      account_id: 'account-1',
    },
  }, null, 2)}\n`);
  return { root, authPath };
}

function refreshed(access = 'new-access', refresh = 'new-refresh') {
  return {
    apiKey: access,
    newCredentials: {
      access,
      refresh,
      expires: Date.now() + 3_600_000,
      accountId: 'account-1',
    },
  };
}

test('concurrent access requests share one OAuth operation', async (t) => {
  const { authPath } = await authFixture(t);
  let calls = 0;
  const manager = new CodexAuthManager(authPath, {
    getOAuth: async () => {
      calls += 1;
      await Promise.resolve();
      return {
        apiKey: 'old-access',
        newCredentials: {
          access: 'old-access',
          refresh: 'old-refresh',
          expires: Date.now() + 3_600_000,
          accountId: 'account-1',
        },
      };
    },
  });
  const values = await Promise.all(Array.from({ length: 50 }, () => manager.getAccessToken()));
  assert.deepEqual(new Set(values), new Set(['old-access']));
  assert.equal(calls, 1);
});

test('an external auth writer wins refresh-token rotation without being overwritten', async (t) => {
  const { authPath } = await authFixture(t);
  const manager = new CodexAuthManager(authPath, {
    getOAuth: async () => {
      await fs.writeFile(authPath, `${JSON.stringify({
        tokens: {
          access_token: 'winner-access',
          refresh_token: 'winner-refresh',
          account_id: 'account-1',
        },
      })}\n`);
      return refreshed('loser-access', 'loser-refresh');
    },
  });
  assert.equal(await manager.getAccessToken(), 'winner-access');
  const saved = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'winner-refresh');
});

test('transient Windows rename failures retry and clean temporary auth files', async (t) => {
  const { root, authPath } = await authFixture(t);
  let renameAttempts = 0;
  const fileSystem = {
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rm: (...args) => fs.rm(...args),
    link: (...args) => fs.link(...args),
    rename: async (...args) => {
      renameAttempts += 1;
      if (renameAttempts < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return fs.rename(...args);
    },
  };
  const manager = new CodexAuthManager(authPath, {
    fileSystem,
    getOAuth: async () => refreshed(),
    sleep: async () => {},
  });
  assert.equal(await manager.getAccessToken(), 'new-access');
  assert.equal(renameAttempts, 3);
  const saved = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'new-refresh');
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.tmp-')), []);
});

test('an ENOENT reservation race yields to the external winner without artifacts', async (t) => {
  const { root, authPath } = await authFixture(t);
  let injected = false;
  const fileSystem = {
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rm: (...args) => fs.rm(...args),
    link: (...args) => fs.link(...args),
    copyFile: (...args) => fs.copyFile(...args),
    rename: async (source, destination) => {
      if (!injected && source === authPath && destination.includes('.parked-')) {
        injected = true;
        const otherParked = `${authPath}.other-publisher`;
        await fs.rename(authPath, otherParked);
        await fs.writeFile(authPath, `${JSON.stringify({
          tokens: {
            access_token: 'winner-access',
            refresh_token: 'winner-refresh',
            account_id: 'account-1',
          },
        })}\n`);
        await fs.rm(otherParked, { force: true });
        throw Object.assign(new Error('canonical path was reserved elsewhere'), { code: 'ENOENT' });
      }
      return fs.rename(source, destination);
    },
  };
  const manager = new CodexAuthManager(authPath, {
    fileSystem,
    getOAuth: async () => refreshed('loser-access', 'loser-refresh'),
  });
  assert.equal(await manager.getAccessToken(), 'winner-access');
  const saved = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'winner-refresh');
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.includes('.tmp-') || name.includes('.parked-')),
    [],
  );
});

test('persistent reservation failure retains the rotated credential and reports its path', async (t) => {
  const { root, authPath } = await authFixture(t);
  const fileSystem = {
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rm: (...args) => fs.rm(...args),
    link: (...args) => fs.link(...args),
    rename: async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); },
  };
  const manager = new CodexAuthManager(authPath, {
    fileSystem,
    getOAuth: async () => refreshed(),
    sleep: async () => {},
  });
  let failure;
  try {
    await manager.getAccessToken();
    assert.fail('expected auth publication to fail');
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /locked/);
  const saved = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'old-refresh');
  const retained = (await fs.readdir(root)).filter((name) => name.includes('.tmp-'));
  assert.equal(retained.length, 1);
  assert.match(failure.message, new RegExp(retained[0]));
  const candidate = JSON.parse(await fs.readFile(path.join(root, retained[0]), 'utf8'));
  assert.equal(candidate.tokens.refresh_token, 'new-refresh');
});

test('an external writer appearing immediately after reservation wins publication', async (t) => {
  const { root, authPath } = await authFixture(t);
  let injected = false;
  const fileSystem = {
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rm: (...args) => fs.rm(...args),
    link: (...args) => fs.link(...args),
    rename: async (source, destination) => {
      await fs.rename(source, destination);
      if (!injected && source === authPath && destination.includes('.parked-')) {
        injected = true;
        await fs.writeFile(authPath, `${JSON.stringify({
          tokens: {
            access_token: 'winner-access',
            refresh_token: 'winner-refresh',
            account_id: 'account-1',
          },
        })}\n`);
      }
    },
  };
  const manager = new CodexAuthManager(authPath, {
    fileSystem,
    getOAuth: async () => refreshed('loser-access', 'loser-refresh'),
  });
  assert.equal(await manager.getAccessToken(), 'winner-access');
  const saved = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'winner-refresh');
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.includes('.tmp-') || name.includes('.parked-')),
    [],
  );
});

test('exclusive-copy fallback publishes after a hard-link failure', async (t) => {
  const { root, authPath } = await authFixture(t);
  let linkCalls = 0;
  const fileSystem = {
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rm: (...args) => fs.rm(...args),
    rename: (...args) => fs.rename(...args),
    copyFile: (...args) => fs.copyFile(...args),
    link: async () => {
      linkCalls += 1;
      throw Object.assign(new Error('link failed'), { code: 'EIO' });
    },
  };
  const manager = new CodexAuthManager(authPath, {
    fileSystem,
    getOAuth: async () => refreshed(),
  });
  assert.equal(await manager.getAccessToken(), 'new-access');
  const saved = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(saved.tokens.refresh_token, 'new-refresh');
  assert.equal(linkCalls, 1);
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) => name.includes('.tmp-') || name.includes('.parked-')),
    [],
  );
});

test('uncertain publication failure retains the rotated candidate after restoring canonical auth', async (t) => {
  const { root, authPath } = await authFixture(t);
  let linkCalls = 0;
  const fileSystem = {
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rm: (...args) => fs.rm(...args),
    rename: (...args) => fs.rename(...args),
    link: async (...args) => {
      linkCalls += 1;
      if (linkCalls === 1) throw Object.assign(new Error('candidate link failed'), { code: 'EIO' });
      return fs.link(...args);
    },
    copyFile: async () => { throw Object.assign(new Error('candidate copy failed'), { code: 'EIO' }); },
  };
  const manager = new CodexAuthManager(authPath, {
    fileSystem,
    getOAuth: async () => refreshed(),
  });
  let failure;
  try {
    await manager.getAccessToken();
    assert.fail('expected auth publication to fail');
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /candidate link failed/);
  const canonical = JSON.parse(await fs.readFile(authPath, 'utf8'));
  assert.equal(canonical.tokens.refresh_token, 'old-refresh');
  const artifacts = (await fs.readdir(root)).filter((name) => name.includes('.tmp-') || name.includes('.parked-'));
  assert.equal(artifacts.filter((name) => name.includes('.parked-')).length, 0);
  const retained = artifacts.filter((name) => name.includes('.tmp-'));
  assert.equal(retained.length, 1);
  assert.match(failure.message, new RegExp(retained[0]));
  const candidate = JSON.parse(await fs.readFile(path.join(root, retained[0]), 'utf8'));
  assert.equal(candidate.tokens.refresh_token, 'new-refresh');
});

test('malformed external path retains both candidate and parked credentials', async (t) => {
  const { root, authPath } = await authFixture(t);
  let injected = false;
  const fileSystem = {
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rm: (...args) => fs.rm(...args),
    link: (...args) => fs.link(...args),
    copyFile: (...args) => fs.copyFile(...args),
    rename: async (source, destination) => {
      await fs.rename(source, destination);
      if (!injected && source === authPath && destination.includes('.parked-')) {
        injected = true;
        await fs.writeFile(authPath, '{"tokens":');
      }
    },
  };
  const manager = new CodexAuthManager(authPath, {
    fileSystem,
    getOAuth: async () => refreshed(),
    sleep: async () => {},
  });
  let failure;
  try {
    await manager.getAccessToken();
    assert.fail('expected malformed external auth to fail validation');
  } catch (error) {
    failure = error;
  }
  const artifacts = (await fs.readdir(root)).filter((name) => name.includes('.tmp-') || name.includes('.parked-'));
  const temporary = artifacts.find((name) => name.includes('.tmp-'));
  const parked = artifacts.find((name) => name.includes('.parked-'));
  assert.ok(temporary);
  assert.ok(parked);
  assert.match(failure.message, new RegExp(temporary));
  assert.match(failure.message, new RegExp(parked));
  const candidate = JSON.parse(await fs.readFile(path.join(root, temporary), 'utf8'));
  const previous = JSON.parse(await fs.readFile(path.join(root, parked), 'utf8'));
  assert.equal(candidate.tokens.refresh_token, 'new-refresh');
  assert.equal(previous.tokens.refresh_token, 'old-refresh');
  assert.equal(await fs.readFile(authPath, 'utf8'), '{"tokens":');
});

test('OAuth retries once when another process rotates auth during a failed refresh', async (t) => {
  const { authPath } = await authFixture(t);
  let calls = 0;
  const manager = new CodexAuthManager(authPath, {
    getOAuth: async (_provider, credentials) => {
      calls += 1;
      if (calls === 1) {
        await fs.writeFile(authPath, `${JSON.stringify({
          tokens: {
            access_token: 'winner-access',
            refresh_token: 'winner-refresh',
            account_id: 'account-1',
          },
        })}\n`);
        throw new Error('old refresh rejected');
      }
      assert.equal(credentials['openai-codex'].refresh, 'winner-refresh');
      return {
        apiKey: 'winner-access',
        newCredentials: credentials['openai-codex'],
      };
    },
  });
  assert.equal(await manager.getAccessToken(), 'winner-access');
  assert.equal(calls, 2);
});

test('the model list is the login\'s own, from the backend, in its order and without hidden models', async () => {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } };
  const token = ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
  let seen;
  const ids = await fetchAccountModels({
    getAccessToken: async () => token,
    fetchImpl: async (url, init) => {
      seen = { url: new URL(url), headers: init.headers };
      return new Response(JSON.stringify({ models: [
        { slug: 'gpt-6-astra', visibility: 'list' },
        { slug: 'gpt-reserve', visibility: 'hide' },
        { slug: 'gpt-5.6-sol', visibility: 'list' },
        { slug: 'gpt-5.5', visibility: 'list' },
        { slug: 'codex-auto-review', visibility: 'hide' },
      ] }), { status: 200 });
    },
  });
  assert.deepEqual(ids, ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5']);
  assert.equal(`${seen.url.origin}${seen.url.pathname}`, 'https://chatgpt.com/backend-api/codex/models');
  assert.ok(seen.url.searchParams.get('client_version'), 'the backend answers 400 without a client_version');
  assert.equal(seen.headers.authorization, `Bearer ${token}`);
  assert.equal(seen.headers['chatgpt-account-id'], 'acct-123');

  await assert.rejects(fetchAccountModels({
    getAccessToken: async () => token,
    fetchImpl: async () => new Response('{}', { status: 401 }),
  }), /HTTP 401/);
  await assert.rejects(fetchAccountModels({
    getAccessToken: async () => token,
    fetchImpl: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
  }), /empty/);
});

test('the model list is cached, survives a failed refresh, and claims only the default before any list', async (t) => {
  t.mock.method(console, 'error', () => {});
  let clock = 0;
  let calls = 0;
  let answer = async () => { throw new Error('offline'); };
  const list = createModelLister({
    fetchModels: () => { calls += 1; return answer(); },
    now: () => clock,
    ttlMs: 1000,
    retryMs: 100,
    fallbackIds: ['gpt-5.5'],
  });
  const ids = async () => (await list()).map(entry => entry.id);

  assert.deepEqual(await ids(), ['gpt-5.5'], 'nothing has arrived yet, so only the default');
  assert.deepEqual(await ids(), ['gpt-5.5']);
  assert.equal(calls, 1, 'a failure is not retried before retryMs');

  answer = async () => ['gpt-6-astra', 'gpt-5.5'];
  clock = 100;
  assert.deepEqual(await ids(), ['gpt-6-astra', 'gpt-5.5']);
  clock = 1099;
  await ids();
  assert.equal(calls, 2, 'a good list is kept for ttlMs');

  answer = async () => { throw new Error('offline'); };
  clock = 1100;
  assert.deepEqual(await ids(), ['gpt-6-astra', 'gpt-5.5'], 'a failed refresh keeps the last good list');
  assert.equal(calls, 3);

  // Callers that arrive while a refresh is out wait for that one.
  let release;
  answer = () => new Promise(resolve => { release = () => resolve(['gpt-6-sol']); });
  clock = 1200;
  const first = ids();
  const second = ids();
  release();
  assert.deepEqual(await first, ['gpt-6-sol']);
  assert.deepEqual(await second, ['gpt-6-sol']);
  assert.equal(calls, 4);
  assert.deepEqual((await list())[0], { id: 'gpt-6-sol', object: 'model', owned_by: 'openai-codex' });
});

// --- upstream failures -----------------------------------------------------

const QUOTA_MESSAGE = 'You have hit your ChatGPT usage limit (plus plan). Try again in ~7 min.';

function errorEvent(errorMessage) {
  return {
    type: 'error',
    reason: 'error',
    error: { role: 'assistant', content: [], stopReason: 'error', errorMessage },
  };
}

function successEvents() {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello' }],
    stopReason: 'stop',
    usage: { input: 3, output: 2, totalTokens: 5 },
  };
  return [
    { type: 'start', partial: message },
    { type: 'text_start', contentIndex: 0, partial: message },
    { type: 'text_delta', contentIndex: 0, delta: 'Hel', partial: message },
    { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: message },
    { type: 'text_end', contentIndex: 0, content: 'Hello', partial: message },
    { type: 'done', reason: 'stop', message },
  ];
}

// Runs the real chat-completions handler behind a real HTTP server, with pi-ai's
// stream replaced by a scripted event sequence and no auth file involved.
async function postCodex(events, body, t) {
  t?.mock.method(console, 'error', () => {});
  const streamFn = () => (async function* replay() {
    for (const event of events) yield event;
  })();
  const server = http.createServer((req, res) => {
    handleChatCompletions(req, res, { streamFn, getAccessToken: async () => 'test-access-token' })
      .catch((error) => {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(`${JSON.stringify({ error: String(error?.message || error) })}\n`);
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sseData(text) {
  return text.split('\n\n').filter(Boolean).map((frame) => {
    assert.ok(frame.startsWith('data: '), `not an SSE data frame: ${frame}`);
    const data = frame.slice('data: '.length);
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}

test('classifyUpstreamError recognizes quota messages and parses Try again in ~N min', () => {
  assert.deepEqual(classifyUpstreamError(QUOTA_MESSAGE), { quota: true, retryAfterSeconds: 420 });
  assert.deepEqual(
    classifyUpstreamError('You have hit your ChatGPT usage limit. Try again in ~0 min.'),
    { quota: true, retryAfterSeconds: 0 },
  );
  for (const message of [
    'You have hit your ChatGPT usage limit (pro plan).',
    'You have hit your ChatGPT usage limit.',
    'Claude AI usage limit reached|1759999999',
    'usage limit reached',
    'Weekly limit reached',
    "You've hit your limit · resets 5pm",
    'You hit your usage limit',
    '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
    'rate_limit_exceeded',
    'Rate limit exceeded',
    'usage_limit_reached',
    'HTTP 429 Too Many Requests',
  ]) {
    assert.deepEqual(classifyUpstreamError(message), { quota: true }, message);
  }
  for (const message of [
    'fetch failed',
    'Request was aborted',
    'No response body',
    'Failed after retries',
    '{"detail":"Bad Request"}',
    'context has 4290 tokens',
    'Context limit reached',
    'max tokens limit reached',
    'limit reached',
    '',
    undefined,
  ]) {
    assert.deepEqual(classifyUpstreamError(message), { quota: false }, String(message));
  }
});

test('non-stream quota error event becomes 429 usage_limit_reached with retry-after', async (t) => {
  const { status, headers, text } = await postCodex([errorEvent(QUOTA_MESSAGE)], {}, t);
  assert.equal(status, 429);
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(headers.get('retry-after'), '420');
  assert.deepEqual(JSON.parse(text), {
    error: { message: QUOTA_MESSAGE, type: 'usage_limit_reached', code: 'usage_limit_reached' },
  });
});

test('non-stream quota error without a reset time omits retry-after', async (t) => {
  const message = 'You have hit your ChatGPT usage limit (plus plan).';
  const { status, headers, text } = await postCodex([errorEvent(message)], {}, t);
  assert.equal(status, 429);
  assert.equal(headers.get('retry-after'), null);
  assert.deepEqual(JSON.parse(text), {
    error: { message, type: 'usage_limit_reached', code: 'usage_limit_reached' },
  });
});

test('non-stream non-quota error event becomes 502 upstream_error with its message', async (t) => {
  const { status, headers, text } = await postCodex([errorEvent('fetch failed')], {}, t);
  assert.equal(status, 502);
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(headers.get('retry-after'), null);
  assert.deepEqual(JSON.parse(text), {
    error: { message: 'fetch failed', type: 'upstream_error', code: 'upstream_error' },
  });
});

test('non-stream with neither done nor error keeps the 500', async (t) => {
  const { status, text } = await postCodex([], {}, t);
  assert.equal(status, 500);
  assert.match(text, /No assistant response received from Codex proxy/);
});

test('non-stream success is unchanged', async (t) => {
  const { status, headers, text } = await postCodex(successEvents(), {}, t);
  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  const json = JSON.parse(text);
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.model, 'gpt-5.5');
  assert.deepEqual(json.choices, [
    { index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' },
  ]);
  assert.deepEqual(json.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test('stream quota error as the first event becomes a 429 JSON answer, not SSE', async (t) => {
  const { status, headers, text } = await postCodex([errorEvent(QUOTA_MESSAGE)], { stream: true }, t);
  assert.equal(status, 429);
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.ok(!String(headers.get('content-type')).includes('text/event-stream'));
  assert.equal(headers.get('retry-after'), '420');
  assert.ok(!text.includes('data:'));
  assert.deepEqual(JSON.parse(text), {
    error: { message: QUOTA_MESSAGE, type: 'usage_limit_reached', code: 'usage_limit_reached' },
  });
});

test('stream non-quota error as the first event becomes a 502 JSON answer', async (t) => {
  const { status, headers, text } = await postCodex([errorEvent('fetch failed')], { stream: true }, t);
  assert.equal(status, 502);
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(text), {
    error: { message: 'fetch failed', type: 'upstream_error', code: 'upstream_error' },
  });
});

test('stream success is unchanged', async (t) => {
  const { status, headers, text } = await postCodex(
    successEvents(),
    { stream: true, stream_options: { include_usage: true } },
    t,
  );
  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(headers.get('retry-after'), null);
  const frames = sseData(text);
  const [{ id, created }] = frames;
  assert.match(id, /^chatcmpl-/);
  const base = { id, object: 'chat.completion.chunk', created, model: 'gpt-5.5' };
  assert.deepEqual(frames, [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    '[DONE]',
  ]);
});

test('stream error event after the stream started is written as an SSE error, then [DONE]', async (t) => {
  const [start, textStart, firstDelta] = successEvents();
  const { status, headers, text } = await postCodex(
    [start, textStart, firstDelta, errorEvent('stream interrupted')],
    { stream: true },
    t,
  );
  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const frames = sseData(text);
  assert.deepEqual(frames.slice(-2), [{ error: { message: 'stream interrupted' } }, '[DONE]']);
  assert.equal(frames[1].choices[0].delta.content, 'Hel');
});
