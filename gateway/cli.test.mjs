// The CLI, the autostart it registers and the Windows supervisor. Nothing here
// reaches launchctl, reg.exe or systemctl: every run is a recording fake, every
// file lives in a temporary directory, and the real processes started (the CLI
// itself, the supervisor's stand-in screen) use their own directory and ports.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { launchAgent, renderPlist, RUN_KEY, RUN_VALUE, SYSTEMD_UNIT } from "./autostart.mjs";
import { openInBrowser, runCli } from "./cli.mjs";
import { gatewayPaths, sourceRoot } from "./paths.mjs";
import { askSupervisor, restartDelay, superviseScreen, supervisorEndpoint } from "./supervise.mjs";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const PROBE = "http://127.0.0.1:11450/health";

async function tempDir(t, name = "gateway-cli-") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeBin(dir, names) {
  await fsp.mkdir(dir, { recursive: true });
  for (const name of names) await fsp.writeFile(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  return dir;
}

/** A source tree with or without the Codex adapter's dependencies. */
async function sourceTree(dir, { dependencies }) {
  const adapter = path.join(dir, "codex-openai-proxy");
  await fsp.mkdir(adapter, { recursive: true });
  if (dependencies) await fsp.mkdir(path.join(adapter, "node_modules", "@mariozechner", "pi-ai"), { recursive: true });
  return dir;
}

/** A recording stand-in for execFile: `answer(file, args)` decides the result. */
function recorder(answer = () => ({ code: 0 })) {
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    return { code: 0, stdout: "", stderr: "", ...(await answer(file, args, options)) };
  };
  run.calls = calls;
  return run;
}

function healthyScreen(extra = async () => { throw new Error("connection refused"); }) {
  return async (url, options) => {
    if (String(url) === PROBE) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    return extra(String(url), options);
  };
}

const deadScreen = async () => { throw new Error("connection refused"); };

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async ms => { now += ms; } };
}

// These build a macOS or Linux host out of executables on a ':'-separated PATH.
const POSIX_HOST = process.platform === "win32" ? { skip: "needs a macOS or Linux host" } : {};

function parse(result) {
  // What the process would print: one line of JSON.
  const line = JSON.stringify(result);
  assert.equal(line.includes("\n"), false);
  return JSON.parse(line);
}

// ------------------------------------------------------------------- usage

test("an unknown command, or anything after the command, is a usage error with exit 2", async () => {
  for (const argv of [[], ["bogus"], ["status", "--verbose"]]) {
    const { code, result } = await runCli(argv, { run: recorder(), fetchImpl: deadScreen });
    assert.equal(code, 2);
    assert.equal(result.ok, false);
    assert.match(result.error, /install\|uninstall\|status\|connect-info\|open/);
  }
});

// ------------------------------------------------------------------ macOS

async function macSetup(t) {
  const dir = await tempDir(t);
  const bin = await fakeBin(path.join(dir, "bin"), ["node", "codex", "claude", "npm"]);
  const home = path.join(dir, "home");
  const env = {
    PATH: `/private/tmp/session-shims:${bin}:/usr/bin:/bin`,
    GATEWAY_HOME: path.join(dir, "app"),
    GATEWAY_USER_HOME: home,
    // A terminal's own variables: none of them may reach the LaunchAgent.
    TERM_SESSION_ID: "w0t0p0:1234",
    SSH_AUTH_SOCK: "/private/tmp/agent.sock",
  };
  return { dir, bin, home, env, root: await sourceTree(path.join(dir, "src"), { dependencies: false }) };
}

