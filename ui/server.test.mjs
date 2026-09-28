import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { authEnvironment, backend, loginStatus } from "../gateway/auth.mjs";
import { gatewayPaths } from "../gateway/paths.mjs";
import { loadSecrets, SECRET_ENV } from "../gateway/secrets.mjs";
import { routerConfig, serviceEnvironment, service } from "../gateway/services.mjs";
import { chatTest, connect, createHandler, requestAllowed, statusReport } from "./server.mjs";

async function tempPaths(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "subscription-gateway-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { root, paths: gatewayPaths({ GATEWAY_HOME: root }, "linux") };
}

function fakeRequest({ method = "GET", url = "/api/status", host = "127.0.0.1:11450", origin, contentType, address = "127.0.0.1", body = "" } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (contentType !== undefined) headers["content-type"] = contentType;
  const chunks = body ? [Buffer.from(body)] : [];
  return Object.assign(
    { method, url, headers, socket: { remoteAddress: address } },
    { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } },
  );
}

function fakeResponse() {
  const captured = { status: 0, headers: {}, body: "" };
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers || {}; },
    end(body) { captured.body = body ? String(body) : ""; },
  };
}

test("only a loopback browser on this origin sending JSON may drive the screen", () => {
  const port = 11450;
  assert.equal(requestAllowed(fakeRequest(), { port }).ok, true);
  assert.equal(requestAllowed(fakeRequest({ host: "localhost:11450" }), { port }).ok, true);

  // A name that resolves here is still refused, which is what stops DNS rebinding.
  assert.equal(requestAllowed(fakeRequest({ host: "gateway.example.com:11450" }), { port }).status, 403);
  // A page on another site must not be able to post.
  assert.equal(requestAllowed(fakeRequest({ origin: "https://evil.example" }), { port }).status, 403);
  assert.equal(requestAllowed(fakeRequest({ origin: `http://127.0.0.1:${port}` }), { port }).ok, true);
  // A form post cannot be made to look like our JSON call.
  assert.equal(requestAllowed(fakeRequest({ method: "POST", contentType: "application/x-www-form-urlencoded" }), { port }).status, 415);
  assert.equal(requestAllowed(fakeRequest({ method: "POST", contentType: "application/json" }), { port }).ok, true);
  // A request forwarded from off-machine is refused even if the Host header lies.
  assert.equal(requestAllowed(fakeRequest({ address: "192.168.1.20" }), { port }).status, 403);
});

