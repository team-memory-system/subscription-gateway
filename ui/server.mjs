// The control screen's own server.
//
// It is deliberately separate from the three services it manages: the screen is
// most needed exactly when nothing is running, which is when you log in and start
// things. It binds to loopback only and checks Host and Origin on every request,
// because a page on another site must not be able to drive a login or read what a
// backend answered.
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addAccount,
  findAccount,
  MODES,
  moveAccount,
  readAccounts,
  removeAccount,
  setMode,
} from "../gateway/accounts.mjs";
import { BACKENDS, loginStatus, logout, startLogin } from "../gateway/auth.mjs";
import { gatewayPaths } from "../gateway/paths.mjs";
import { loadSecrets, SECRET_ENV } from "../gateway/secrets.mjs";
import {
  adapterService,
  routerConfig,
  routerService,
  serviceStatus,
  serviceUrl,
  startService,
  stopService,
  writeRouterConfig,
} from "../gateway/services.mjs";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 11450;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);
const MAX_BODY_BYTES = 64 * 1024;
// How often the gateway checks that what it connected is still running.
export const KEEP_INTERVAL_MS = 30_000;
const KEEP_MAX_BACKOFF_MS = 10 * 60_000;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

function hostname(value) {
  const host = String(value || "").trim();
  if (!host) return "";
  const match = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  return match ? match[1] : "";
}

/**
 * Only a browser on this machine, on our own origin, sending JSON. The Origin
 * check is what stops another site's page from posting here; the Host check is
 * what stops a DNS-rebinding name from resolving to us.
 */
export function requestAllowed(req, { port }) {
  const host = hostname(req.headers.host);
  if (!LOOPBACK_HOSTS.has(host)) return { ok: false, status: 403, error: "loopback only" };
  const address = req.socket?.remoteAddress ? String(req.socket.remoteAddress).replace(/^::ffff:/, "") : "";
  if (address && !LOOPBACK_HOSTS.has(address)) return { ok: false, status: 403, error: "loopback only" };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (!allowed.has(origin)) return { ok: false, status: 403, error: "cross-origin request refused" };
  }
  if (req.method === "POST") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return { ok: false, status: 415, error: "send application/json" };
  }
  return { ok: true };
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw Object.assign(new Error("body is not valid JSON"), { status: 400 });
  }
}

/** The router's own view of each account: cooldowns and how much it has been used. */
function routingByAccount(routerStatus) {
  const backends = routerStatus?.health?.body?.backends;
  if (!Array.isArray(backends)) return {};
  return Object.fromEntries(backends
    .filter(entry => entry && typeof entry.name === "string" && entry.routing)
    .map(entry => [entry.name, entry.routing]));
}

/** Everything the screen draws. No secret is part of this. */
export async function statusReport({ paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch, runner } = {}) {
  const state = await readAccounts({ paths });
  const ask = runner ? { paths, env, runner } : { paths, env };
  const router = routerService(env);
  const [{ secrets }, logins, adapters, routerStatus] = await Promise.all([
    loadSecrets({ paths }),
    Promise.all(state.accounts.map(account => loginStatus(account, ask))),
    Promise.all(state.accounts.map(account => serviceStatus(adapterService(account), { paths, fetchImpl }))),
    serviceStatus(router, { paths, fetchImpl }),
  ]);
  let models = { ok: false, reason: "라우터가 실행 중이 아닙니다" };
  if (routerStatus.running) {
    models = await routerModels({ secrets, env, fetchImpl });
  }
  const routing = routingByAccount(routerStatus);
  const accounts = state.accounts.map((account, index) => ({
    ...account,
    login: logins[index],
    service: adapters[index],
    routing: routing[account.id] || null,
  }));
  // Serving means the router routes to it, not only that its adapter is up: an
  // adapter started after the router is invisible to it until a reconnect.
  const serving = accounts
    .filter(account => account.service.running && account.routing)
    .map(account => account.id);
  return {
    ok: true,
    appHome: paths.appHome,
    secretEnvNames: SECRET_ENV,
    mode: state.mode,
    modes: MODES,
    backends: BACKENDS.map(entry => ({ name: entry.name, label: entry.label })),
    accounts,
    services: [...adapters, routerStatus],
    models,
    ready: accounts.some(account => account.login.loggedIn),
    // The one address anything else should be pointed at, and whether it is
    // actually answering for at least one account right now.
    endpoint: `${serviceUrl(router)}/v1`,
    connected: routerStatus.running && serving.length > 0,
    servingAccounts: serving,
  };
}

