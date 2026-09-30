// Starting, stopping and inspecting the local services: one adapter per account,
// and the router in front of them.
//
// None of these is registered with launchd, the Windows task scheduler or
// systemd. The control server spawns each service detached and records its pid,
// so a CLI or a UI that exits can still find and stop what it started — and so
// restarting the UI never kills a running proxy. After a reboot they are down
// until the control server starts; it then brings them up itself, and
// `cli.mjs install` (or, on macOS, `proxyctl.py install ui`) has the OS start it
// at login.
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { accountDirectory, authEnvironment, backend as authBackend, backendBin } from "./auth.mjs";
import { DEFAULT_MODE } from "./accounts.mjs";
import { gatewayPaths, sourceRoot } from "./paths.mjs";
import { SECRET_ENV, secretEnvironment } from "./secrets.mjs";

// What each kind of process is. An adapter runs once per account; the router once.
const ADAPTERS = Object.freeze({
  codex: Object.freeze({
    label: "Codex 어댑터",
    subdirectory: "codex-openai-proxy",
    // Present only because the adapter installs node dependencies of its own.
    dependenciesSubpath: path.join("node_modules", "@mariozechner", "pi-ai"),
  }),
  claude: Object.freeze({
    label: "Claude 어댑터",
    subdirectory: "claude-print-proxy",
    dependenciesSubpath: "",
  }),
});

const ROUTER_DEFAULT_PORT = 11400;

/**
 * The service folders with npm dependencies of their own, and the path that is
 * there once they are installed. `cli.mjs install` runs `npm ci` in each that
 * lacks it; `serviceStatus` reports the same check as `dependenciesReady`.
 */
export function dependencyFolders() {
  return Object.values(ADAPTERS)
    .filter(entry => entry.dependenciesSubpath)
    .map(entry => ({ subdirectory: entry.subdirectory, marker: entry.dependenciesSubpath }));
}

/** The router, as a service this gateway starts and stops. */
export function routerService(env = process.env) {
  const raw = Number.parseInt(String(env.GATEWAY_ROUTER_PORT || ""), 10);
  const port = Number.isInteger(raw) && raw > 0 && raw < 65_536 ? raw : ROUTER_DEFAULT_PORT;
  return Object.freeze({
    key: "router",
    kind: "router",
    label: "라우터",
    subdirectory: "router",
    dependenciesSubpath: "",
    port,
  });
}

/** One account's adapter. Its key is the account id, which names its pid and log files. */
export function adapterService(account) {
  const adapter = ADAPTERS[account.backend];
  if (!adapter) throw new Error(`unknown backend: ${account.backend}`);
  return Object.freeze({
    key: account.id,
    kind: "adapter",
    backend: account.backend,
    account,
    label: `${adapter.label} ${account.id.split("-").pop()}`,
    subdirectory: adapter.subdirectory,
    dependenciesSubpath: adapter.dependenciesSubpath,
    port: account.port,
  });
}

export function serviceUrl(entry) {
  return `http://127.0.0.1:${entry.port}`;
}

/**
 * The environment one service needs. Secrets are injected here and nowhere else,
 * so no key reaches a command line or a response body.
 */
export function serviceEnvironment(entry, { secrets, paths = gatewayPaths(), env = process.env }) {
  const result = { ...env, HOST: "127.0.0.1", PORT: String(entry.port) };
  if (entry.kind === "adapter") {
    Object.assign(result, secretEnvironment(entry.backend, secrets));
    const directory = accountDirectory(entry.account, paths);
    if (entry.backend === "codex") {
      result.CODEX_HOME = directory;
      result.CODEX_AUTH_PATH = path.join(directory, authBackend("codex").credentialFile);
    }
    if (entry.backend === "claude") {
      // The adapter spawns the CLI with its own environment, so pointing the
      // adapter at this directory is enough for the child to use it too.
      result.CLAUDE_CONFIG_DIR = directory;
      result.CLAUDE_BIN = backendBin(authBackend("claude"), env);
    }
  }
  if (entry.kind === "router") {
    Object.assign(result, secretEnvironment("router", secrets));
    result.ROUTER_CONFIG = paths.routerConfigFile;
    // The router presents these to the adapters it calls, per `apiKeyEnv`.
    for (const name of ["codex", "claude"]) Object.assign(result, secretEnvironment(name, secrets));
  }
  return result;
}

