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

import { BACKENDS, loginStatus, logout, startLogin } from "../gateway/auth.mjs";
import { gatewayPaths } from "../gateway/paths.mjs";
import { loadSecrets, SECRET_ENV } from "../gateway/secrets.mjs";
import {
  routerConfig,
  SERVICES,
  serviceStatus,
  serviceUrl,
  service,
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

function enabledBackends(logins) {
  return BACKENDS.filter(entry => logins[entry.name]?.loggedIn).map(entry => entry.name);
}

/** Everything the screen draws. No secret is part of this. */
export async function statusReport({ paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const [{ secrets }, logins, services] = await Promise.all([
    loadSecrets({ paths }),
    Promise.all(BACKENDS.map(entry => loginStatus(entry.name, { paths, env }))).then(list =>
      Object.fromEntries(list.map(entry => [entry.backend, entry]))),
    Promise.all(SERVICES.map(entry => serviceStatus(entry.name, { paths, env, fetchImpl }))),
  ]);
  const router = services.find(entry => entry.name === "router");
  let models = { ok: false, reason: "라우터가 실행 중이 아닙니다" };
  if (router?.running) {
    models = await routerModels({ secrets, env, fetchImpl });
  }
  const adaptersUp = services.filter(entry => entry.name !== "router" && entry.running).map(entry => entry.name);
  return {
    ok: true,
    appHome: paths.appHome,
    secretEnvNames: SECRET_ENV,
    logins,
    services,
    models,
    ready: enabledBackends(logins).length > 0,
    // The one address anything else should be pointed at, and whether it is
    // actually answering for at least one backend right now.
    endpoint: `${serviceUrl(service("router"), env)}/v1`,
    connected: Boolean(router?.running) && adaptersUp.length > 0,
    servingBackends: adaptersUp,
  };
}

async function routerModels({ secrets, env = process.env, fetchImpl = globalThis.fetch }) {
  const url = `${serviceUrl(service("router"), env)}/v1/models`;
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
  const router = await serviceStatus("router", { paths, env, fetchImpl });
  if (!router.running) {
    // Never quietly fall back to a backend's own port: that would test a path
    // nobody uses and hide the fact that the dispatcher is down.
    return { ok: false, error: "라우터가 실행 중이 아닙니다. 먼저 라우터를 시작하세요" };
  }
  const { secrets } = await loadSecrets({ paths });
  const started = Date.now();
  try {
    const response = await fetchImpl(`${serviceUrl(service("router"), env)}/v1/chat/completions`, {
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

/**
 * Everything a login should have caused. Logging in is the only decision a person
 * makes here; which processes that implies, and the order they have to come up in,
 * is this file's problem, not theirs.
 *
 * The router is restarted rather than left alone because it reads its backend list
 * once at startup: a backend logged in afterwards would be invisible to it.
 */
export async function connect({ paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch, runner, starter = startService, stopper = stopService } = {}) {
  const ask = runner ? { paths, env, runner } : { paths, env };
  const logins = await Promise.all(BACKENDS.map(entry => loginStatus(entry.name, ask)));
  const ready = logins.filter(entry => entry.loggedIn).map(entry => entry.backend);
  if (!ready.length) {
    return { ok: false, error: "로그인된 것이 없습니다. 먼저 로그인하세요", steps: [] };
  }
  const { secrets } = await loadSecrets({ paths });
  const steps = [];
  for (const name of ready) {
    const result = await starter(name, { secrets, paths, env, fetchImpl });
    steps.push({ service: name, ok: result.ok, alreadyRunning: Boolean(result.alreadyRunning), error: result.error });
  }
  const applied = await applyRouterConfig({ backends: ready, paths, env });
  if (!applied.ok) return { ok: false, error: applied.error, steps };
  // Stop first: a router already up is holding the previous backend list.
  await stopper("router", { paths, env, fetchImpl });
  const router = await starter("router", { secrets, paths, env, fetchImpl });
  steps.push({ service: "router", ok: router.ok, error: router.error });
  const failed = steps.filter(step => !step.ok);
  return {
    ok: failed.length === 0,
    connected: ready,
    steps,
    ...(failed.length ? { error: failed.map(step => step.error || `${step.service}를 시작하지 못했습니다`).join(" / ") } : {}),
  };
}

/** Takes the backend list its caller already established rather than asking again. */
async function applyRouterConfig({ backends, paths, env }) {
  if (!backends.length) {
    return { ok: false, error: "로그인된 백엔드가 없습니다. 먼저 로그인하세요" };
  }
  const ollamaBaseUrl = String(env.GATEWAY_OLLAMA_BASE_URL || "").trim();
  const config = routerConfig({ backends, env, ollamaBaseUrl });
  const file = await writeRouterConfig(config, { paths });
  return { ok: true, backends, configPath: file };
}

async function loggedInBackends({ paths, env, runner }) {
  const ask = runner ? { paths, env, runner } : { paths, env };
  const logins = await Promise.all(BACKENDS.map(entry => loginStatus(entry.name, ask)));
  return logins.filter(entry => entry.loggedIn).map(entry => entry.backend);
}

export function createHandler({ paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch, port } = {}) {
  return async function handler(req, res) {
    const allowed = requestAllowed(req, { port });
    if (!allowed.ok) return json(res, allowed.status, { error: allowed.error });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

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
      if (req.method === "POST" && url.pathname === "/api/login") {
        const result = await startLogin(String(body.backend || ""), { paths, env });
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url.pathname === "/api/logout") {
        const result = await logout(String(body.backend || ""), { paths, env });
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url.pathname === "/api/connect") {
        const result = await connect({ paths, env, fetchImpl });
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url.pathname === "/api/router-config") {
        const backends = await loggedInBackends({ paths, env });
        return json(res, 200, await applyRouterConfig({ backends, paths, env }));
      }
      if (req.method === "POST" && url.pathname === "/api/start") {
        const name = String(body.service || "");
        const { secrets } = await loadSecrets({ paths });
        if (name === "router") {
          const backends = await loggedInBackends({ paths, env });
          const applied = await applyRouterConfig({ backends, paths, env });
          if (!applied.ok) return json(res, 400, applied);
        }
        const result = await startService(name, { secrets, paths, env, fetchImpl });
        return json(res, result.ok ? 200 : 400, result);
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        const result = await stopService(String(body.service || ""), { paths, env, fetchImpl });
        return json(res, result.ok ? 200 : 400, result);
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

export function createServer({ paths = gatewayPaths(), env = process.env, fetchImpl = globalThis.fetch, port = DEFAULT_PORT } = {}) {
  return http.createServer(createHandler({ paths, env, fetchImpl, port }));
}

export function uiPort(env = process.env) {
  const raw = Number.parseInt(String(env.GATEWAY_UI_PORT || ""), 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65_536 ? raw : DEFAULT_PORT;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = uiPort();
  createServer({ port }).listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ status: "listening", url: `http://127.0.0.1:${port}` }));
  });
}
