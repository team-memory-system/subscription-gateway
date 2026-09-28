// Login state and login/logout for each subscription backend.
//
// Both CLIs can be pointed at a different configuration directory, and both then
// look for credentials only there. That is what keeps this gateway's login
// separate from the user's own:
//
//   CODEX_HOME=<dir>        codex login status   -> "Not logged in" in a fresh dir
//   CLAUDE_CONFIG_DIR=<dir> claude auth status   -> {"loggedIn": false, ...}
//
// So nothing is ever copied out of ~/.codex or ~/.claude, and the Codex adapter's
// refresh-token rotation has a single writer.
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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

/** The environment that makes a CLI use this gateway's own credentials. */
export function authEnvironment(entry, { paths = gatewayPaths(), env = process.env } = {}) {
  return { ...env, [entry.homeEnv]: paths.authDir(entry.name) };
}

function parseCodexStatus(stdout) {
  const text = String(stdout || "");
  if (/not logged in/i.test(text)) return { loggedIn: false };
  const match = text.match(/logged in(?:\s+using\s+(.+))?/i);
  if (match) return { loggedIn: true, method: (match[1] || "").trim() || undefined };
  return { loggedIn: false, unrecognized: text.trim().slice(0, 200) || undefined };
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
    return { loggedIn: false, unrecognized: String(stdout || "").trim().slice(0, 200) || undefined };
  }
}

/**
 * Asks the CLI itself, rather than guessing from files on disk: the CLI knows
 * whether what it has is still usable. The credential file is reported too,
 * because the adapter needs that path and its absence explains a failed start.
 */
export async function loginStatus(name, { paths = gatewayPaths(), env = process.env, runner = execFileAsync } = {}) {
  const entry = backend(name);
  const directory = paths.authDir(name);
  const credentialPath = path.join(directory, entry.credentialFile);
  const credentialPresent = await fsp.access(credentialPath).then(() => true, () => false);
  const base = { backend: name, label: entry.label, directory, credentialPath, credentialPresent };
  let result;
  try {
    result = await runner(backendBin(entry, env), entry.statusArgs, {
      env: authEnvironment(entry, { paths, env }),
      timeout: 30_000,
    });
  } catch (error) {
    // A missing CLI and a CLI that reports "not logged in" on a non-zero exit are
    // different situations, and only the first one the user has to fix elsewhere.
    if (error?.code === "ENOENT") {
      return { ...base, loggedIn: false, cliAvailable: false, error: `${backendBin(entry, env)} is not installed` };
    }
    const stdout = error?.stdout || "";
    const parsed = name === "codex" ? parseCodexStatus(stdout) : parseClaudeStatus(stdout);
    if (parsed.loggedIn || parsed.unrecognized === undefined) return { ...base, cliAvailable: true, ...parsed };
    return { ...base, loggedIn: false, cliAvailable: true, error: shortError(error) };
  }
  const parsed = name === "codex" ? parseCodexStatus(result.stdout) : parseClaudeStatus(result.stdout);
  return { ...base, cliAvailable: true, ...parsed };
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
 */
export async function startLogin(name, {
  paths = gatewayPaths(),
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  const entry = backend(name);
  await fsp.mkdir(paths.authDir(name), { recursive: true });
  await fsp.mkdir(paths.logDir, { recursive: true });
  const logPath = paths.logFile(`login-${name}`);
  const handle = await fsp.open(logPath, "a");
  try {
    const child = spawnImpl(backendBin(entry, env), entry.loginArgs, {
      env: authEnvironment(entry, { paths, env }),
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd],
    });
    child.unref();
    return { ok: true, started: true, backend: name, pid: child.pid ?? null, logPath };
  } catch (error) {
    return { ok: false, started: false, backend: name, error: shortError(error) };
  } finally {
    await handle.close();
  }
}

export async function logout(name, { paths = gatewayPaths(), env = process.env, runner = execFileAsync } = {}) {
  const entry = backend(name);
  try {
    await runner(backendBin(entry, env), entry.logoutArgs, {
      env: authEnvironment(entry, { paths, env }),
      timeout: 60_000,
    });
    return { ok: true, backend: name };
  } catch (error) {
    return { ok: false, backend: name, error: shortError(error) };
  }
}