/**
 * The router config, written from the accounts that are logged in, in the user's
 * order: every account is a backend of its own, and accounts of one subscription
 * list the same models, which is what lets the router move between them.
 */
export function routerConfig({ accounts, mode = DEFAULT_MODE, env = process.env, ollamaBaseUrl = "" }) {
  const entries = accounts.map(account => ({
    name: account.id,
    baseUrl: `${serviceUrl(adapterService(account))}/v1`,
    discoverModels: true,
    apiKeyEnv: SECRET_ENV[account.backend],
  }));
  if (ollamaBaseUrl) {
    entries.push({ name: "ollama", baseUrl: ollamaBaseUrl.replace(/\/+$/, ""), discoverModels: true });
  }
  return {
    listen: { host: "127.0.0.1", port: routerService(env).port },
    clientAuthEnv: SECRET_ENV.router,
    routing: { mode },
    backends: entries,
  };
}

export async function writeRouterConfig(config, { paths = gatewayPaths() } = {}) {
  await fsp.mkdir(path.dirname(paths.routerConfigFile), { recursive: true });
  await fsp.writeFile(paths.routerConfigFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return paths.routerConfigFile;
}

async function readPid(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    const pid = Number.parseInt(String(parsed?.pid ?? ""), 10);
    return Number.isInteger(pid) && pid > 0 ? { pid, startedAt: parsed?.startedAt || null } : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists and belongs to someone else, which for our
    // purposes is "not ours"; only ESRCH proves it is gone.
    return error?.code === "EPERM";
  }
}

export async function pidState(file) {
  const recorded = await readPid(file);
  if (!recorded) return { running: false, pid: null };
  if (!alive(recorded.pid)) return { running: false, pid: recorded.pid, stale: true };
  return { running: true, pid: recorded.pid, startedAt: recorded.startedAt };
}

export async function probeHealth(url, { fetchImpl = globalThis.fetch, timeoutMs = 2_000 } = {}) {
  try {
    const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, status: response.status };
    const body = await response.json().catch(() => null);
    return { ok: true, status: response.status, body: body || undefined };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200) };
  }
}

/** The key this gateway presents to a service, which is the key that service checks. */
function serviceSecret(entry, secrets) {
  if (!secrets) return "";
  return String(secrets[entry.kind === "router" ? "router" : entry.backend] || "");
}

/**
 * Whether the service on `url` takes this gateway's key. /health is open to
 * anyone, so it cannot tell our service from one an earlier install left
 * running with its own keys; GET /v1/models is where the adapters and the router
 * check the shared key, and what the router itself asks the adapters for. Only a
 * 401 or 403 counts as refused: a timeout or a 5xx proves nothing either way.
 */
