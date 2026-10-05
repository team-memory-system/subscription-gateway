import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addAccount } from "./accounts.mjs";
import { loginStatus, logout, startLogin } from "./auth.mjs";
import { cmdArgument, commandInvocation, envValue, findOnPath, invocationOptions, readNpmShim } from "./command.mjs";
import { gatewayPaths } from "./paths.mjs";

// Shims as npm and pnpm write them. codex.cmd, claude.cmd and npm.cmd are copied
// byte for byte from a Windows 11 machine (Node 24.15, npm 11.12, codex 0.144,
// claude 2.1.214); the others follow cmd-shim's and pnpm's templates.
function fixture(name) {
  return fs.readFileSync(new URL(`./test-fixtures/windows/${name}`, import.meta.url), "utf8");
}

// A Windows file system in memory: names compare without case, as NTFS does.
function windowsFiles(entries) {
  const files = new Map(Object.entries(entries).map(([name, text]) => [name.toLowerCase(), text]));
  return {
    isFile: target => files.has(target.toLowerCase()),
    read(target) {
      const text = files.get(target.toLowerCase());
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
      return text;
    },
  };
}

const NODE_DIR = "C:\\Program Files\\nodejs";
const NODE = `${NODE_DIR}\\node.exe`;
const CODEX_JS = `${NODE_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;
const CLAUDE_EXE = `${NODE_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

function npmGlobal(extra = {}) {
  return windowsFiles({
    [NODE]: "",
    [`${NODE_DIR}\\codex.cmd`]: fixture("codex.cmd"),
    [`${NODE_DIR}\\codex`]: "#!/bin/sh\n",
    [`${NODE_DIR}\\codex.ps1`]: "",
    [CODEX_JS]: "",
    [`${NODE_DIR}\\claude.cmd`]: fixture("claude.cmd"),
    [CLAUDE_EXE]: "",
    [`${NODE_DIR}\\npm.cmd`]: fixture("npm.cmd"),
    // PATHEXT lists .JS, which Windows would hand to the script host: never a match.
    ["C:\\Program Files\\Git\\usr\\bin\\codex.js"]: "",
    ...extra,
  });
}

const WINDOWS_ENV = Object.freeze({
  // A copied environment keeps Windows' own spelling, which is not "PATH".
  Path: `C:\\Program Files\\Git\\usr\\bin;C:\\WINDOWS\\system32;"${NODE_DIR}";`,
  PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL",
  ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
});

function onWindows(command, args, { env = WINDOWS_ENV, files = npmGlobal(), allowShell } = {}) {
  return commandInvocation(command, args, { env, platform: "win32", execPath: NODE, files, ...(allowShell === undefined ? {} : { allowShell }) });
}

test("off Windows a command is spawned exactly as named, with the options untouched", () => {
  for (const platform of ["darwin", "linux"]) {
    const call = commandInvocation("codex", ["login", "status"], { env: { PATH: "/usr/bin" }, platform });
    assert.deepEqual(call, { file: "codex", args: ["login", "status"] });
    const options = { env: {}, timeout: 30_000 };
    assert.equal(invocationOptions(call, options, platform), options, "the very same object, so nothing about a spawn changes");
  }
});

test("Windows: an npm shim runs its JavaScript entry under this Node, its native target directly", () => {
  const codex = onWindows("codex", ["login", "status"]);
  assert.deepEqual(codex, { file: NODE, args: [CODEX_JS, "login", "status"] });
  assert.deepEqual(invocationOptions(codex, { timeout: 30_000 }, "win32"), { timeout: 30_000, windowsHide: true });

  const claude = onWindows("claude", ["auth", "status", "--json"]);
  assert.deepEqual(claude, { file: CLAUDE_EXE, args: ["auth", "status", "--json"] });

  // Something that looks like an argument for cmd.exe is just an argument here.
  const hostile = onWindows("claude", ["-p", 'a"&calc&"b %PATH% ^!']);
  assert.deepEqual(hostile.args, ["-p", 'a"&calc&"b %PATH% ^!']);
  assert.equal(hostile.windowsVerbatimArguments, undefined);
});

test("Windows: PATH is searched in order with PATHEXT, and a native .exe first on PATH wins", () => {
  const files = npmGlobal({ ["C:\\Users\\me\\.local\\bin\\claude.exe"]: "" });
  const env = { ...WINDOWS_ENV, Path: `C:\\Users\\me\\.local\\bin;${WINDOWS_ENV.Path}` };
  assert.equal(findOnPath("claude", { env, files }), "C:\\Users\\me\\.local\\bin\\claude.exe");
  assert.deepEqual(onWindows("claude", ["-p"], { env, files }), { file: "C:\\Users\\me\\.local\\bin\\claude.exe", args: ["-p"] });

  // A path without an extension is completed the same way; a missing command is
  // returned as named so spawn still says ENOENT, which reads as "not installed".
  assert.deepEqual(onWindows(`${NODE_DIR}\\codex`, ["logout"]), { file: NODE, args: [CODEX_JS, "logout"] });
  assert.deepEqual(onWindows("gemini", ["--version"]), { file: "gemini", args: ["--version"] });
  assert.equal(envValue({ Path: "a", PATH: "b" }, "path"), "b", "Node's spawn keeps the first spelling in sorted order");
});

test("Windows: a batch file that is not a shim runs through cmd.exe, escaped, or not at all", () => {
  const npm = onWindows("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"]);
  assert.equal(npm.file, "C:\\WINDOWS\\system32\\cmd.exe");
  assert.deepEqual(npm.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(npm.args[3], '"C:\\Program^ Files\\nodejs\\npm.cmd ^^^"ci^^^" ^^^"--omit=dev^^^" ^^^"--no-audit^^^" ^^^"--no-fund^^^""');
  assert.equal(npm.windowsVerbatimArguments, true);
  assert.deepEqual(invocationOptions(npm, { cwd: "C:\\x" }, "win32"), { cwd: "C:\\x", windowsHide: true, windowsVerbatimArguments: true });

  // Where an argument carries request text, the caller refuses cmd.exe outright.
  assert.throws(() => onWindows("npm", ["ci"], { allowShell: false }), error => error.code === "ESHELL");
});

test("cmd.exe arguments survive both of cmd's parses: quotes, carets, percent signs, trailing backslashes", () => {
  assert.equal(cmdArgument("plain"), '^^^"plain^^^"');
  assert.equal(cmdArgument(""), '^^^"^^^"');
  assert.equal(cmdArgument('a"&calc&"b'), '^^^"a\\^^^"^^^&calc^^^&\\^^^"b^^^"');
  assert.equal(cmdArgument("%PATH%"), '^^^"^^^%PATH^^^%^^^"');
  assert.equal(cmdArgument("C:\\dir\\"), '^^^"C:\\dir\\\\^^^"', "a trailing backslash must not escape the closing quote");
  assert.equal(cmdArgument("x^y!"), '^^^"x^^^^y^^^!^^^"');
});

test("npm shims are recognised in every form npm and pnpm have written; anything else is not", () => {
  const dir = "C:\\npm";
  const entry = `${dir}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  const exe = `${dir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const read = (name, extra = {}) => readNpmShim(`${dir}\\${name}`, {
    files: windowsFiles({ [`${dir}\\${name}`]: fixture(name), [entry]: "", [exe]: "", ...extra }),
  });
  assert.deepEqual(read("codex.cmd"), { node: entry }, "npm 7 and later");
  assert.deepEqual(read("codex-cmdshim3.cmd"), { node: entry }, "npm 6.10 and later");
  assert.deepEqual(read("codex-npm6.cmd"), { node: entry }, "npm 6 and earlier");
  assert.deepEqual(read("claude.cmd"), { exe }, "a native bin, npm 7 and later");
  assert.deepEqual(read("claude-npm6.cmd"), { exe }, "a native bin, npm 6 and earlier");
  const pnpmEntry = `${dir}\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js`;
  assert.deepEqual(read("codex-pnpm.cmd", { [pnpmEntry]: "" }), { node: pnpmEntry }, "pnpm's shim, which also sets NODE_PATH");

  // A line ending in LF instead of CRLF changes nothing.
  const lf = `${dir}\\codex-lf.cmd`;
  assert.deepEqual(readNpmShim(lf, { files: windowsFiles({ [lf]: fixture("codex.cmd").replace(/\r\n/g, "\n"), [entry]: "" }) }), { node: entry });

  assert.equal(read("npm.cmd"), null, "npm's own wrapper picks its entry at run time");
  assert.equal(read("tool-node-flag.cmd"), null, "a shim passing Node a flag");
  assert.equal(read("wrapper.bat"), null, "a batch file that also changes directory");
  assert.equal(readNpmShim(`${dir}\\codex.cmd`, { files: windowsFiles({ [`${dir}\\codex.cmd`]: fixture("codex.cmd") }) }), null, "a shim whose target is gone");
});

async function tempPaths(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "subscription-gateway-command-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return gatewayPaths({ GATEWAY_HOME: root }, "linux");
}

test("login status, login and logout run what the shim runs on Windows, and exactly as before elsewhere", async (t) => {
  const paths = await tempPaths(t);
  const account = await addAccount("codex", { paths, env: {} });
  const resolve = (bin, args, options) => commandInvocation(bin, args, { ...options, execPath: NODE, files: npmGlobal() });

  const calls = [];
  const runner = async (file, args, options) => { calls.push({ file, args, options }); return { stdout: "", stderr: "Not logged in\n" }; };
  const status = await loginStatus(account, { paths, env: WINDOWS_ENV, runner, platform: "win32", resolve });
  assert.equal(status.cliAvailable, true);
  assert.equal(status.loggedIn, false);
  assert.equal(calls[0].file, NODE);
  assert.deepEqual(calls[0].args, [CODEX_JS, "login", "status"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.CODEX_HOME, paths.authDir("codex", "codex-1"), "the account's own directory still reaches the CLI");

  await logout(account, { paths, env: WINDOWS_ENV, runner, platform: "win32", resolve });
  assert.deepEqual(calls[1].args, [CODEX_JS, "logout"]);

  const spawned = [];
  const spawnImpl = (file, args, options) => { spawned.push({ file, args, options }); return { pid: 4242, unref() {} }; };
  const login = await startLogin(account, { paths, env: WINDOWS_ENV, spawnImpl, platform: "win32", resolve });
  assert.equal(login.ok, true);
  assert.deepEqual(spawned[0].args, [CODEX_JS, "login"]);
  // Detached, a Windows process has no console, and codex.exe would open a window.
  assert.equal(spawned[0].options.detached, false);
  assert.equal(spawned[0].options.windowsHide, true);

  // macOS: the same calls as always, option for option.
  calls.length = 0;
  spawned.length = 0;
  await loginStatus(account, { paths, env: { PATH: "/usr/bin" }, runner, platform: "darwin" });
  assert.equal(calls[0].file, "codex");
  assert.deepEqual(calls[0].args, ["login", "status"]);
  assert.deepEqual(Object.keys(calls[0].options), ["env", "timeout"]);
  await startLogin(account, { paths, env: { PATH: "/usr/bin" }, spawnImpl, platform: "darwin" });
  assert.equal(spawned[0].file, "codex");
  assert.deepEqual(Object.keys(spawned[0].options), ["env", "detached", "stdio"]);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.stdio[0], "ignore", "Codex takes its callback over HTTP, never stdin");

  // Claude reads the code from stdin: a pipe on macOS and Linux, ignored on Windows as before.
  const claude = await addAccount("claude", { paths, env: {} });
  spawned.length = 0;
  for (const platform of ["darwin", "linux"]) {
    const started = await startLogin(claude, { paths, env: { PATH: "/usr/bin" }, spawnImpl, platform });
    assert.equal(started.input, "code");
  }
  assert.deepEqual(spawned.map(entry => entry.options.stdio[0]), ["pipe", "pipe"]);
  assert.deepEqual(Object.keys(spawned[0].options), ["env", "detached", "stdio"]);
  const windowsClaude = await startLogin(claude, { paths, env: WINDOWS_ENV, spawnImpl, platform: "win32", resolve });
  assert.equal(windowsClaude.input, null);
  assert.equal(spawned[2].options.stdio[0], "ignore");
  assert.equal(spawned[2].options.detached, false);
});