async function routerModels({ secrets, env = process.env, fetchImpl = globalThis.fetch }) {
  const url = `${serviceUrl(routerService(env))}/v1/models`;
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${secrets.router}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, reason: `라우터가 HTTP ${response.status} 를 돌려줬습니다` };
    const body = await response.json();
    const data = Array.isArray(body?.data) ? body.data : [];
    return { ok: true, models: data.map(entry => ({ id: entry?.id, ownedBy: entry?.owned_by })).filter(entry => entry.id) };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 200) };
  }
}

/** One completion through the router, so the routing-by-model path is exercised. */
export async function chatTest({
  model,
  prompt,
  paths = gatewayPaths(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  const chosen = String(model || "").trim();
  const text = String(prompt || "").trim();
  if (!chosen) return { ok: false, error: "모델을 고르세요" };
  if (!text) return { ok: false, error: "보낼 말을 적으세요" };
  const router = await serviceStatus(routerService(env), { paths, fetchImpl });
  if (!router.running) {
    // Never quietly fall back to a backend's own port: that would test a path
    // nobody uses and hide the fact that the dispatcher is down.
    return { ok: false, error: "라우터가 실행 중이 아닙니다. 먼저 라우터를 시작하세요" };
  }
  const { secrets } = await loadSecrets({ paths });
  const started = Date.now();
  try {
    const response = await fetchImpl(`${serviceUrl(routerService(env))}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secrets.router}` },
      body: JSON.stringify({ model: chosen, messages: [{ role: "user", content: text }], stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, error: firstLine(body), elapsedMs: Date.now() - started };
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, error: "라우터의 답을 읽을 수 없습니다", elapsedMs: Date.now() - started };
    }
    const choice = parsed?.choices?.[0]?.message?.content;
    return {
      ok: true,
      model: parsed?.model || chosen,
      reply: typeof choice === "string" ? choice : JSON.stringify(choice ?? null),
      usage: parsed?.usage || undefined,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 300), elapsedMs: Date.now() - started };
  }
}

function firstLine(text) {
  return String(text || "").trim().split(/\r?\n/)[0].slice(0, 400);
}

async function loggedInAccounts({ paths, env, runner }) {
  const state = await readAccounts({ paths });
  const ask = runner ? { paths, env, runner } : { paths, env };
  const logins = await Promise.all(state.accounts.map(account => loginStatus(account, ask)));
  return { mode: state.mode, accounts: state.accounts.filter((_, index) => logins[index].loggedIn) };
}

/**
 * Everything a login should have caused. Logging in is the only decision a person
 * makes here; which processes that implies, and the order they have to come up in,
 * is this file's problem, not theirs.
 *
 * The router is restarted rather than left alone because it reads its backend list
 * once at startup: an account logged in afterwards would be invisible to it. The
 * restart also clears the router's cooldowns, which live only in its memory.
 */
export async function connect({ paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch, runner, starter = startService, stopper = stopService } = {}) {
  const { mode, accounts } = await loggedInAccounts({ paths, env, runner });
  if (!accounts.length) {
    return { ok: false, error: "로그인된 계정이 없습니다. 먼저 로그인하세요", steps: [] };
  }
  const { secrets } = await loadSecrets({ paths });
  const steps = [];
  for (const account of accounts) {
    const result = await starter(adapterService(account), { secrets, paths, env, fetchImpl });
    steps.push({ service: account.id, ok: result.ok, alreadyRunning: Boolean(result.alreadyRunning), error: result.error });
  }
  const applied = await applyRouterConfig({ accounts, mode, paths, env });
  if (!applied.ok) return { ok: false, error: applied.error, steps };
  const router = routerService(env);
  // Stop first: a router already up is holding the previous account list.
  await stopper(router, { paths, env, fetchImpl });
  const started = await starter(router, { secrets, paths, env, fetchImpl });
  steps.push({ service: "router", ok: started.ok, error: started.error });
  const failed = steps.filter(step => !step.ok);
  return {
    ok: failed.length === 0,
    connected: accounts.map(account => account.id),
    mode,
    steps,
    ...(failed.length ? { error: failed.map(step => step.error || `${step.service}를 시작하지 못했습니다`).join(" / ") } : {}),
  };
}

/** Takes the account list its caller already established rather than asking again. */
async function applyRouterConfig({ accounts, mode, paths, env }) {
  if (!accounts.length) {
    return { ok: false, error: "로그인된 계정이 없습니다. 먼저 로그인하세요" };
  }
  const ollamaBaseUrl = String(env.GATEWAY_OLLAMA_BASE_URL || "").trim();
  const config = routerConfig({ accounts, mode, env, ollamaBaseUrl });
  const file = await writeRouterConfig(config, { paths });
  return { ok: true, accounts: accounts.map(account => account.id), mode, configPath: file };
}