test("install on macOS: npm ci, keys, the LaunchAgent proxyctl.py writes, started and healthy", POSIX_HOST, async (t) => {
  const { bin, home, env, root } = await macSetup(t);
  let loaded = false;
  const run = recorder(async (file, args, options) => {
    if (path.basename(file) === "npm") {
      await fsp.mkdir(path.join(options.cwd, "node_modules", "@mariozechner", "pi-ai"), { recursive: true });
      return { code: 0 };
    }
    if (args[0] === "print") return { code: loaded ? 0 : 113 };
    if (args[0] === "bootstrap") { loaded = true; return { code: 0 }; }
    return { code: 0 };
  });
  const deps = { env, platform: "darwin", root, run, fetchImpl: healthyScreen(), uid: 501, ...fakeClock() };
  const { code, result } = await runCli(["install"], deps);
  assert.equal(code, 0, JSON.stringify(result));
  assert.deepEqual(parse(result), {
    ok: true,
    autostart: "launchd",
    uiUrl: "http://127.0.0.1:11450",
    routerUrl: "http://127.0.0.1:11400/v1",
  });

  const npm = run.calls.find(call => path.basename(call.file) === "npm");
  assert.deepEqual(npm.args, ["ci", "--omit=dev", "--no-audit", "--no-fund"]);
  assert.equal(npm.options.cwd, path.join(root, "codex-openai-proxy"));

  const secrets = JSON.parse(await fsp.readFile(path.join(env.GATEWAY_HOME, "secrets.json"), "utf8"));
  assert.match(secrets.secrets.router, /^[0-9a-f]{64}$/);

  const plistPath = path.join(home, "Library", "LaunchAgents", "subscription-gateway.ui.plist");
  assert.equal((await fsp.stat(plistPath)).mode & 0o777, 0o600);
  const text = await fsp.readFile(plistPath, "utf8");
  const state = path.join(home, ".local", "share", "subscription-gateway");
  assert.equal(text, renderPlist({
    RunAtLoad: true,
    KeepAlive: true,
    EnvironmentVariables: {
      PATH: `${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      GATEWAY_UI_PORT: "11450",
      // The installer's own overrides, so the screen at login uses the same directory.
      GATEWAY_HOME: env.GATEWAY_HOME,
      GATEWAY_USER_HOME: home,
    },
    Label: "subscription-gateway.ui",
    ProgramArguments: [path.join(bin, "node"), path.join(root, "ui", "server.mjs")],
    WorkingDirectory: path.join(root, "ui"),
    StandardOutPath: path.join(state, "logs", "ui.log"),
    StandardErrorPath: path.join(state, "logs", "ui.error.log"),
  }));
  for (const leak of ["TERM_SESSION_ID", "SSH_AUTH_SOCK", "session-shims"]) assert.equal(text.includes(leak), false, leak);
  assert.deepEqual(
    run.calls.filter(call => call.file === "/bin/launchctl").map(call => call.args),
    [["print", "gui/501/subscription-gateway.ui"], ["bootstrap", "gui/501", plistPath]],
  );

  // Again: nothing to install, nothing changed, and launchd is not bothered.
  run.calls.length = 0;
  const again = await runCli(["install"], deps);
  assert.equal(again.code, 0);
  assert.deepEqual(again.result, result);
  assert.deepEqual(run.calls.map(call => [path.basename(call.file), call.args[0]]), [["launchctl", "print"]]);

  // A different port is a different agent: it is reloaded.
  run.calls.length = 0;
  const moved = await runCli(["install"], { ...deps, env: { ...env, GATEWAY_UI_PORT: "11451" }, fetchImpl: async url => {
    if (String(url) === "http://127.0.0.1:11451/health") return new Response('{"status":"ok"}');
    throw new Error("refused");
  } });
  assert.equal(moved.result.uiUrl, "http://127.0.0.1:11451");
  assert.deepEqual(run.calls.map(call => call.args[0]), ["print", "bootout", "bootstrap"]);
});

test("the LaunchAgent is byte for byte what proxyctl.py install ui writes", POSIX_HOST, async (t) => {
  let python = true;
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
  } catch {
    python = false;
  }
  if (!python) return t.skip("python3 is not installed");
  const dir = await tempDir(t);
  const bin = await fakeBin(path.join(dir, "bin"), ["node", "codex", "claude"]);
  const home = path.join(dir, "home");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
  // Every Mac has this folder; proxyctl.py assumes it.
  await fsp.mkdir(path.join(home, "Library", "LaunchAgents"), { recursive: true });
  const script = [
    "import io, sys",
    "from unittest.mock import patch",
    "sys.path.insert(0, sys.argv[1])",
    "import proxyctl",
    "with patch.object(proxyctl, 'launch') as launch, \\",
    "        patch.object(proxyctl.urllib.request, 'urlopen', return_value=io.BytesIO(b'{\"status\":\"ok\"}')), \\",
    "        patch('sys.stdout', new_callable=io.StringIO):",
    "    launch.return_value.returncode = 0",
    "    proxyctl.install('ui')",
  ].join("\n");
  await execFileAsync("python3", ["-c", script, sourceRoot()], { env });
  const written = await fsp.readFile(path.join(home, "Library", "LaunchAgents", "subscription-gateway.ui.plist"), "utf8");
  const agent = launchAgent({ env: { PATH: env.PATH }, root: sourceRoot(), home, uiPort: 11450 });
  assert.equal(agent.text, written);
});

test("install on macOS refuses next to proxyctl's single-account router, before touching anything", async (t) => {
  const { home, env, root } = await macSetup(t);
  const agents = path.join(home, "Library", "LaunchAgents");
  await fsp.mkdir(agents, { recursive: true });
  await fsp.writeFile(path.join(agents, "subscription-gateway.router.plist"), "<plist/>");
  const run = recorder();
  const { code, result } = await runCli(["install"], { env, platform: "darwin", root, run, fetchImpl: healthyScreen(), uid: 501 });
  assert.equal(code, 1);
  assert.match(result.error, /subscription-gateway\.router/);
  assert.deepEqual(run.calls, [], "no npm, no launchctl");
  await assert.rejects(fsp.access(path.join(agents, "subscription-gateway.ui.plist")));
});

test("install reports a screen that never answers, and a failed npm ci, as errors", async (t) => {
  const { env, root } = await macSetup(t);
  const run = recorder(async file => (path.basename(file) === "npm" ? { code: 1, stderr: "npm ERR! code ENOTFOUND\nnpm ERR! network request failed\n" } : { code: 0 }));
  const failed = await runCli(["install"], { env, platform: "darwin", root, run, fetchImpl: deadScreen, uid: 501, ...fakeClock() });
  assert.equal(failed.code, 1);
  assert.match(failed.result.error, /codex-openai-proxy.*npm ci.*network request failed/);
  assert.equal(run.calls.some(call => call.file === "/bin/launchctl"), false, "no autostart without dependencies");

  await sourceTree(root, { dependencies: true });
  const silent = await runCli(["install"], { env, platform: "darwin", root, run: recorder(), fetchImpl: deadScreen, uid: 501, ...fakeClock() });
  assert.equal(silent.code, 1);
  assert.match(silent.result.error, /30초 안에 응답하지 않았습니다/);
  assert.match(silent.result.error, /ui\.error\.log/);
});

test("uninstall on macOS boots the agent out and removes it, and says ok when there is nothing left", async (t) => {
  const { home, env, root } = await macSetup(t);
  const plistPath = path.join(home, "Library", "LaunchAgents", "subscription-gateway.ui.plist");
  await fsp.mkdir(path.dirname(plistPath), { recursive: true });
  await fsp.writeFile(plistPath, "<plist/>");
  await fsp.mkdir(env.GATEWAY_HOME, { recursive: true });
  await fsp.writeFile(path.join(env.GATEWAY_HOME, "accounts.json"), "{}");
  let loaded = true;
  const run = recorder(async (file, args) => {
    if (args[0] === "print") return { code: loaded ? 0 : 113 };
    if (args[0] === "bootout") loaded = false;
    return { code: 0 };
  });
  const first = await runCli(["uninstall"], { env, platform: "darwin", root, run, uid: 501 });
  assert.deepEqual(first, { code: 0, result: { ok: true } });
  assert.deepEqual(run.calls.map(call => call.args), [["print", "gui/501/subscription-gateway.ui"], ["bootout", "gui/501/subscription-gateway.ui"]]);
  await assert.rejects(fsp.access(plistPath));
  await fsp.access(path.join(env.GATEWAY_HOME, "accounts.json"));
  assert.deepEqual(await runCli(["uninstall"], { env, platform: "darwin", root, run, uid: 501 }), { code: 0, result: { ok: true } });
});

// ---------------------------------------------------------------- Windows

function windowsFiles(entries) {
  const files = new Map(Object.entries(entries).map(([name, text]) => [name.toLowerCase(), text]));
  return {
    isFile: target => files.has(target.toLowerCase()),
    read(target) {
      if (!files.has(target.toLowerCase())) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(target.toLowerCase());
    },
  };
}

async function windowsSetup(t) {
  const dir = await tempDir(t);
  const env = {
    Path: "C:\\WINDOWS\\system32;C:\\Users\\me\\AppData\\Roaming\\npm",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: "C:\\WINDOWS",
    GATEWAY_HOME: path.join(dir, "app"),
    SESSIONNAME: "Console",
  };
  const files = windowsFiles({
    "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd": "",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd": "",
  });
  const root = await sourceTree(path.join(dir, "src"), { dependencies: true });
  return { dir, env, files, root, execPath: "C:\\Program Files\\nodejs\\node.exe" };
}

test("install on Windows: an HKCU Run value, a VBS that starts the supervisor unseen, started now", async (t) => {
  const { env, files, root, execPath } = await windowsSetup(t);
  const vbsPath = path.join(env.GATEWAY_HOME, "autostart", "ui.vbs");
  const run = recorder();
  const spawned = [];
  const spawnImpl = (file, args, options) => { spawned.push({ file, args, options }); return { on() {}, unref() {} }; };
  let supervisor = null;
  const asked = [];
  const ask = async (endpoint, command) => {
    asked.push(command);
    if (command === "stop") { supervisor = null; return { ok: true, stopping: true }; }
    return supervisor;
  };
  const deps = { env, platform: "win32", root, run, spawnImpl, ask, files, execPath, fetchImpl: healthyScreen(), ...fakeClock() };
  const { code, result } = await runCli(["install"], deps);
  assert.equal(code, 0, JSON.stringify(result));
  assert.deepEqual(result, { ok: true, autostart: "windows-run", uiUrl: "http://127.0.0.1:11450", routerUrl: "http://127.0.0.1:11400/v1" });
  assert.equal(run.calls.some(call => /npm/i.test(call.file) || call.args.some(arg => /npm/i.test(arg))), false, "dependencies were there already");

  const runValue = `"C:\\WINDOWS\\System32\\wscript.exe" //B //NoLogo "${vbsPath}"`;
  assert.deepEqual(run.calls.map(call => [call.file, call.args]), [
    ["C:\\WINDOWS\\System32\\reg.exe", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", runValue, "/f"]],
  ]);
  assert.deepEqual(spawned, [{
    file: "C:\\WINDOWS\\System32\\wscript.exe",
    args: ["//B", "//NoLogo", vbsPath],
    options: { detached: true, stdio: "ignore", windowsHide: true },
  }]);

  const bytes = await fsp.readFile(vbsPath);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "UTF-16, so a non-ASCII user folder survives");
  const vbs = bytes.subarray(2).toString("utf16le");
  assert.match(vbs, /^env\("GATEWAY_UI_PORT"\) = "11450"\r$/m);
  assert.ok(vbs.includes(`env("GATEWAY_HOME") = "${env.GATEWAY_HOME}"`));
  assert.ok(vbs.includes('env("PATH") = "C:\\Program Files\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm;" & env("PATH")'));
  assert.ok(vbs.includes('node = "C:\\Program Files\\nodejs\\node.exe"'));
  assert.ok(vbs.includes(`shell.Run """" & node & """ " & """${path.join(root, "gateway", "supervise.mjs")}""", 0, False`), "window style 0: hidden");
  assert.equal(vbs.includes("SESSIONNAME"), false);

  // Running and unchanged: left alone. Running from an older script: replaced.
  supervisor = { ok: true, pid: 10 };
  spawned.length = 0;
  asked.length = 0;
  assert.equal((await runCli(["install"], deps)).code, 0);
  assert.deepEqual(spawned, []);
  const moved = await runCli(["install"], { ...deps, env: { ...env, GATEWAY_ROUTER_PORT: "11401" } });
  assert.equal(moved.result.routerUrl, "http://127.0.0.1:11401/v1");
  assert.deepEqual(asked, ["status", "status", "stop", "status"]);
  assert.equal(spawned.length, 1);
});

test("uninstall on Windows deletes the Run value, stops the supervisor and removes the script", async (t) => {
  const { env, files, root, execPath } = await windowsSetup(t);
  const vbsPath = path.join(env.GATEWAY_HOME, "autostart", "ui.vbs");
  await fsp.mkdir(path.dirname(vbsPath), { recursive: true });
  await fsp.writeFile(vbsPath, "x");
  let supervisor = { ok: true };
  const asked = [];
  const ask = async (endpoint, command) => {
    asked.push(command);
    if (command === "stop") { supervisor = null; return { ok: true, stopping: true }; }
    return supervisor;
  };
  const run = recorder(async (file, args) => (args[0] === "query" ? { code: 1 } : { code: 0 }));
  const { code, result } = await runCli(["uninstall"], { env, platform: "win32", root, run, ask, files, execPath, ...fakeClock() });
  assert.deepEqual({ code, result }, { code: 0, result: { ok: true } });
  assert.deepEqual(run.calls.map(call => call.args.slice(0, 3)), [
    ["delete", RUN_KEY, "/v"],
    ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run", "/v"],
  ]);
  assert.deepEqual(asked, ["status", "stop", "status"]);
  await assert.rejects(fsp.access(vbsPath));
});

// ------------------------------------------------------------------ Linux

test("install on Linux: a systemd user unit that restarts the screen, or a clear error without systemd", POSIX_HOST, async (t) => {
  const dir = await tempDir(t);
  const bin = await fakeBin(path.join(dir, "bin"), ["node", "codex"]);
  const env = { PATH: `${bin}:/usr/bin`, GATEWAY_HOME: path.join(dir, "app"), XDG_CONFIG_HOME: path.join(dir, "config"), GATEWAY_USER_HOME: path.join(dir, "home") };
  const root = await sourceTree(path.join(dir, "src"), { dependencies: false });

  const without = recorder(async () => ({ code: 1, stderr: "Failed to connect to bus: No medium found" }));
  const refused = await runCli(["install"], { env, platform: "linux", root, run: without, fetchImpl: healthyScreen() });
  assert.equal(refused.code, 1);
  assert.match(refused.result.error, /systemd --user.*No medium found/);
  assert.deepEqual(without.calls.map(call => call.args), [["--user", "show-environment"]], "no npm ci before finding out");

  const run = recorder(async (file, args, options) => {
    if (path.basename(file) === "npm") await fsp.mkdir(path.join(options.cwd, "node_modules", "@mariozechner", "pi-ai"), { recursive: true });
    return { code: 0 };
  });
  const { code, result } = await runCli(["install"], { env, platform: "linux", root, run, fetchImpl: healthyScreen(), ...fakeClock() });
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.autostart, "systemd");
  const unit = await fsp.readFile(path.join(env.XDG_CONFIG_HOME, "systemd", "user", SYSTEMD_UNIT), "utf8");
  assert.match(unit, new RegExp(`^ExecStart="${bin}/node" "${root}/ui/server\\.mjs"$`, "m"));
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^KillMode=process$/m, "the router and adapters outlive a restart of the screen");
  assert.match(unit, /^Environment="GATEWAY_UI_PORT=11450"$/m);
  assert.match(unit, new RegExp(`^Environment="PATH=${bin}:/usr/local/bin:/usr/bin`, "m"));
  assert.deepEqual(run.calls.filter(call => call.file === "systemctl").map(call => call.args.slice(1).join(" ")), [
    "show-environment", "show-environment", "daemon-reload", `enable ${SYSTEMD_UNIT}`, `restart ${SYSTEMD_UNIT}`,
  ]);

  run.calls.length = 0;
  assert.equal((await runCli(["install"], { env, platform: "linux", root, run, fetchImpl: healthyScreen(), ...fakeClock() })).code, 0);
  assert.equal(run.calls.at(-1).args.slice(1).join(" "), `start ${SYSTEMD_UNIT}`, "unchanged: started if stopped, not restarted");

  run.calls.length = 0;
  assert.deepEqual(await runCli(["uninstall"], { env, platform: "linux", root, run }), { code: 0, result: { ok: true } });
  assert.deepEqual(run.calls.map(call => call.args.slice(1).join(" ")), [`disable --now ${SYSTEMD_UNIT}`, "daemon-reload"]);
  await assert.rejects(fsp.access(path.join(env.XDG_CONFIG_HOME, "systemd", "user", SYSTEMD_UNIT)));
});

// ------------------------------------------------------------------ status

test("status comes from the screen when it answers, and never carries a key", async (t) => {
  const { home, env, root } = await macSetup(t);
  const plistPath = path.join(home, "Library", "LaunchAgents", "subscription-gateway.ui.plist");
  await fsp.mkdir(path.dirname(plistPath), { recursive: true });
  await fsp.writeFile(plistPath, "<plist/>");
  const report = {
    ok: true,
    endpoint: "http://127.0.0.1:11400/v1",
    accounts: [
      { id: "codex-1", backend: "codex", login: { loggedIn: true, account: "someone@example.com" }, service: { running: true } },
      { id: "claude-1", backend: "claude", login: { loggedIn: false }, service: { running: false } },
    ],
    services: [{ name: "codex-1", kind: "adapter", running: true }, { name: "router", kind: "router", running: true }],
    servingAccounts: ["codex-1"],
    models: { ok: true, models: [{ id: "gpt-5.5", ownedBy: "codex-1" }, { id: "gpt-6-luna", ownedBy: "codex-1" }] },
  };
  const fetchImpl = healthyScreen(async url => {
    if (url === "http://127.0.0.1:11450/api/status") return new Response(JSON.stringify(report));
    throw new Error("refused");
  });
  const { code, result } = await runCli(["status"], { env, platform: "darwin", root, run: recorder(), fetchImpl, uid: 501 });
  assert.equal(code, 0);
  assert.deepEqual(parse(result), {
    ok: true,
    ui: { url: "http://127.0.0.1:11450", ok: true },
    router: { url: "http://127.0.0.1:11400/v1", ok: true },
    autostart: { kind: "launchd", installed: true },
    accounts: [
      { id: "codex-1", backend: "codex", loggedIn: true, serving: true },
      { id: "claude-1", backend: "claude", loggedIn: false, serving: false },
    ],
    models: ["gpt-5.5", "gpt-6-luna"],
  });
});

test("status with the screen down asks the CLIs itself and creates nothing", async (t) => {
  const { env, root } = await macSetup(t);
  await fsp.mkdir(env.GATEWAY_HOME, { recursive: true });
  await fsp.writeFile(path.join(env.GATEWAY_HOME, "accounts.json"), JSON.stringify({
    format: 1, mode: "drain", accounts: [{ id: "codex-1", backend: "codex", port: 11460 }],
  }));
  const runner = async () => { throw Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "Not logged in\n" }); };
  const { code, result } = await runCli(["status"], { env, platform: "darwin", root, run: recorder(), fetchImpl: deadScreen, runner, uid: 501 });
  assert.equal(code, 0);
  assert.deepEqual(result, {
    ok: true,
    ui: { url: "http://127.0.0.1:11450", ok: false },
    router: { url: "http://127.0.0.1:11400/v1", ok: false },
    autostart: { kind: "launchd", installed: false },
    accounts: [{ id: "codex-1", backend: "codex", loggedIn: false, serving: false }],
    models: [],
  });
  await assert.rejects(fsp.access(path.join(env.GATEWAY_HOME, "secrets.json")), "looking must not create the keys");
});

