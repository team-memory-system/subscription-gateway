// A port held by something that does not know this gateway's keys: an adapter
// an earlier install left running, or an unrelated program. Everything here is a
// fake or a throwaway process on a free port; nothing touches 114xx.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gatewayPaths, sourceRoot } from "./paths.mjs";
import {
  adapterService,
  emptyModelsReason,
  foreignMessage,
  isOwnService,
  serviceStatus,
  startService,
  stopService,
  systemProcesses,
} from "./services.mjs";

const CLAUDE_DIR = path.join(sourceRoot(), "claude-print-proxy");
const POSIX_HOST = process.platform === "win32" ? { skip: "needs a macOS or Linux host" } : {};
const SECRETS = Object.freeze({ codex: "new-codex-key", claude: "new-claude-key", router: "new-router-key" });

async function tempPaths(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gateway-services-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return gatewayPaths({ GATEWAY_HOME: root }, process.platform);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A fake port. `holder` is what answers there: "stale" answers /health and
 * refuses our key, "ours" answers and takes it, null is nothing listening.
 */
function fakePort(port, { holder = "stale", key = SECRETS.claude } = {}) {
  const state = { holder, calls: [] };
  state.fetchImpl = async (url, options = {}) => {
    const target = new URL(String(url));
    state.calls.push({ path: target.pathname, authorization: options.headers?.authorization });
    if (Number(target.port) !== port || !state.holder) throw new Error("connect ECONNREFUSED");
    if (target.pathname === "/health") return json({ status: "ok" });
    if (target.pathname === "/v1/models") {
      if (state.holder === "stale" || options.headers?.authorization !== `Bearer ${key}`) return json({ error: "Unauthorized" }, 401);
      return json({ object: "list", data: [{ id: "claude-opus-5-5" }] });
    }
    return json({ error: "Not found" }, 404);
  };
  return state;
}

/** What the OS would say, and a record of what was asked of it. */
function fakeProcesses({ pids = [], info = null, onStop = () => {} } = {}) {
  const record = { stopped: [], described: [] };
  return {
    record,
    listeners: async () => pids,
    describe: async pid => { record.described.push(pid); return info; },
    stop: async pid => { record.stopped.push(pid); onStop(pid); },
  };
}

function fakeSpawn(onSpawn = () => {}) {
  const spawned = [];
  const spawnImpl = (file, args, options) => {
    spawned.push({ file, args, cwd: options.cwd, env: options.env });
    onSpawn();
    // A live pid, so the pid file this writes reads as running.
    return { pid: process.pid, unref() {} };
  };
  return { spawned, spawnImpl };
}

const claudeAccount = port => ({ id: "claude-1", backend: "claude", port });

test("a service on the port that refuses this gateway's key is foreign, not already running", async (t) => {
  const paths = await tempPaths(t);
  const port = 47_460;
  const entry = adapterService(claudeAccount(port));
  const holder = fakePort(port);

  const status = await serviceStatus(entry, { paths, fetchImpl: holder.fetchImpl, secrets: SECRETS });
  assert.equal(status.running, false, "a service that refuses our key is not usable");
  assert.equal(status.foreign, true);
  assert.match(status.error, new RegExp(`^포트 ${port}을 이 게이트웨이의 키를 모르는 다른 프로그램이 쓰고 있습니다\\. 예전에 설치한 게이트웨이가 남아 있을 수 있습니다\\.`));
  assert.match(status.error, /끄거나 컴퓨터를 다시 시작한 뒤 연결을 누르세요/, "and it says what to do");
  // The probe is the request the router makes, with the key the router presents.
  assert.deepEqual(holder.calls.find(call => call.path === "/v1/models"), { path: "/v1/models", authorization: `Bearer ${SECRETS.claude}` });
  assert.equal(JSON.stringify(status).includes(SECRETS.claude), false, "the key never reaches the status");

  // Without the keys (a caller that only looks) nothing is probed, as before.
  const looking = await serviceStatus(entry, { paths, fetchImpl: holder.fetchImpl });
  assert.equal(looking.running, true);
  assert.equal(looking.foreign, false);

  // Nothing is identified as ours on that port: start refuses instead of claiming success.
  const processes = fakeProcesses({ pids: [] });
  const { spawned, spawnImpl } = fakeSpawn();
  const started = await startService(entry, { secrets: SECRETS, paths, env: {}, fetchImpl: holder.fetchImpl, spawnImpl, processes });
  assert.equal(started.ok, false);
  assert.equal(started.alreadyRunning, undefined, "never reported as already running");
  assert.equal(started.foreign, true);
  assert.equal(started.error, foreignMessage(port));
  assert.deepEqual(spawned, [], "nothing is started onto a taken port");
  assert.deepEqual(processes.record.stopped, []);
});

test("a service that takes the key is already running, whoever started it", async (t) => {
  const paths = await tempPaths(t);
  const port = 47_461;
  const entry = adapterService(claudeAccount(port));
  const holder = fakePort(port, { holder: "ours" });
  const processes = fakeProcesses({ pids: [4321] });
  const started = await startService(entry, { secrets: SECRETS, paths, env: {}, fetchImpl: holder.fetchImpl, processes, spawnImpl: fakeSpawn().spawnImpl });
  assert.equal(started.ok, true);
  assert.equal(started.alreadyRunning, true);
  assert.equal(started.status.foreign, false);
  assert.deepEqual(processes.record.stopped, [], "a working service is never touched");
});

test("a stale copy of this gateway's own adapter is stopped and ours is started in its place", async (t) => {
  const paths = await tempPaths(t);
  const port = 47_462;
  const entry = adapterService(claudeAccount(port));
  const holder = fakePort(port);
  const processes = fakeProcesses({
    pids: [7777],
    // What `ps` and `lsof -d cwd` say about the old install's adapter.
    info: { command: "/opt/homebrew/bin/node server.mjs", cwd: CLAUDE_DIR },
    onStop: () => { holder.holder = null; },
  });
  const { spawned, spawnImpl } = fakeSpawn(() => { holder.holder = "ours"; });
  const started = await startService(entry, { secrets: SECRETS, paths, env: { PATH: "/usr/bin" }, fetchImpl: holder.fetchImpl, spawnImpl, processes, pollMs: 5 });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.started, true);
  assert.equal(started.replacedStalePid, 7777);
  assert.deepEqual(processes.record.stopped, [7777]);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ["server.mjs"]);
  assert.equal(spawned[0].cwd, CLAUDE_DIR);
  assert.equal(spawned[0].env.CLAUDE_PROXY_SHARED_SECRET, SECRETS.claude, "the new adapter has this install's key");
  assert.equal(started.status.running, true);
});