/** A service by the key the screen knows it by: "router", or an account id. */
async function serviceByKey(key, { paths, env }) {
  if (key === "router") return routerService(env);
  const account = findAccount(await readAccounts({ paths }), key);
  return account ? adapterService(account) : null;
}

async function accountById(id, paths) {
  return findAccount(await readAccounts({ paths }), String(id || ""));
}

/**
 * What the gateway keeps running without being asked. A connect decides the set:
 * the router and the adapter of every account that was logged in. After that,
 * `tick` starts again whatever of it has stopped, so a crashed adapter or router
 * is back within KEEP_INTERVAL_MS; the router comes back with the config it
 * already has. A service stopped from the screen stays down until the next
 * connect, and one that fails to start is retried less and less often. At startup
 * (at login, when launchd runs this server) `resume` connects whatever is logged
 * in. Everything that starts or stops a service goes through `exclusive`, so a
 * tick never races a connect that is restarting the router.
 */
export function createKeeper({
  paths = gatewayPaths(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  runner,
  starter = startService,
  stopper = stopService,
  now = Date.now,
  log = line => console.log(JSON.stringify(line)),
} = {}) {
  let wanted = [];
  const held = new Set();
  const retry = new Map();
  let queue = Promise.resolve();

  function exclusive(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function connectNow() {
    const result = await connect({ paths, env, fetchImpl, runner, starter, stopper });
    held.clear();
    retry.clear();
    if (Array.isArray(result.connected)) {
      const { accounts } = await readAccounts({ paths });
      wanted = [
        ...accounts.filter(account => result.connected.includes(account.id)).map(adapterService),
        routerService(env),
      ];
    }
    return result;
  }

  async function tick() {
    if (!wanted.length) return;
    const { secrets } = await loadSecrets({ paths });
    for (const entry of wanted) {
      if (held.has(entry.key)) continue;
      const waiting = retry.get(entry.key);
      if (waiting && now() < waiting.nextAt) continue;
      if ((await serviceStatus(entry, { paths, fetchImpl })).running) {
        retry.delete(entry.key);
        continue;
      }
      const result = await starter(entry, { secrets, paths, env, fetchImpl });
      if (result.ok) {
        retry.delete(entry.key);
      } else {
        const failures = (waiting?.failures || 0) + 1;
        retry.set(entry.key, { failures, nextAt: now() + Math.min(KEEP_INTERVAL_MS * 2 ** failures, KEEP_MAX_BACKOFF_MS) });
      }
      log({ event: "restarted", at: new Date(now()).toISOString(), service: entry.key, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
    }
  }

  return {
    exclusive,
    connect: () => exclusive(connectNow),
    resume: () => exclusive(async () => {
      const result = await connectNow();
      log({ event: "resumed", at: new Date(now()).toISOString(), ok: result.ok, connected: result.connected || [], ...(result.error ? { error: result.error } : {}) });
      return result;
    }),
    tick: () => exclusive(tick),
    /** Stopped from the screen: not restarted until the next connect. */
    hold(key) { held.add(key); },
    /** Started from the screen: kept up again. */
    release(key) { held.delete(key); retry.delete(key); },
    /** An account that is gone: nothing of it is kept up any more. */
    forget(key) { wanted = wanted.filter(entry => entry.key !== key); held.delete(key); retry.delete(key); },
    wanted: () => wanted.map(entry => entry.key),
  };
}

export function createHandler({ paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch, port, keeper = createKeeper({ paths, env, fetchImpl }) } = {}) {
  return async function handler(req, res) {
    const allowed = requestAllowed(req, { port });
    if (!allowed.ok) return json(res, allowed.status, { error: allowed.error });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // For launchd and `proxyctl.py status ui`: the screen's own server is up.
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok" });

    if (req.method === "GET" && STATIC_FILES.has(url.pathname)) {
      const entry = STATIC_FILES.get(url.pathname);
      try {
        const body = await fsp.readFile(path.join(UI_DIR, entry.file));
        res.writeHead(200, { "content-type": entry.type, "cache-control": "no-store" });
        return res.end(body);
      } catch {
        return json(res, 500, { error: `${entry.file} 를 읽을 수 없습니다` });
      }
    }

    let body = {};
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return json(res, error.status || 400, { error: error.message });
      }
    }

    try {
      if (req.method === "GET" && url.pathname === "/api/status") {
        return json(res, 200, await statusReport({ paths, env, fetchImpl }));
      }
      if (req.method === "POST" && url.pathname === "/api/accounts/add") {
        // Adding an account is only ever done to log into it, so both happen here.
        const backendName = String(body.backend || "");
        if (!BACKENDS.some(entry => entry.name === backendName)) {
          return json(res, 400, { ok: false, error: `백엔드는 ${BACKENDS.map(entry => entry.name).join(", ")} 중 하나입니다` });
        }
        const account = await addAccount(backendName, { paths, env });
        const login = await startLogin(account, { paths, env });
        return json(res, login.ok ? 200 : 400, { ok: login.ok, account, login, error: login.error });
      }
      if (req.method === "POST" && url.pathname === "/api/accounts/remove") {
        const account = await accountById(body.account, paths);
        if (!account) return json(res, 404, { ok: false, error: "그런 계정이 없습니다" });
        // What was serving it goes first, then its login, then its directory.
        return await keeper.exclusive(async () => {
          keeper.forget(account.id);
          const stopped = await stopService(adapterService(account), { paths, fetchImpl });
          const loggedOut = await logout(account, { paths, env });
          await removeAccount(account.id, { paths });
          return json(res, 200, { ok: true, removed: account.id, stopped: stopped.ok, loggedOut: loggedOut.ok });
        });
      }
      if (req.method === "POST" && url.pathname === "/api/accounts/move") {
        const moved = await moveAccount(String(body.account || ""), String(body.direction || ""), { paths });
        if (!moved) return json(res, 404, { ok: false, error: "그런 계정이 없습니다" });
        return json(res, 200, { ok: true, accounts: moved.accounts.map(account => account.id) });
      }
      if (req.method === "POST" && url.pathname === "/api/mode") {
        const mode = String(body.mode || "");
        if (!MODES.includes(mode)) return json(res, 400, { ok: false, error: `모드는 ${MODES.join(", ")} 중 하나입니다` });
        await setMode(mode, { paths });
        return json(res, 200, { ok: true, mode });
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        const account = await accountById(body.account, paths);
        if (!account) return json(res, 404, { ok: false, error: "그런 계정이 없습니다" });
        const result = await startLogin(account, { paths, env });
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url.pathname === "/api/logout") {
        const account = await accountById(body.account, paths);
        if (!account) return json(res, 404, { ok: false, error: "그런 계정이 없습니다" });
        const result = await logout(account, { paths, env });
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url.pathname === "/api/connect") {
        const result = await keeper.connect();
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url.pathname === "/api/router-config") {
        const { mode, accounts } = await loggedInAccounts({ paths, env });
        return json(res, 200, await applyRouterConfig({ accounts, mode, paths, env }));
      }
      if (req.method === "POST" && url.pathname === "/api/start") {
        const entry = await serviceByKey(String(body.service || ""), { paths, env });
        if (!entry) return json(res, 404, { ok: false, error: "그런 서비스가 없습니다" });
        return await keeper.exclusive(async () => {
          keeper.release(entry.key);
          const { secrets } = await loadSecrets({ paths });
          if (entry.kind === "router") {
            const { mode, accounts } = await loggedInAccounts({ paths, env });
            const applied = await applyRouterConfig({ accounts, mode, paths, env });
            if (!applied.ok) return json(res, 400, applied);
          }
          const result = await startService(entry, { secrets, paths, env, fetchImpl });
          return json(res, result.ok ? 200 : 400, result);
        });
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        const entry = await serviceByKey(String(body.service || ""), { paths, env });
        if (!entry) return json(res, 404, { ok: false, error: "그런 서비스가 없습니다" });
        return await keeper.exclusive(async () => {
          keeper.hold(entry.key);
          const result = await stopService(entry, { paths, fetchImpl });
          return json(res, result.ok ? 200 : 400, result);
        });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const result = await chatTest({ model: body.model, prompt: body.prompt, paths, env, fetchImpl });
        return json(res, result.ok ? 200 : 400, result);
      }
    } catch (error) {
      return json(res, 500, { error: String(error?.message || error).slice(0, 400) });
    }
    return json(res, 404, { error: "Not found" });
  };
}

export function createServer({ paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch, port = DEFAULT_PORT, keeper } = {}) {
  return http.createServer(createHandler({ paths, env, fetchImpl, port, ...(keeper ? { keeper } : {}) }));
}

export function uiPort(env = process.env) {
  const raw = Number.parseInt(String(env.GATEWAY_UI_PORT || ""), 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65_536 ? raw : DEFAULT_PORT;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = uiPort();
  const keeper = createKeeper();
  const report = error => console.log(JSON.stringify({ event: "keep_failed", error: String(error?.message || error).slice(0, 300) }));
  // Only once the port is ours: a second copy that fails to bind must not start
  // or restart anything on its way out.
  createServer({ port, keeper }).listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ status: "listening", url: `http://127.0.0.1:${port}` }));
    keeper.resume().catch(report);
    setInterval(() => keeper.tick().catch(report), KEEP_INTERVAL_MS);
  });
}
