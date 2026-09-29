// Login state and login/logout for each subscription account.
//
// Both CLIs can be pointed at a different configuration directory, and both then
// look for credentials only there. That is what keeps this gateway's login
// separate from the user's own, and what lets one backend hold several logins:
// every account is its own directory.
//
//   CODEX_HOME=<dir>        codex login status   -> "Not logged in" on stderr, exit 1, in a fresh dir
//   CLAUDE_CONFIG_DIR=<dir> claude auth status   -> {"loggedIn": false, ...} on stdout
//
// So nothing is ever copied out of ~/.codex or ~/.claude, and the Codex adapter's
// refresh-token rotation has a single writer.
//
// On Windows both CLIs are npm .cmd shims, which spawn cannot start by name;
// commandInvocation turns the name into the program the shim would run.
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { commandInvocation, invocationOptions } from "./command.mjs";
import { gatewayPaths } from "./paths.mjs";

const execFileAsync = promisify(execFile);

export const BACKENDS = Object.freeze([
  Object.freeze({
    name: "codex",
    label: "Codex",
    // The variable that moves the CLI's whole configuration home.
    homeEnv: "CODEX_HOME",
    binEnv: "CODEX_BIN",
    defaultBin: "codex",
    statusArgs: ["login", "status"],
    loginArgs: ["login"],
    logoutArgs: ["logout"],
    // Read by the adapter to find the token it should present and rotate.
    credentialFile: "auth.json",
  }),
  Object.freeze({
    name: "claude",
    label: "Claude",
    homeEnv: "CLAUDE_CONFIG_DIR",
    binEnv: "CLAUDE_BIN",
    defaultBin: "claude",
    statusArgs: ["auth", "status", "--json"],
    loginArgs: ["auth", "login", "--claudeai"],
    logoutArgs: ["auth", "logout"],
    credentialFile: ".credentials.json",
  }),
]);

export function backend(name) {
  const found = BACKENDS.find(entry => entry.name === name);
  if (!found) throw new Error(`unknown backend: ${name}`);
  return found;
}

export function backendBin(entry, env = process.env) {
  return String(env[entry.binEnv] || "").trim() || entry.defaultBin;
}

/** Where one account's CLI configuration lives. */
export function accountDirectory(account, paths = gatewayPaths()) {
  return paths.authDir(account.backend, account.id);
}

/** The environment that makes a CLI use one account's credentials. */
export function authEnvironment(account, { paths = gatewayPaths(), env = process.env } = {}) {
  const entry = backend(account.backend);
  return { ...env, [entry.homeEnv]: accountDirectory(account, paths) };
}

/**
 * Who a Codex login belongs to. `codex login status` only says "Logged in using
 * ChatGPT", which cannot tell two accounts apart, so the email and plan are read
 * from the id token's claims. Nothing but those two fields leaves this function.
 */
async function codexIdentity(directory) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(directory, "auth.json"), "utf8"));
    const token = parsed?.tokens?.id_token;
    if (typeof token !== "string") return {};
    const claims = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
    const auth = claims?.["https://api.openai.com/auth"] || {};
    return {
      account: typeof claims?.email === "string" ? claims.email : undefined,
      plan: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
    };
  } catch {
    return {};
  }
}

function parseCodexStatus(output) {
  const text = String(output || "");
  if (/not logged in/i.test(text)) return { loggedIn: false };
  const match = text.match(/logged in(?:\s+using\s+(.+))?/i);
  if (match) return { loggedIn: true, method: (match[1] || "").trim() || undefined };
  return { loggedIn: false, unrecognized: text.trim().slice(0, 200) };
}

// codex-cli 0.154 prints "Logged in using ChatGPT" (exit 0) and "Not logged in"
// (exit 1) on stderr, not stdout, so Codex is read from both streams. Claude's
// JSON is on stdout, and a warning on its stderr must not spoil the parse.
function parseStatus(name, output) {
  if (name === "codex") return parseCodexStatus([output?.stdout, output?.stderr].filter(Boolean).join("\n"));
  return parseClaudeStatus(output?.stdout);
}

function parseClaudeStatus(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || ""));
    return {
      loggedIn: parsed.loggedIn === true,
      method: parsed.authMethod && parsed.authMethod !== "none" ? parsed.authMethod : undefined,
      plan: parsed.subscriptionType || undefined,
      account: parsed.email || undefined,
    };
  } catch {
    return { loggedIn: false, unrecognized: String(stdout || "").trim().slice(0, 200) };
  }
}