test("an unrelated program on the port is never stopped, only reported", async (t) => {
  const paths = await tempPaths(t);
  const port = 47_463;
  const entry = adapterService(claudeAccount(port));
  const cases = [
    { command: "python3 -m http.server 47463", cwd: CLAUDE_DIR },
    // node server.mjs, but somebody else's.
    { command: "/usr/local/bin/node server.mjs", cwd: "/Users/someone/other-project" },
    { command: "/usr/local/bin/node /Users/someone/other-project/server.mjs", cwd: "/Users/someone/other-project" },
    // Our folder, but not our program.
    { command: "/usr/local/bin/node other.mjs", cwd: CLAUDE_DIR },
    null,
  ];
  for (const info of cases) {
    const holder = fakePort(port);
    const processes = fakeProcesses({ pids: [8888], info });
    const { spawned, spawnImpl } = fakeSpawn();
    const started = await startService(entry, { secrets: SECRETS, paths, env: {}, fetchImpl: holder.fetchImpl, spawnImpl, processes });
    assert.equal(started.ok, false, JSON.stringify(info));
    assert.equal(started.foreign, true);
    assert.equal(started.holderPid, 8888);
    assert.equal(started.error, foreignMessage(port, { pid: 8888 }));
    assert.match(started.error, /다른 프로그램\(pid 8888\)이 쓰고 있습니다/);
    assert.deepEqual(processes.record.stopped, [], `never killed: ${JSON.stringify(info)}`);
    assert.deepEqual(spawned, []);
  }

  // Two listeners, or none that can be named: nothing to identify, nothing stopped.
  for (const pids of [[1, 2], []]) {
    const processes = fakeProcesses({ pids, info: { command: "node server.mjs", cwd: CLAUDE_DIR } });
    const started = await startService(entry, { secrets: SECRETS, paths, env: {}, fetchImpl: fakePort(port).fetchImpl, spawnImpl: fakeSpawn().spawnImpl, processes });
    assert.equal(started.ok, false);
    assert.deepEqual(processes.record.described, []);
    assert.deepEqual(processes.record.stopped, []);
  }
});