// ------------------------------------------------------------ connect-info

test("connect-info gives the router's address and key, and is ready only when the key lists a model", async (t) => {
  const { env, root } = await macSetup(t);
  const base = { env, platform: "darwin", root, run: recorder(), uid: 501 };
  const down = await runCli(["connect-info"], { ...base, fetchImpl: deadScreen });
  assert.equal(down.code, 0);
  const secrets = JSON.parse(await fsp.readFile(path.join(env.GATEWAY_HOME, "secrets.json"), "utf8")).secrets;
  assert.deepEqual(down.result, {
    ok: true,
    ready: false,
    baseUrl: "http://127.0.0.1:11400/v1",
    apiKey: secrets.router,
    models: [],
    reason: down.result.reason,
  });
  assert.match(down.result.reason, /라우터\(http:\/\/127\.0\.0\.1:11400\/v1\)가 응답하지 않습니다/);

  const seen = [];
  const router = (status, body) => async (url, options) => {
    seen.push({ url: String(url), authorization: options?.headers?.authorization });
    return new Response(JSON.stringify(body), { status });
  };
  const ready = await runCli(["connect-info"], { ...base, fetchImpl: router(200, { data: [{ id: "gpt-5.5" }, { id: "claude-opus-5-5" }] }) });
  assert.deepEqual(ready.result, { ok: true, ready: true, baseUrl: "http://127.0.0.1:11400/v1", apiKey: secrets.router, models: ["gpt-5.5", "claude-opus-5-5"] });
  assert.deepEqual(seen.at(-1), { url: "http://127.0.0.1:11400/v1/models", authorization: `Bearer ${secrets.router}` });

  const empty = await runCli(["connect-info"], { ...base, fetchImpl: router(200, { data: [] }) });
  assert.equal(empty.result.ready, false);
  assert.match(empty.result.reason, /연결된 계정이 없습니다/);
  const refused = await runCli(["connect-info"], { ...base, fetchImpl: router(401, { error: "Unauthorized" }) });
  assert.equal(refused.result.ready, false);
  assert.match(refused.result.reason, /키를 받지 않습니다/);
  assert.equal(refused.result.reason.includes(secrets.router), false);
});