test("the keys are generated once, kept to this user, and never reach a response", async (t) => {
  const { paths } = await tempPaths(t);
  const first = await loadSecrets({ paths });
  assert.deepEqual(first.created.sort(), ["claude", "codex", "router"]);
  for (const value of Object.values(first.secrets)) assert.match(value, /^[0-9a-f]{64}$/);

  const again = await loadSecrets({ paths });
  assert.deepEqual(again.created, [], "a second call must not rotate a key in use");
  assert.deepEqual(again.secrets, first.secrets);

  if (process.platform !== "win32") {
    const mode = (await fsp.stat(paths.secretsFile)).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  // Asking about one service must not discard the others' keys.
  const narrow = await loadSecrets({ paths, services: ["codex"] });
  assert.equal(narrow.secrets.codex, first.secrets.codex);
  const stored = JSON.parse(await fsp.readFile(paths.secretsFile, "utf8"));
  assert.deepEqual(Object.keys(stored.secrets).sort(), ["claude", "codex", "router"]);

  const report = await statusReport({
    paths,
    env: { PATH: process.env.PATH, GATEWAY_HOME: paths.appHome },
    fetchImpl: async () => { throw new Error("nothing is running"); },
  });
  const serialized = JSON.stringify(report);
  for (const value of Object.values(first.secrets)) {
    assert.equal(serialized.includes(value), false, "a key leaked into the status report");
  }
  // The names are useful to show; the values are not.
  assert.deepEqual(report.secretEnvNames, SECRET_ENV);
});

test("each service is told where this gateway's own credentials live, not the user's", async (t) => {
  const { paths } = await tempPaths(t);
  const { secrets } = await loadSecrets({ paths });
  const env = { PATH: "/usr/bin", HOME: "/home/someone" };

  const codex = serviceEnvironment(service("codex"), { secrets, paths, env });
  assert.equal(codex.CODEX_HOME, paths.authDir("codex"));
  assert.equal(codex.CODEX_AUTH_PATH, path.join(paths.authDir("codex"), "auth.json"));
  assert.equal(codex.CODEX_PROXY_SHARED_SECRET, secrets.codex);
  assert.equal(codex.CLAUDE_PROXY_SHARED_SECRET, undefined, "a service gets only its own key");

  const claude = serviceEnvironment(service("claude"), { secrets, paths, env });
  assert.equal(claude.CLAUDE_CONFIG_DIR, paths.authDir("claude"));
  assert.equal(claude.CLAUDE_PROXY_SHARED_SECRET, secrets.claude);

  // The router authenticates its own callers and also calls the two backends.
  const router = serviceEnvironment(service("router"), { secrets, paths, env });
  assert.equal(router.ROUTER_PROXY_SHARED_SECRET, secrets.router);
  assert.equal(router.CODEX_PROXY_SHARED_SECRET, secrets.codex);
  assert.equal(router.CLAUDE_PROXY_SHARED_SECRET, secrets.claude);
  assert.equal(router.ROUTER_CONFIG, paths.routerConfigFile);

  const home = authEnvironment(backend("claude"), { paths, env });
  assert.equal(home.CLAUDE_CONFIG_DIR, paths.authDir("claude"));
  assert.equal(home.HOME, "/home/someone", "the rest of the environment is passed through");
});

test("the router config lists only what is logged in and names keys instead of holding them", async (t) => {
  const { paths } = await tempPaths(t);
  const { secrets } = await loadSecrets({ paths });
  const config = routerConfig({ backends: ["codex"], env: {} });
  assert.deepEqual(config.backends.map(entry => entry.name), ["codex"]);
  assert.equal(config.backends[0].apiKeyEnv, SECRET_ENV.codex);
  assert.equal(config.backends[0].discoverModels, true);
  assert.equal(config.clientAuthEnv, SECRET_ENV.router);
  assert.equal(config.listen.host, "127.0.0.1");
  const serialized = JSON.stringify(config);
  for (const value of Object.values(secrets)) assert.equal(serialized.includes(value), false);

  const both = routerConfig({ backends: ["codex", "claude"], env: {}, ollamaBaseUrl: "http://127.0.0.1:11434/v1/" });
  assert.deepEqual(both.backends.map(entry => entry.name), ["codex", "claude", "ollama"]);
  assert.equal(both.backends[2].baseUrl, "http://127.0.0.1:11434/v1", "a trailing slash would break path joining");
  assert.equal(both.backends[2].apiKeyEnv, undefined, "Ollama has no key");
});

test("the chat test refuses when the router is down instead of calling a backend directly", async (t) => {
  const { paths } = await tempPaths(t);
  let reached = 0;
  const result = await chatTest({
    model: "gpt-5.5",
    prompt: "hello",
    paths,
    env: {},
    fetchImpl: async () => { reached += 1; throw new Error("connection refused"); },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /라우터가 실행 중이 아닙니다/);
  assert.equal(reached, 1, "only the router health probe should have been attempted");

  assert.match((await chatTest({ prompt: "hi", paths, env: {} })).error, /모델을 고르세요/);
  assert.match((await chatTest({ model: "gpt-5.5", paths, env: {} })).error, /보낼 말을 적으세요/);
});

test("login status comes from the CLI, and a missing CLI is reported as such", async (t) => {
  const { paths } = await tempPaths(t);
  const codexLoggedIn = await loginStatus("codex", {
    paths,
    env: {},
    runner: async () => ({ stdout: "Logged in using ChatGPT\n", stderr: "" }),
  });
  assert.equal(codexLoggedIn.loggedIn, true);
  assert.equal(codexLoggedIn.method, "ChatGPT");
  assert.equal(codexLoggedIn.directory, paths.authDir("codex"));

  const codexOut = await loginStatus("codex", {
    paths,
    env: {},
    runner: async () => ({ stdout: "Not logged in\n", stderr: "" }),
  });
  assert.equal(codexOut.loggedIn, false);

  const claudeIn = await loginStatus("claude", {
    paths,
    env: {},
    runner: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "someone@example.com" }), stderr: "" }),
  });
  assert.equal(claudeIn.loggedIn, true);
  assert.equal(claudeIn.plan, "max");

  const missing = await loginStatus("claude", {
    paths,
    env: {},
    runner: async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); },
  });
  assert.equal(missing.cliAvailable, false);
  assert.match(missing.error, /not installed/);

  // A non-zero exit that still says "not logged in" is a state, not a breakage.
  const exited = await loginStatus("codex", {
    paths,
    env: {},
    runner: async () => { throw Object.assign(new Error("exit 1"), { stdout: "Not logged in\n" }); },
  });
  assert.equal(exited.cliAvailable, true);
  assert.equal(exited.loggedIn, false);
  assert.equal(exited.error, undefined);
});

