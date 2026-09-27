import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexAuthManager, resolveReasoningEffort } from './server.mjs';

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