test("what counts as our own adapter: node server.mjs from its source folder, even one recreated", () => {
  const posixDir = "/Users/me/.local/share/subscription-gateway/src/claude-print-proxy";
  assert.equal(isOwnService({ command: "node server.mjs", cwd: posixDir }, [posixDir], "darwin"), true);
  assert.equal(isOwnService({ command: "/opt/homebrew/bin/node server.mjs", cwd: `${posixDir}/` }, [posixDir], "darwin"), true);
  assert.equal(isOwnService({ command: `/usr/bin/node ${posixDir}/server.mjs`, cwd: posixDir }, [posixDir], "linux"), true);
  // As resolved (macOS reports /private/var for /var).
  assert.equal(isOwnService({ command: "node server.mjs", cwd: `/private${posixDir}` }, [posixDir, `/private${posixDir}`], "darwin"), true);
  assert.equal(isOwnService({ command: "node server.mjs", cwd: "/elsewhere" }, [posixDir], "darwin"), false);
  assert.equal(isOwnService({ command: "node server.mjs --inspect", cwd: posixDir }, [posixDir], "darwin"), false);
  assert.equal(isOwnService({ command: "deno server.mjs", cwd: posixDir }, [posixDir], "darwin"), false);
  assert.equal(isOwnService({ command: "node", cwd: posixDir }, [posixDir], "darwin"), false);

  const winDir = "C:\\Users\\me\\AppData\\Local\\SubscriptionGateway\\src\\claude-print-proxy";
  assert.equal(isOwnService({ command: `"C:\\Program Files\\nodejs\\node.exe" "${winDir}\\server.mjs"`, cwd: null }, [winDir], "win32"), true);
  assert.equal(isOwnService({ command: `"C:\\Program Files\\nodejs\\node.exe" ${winDir.toUpperCase()}\\SERVER.MJS`, cwd: null }, [winDir], "win32"), true);
  // A relative server.mjs on Windows: its folder cannot be read, so it is not ours.
  assert.equal(isOwnService({ command: "\"C:\\Program Files\\nodejs\\node.exe\" server.mjs", cwd: null }, [winDir], "win32"), false);
  assert.equal(isOwnService({ command: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\other\\server.mjs", cwd: null }, [winDir], "win32"), false);
});

test("the OS is asked with lsof and ps on macOS and Linux, PowerShell on Windows", async () => {
  const calls = [];
  const killed = [];
  const answers = {
    lsof: args => (args.includes("cwd") ? "p7777\nfcwd\nn/old/install/claude-print-proxy (deleted)\n" : "7777\n7777\n"),
    ps: () => "/opt/homebrew/bin/node server.mjs\n",
    "powershell.exe": args => (args.at(-1).startsWith("Get-NetTCPConnection") ? "5555\r\n" : "\"C:\\node.exe\" C:\\src\\claude-print-proxy\\server.mjs\r\n"),
  };
  const run = async (file, args) => { calls.push([file, ...args]); return { ok: true, stdout: answers[file](args) }; };
  const kill = (pid, signal) => killed.push([pid, signal]);

  const posix = systemProcesses({ platform: "darwin", run, kill });
  assert.deepEqual(await posix.listeners(47_460), [7777]);
  assert.deepEqual(calls.at(-1), ["lsof", "-nP", "-tiTCP:47460", "-sTCP:LISTEN"]);
  assert.deepEqual(await posix.describe(7777), { command: "/opt/homebrew/bin/node server.mjs", cwd: "/old/install/claude-print-proxy" });
  assert.ok(calls.some(call => call.join(" ") === "lsof -a -p 7777 -d cwd -Fn"));
  await posix.stop(7777);
  assert.deepEqual(killed, [[7777, "SIGTERM"]]);

  const windows = systemProcesses({ platform: "win32", run, kill });
  assert.deepEqual(await windows.listeners(47_460), [5555]);
  assert.match(calls.at(-1).at(-1), /^Get-NetTCPConnection -LocalPort 47460 -State Listen/);
  assert.deepEqual(await windows.describe(5555), { command: "\"C:\\node.exe\" C:\\src\\claude-print-proxy\\server.mjs", cwd: null });
  assert.match(calls.at(-1).at(-1), /Get-CimInstance Win32_Process -Filter "ProcessId=5555"/);

  // Only integers reach a command line.
  await assert.rejects(posix.listeners("47460; rm -rf /"));
  await assert.rejects(windows.describe("1) ; Remove-Item"));
});

test("the reason for an empty model list names keys the adapters refused", () => {
  const reason = emptyModelsReason({
    backends: [
      { name: "codex-1", discovery: { ok: false, status: 401, reason: "HTTP 401" } },
      { name: "claude-1", discovery: { ok: false, status: 401, reason: "HTTP 401" } },
    ],
  });
  assert.match(reason, /^어댑터가 키를 거절합니다 \(codex-1: HTTP 401, claude-1: HTTP 401\)/);
  assert.match(emptyModelsReason({ backends: [{ name: "codex-1", discovery: { ok: false, status: null, reason: "fetch failed" } }] }), /모델 목록을 주지 않습니다 \(codex-1: fetch failed\)/);
  assert.equal(emptyModelsReason({ backends: [{ name: "codex-1", discovery: { ok: true, status: 200 } }] }), null);
  assert.equal(emptyModelsReason({ backends: [] }), null);
  assert.equal(emptyModelsReason(undefined), null);
});

// ---------------------------------------------------- with real processes

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

const answers = port => fetch(`http://127.0.0.1:${port}/health`).then(response => response.ok, () => false);

test("a real stale Claude adapter with an old key is found by lsof, replaced, and the new one takes our key", POSIX_HOST, async (t) => {
  const paths = await tempPaths(t);
  const port = await freePort();
  const env = { ...process.env, CLAUDE_PROXY_REQUEST_LOG: "0", CLAUDE_BIN: "/nonexistent/claude" };
  // As the old install left it: node server.mjs, from this adapter's folder, with its own key.
  const stale = spawn(process.execPath, ["server.mjs"], {
    cwd: CLAUDE_DIR,
    env: { ...env, PORT: String(port), HOST: "127.0.0.1", CLAUDE_PROXY_SHARED_SECRET: "old-install-key" },
    stdio: "ignore",
  });
  t.after(() => { if (alive(stale.pid)) stale.kill("SIGKILL"); });
  assert.ok(await until(() => answers(port)), "the stale adapter answers");

  const entry = adapterService(claudeAccount(port));
  const before = await serviceStatus(entry, { paths, secrets: SECRETS });
  assert.equal(before.foreign, true);

  const started = await startService(entry, { secrets: SECRETS, paths, env, readyTimeoutMs: 15_000 });
  const pid = JSON.parse(await fsp.readFile(paths.pidFile(entry.key), "utf8")).pid;
  t.after(() => { if (alive(pid)) process.kill(pid, "SIGKILL"); });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.replacedStalePid, stale.pid);
  assert.ok(await until(() => !alive(stale.pid)), "the stale adapter is gone");
  const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${SECRETS.claude}` } });
  assert.equal(models.status, 200, "the adapter on the port now takes this install's key");
  assert.equal((await stopService(entry, { paths, confirmDelayMs: 20 })).stopped, true);
});

test("a real unrelated program that refuses the key is left running", POSIX_HOST, async (t) => {
  const paths = await tempPaths(t);
  const port = await freePort();
  const bystander = spawn(process.execPath, ["-e", `require("node:http").createServer((q, s) => { s.statusCode = q.url === "/health" ? 200 : 401; s.end("{}"); }).listen(${port}, "127.0.0.1")`], { stdio: "ignore" });
  t.after(() => { if (alive(bystander.pid)) bystander.kill("SIGKILL"); });
  assert.ok(await until(() => answers(port)));
  const entry = adapterService(claudeAccount(port));
  const started = await startService(entry, { secrets: SECRETS, paths, env: {} });
  assert.equal(started.ok, false);
  assert.equal(started.foreign, true);
  assert.equal(started.holderPid, bystander.pid, "lsof named the program on the port");
  assert.match(started.error, new RegExp(`포트 ${port}을`));
  assert.equal(alive(bystander.pid), true, "an unrelated program is never killed");
});