/**
 * Asks the CLI itself, rather than guessing from files on disk: the CLI knows
 * whether what it has is still usable. The credential file is reported too,
 * because the adapter needs that path and its absence explains a failed start.
 */
export async function loginStatus(account, {
  paths = gatewayPaths(),
  env = process.env,
  runner = execFileAsync,
  platform = process.platform,
  resolve = commandInvocation,
} = {}) {
  const name = account.backend;
  const entry = backend(name);
  const directory = accountDirectory(account, paths);
  const credentialPath = path.join(directory, entry.credentialFile);
  const credentialPresent = await fsp.access(credentialPath).then(() => true, () => false);
  const base = { accountId: account.id, backend: name, label: entry.label, directory, credentialPath, credentialPresent };
  const identity = name === "codex" && credentialPresent ? await codexIdentity(directory) : {};
  let result;
  try {
    const call = resolve(backendBin(entry, env), entry.statusArgs, { env, platform });
    result = await runner(call.file, call.args, invocationOptions(call, {
      env: authEnvironment(account, { paths, env }),
      timeout: 30_000,
    }, platform));
  } catch (error) {
    // A missing CLI and a CLI that reports "not logged in" on a non-zero exit are
    // different situations, and only the first one the user has to fix elsewhere.
    if (error?.code === "ENOENT") {
      return { ...base, loggedIn: false, cliAvailable: false, error: `${backendBin(entry, env)} is not installed` };
    }
    const parsed = parseStatus(name, error);
    if (parsed.loggedIn || parsed.unrecognized === undefined) return { ...base, cliAvailable: true, ...identity, ...parsed };
    return { ...base, loggedIn: false, cliAvailable: true, error: shortError(error) };
  }
  const parsed = parseStatus(name, result);
  // An answer this cannot read is shown as one, not taken for "not logged in":
  // that is how a CLI printing to the other stream once went unnoticed.
  if (parsed.unrecognized !== undefined) {
    return { ...base, cliAvailable: true, ...identity, ...parsed, error: `로그인 상태를 알아볼 수 없습니다: ${parsed.unrecognized || "출력 없음"}` };
  }
  return { ...base, cliAvailable: true, ...identity, ...parsed };
}

function shortError(error) {
  const text = String(error?.stderr || error?.message || error || "").trim();
  return text.split(/\r?\n/)[0].slice(0, 300);
}

/**
 * Starts a login and returns immediately. The CLI opens a browser and the person
 * finishes there, so this cannot report success; the caller polls `loginStatus`.
 * Output goes to a log file because a detached process with no stdout can wedge
 * a CLI that still tries to print.
 *
 * On Windows the login is not detached. A detached process there has no console,
 * so a console program it starts (codex.js starts codex.exe) opens a window of its
 * own; sharing the screen's hidden console avoids that. The price is that a login
 * still waiting for the browser ends if the screen itself exits.
 */
export async function startLogin(account, {
  paths = gatewayPaths(),
  env = process.env,
  spawnImpl = spawn,
  platform = process.platform,
  resolve = commandInvocation,
} = {}) {
  const entry = backend(account.backend);
  await fsp.mkdir(accountDirectory(account, paths), { recursive: true });
  await fsp.mkdir(paths.logDir, { recursive: true });
  const logPath = paths.logFile(`login-${account.id}`);
  const handle = await fsp.open(logPath, "a");
  try {
    const call = resolve(backendBin(entry, env), entry.loginArgs, { env, platform });
    const child = spawnImpl(call.file, call.args, invocationOptions(call, {
      env: authEnvironment(account, { paths, env }),
      detached: platform !== "win32",
      stdio: ["ignore", handle.fd, handle.fd],
    }, platform));
    child.unref();
    return { ok: true, started: true, accountId: account.id, backend: account.backend, pid: child.pid ?? null, logPath };
  } catch (error) {
    return { ok: false, started: false, accountId: account.id, backend: account.backend, error: shortError(error) };
  } finally {
    await handle.close();
  }
}

export async function logout(account, {
  paths = gatewayPaths(),
  env = process.env,
  runner = execFileAsync,
  platform = process.platform,
  resolve = commandInvocation,
} = {}) {
  const entry = backend(account.backend);
  try {
    const call = resolve(backendBin(entry, env), entry.logoutArgs, { env, platform });
    await runner(call.file, call.args, invocationOptions(call, {
      env: authEnvironment(account, { paths, env }),
      timeout: 60_000,
    }, platform));
    return { ok: true, accountId: account.id, backend: account.backend };
  } catch (error) {
    return { ok: false, accountId: account.id, backend: account.backend, error: shortError(error) };
  }
}