// -------------------------------------------------------------------- open

test("open prints the screen's address and hands it to the platform's opener", async () => {
  const opened = [];
  const { code, result } = await runCli(["open"], { env: { GATEWAY_UI_PORT: "11452" }, openBrowser: url => opened.push(url) });
  assert.deepEqual({ code, result }, { code: 0, result: { ok: true, url: "http://127.0.0.1:11452" } });
  assert.deepEqual(opened, ["http://127.0.0.1:11452"]);

  const spawned = [];
  const spawnImpl = (file, args, options) => { spawned.push([file, args, options.detached]); return { on() {}, unref() {} }; };
  openInBrowser("http://127.0.0.1:11450", { platform: "darwin", spawnImpl });
  openInBrowser("http://127.0.0.1:11450", { platform: "win32", env: { SystemRoot: "C:\\WINDOWS" }, spawnImpl });
  openInBrowser("http://127.0.0.1:11450", { platform: "linux", spawnImpl });
  assert.deepEqual(spawned, [
    ["/usr/bin/open", ["http://127.0.0.1:11450"], true],
    ["C:\\WINDOWS\\System32\\rundll32.exe", ["url.dll,FileProtocolHandler", "http://127.0.0.1:11450"], true],
    ["xdg-open", ["http://127.0.0.1:11450"], true],
  ]);
  assert.equal(openInBrowser("x", { platform: "linux", spawnImpl: () => { throw new Error("ENOENT"); } }), false);
});

