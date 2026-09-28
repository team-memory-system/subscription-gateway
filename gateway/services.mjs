// Starting, stopping and inspecting the three local services.
//
// Nothing is registered with launchd, the Windows task scheduler or systemd. The
// control server spawns each service detached and records its pid, so a CLI or a
// UI that exits can still find and stop what it started — and so restarting the
// UI never kills a running proxy. The cost is that a reboot leaves them down
// until something starts them again.
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

import { authEnvironment, backend as authBackend, backendBin } from "./auth.mjs";
import { gatewayPaths, sourceRoot } from "./paths.mjs";
import { SECRET_ENV, secretEnvironment } from "./secrets.mjs";

export const SERVICES = Object.freeze([
  Object.freeze({
    name: "codex",
    label: "Codex 어댑터",
    subdirectory: "codex-openai-proxy",
    defaultPort: 11435,
    // Present only because the adapter installs node dependencies of its own.
    dependenciesSubpath: path.join("node_modules", "@mariozechner", "pi-ai"),
    authBackend: "codex",
  }),
  Object.freeze({
    name: "claude",
    label: "Claude 어댑터",
    subdirectory: "claude-print-proxy",
    defaultPort: 11446,
    dependenciesSubpath: "",
    authBackend: "claude",
  }),
  Object.freeze({
    name: "router",
    label: "라우터",
    subdirectory: "router",
    defaultPort: 11400,
    dependenciesSubpath: "",
    authBackend: null,
  }),
]);

export function service(name) {
  const found = SERVICES.find(entry => entry.name === name);
  if (!found) throw new Error(`unknown service: ${name}`);
  return found;
}

export function servicePort(entry, env = process.env) {
  const raw = Number.parseInt(String(env[`GATEWAY_${entry.name.toUpperCase()}_PORT`] || ""), 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65_536 ? raw : entry.defaultPort;
}

export function serviceUrl(entry, env = process.env) {
  return `http://127.0.0.1:${servicePort(entry, env)}`;
}

/**
 * The environment one service needs. Secrets are injected here and nowhere else,
 * so no key reaches a command line or a response body.
 */
export function serviceEnvironment(entry, { secrets, paths = gatewayPaths(), env = process.env }) {
  const result = {
    ...env,
    HOST: "127.0.0.1",
    PORT: String(servicePort(entry, env)),
    ...secretEnvironment(entry.name, secrets),
  };
  if (entry.name === "codex") {
    const codex = authBackend("codex");
    result.CODEX_HOME = paths.authDir("codex");
    result.CODEX_AUTH_PATH = path.join(paths.authDir("codex"), codex.credentialFile);
  }
  if (entry.name === "claude") {
    const claude = authBackend("claude");
    // The adapter spawns the CLI with its own environment, so pointing the
    // adapter at this directory is enough for the child to use it too.
    result.CLAUDE_CONFIG_DIR = paths.authDir("claude");
    result.CLAUDE_BIN = backendBin(claude, env);
  }
  if (entry.name === "router") {
    result.ROUTER_CONFIG = paths.routerConfigFile;
    // The router presents these to the backends it calls, per `apiKeyEnv`.
    for (const name of ["codex", "claude"]) Object.assign(result, secretEnvironment(name, secrets));
  }
  return result;
}

/** The router config, written from what is actually enabled rather than a sample. */
export function routerConfig({ backends, env = process.env, ollamaBaseUrl = "" }) {
  const entries = [];
  for (const name of backends) {
    const entry = service(name);
    entries.push({
      name,
      baseUrl: `${serviceUrl(entry, env)}/v1`,
      discoverModels: true,
      apiKeyEnv: SECRET_ENV[name],
    });
  }
  if (ollamaBaseUrl) {
    entries.push({ name: "ollama", baseUrl: ollamaBaseUrl.replace(/\/+$/, ""), discoverModels: true });
  }
  return {
    listen: { host: "127.0.0.1", port: servicePort(service("router"), env) },
    clientAuthEnv: SECRET_ENV.router,
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

export async function serviceStatus(name, { paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const entry = service(name);
  const url = serviceUrl(entry, env);
  const [pid, health] = await Promise.all([
    pidState(paths.pidFile(name)),
    probeHealth(url, { fetchImpl }),
  ]);
  const sourceDir = path.join(sourceRoot(), entry.subdirectory);
  const dependenciesReady = entry.dependenciesSubpath
    ? await fsp.access(path.join(sourceDir, entry.dependenciesSubpath)).then(() => true, () => false)
    : true;
  return {
    name,
    label: entry.label,
    url,
    port: servicePort(entry, env),
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

export async function startService(name, {
  secrets,
  paths = gatewayPaths(),
  env = process.env,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  readyTimeoutMs = 30_000,
} = {}) {
  const entry = service(name);
  const existing = await serviceStatus(name, { paths, env, fetchImpl });
  if (existing.running) return { ok: true, started: false, alreadyRunning: true, status: existing };
  if (!existing.dependenciesReady) {
    return { ok: false, started: false, error: `${entry.label}의 의존성이 아직 설치되지 않았습니다`, status: existing };
  }
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.mkdir(paths.logDir, { recursive: true });
  const handle = await fsp.open(paths.logFile(name), "a");
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
    paths.pidFile(name),
    `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  const deadline = Date.now() + readyTimeoutMs;
  let status = await serviceStatus(name, { paths, env, fetchImpl });
  while (!status.running && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
    status = await serviceStatus(name, { paths, env, fetchImpl });
  }
  return {
    ok: status.running,
    started: true,
    status,
    ...(status.running ? {} : { error: `${entry.label}가 시작되지 않았습니다. ${paths.logFile(name)} 를 보세요`, logPath: paths.logFile(name) }),
  };
}

export async function stopService(name, { paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const pid = await pidState(paths.pidFile(name));
  if (!pid.running) {
    await fsp.rm(paths.pidFile(name), { force: true });
    const status = await serviceStatus(name, { paths, env, fetchImpl });
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
    if (!(await pidState(paths.pidFile(name))).running) break;
  }
  await fsp.rm(paths.pidFile(name), { force: true });
  const status = await serviceStatus(name, { paths, env, fetchImpl });
  return { ok: !status.running, stopped: true, status };
}

export { authEnvironment };
