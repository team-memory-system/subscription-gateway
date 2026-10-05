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
import http from "node:http";
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
 * What the screen can take back from the person to finish a login whose browser
 * is on another computer:
 *
 *   "callback"  Codex. Its sign-in ends by sending the browser to
 *               http://localhost:1455/auth/callback?code=...&state=..., which is
 *               the codex process on *this* machine. From another computer that
 *               page does not load, but its address does; the screen replays it
 *               here (replayCallback).
 *   "code"      Claude. Its sign-in page shows a code, which the CLI reads from
 *               stdin at "Paste code here if prompted >". A pipe is enough: both
 *               on Linux and on macOS the CLI reads the line and exchanges it.
 *   null        Claude on Windows, where the login shares the screen's console
 *               and keeps stdin ignored, as before.
 *
 * On the same machine none of it is needed: the CLI opens the browser and its
 * own localhost callback finishes the login, exactly as before.
 */
export function loginInput(backendName, platform = process.platform) {
  if (backendName === "codex") return "callback";
  if (backendName === "claude" && platform !== "win32") return "code";
  return null;
}

/**
 * Starts a login and returns immediately. The CLI opens a browser and the person
 * finishes there, so this cannot report success; the caller polls `loginStatus`.
 * Output goes to a log file because a detached process with no stdout can wedge
 * a CLI that still tries to print. `logOffset` is where this login's output
 * starts in that file, which is where its sign-in URL is read from.
 *
 * Claude's stdin is a pipe (see loginInput) and `onSpawn` receives the child,
 * so the caller can write the code to it; every other login keeps stdin ignored.
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
  onSpawn,
} = {}) {
  const entry = backend(account.backend);
  await fsp.mkdir(accountDirectory(account, paths), { recursive: true });
  await fsp.mkdir(paths.logDir, { recursive: true });
  const logPath = paths.logFile(`login-${account.id}`);
  const handle = await fsp.open(logPath, "a");
  const input = loginInput(entry.name, platform);
  try {
    const logOffset = (await handle.stat()).size;
    const call = resolve(backendBin(entry, env), entry.loginArgs, { env, platform });
    const child = spawnImpl(call.file, call.args, invocationOptions(call, {
      env: authEnvironment(account, { paths, env }),
      detached: platform !== "win32",
      stdio: [input === "code" ? "pipe" : "ignore", handle.fd, handle.fd],
    }, platform));
    // A code written after the CLI has exited must not take the screen down with EPIPE.
    child.stdin?.on?.("error", () => {});
    child.unref();
    onSpawn?.(child);
    return { ok: true, started: true, accountId: account.id, backend: account.backend, pid: child.pid ?? null, logPath, logOffset, input };
  } catch (error) {
    return { ok: false, started: false, accountId: account.id, backend: account.backend, error: shortError(error) };
  } finally {
    await handle.close();
  }
}

const ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const URLS = /https?:\/\/[^\s\u0007\u001b"'<>]+/g;

/** A login's output as text a person could read: no terminal escapes, no carriage returns. */
export function plainOutput(text) {
  return String(text || "").replace(ESCAPES, "").replace(/\r/g, "");
}

/**
 * The sign-in address a login printed ("If your browser did not open, navigate
 * to this URL", "If the browser didn't open, visit:"): the first https URL whose
 * path ends in /authorize. Null until the CLI has printed it.
 */
export function signInUrl(output) {
  for (const candidate of plainOutput(output).match(URLS) || []) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && /\/authorize$/.test(url.pathname)) return url.href;
    } catch {
      // not a URL after all
    }
  }
  return null;
}

// Claude's prompt. A code read from a pipe is not echoed, so its answer follows on the same line.
const CODE_PROMPT = /^Paste code here if prompted >\s*/;

/** The last line a login printed, without addresses: why it ended, when it ended badly. */
export function lastOutputLine(output) {
  const lines = plainOutput(output).split("\n").map(line => line.replace(URLS, "").replace(CODE_PROMPT, "").trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Where a Codex sign-in sends the browser back to, from its redirect_uri: a loopback port and path. */
export function callbackTarget(signIn) {
  try {
    const redirect = new URL(new URL(signIn).searchParams.get("redirect_uri") || "");
    if (redirect.protocol !== "http:" || !LOOPBACK_NAMES.has(redirect.hostname) || !redirect.port) return null;
    return { port: Number(redirect.port), pathname: redirect.pathname };
  } catch {
    return null;
  }
}

/**
 * Checks an address the person pasted against the login's own redirect_uri: the
 * same loopback port and path, with the state the browser came back with. Only
 * that address is ever requested, and only on this machine's loopback.
 */
export function callbackRequest(signIn, pasted) {
  const target = callbackTarget(signIn);
  if (!target) return { ok: false, error: "이 로그인은 주소를 받지 않습니다" };
  let text = String(pasted || "").trim();
  if (/^(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "주소를 읽을 수 없습니다. 브라우저 주소창의 주소를 통째로 붙여 넣으세요" };
  }
  if (url.protocol !== "http:" || !LOOPBACK_NAMES.has(url.hostname) || Number(url.port) !== target.port || url.pathname !== target.pathname) {
    return { ok: false, error: `localhost:${target.port}${target.pathname} 로 시작하는 주소가 아닙니다` };
  }
  if (!url.searchParams.get("state") || !(url.searchParams.get("code") || url.searchParams.get("error"))) {
    return { ok: false, error: "주소에 code 와 state 가 없습니다. 로그인을 끝낸 뒤 주소창의 주소를 붙여 넣으세요" };
  }
  return { ok: true, port: target.port, path: `${url.pathname}${url.search}` };
}

function loopbackGet(port, requestPath, { timeoutMs }) {
  return new Promise(resolve => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath, headers: { host: `localhost:${port}` }, timeout: timeoutMs }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => { if (size < 16_384) { chunks.push(chunk); size += chunk.length; } });
      response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", error => resolve({ error: String(error?.message || error) }));
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", error => resolve({ error: String(error?.message || error) }));
  });
}

function bodyLine(body) {
  return String(body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Sends the browser's last request again, from here: GET the pasted callback on
 * 127.0.0.1, where the codex login listens. The CLI then exchanges the code, as
 * if the browser had reached it. A redirect back to that same server (its
 * success page, which is when it exits) is followed once. Nothing of the answer
 * goes back but its status and, on an error, its first words.
 */
export async function replayCallback(signIn, pasted, { get = loopbackGet, timeoutMs = 60_000 } = {}) {
  const checked = callbackRequest(signIn, pasted);
  if (!checked.ok) return checked;
  const answer = await get(checked.port, checked.path, { timeoutMs });
  if (answer.error) return { ok: false, error: `로그인 중인 codex 에 닿지 못했습니다: ${answer.error}` };
  if (answer.status >= 400) return { ok: false, status: answer.status, error: bodyLine(answer.body) || `HTTP ${answer.status}` };
  if (answer.status >= 300 && answer.location) {
    let next = null;
    try {
      next = new URL(answer.location, `http://localhost:${checked.port}`);
    } catch {
      // an address we will not follow
    }
    // Whether the login worked is the CLI's to say (loginStatus); this page only lets it finish.
    if (next && next.protocol === "http:" && LOOPBACK_NAMES.has(next.hostname) && Number(next.port) === checked.port) {
      await get(checked.port, `${next.pathname}${next.search}`, { timeoutMs });
    }
  }
  return { ok: true, status: answer.status };
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