// ----------------------------------------------------- the process itself

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("the CLI process prints exactly one JSON line on stdout, for success and failure alike", async (t) => {
  const dir = await tempDir(t);
  // Ports nothing listens on, and a home of its own: this never reaches a real gateway.
  const env = {
    PATH: process.env.PATH,
    GATEWAY_HOME: path.join(dir, "app"),
    GATEWAY_USER_HOME: path.join(dir, "home"),
    GATEWAY_UI_PORT: String(await freePort()),
    GATEWAY_ROUTER_PORT: String(await freePort()),
  };
  const run = args => execFileAsync(process.execPath, [CLI, ...args], { env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );

  const usage = await run(["bogus"]);
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout.split("\n").filter(Boolean).length, 1);
  assert.equal(JSON.parse(usage.stdout).ok, false);

  const info = await run(["connect-info"]);
  assert.equal(info.code, 0, info.stderr);
  assert.equal(info.stdout.split("\n").filter(Boolean).length, 1);
  const parsed = JSON.parse(info.stdout);
  assert.equal(parsed.ready, false);
  assert.equal(parsed.baseUrl, `http://127.0.0.1:${env.GATEWAY_ROUTER_PORT}/v1`);
  const stored = JSON.parse(await fsp.readFile(path.join(env.GATEWAY_HOME, "secrets.json"), "utf8")).secrets;
  assert.equal(parsed.apiKey, stored.router);

  if (process.platform === "darwin" || process.platform === "linux") {
    const status = await run(["status"]);
    assert.equal(status.code, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.deepEqual(report.ui, { url: `http://127.0.0.1:${env.GATEWAY_UI_PORT}`, ok: false });
    assert.deepEqual(report.accounts, []);
    assert.equal(status.stdout.includes(stored.router), false, "status never prints the key");
  }
});

// -------------------------------------------------------------- supervisor

async function screenScript(dir, mode) {
  const file = path.join(dir, `screen-${mode}.mjs`);
  await fsp.writeFile(file, [
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.SCREEN_RUNS, `${process.pid}\\n`);",
    mode === "crash" ? "process.exit(3);" : "setInterval(() => {}, 1000);",
  ].join("\n"));
  return file;
}