export async function probeAuth(url, secret, { fetchImpl = globalThis.fetch, timeoutMs = 3_000 } = {}) {
  try {
    const response = await fetchImpl(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel?.().catch(() => {});
    return { refused: response.status === 401 || response.status === 403, status: response.status };
  } catch (error) {
    return { refused: false, error: String(error?.message || error).slice(0, 200) };
  }
}

/** What the screen and the CLI say about a port held by something that refuses our key. */
export function foreignMessage(port, { pid } = {}) {
  const holder = pid ? `(pid ${pid})` : "";
  return `포트 ${port}을 이 게이트웨이의 키를 모르는 다른 프로그램${holder}이 쓰고 있습니다. `
    + "예전에 설치한 게이트웨이가 남아 있을 수 있습니다. "
    + "그 프로그램을 끄거나 컴퓨터를 다시 시작한 뒤 연결을 누르세요.";
}

/**
 * `secrets`, when given, lets this tell our service from a foreign one on the
 * port. Without it (a caller that only looks and holds no keys) whatever answers
 * /health counts as running, as it always did.
 */
export async function serviceStatus(entry, { paths = gatewayPaths(), fetchImpl = globalThis.fetch, secrets } = {}) {
  const url = serviceUrl(entry);
  const [pid, health] = await Promise.all([
    pidState(paths.pidFile(entry.key)),
    probeHealth(url, { fetchImpl }),
  ]);
  const sourceDir = path.join(sourceRoot(), entry.subdirectory);
  const dependenciesReady = entry.dependenciesSubpath
    ? await fsp.access(path.join(sourceDir, entry.dependenciesSubpath)).then(() => true, () => false)
    : true;
  // Something answers that this gateway did not start. It may be ours all the
  // same (started by an earlier run of this screen, with these keys), or an
  // earlier install's, holding keys this one never had: then the router's every
  // request to it is refused, and the router lists no models.
  const secret = serviceSecret(entry, secrets);
  const auth = health.ok && !pid.running && secret
    ? await probeAuth(url, secret, { fetchImpl })
    : null;
  const foreign = Boolean(auth?.refused);
  return {
    name: entry.key,
    kind: entry.kind,
    backend: entry.backend,
    label: entry.label,
    url,
    port: entry.port,
    // Health, not the pid, decides whether it is usable: a service started by
    // something else answers too, and this gateway should say so rather than
    // claim it is down and then fail to bind the port. One that refuses our key
    // is not usable, however healthy it says it is.
    running: health.ok && !foreign,
    managed: pid.running,
    foreign,
    ...(foreign ? { error: foreignMessage(entry.port) } : {}),
    pid: pid.pid,
    stalePidFile: Boolean(pid.stale),
    dependenciesReady,
    sourceDir,
    health,
  };
}

// ------------------------------------------------------- who holds a port

function runFile(file, args, { timeoutMs = 5_000 } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || "") });
    });
  });
}

function pidsIn(text) {
  return [...new Set(String(text || "").split(/\s+/)
    .map(word => Number.parseInt(word, 10))
    .filter(pid => Number.isInteger(pid) && pid > 0))];
}

function checkedNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`not a port or pid: ${value}`);
  return number;
}

/**
 * The OS side of finding who holds a port: the listening pids, what one of them
 * runs and from where, and stopping it. Ports and pids are checked to be
 * integers, so nothing else reaches a command line. A step that cannot tell
 * answers "unknown" (no pids, no description), and unknown is never ours.
 */