test("the screen is served, an unknown path is a JSON 404, and a refused request never runs a handler", async (t) => {
  const { paths } = await tempPaths(t);
  const handler = createHandler({ paths, env: {}, fetchImpl: async () => { throw new Error("down"); }, port: 11450 });

  const page = fakeResponse();
  await handler(fakeRequest({ url: "/" }), page);
  assert.equal(page.captured.status, 200);
  assert.match(page.captured.headers["content-type"], /text\/html/);
  assert.match(page.captured.body, /구독 게이트웨이/);

  const missing = fakeResponse();
  await handler(fakeRequest({ url: "/api/nope" }), missing);
  assert.equal(missing.captured.status, 404);

  const refused = fakeResponse();
  await handler(fakeRequest({ method: "POST", url: "/api/login", host: "elsewhere.example:11450", contentType: "application/json", body: '{"backend":"codex"}' }), refused);
  assert.equal(refused.captured.status, 403);

  const oversized = fakeResponse();
  const big = Object.assign(fakeRequest({ method: "POST", url: "/api/chat", contentType: "application/json" }), {
    async *[Symbol.asyncIterator]() { yield Buffer.alloc(70 * 1024, 0x61); },
  });
  await handler(big, oversized);
  assert.equal(oversized.captured.status, 413);
});

test("logging in is the only decision: connecting brings up what that implies", async (t) => {
  const { paths } = await tempPaths(t);
  const loggedOut = async () => ({ stdout: "Not logged in\n", stderr: "" });

  const nothing = await connect({ paths, env: {}, runner: loggedOut, fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(nothing.ok, false);
  assert.match(nothing.error, /로그인된 것이 없습니다/);
  assert.deepEqual(nothing.steps, [], "nothing should be started for a machine with no login");

  // Codex logged in, Claude not: only the one adapter comes up, and the router
  // is restarted so it reads the new backend list instead of the previous one.
  const started = [];
  const stopped = [];
  const result = await connect({
    paths,
    env: {},
    fetchImpl: async () => { throw new Error("down"); },
    runner: async (bin, args) => (args[0] === "login"
      ? { stdout: "Logged in using ChatGPT\n", stderr: "" }
      : { stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }), stderr: "" }),
    starter: async (name) => { started.push(name); return { ok: true, status: { name, running: true } }; },
    stopper: async (name) => { stopped.push(name); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.connected, ["codex"]);
  assert.deepEqual(started, ["codex", "router"], "the router must come up after the backend it will route to");
  assert.deepEqual(stopped, ["router"], "a running router holds the previous backend list");

  const config = JSON.parse(await fsp.readFile(paths.routerConfigFile, "utf8"));
  assert.deepEqual(config.backends.map(entry => entry.name), ["codex"]);
});