async function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

async function runs(file) {
  return (await fsp.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
}

test("the supervisor starts the screen again after each exit, waiting longer after each quick failure", async (t) => {
  assert.deepEqual([0, 1, 2, 3, 6, 7, 20].map(restartDelay), [1_000, 2_000, 4_000, 8_000, 60_000, 60_000, 60_000]);
  const dir = await tempDir(t);
  const paths = gatewayPaths({ GATEWAY_HOME: path.join(dir, "app") }, process.platform);
  const runsFile = path.join(dir, "runs");
  const waits = [];
  const supervisor = await superviseScreen({
    paths,
    env: { ...process.env, SCREEN_RUNS: runsFile },
    script: await screenScript(dir, "crash"),
    delay: failures => { waits.push(failures); return 10; },
  });
  t.after(() => supervisor.stop());
  assert.ok(await until(async () => (await runs(runsFile)).length >= 3), "restarted twice");
  assert.deepEqual(waits.slice(0, 2), [1, 2], "each quick exit is one more failure in a row");
  const status = await askSupervisor(supervisor.endpoint, "status");
  assert.equal(status.ok, true);
  assert.equal(status.pid, process.pid);
  assert.ok(status.restarts >= 2);
  await supervisor.stop();
  assert.equal(await askSupervisor(supervisor.endpoint, "status"), null);
  await assert.rejects(fsp.access(paths.pidFile("ui-supervisor")));
  const log = await fsp.readFile(paths.logFile("ui-supervisor"), "utf8");
  assert.match(log, /"event":"exited".*"code":3/);
});

test("one supervisor per app directory, and `stop` over its endpoint ends it and the screen", async (t) => {
  const dir = await tempDir(t);
  const paths = gatewayPaths({ GATEWAY_HOME: path.join(dir, "app") }, process.platform);
  const runsFile = path.join(dir, "runs");
  const options = { paths, env: { ...process.env, SCREEN_RUNS: runsFile }, script: await screenScript(dir, "run") };
  const first = await superviseScreen(options);
  t.after(() => first.stop());
  assert.equal(first.endpoint, supervisorEndpoint(paths.appHome));
  assert.ok(await until(async () => (await runs(runsFile)).length === 1));
  const [screen] = await runs(runsFile);
  assert.equal(await superviseScreen(options), null, "a second copy leaves at once");

  const record = JSON.parse(await fsp.readFile(paths.pidFile("ui-supervisor"), "utf8"));
  assert.equal(record.screenPid, screen);
  assert.deepEqual(await askSupervisor(first.endpoint, "stop"), { ok: true, stopping: true });
  await first.stopped;
  assert.ok(await until(() => { try { process.kill(screen, 0); return false; } catch { return true; } }), "the screen is gone");
  assert.equal((await runs(runsFile)).length, 1, "and it was not started again");
});
