// Starting, stopping and inspecting the local services: one adapter per account,
// and the router in front of them.
//
// Nothing is registered with launchd, the Windows task scheduler or systemd. The
// control server spawns each service detached and records its pid, so a CLI or a
// UI that exits can still find and stop what it started — and so restarting the
// UI never kills a running proxy. The cost is that a reboot leaves them down
// until something starts them again.
import { spawn } from "node:child_process";
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

export async function serviceStatus(entry, { paths = gatewayPaths(), fetchImpl = globalThis.fetch } = {}) {
  const url = serviceUrl(entry);
  const [pid, health] = await Promise.all([
    pidState(paths.pidFile(entry.key)),
    probeHealth(url, { fetchImpl }),
  ]);
  const sourceDir = path.join(sourceRoot(), entry.subdirectory);
  const dependenciesReady = entry.dependenciesSubpath
    ? await fsp.access(path.join(sourceDir, entry.dependenciesSubpath)).then(() => true, () => false)
    : true;
  return {
    name: entry.key,
    kind: entry.kind,
    backend: entry.backend,
    label: entry.label,
    url,
    port: entry.port,
    // Health, not the pid, decides whether it is usable: a service started by
    // something else answers too, and this gateway should say so rather than
    // claim it is down and then fail to bind the port.
    running: health.ok,
    managed: pid.running,
    pid: pid.pid,
    stalePidFile: Boolean(pid.stale),
    dependenciesReady,
    sourceDir,
    health,
  };
}

export async function startService(entry, {
  secrets,
  paths = gatewayPaths(),
  env = process.env,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  readyTimeoutMs = 30_000,
} = {}) {
  const existing = await serviceStatus(entry, { paths, fetchImpl });
  if (existing.running) return { ok: true, started: false, alreadyRunning: true, status: existing };
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
  let status = await serviceStatus(entry, { paths, fetchImpl });
  while (!status.running && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
    status = await serviceStatus(entry, { paths, fetchImpl });
  }
  return {
    ok: status.running,
    started: true,
    status,
    ...(status.running ? {} : { error: `${entry.label}가 시작되지 않았습니다. ${paths.logFile(entry.key)} 를 보세요`, logPath: paths.logFile(entry.key) }),
  };
}

export async function stopService(entry, { paths = gatewayPaths(), fetchImpl = globalThis.fetch } = {}) {
  const pid = await pidState(paths.pidFile(entry.key));
  if (!pid.running) {
    await fsp.rm(paths.pidFile(entry.key), { force: true });
    const status = await serviceStatus(entry, { paths, fetchImpl });
    // Something this gateway did not start may still hold the port. Say that
    // instead of reporting a stop that did not happen.
    return { ok: !status.running, stopped: false, unmanaged: status.running, status };
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

export { authEnvironment };