export function systemProcesses({ platform = process.platform, run = runFile, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  if (platform === "win32") {
    const powershell = command => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
    return {
      async listeners(port) {
        const result = await powershell(`Get-NetTCPConnection -LocalPort ${checkedNumber(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`);
        return pidsIn(result.stdout);
      },
      // Windows has no cheap way to read another process's working directory;
      // its command line is what there is.
      async describe(pid) {
        const result = await powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${checkedNumber(pid)}").CommandLine`);
        const command = result.stdout.trim();
        return command ? { command, cwd: null } : null;
      },
      async stop(pid) { kill(checkedNumber(pid)); },
    };
  }
  return {
    async listeners(port) {
      const result = await run("lsof", ["-nP", `-tiTCP:${checkedNumber(port)}`, "-sTCP:LISTEN"]);
      return pidsIn(result.stdout);
    },
    async describe(pid) {
      const id = String(checkedNumber(pid));
      const [ps, lsof] = await Promise.all([
        run("ps", ["-ww", "-o", "command=", "-p", id]),
        run("lsof", ["-a", "-p", id, "-d", "cwd", "-Fn"]),
      ]);
      const command = ps.stdout.trim();
      const line = lsof.stdout.split(/\r?\n/).find(entry => entry.startsWith("n"));
      if (!command || !line) return null;
      // A folder deleted under a running process: Linux adds " (deleted)".
      return { command, cwd: line.slice(1).replace(/ \(deleted\)$/, "") };
    },
    async stop(pid) { kill(checkedNumber(pid), "SIGTERM"); },
  };
}

function samePath(a, b, platform) {
  if (!a || !b) return false;
  const flavor = platform === "win32" ? path.win32 : path.posix;
  const tidy = value => {
    const normal = flavor.normalize(String(value)).replace(/[\\/]+$/, "");
    return platform === "win32" ? normal.toLowerCase() : normal;
  };
  return tidy(a) === tidy(b);
}

function unquote(text) {
  const trimmed = String(text || "").trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Whether `info` ({ command, cwd }) is a copy of this gateway's own service
 * from one of `sourceDirs` (its source folder as spelled and as resolved). It
 * is when node runs server.mjs from that folder: named relatively with the
 * folder as its working directory, which is how this gateway starts it, or by
 * its full path there. The folder is compared by name, so one deleted and
 * recreated by a reinstall still matches. On Windows, where the working
 * directory cannot be read, only the full path in the command line counts.
 */
export function isOwnService(info, sourceDirs, platform = process.platform) {
  if (!info?.command) return false;
  const flavor = platform === "win32" ? path.win32 : path.posix;
  const match = String(info.command).trim().match(/^("[^"]+"|.+?)\s+("[^"]+"|\S+)$/);
  if (!match) return false;
  const executable = flavor.basename(unquote(match[1])).toLowerCase();
  if (executable !== "node" && executable !== "node.exe") return false;
  const script = unquote(match[2]);
  const dirs = sourceDirs.filter(Boolean);
  const inCwd = dirs.some(dir => samePath(info.cwd, dir, platform));
  if (script === "server.mjs") return platform !== "win32" && inCwd;
  const named = dirs.some(dir => samePath(script, flavor.join(dir, "server.mjs"), platform));
  return named && (platform === "win32" || inCwd);
}

/**
 * The port is held by something that refuses our key. When that is an earlier
 * copy of this very service, left behind by a reinstall with the keys of the
 * install before, it is stopped so ours can start. Anything else is left alone
 * and reported.
 */
async function clearStaleCopy(entry, status, { processes, fetchImpl, platform, stopTimeoutMs, pollMs }) {
  const pids = await Promise.resolve().then(() => processes.listeners(entry.port)).catch(() => []);
  const pid = pids.length === 1 ? pids[0] : undefined;
  if (!pid || pid === process.pid) return { ok: false, error: foreignMessage(entry.port, { pid }) };
  const info = await Promise.resolve().then(() => processes.describe(pid)).catch(() => null);
  const dirs = [status.sourceDir, await fsp.realpath(status.sourceDir).catch(() => "")];
  if (!isOwnService(info, dirs, platform)) return { ok: false, pid, error: foreignMessage(entry.port, { pid }) };
  try {
    await processes.stop(pid);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      return { ok: false, pid, error: `${foreignMessage(entry.port, { pid })} (멈추지 못했습니다: ${String(error?.message || error).slice(0, 200)})` };
    }
  }
  const deadline = Date.now() + stopTimeoutMs;
  while ((await probeHealth(serviceUrl(entry), { fetchImpl, timeoutMs: 1_000 })).ok) {
    if (Date.now() >= deadline) {
      return { ok: false, pid, error: `포트 ${entry.port}에 남아 있던 예전 ${entry.label}(pid ${pid})를 멈추게 했지만 포트가 비지 않습니다. 컴퓨터를 다시 시작한 뒤 연결을 누르세요.` };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return { ok: true, pid };
}

export async function startService(entry, {
  secrets,
  paths = gatewayPaths(),
  env = process.env,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  readyTimeoutMs = 30_000,
  platform = process.platform,
  processes = systemProcesses({ platform }),
  stopTimeoutMs = 10_000,
  pollMs = 200,
} = {}) {
  const existing = await serviceStatus(entry, { paths, fetchImpl, secrets });
  if (existing.running) return { ok: true, started: false, alreadyRunning: true, status: existing };
  let replaced = null;
  if (existing.foreign) {
    const cleared = await clearStaleCopy(entry, existing, { processes, fetchImpl, platform, stopTimeoutMs, pollMs });
    if (!cleared.ok) {
      return { ok: false, started: false, foreign: true, error: cleared.error, ...(cleared.pid ? { holderPid: cleared.pid } : {}), status: existing };
    }
    replaced = cleared.pid;
  }
  if (!existing.dependenciesReady) {
    return { ok: false, started: false, error: `${entry.label}의 의존성이 아직 설치되지 않았습니다`, status: existing };
  }
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.mkdir(paths.logDir, { recursive: true });
  const handle = await fsp.open(paths.logFile(entry.key), "a");
  let child;
  try {
    child = spawnImpl(process.execPath, ["server.mjs"], {
      cwd: existing.sourceDir,
      env: serviceEnvironment(entry, { secrets, paths, env }),
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd],
    });
    child.unref();
  } catch (error) {
    return { ok: false, started: false, error: String(error?.message || error).slice(0, 300), status: existing };
  } finally {
    await handle.close();
  }
  await fsp.writeFile(
    paths.pidFile(entry.key),
    `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  const deadline = Date.now() + readyTimeoutMs;
  let status = await serviceStatus(entry, { paths, fetchImpl, secrets });
  while (!status.running && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
    status = await serviceStatus(entry, { paths, fetchImpl, secrets });
  }
  return {
    ok: status.running,
    started: true,
    ...(replaced ? { replacedStalePid: replaced } : {}),
    status,
    ...(status.running ? {} : { error: `${entry.label}가 시작되지 않았습니다. ${paths.logFile(entry.key)} 를 보세요`, logPath: paths.logFile(entry.key) }),
  };
}

export async function stopService(entry, {
  paths = gatewayPaths(),
  fetchImpl = globalThis.fetch,
  confirmAttempts = 5,
  confirmDelayMs = 1_000,
} = {}) {
  const pid = await pidState(paths.pidFile(entry.key));
  if (!pid.running) {
    await fsp.rm(paths.pidFile(entry.key), { force: true });
    const status = await serviceStatus(entry, { paths, fetchImpl });
    // Something this gateway did not start may still hold the port. Say that
    // instead of reporting a stop that did not happen.
    return { ok: !status.running, stopped: false, unmanaged: status.running, status };
  }
  // A pid file holds only a number, and after a restart or a crash that number
  // can belong to another program by now: the router's pid file outlives a
  // reboot, and connect() stops the router first. A service of this gateway
  // answers on its port, so only then is the pid signalled. One that was just
  // spawned gets a few seconds to start answering; one that never does is
  // forgotten, not killed.
  let answering = false;
  for (let attempt = 0; attempt < confirmAttempts && !answering; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, confirmDelayMs));
    answering = (await probeHealth(serviceUrl(entry), { fetchImpl })).ok;
  }
  if (!answering) {
    await fsp.rm(paths.pidFile(entry.key), { force: true });
    const status = await serviceStatus(entry, { paths, fetchImpl });
    return { ok: !status.running, stopped: false, unverified: true, status };
  }
  try {
    process.kill(pid.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") return { ok: false, stopped: false, error: String(error?.message || error) };
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (!(await pidState(paths.pidFile(entry.key))).running) break;
  }
  await fsp.rm(paths.pidFile(entry.key), { force: true });
  const status = await serviceStatus(entry, { paths, fetchImpl });
  return { ok: !status.running, stopped: true, status };
}

/**
 * Why the router lists no model, from its /health: each backend there says how
 * its last model discovery went. An adapter that refused the router's key (one
 * an earlier install left on the port) is a different problem from a router
 * with no account behind it, and needs a different fix. Null when /health says
 * nothing that explains it.
 */
export function emptyModelsReason(routerHealth) {
  const backends = Array.isArray(routerHealth?.backends) ? routerHealth.backends : [];
  if (!backends.length) return null;
  const failed = backends.filter(entry => entry?.discovery && entry.discovery.ok === false);
  const refused = failed.filter(entry => entry.discovery.status === 401 || entry.discovery.status === 403);
  if (refused.length) {
    const names = refused.map(entry => `${entry.name}: HTTP ${entry.discovery.status}`).join(", ");
    return `어댑터가 키를 거절합니다 (${names}). 예전에 설치한 게이트웨이의 어댑터가 포트를 쓰고 있을 수 있습니다. 게이트웨이 화면에서 연결을 누르세요. 그래도 그대로면 그 프로그램을 끄거나 컴퓨터를 다시 시작하세요`;
  }
  if (failed.length) {
    const names = failed.map(entry => `${entry.name}: ${entry.discovery.reason || "응답 없음"}`).join(", ");
    return `어댑터가 모델 목록을 주지 않습니다 (${names})`;
  }
  return null;
}

export { authEnvironment };
