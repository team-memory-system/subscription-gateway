import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addAccount, moveAccount, portBase, readAccounts, removeAccount, setMode } from "../gateway/accounts.mjs";
import { authEnvironment, loginStatus } from "../gateway/auth.mjs";
import { gatewayPaths } from "../gateway/paths.mjs";
import { loadSecrets, SECRET_ENV } from "../gateway/secrets.mjs";
import { adapterService, routerConfig, routerService, serviceEnvironment, startService } from "../gateway/services.mjs";
import { chatTest, connect, createHandler, createKeeper, requestAllowed, statusReport } from "./server.mjs";

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

test("each account is told where its own credentials live, not the user's", async (t) => {
  const { paths } = await tempPaths(t);
  const { secrets } = await loadSecrets({ paths });
  const env = { PATH: "/usr/bin", HOME: "/home/someone" };
  const codexAccount = await addAccount("codex", { paths, env });
  const claudeAccount = await addAccount("claude", { paths, env });

  const codex = serviceEnvironment(adapterService(codexAccount), { secrets, paths, env });
  assert.equal(codex.CODEX_HOME, paths.authDir("codex", "codex-1"));
  assert.equal(codex.CODEX_AUTH_PATH, path.join(paths.authDir("codex", "codex-1"), "auth.json"));
  assert.equal(codex.PORT, String(codexAccount.port));
  assert.equal(codex.CODEX_PROXY_SHARED_SECRET, secrets.codex);
  assert.equal(codex.CLAUDE_PROXY_SHARED_SECRET, undefined, "a service gets only its own key");

  const claude = serviceEnvironment(adapterService(claudeAccount), { secrets, paths, env });
  assert.equal(claude.CLAUDE_CONFIG_DIR, paths.authDir("claude", "claude-1"));
  assert.equal(claude.CLAUDE_PROXY_SHARED_SECRET, secrets.claude);

  // The router authenticates its own callers and also calls the adapters.
  const router = serviceEnvironment(routerService(env), { secrets, paths, env });
  assert.equal(router.ROUTER_PROXY_SHARED_SECRET, secrets.router);
  assert.equal(router.CODEX_PROXY_SHARED_SECRET, secrets.codex);
  assert.equal(router.CLAUDE_PROXY_SHARED_SECRET, secrets.claude);
  assert.equal(router.ROUTER_CONFIG, paths.routerConfigFile);

  const home = authEnvironment(claudeAccount, { paths, env });
  assert.equal(home.CLAUDE_CONFIG_DIR, paths.authDir("claude", "claude-1"));
  assert.equal(home.HOME, "/home/someone", "the rest of the environment is passed through");
});

test("accounts get stable ids and ports, and order is kept per backend", async (t) => {
  const { paths } = await tempPaths(t);
  const env = {};
  const base = portBase(env);
  const first = await addAccount("codex", { paths, env });
  const second = await addAccount("codex", { paths, env });
  const claude = await addAccount("claude", { paths, env });
  assert.deepEqual([first.id, second.id, claude.id], ["codex-1", "codex-2", "claude-1"]);
  assert.deepEqual([first.port, second.port, claude.port], [base, base + 1, base + 2]);
  await fsp.access(paths.authDir("codex", "codex-2"));

  // A removed account's number and port are free again; its credentials are gone.
  await removeAccount("codex-1", { paths });
  await assert.rejects(fsp.access(paths.authDir("codex", "codex-1")));
  const again = await addAccount("codex", { paths, env });
  assert.equal(again.id, "codex-1");
  assert.equal(again.port, base);

  // Moving swaps with the neighbour of the same backend, skipping the others.
  let state = await readAccounts({ paths });
  assert.deepEqual(state.accounts.map(account => account.id), ["codex-2", "claude-1", "codex-1"]);
  await moveAccount("codex-1", "up", { paths });
  state = await readAccounts({ paths });
  assert.deepEqual(state.accounts.map(account => account.id), ["codex-1", "claude-1", "codex-2"]);
  await moveAccount("codex-1", "up", { paths });
  assert.deepEqual((await readAccounts({ paths })).accounts.map(account => account.id), ["codex-1", "claude-1", "codex-2"], "the first stays first");

  assert.equal(state.mode, "drain", "drain is the default");
  await setMode("balance", { paths });
  assert.equal((await readAccounts({ paths })).mode, "balance");
  await assert.rejects(setMode("random", { paths }), /unknown mode/);

  // A port the router or the screen is told to use is never handed to an adapter.
  const { paths: other } = await tempPaths(t);
  const reserved = await addAccount("claude", { paths: other, env: { GATEWAY_ROUTER_PORT: String(base) } });
  assert.equal(reserved.port, base + 1);
});

test("the router config lists the logged-in accounts in order and names keys instead of holding them", async (t) => {
  const { paths } = await tempPaths(t);
  const { secrets } = await loadSecrets({ paths });
  const env = {};
  const one = await addAccount("codex", { paths, env });
  const two = await addAccount("codex", { paths, env });
  const claude = await addAccount("claude", { paths, env });

  const config = routerConfig({ accounts: [two, one], mode: "balance", env });
  assert.deepEqual(config.backends.map(entry => entry.name), ["codex-2", "codex-1"], "the given order is the priority");
  assert.equal(config.backends[0].baseUrl, `http://127.0.0.1:${two.port}/v1`);
  assert.equal(config.backends[0].apiKeyEnv, SECRET_ENV.codex);
  assert.equal(config.backends[0].discoverModels, true);
  assert.deepEqual(config.routing, { mode: "balance" });
  assert.equal(config.clientAuthEnv, SECRET_ENV.router);
  assert.equal(config.listen.host, "127.0.0.1");
  const serialized = JSON.stringify(config);
  for (const value of Object.values(secrets)) assert.equal(serialized.includes(value), false);

  const both = routerConfig({ accounts: [one, claude], env, ollamaBaseUrl: "http://127.0.0.1:11434/v1/" });
  assert.deepEqual(both.backends.map(entry => entry.name), ["codex-1", "claude-1", "ollama"]);
  assert.equal(both.backends[1].apiKeyEnv, SECRET_ENV.claude);
  assert.equal(both.backends[2].baseUrl, "http://127.0.0.1:11434/v1", "a trailing slash would break path joining");
  assert.equal(both.backends[2].apiKeyEnv, undefined, "Ollama has no key");
  assert.deepEqual(both.routing, { mode: "drain" });
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
  const codex = await addAccount("codex", { paths, env: {} });
  const claude = await addAccount("claude", { paths, env: {} });
  // codex-cli 0.154 answers on stderr: this, with exit 0, when logged in.
  const codexLoggedIn = await loginStatus(codex, {
    paths,
    env: {},
    runner: async () => ({ stdout: "", stderr: "Logged in using ChatGPT\n" }),
  });
  assert.equal(codexLoggedIn.loggedIn, true);
  assert.equal(codexLoggedIn.method, "ChatGPT");
  assert.equal(codexLoggedIn.accountId, "codex-1");
  assert.equal(codexLoggedIn.directory, paths.authDir("codex", "codex-1"));

  // And "Not logged in" with exit 1, which execFile throws. A state, not a breakage.
  const codexOut = await loginStatus(codex, {
    paths,
    env: {},
    runner: async () => { throw Object.assign(new Error("Command failed: codex login status"), { code: 1, stdout: "", stderr: "Not logged in\n" }); },
  });
  assert.equal(codexOut.cliAvailable, true);
  assert.equal(codexOut.loggedIn, false);
  assert.equal(codexOut.error, undefined);

  const claudeIn = await loginStatus(claude, {
    paths,
    env: {},
    runner: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "someone@example.com" }), stderr: "" }),
  });
  assert.equal(claudeIn.loggedIn, true);
  assert.equal(claudeIn.plan, "max");
  assert.equal(claudeIn.account, "someone@example.com");

  const missing = await loginStatus(claude, {
    paths,
    env: {},
    runner: async () => { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); },
  });
  assert.equal(missing.cliAvailable, false);
  assert.match(missing.error, /not installed/);

  // Both streams are read, so a CLI that prints its status on stdout still reads.
  const onStdout = await loginStatus(codex, {
    paths,
    env: {},
    runner: async () => ({ stdout: "Logged in using ChatGPT\n", stderr: "" }),
  });
  assert.equal(onStdout.loggedIn, true);

  // A failure the CLI explains, and an answer nothing here recognises, are both
  // shown; neither may pass for "not logged in", which is how this once broke.
  const broken = await loginStatus(codex, {
    paths,
    env: {},
    runner: async () => { throw Object.assign(new Error("Command failed: codex login status"), { code: 1, stdout: "", stderr: "Error checking login status: permission denied\n" }); },
  });
  assert.equal(broken.loggedIn, false);
  assert.match(broken.error, /Error checking login status/);
  const silent = await loginStatus(codex, {
    paths,
    env: {},
    runner: async () => ({ stdout: "", stderr: "" }),
  });
  assert.equal(silent.loggedIn, false);
  assert.match(silent.error, /알아볼 수 없습니다/);
});

test("a Codex login says whose it is, from the id token, and nothing else from that file", async (t) => {
  const { paths } = await tempPaths(t);
  const account = await addAccount("codex", { paths, env: {} });
  const claims = { email: "second@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } };
  const idToken = ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
  const tokens = { id_token: idToken, access_token: "access-secret-value", refresh_token: "refresh-secret-value" };
  await fsp.writeFile(path.join(paths.authDir("codex", account.id), "auth.json"), JSON.stringify({ tokens }));
  const status = await loginStatus(account, {
    paths,
    env: {},
    runner: async () => ({ stdout: "", stderr: "Logged in using ChatGPT\n" }),
  });
  assert.equal(status.account, "second@example.com");
  assert.equal(status.plan, "plus");
  const serialized = JSON.stringify(status);
  for (const secret of ["access-secret-value", "refresh-secret-value", idToken]) {
    assert.equal(serialized.includes(secret), false, "a token leaked into the login status");
  }
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

  // What launchd's installer and `proxyctl.py status ui` probe.
  const health = fakeResponse();
  await handler(fakeRequest({ url: "/health" }), health);
  assert.equal(health.captured.status, 200);
  assert.deepEqual(JSON.parse(health.captured.body), { status: "ok" });

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
  const loggedOut = async () => { throw Object.assign(new Error("Command failed: codex login status"), { code: 1, stdout: "", stderr: "Not logged in\n" }); };

  const empty = await connect({ paths, env: {}, runner: loggedOut, fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /로그인된 계정이 없습니다/);
  assert.deepEqual(empty.steps, [], "nothing should be started for a machine with no login");

  await addAccount("codex", { paths, env: {} });
  await addAccount("claude", { paths, env: {} });
  await addAccount("codex", { paths, env: {} });
  await setMode("balance", { paths });

  // Both Codex accounts logged in, Claude not: only those adapters come up, and
  // the router is restarted so it reads the new account list, not the previous one.
  const started = [];
  const stopped = [];
  const result = await connect({
    paths,
    env: {},
    fetchImpl: async () => { throw new Error("down"); },
    runner: async (bin, args) => (args[0] === "login"
      ? { stdout: "", stderr: "Logged in using ChatGPT\n" }
      : { stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }), stderr: "" }),
    starter: async (entry) => { started.push(entry.key); return { ok: true, status: { name: entry.key, running: true } }; },
    stopper: async (entry) => { stopped.push(entry.key); return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.connected, ["codex-1", "codex-2"]);
  assert.deepEqual(started, ["codex-1", "codex-2", "router"], "the router must come up after the adapters it will route to");
  assert.deepEqual(stopped, ["router"], "a running router holds the previous account list");

  const config = JSON.parse(await fsp.readFile(paths.routerConfigFile, "utf8"));
  assert.deepEqual(config.backends.map(entry => entry.name), ["codex-1", "codex-2"]);
  assert.deepEqual(config.routing, { mode: "balance" });
});

test("the status report shows each account with its login, its adapter and the router's view of it", async (t) => {
  const { paths } = await tempPaths(t);
  const env = { GATEWAY_ROUTER_PORT: "11400" };
  const one = await addAccount("codex", { paths, env });
  await addAccount("codex", { paths, env });
  // Its adapter is up, but it logged in after the router started, so the router
  // does not know it.
  const late = await addAccount("claude", { paths, env });
  const routerHealth = {
    status: "ok",
    backends: [
      { name: "codex-1", routing: { cooldown_until: "2099-01-01T00:00:00.000Z", consecutive_limits: 1, requests_in_window: 7 } },
      { name: "codex-2", routing: { cooldown_until: null, consecutive_limits: 0, requests_in_window: 3 } },
    ],
  };
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target === "http://127.0.0.1:11400/health") return new Response(JSON.stringify(routerHealth), { status: 200 });
    if (target === "http://127.0.0.1:11400/v1/models") return new Response(JSON.stringify({ data: [{ id: "gpt-6-luna", owned_by: "codex-1" }] }), { status: 200 });
    if (target === `http://127.0.0.1:${one.port}/health`) return new Response("{}", { status: 200 });
    if (target === `http://127.0.0.1:${late.port}/health`) return new Response("{}", { status: 200 });
    throw new Error("connection refused");
  };
  const report = await statusReport({
    paths,
    env,
    fetchImpl,
    runner: async (bin, args) => (args[0] === "login"
      ? { stdout: "", stderr: "Logged in using ChatGPT\n" }
      : { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" }),
  });
  assert.equal(report.mode, "drain");
  assert.deepEqual(report.accounts.map(account => account.id), ["codex-1", "codex-2", "claude-1"]);
  assert.equal(report.accounts[2].service.running, true);
  assert.equal(report.accounts[2].routing, null);
  assert.equal(report.accounts[0].login.loggedIn, true);
  assert.equal(report.accounts[0].service.running, true);
  assert.equal(report.accounts[1].service.running, false);
  assert.equal(report.accounts[0].routing.requests_in_window, 7);
  assert.equal(report.accounts[0].routing.cooldown_until, "2099-01-01T00:00:00.000Z");
  assert.deepEqual(report.servingAccounts, ["codex-1"], "an adapter the router does not route to is not serving");
  assert.equal(report.connected, true);
  assert.deepEqual(report.models.models.map(model => model.id), ["gpt-6-luna"]);
});

const LOGGED_IN = async (bin, args) => (args[0] === "login"
  ? { stdout: "", stderr: "Logged in using ChatGPT\n" }
  : { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" });

test("an adapter left by an earlier install shows on its account, and an empty model list says the keys were refused", async (t) => {
  const { paths } = await tempPaths(t);
  const env = { GATEWAY_ROUTER_PORT: "11400" };
  const codex = await addAccount("codex", { paths, env });
  const claude = await addAccount("claude", { paths, env });
  const { secrets } = await loadSecrets({ paths });
  // The router is this install's (its pid file is ours); both adapters answer
  // /health but refuse this install's keys.
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.writeFile(paths.pidFile("router"), JSON.stringify({ pid: process.pid }));
  const refused = { ok: false, status: 401, reason: "HTTP 401", models: 0, at: "2026-10-01T00:00:00.000Z" };
  const routerHealth = {
    status: "ok",
    backends: [
      { name: "codex-1", reachable: true, routing: { requests_in_window: 0 }, discovery: refused },
      { name: "claude-1", reachable: true, routing: { requests_in_window: 0 }, discovery: refused },
    ],
  };
  const adapterPorts = new Set([codex.port, claude.port]);
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(String(url));
    const port = Number(target.port);
    if (port === 11400 && target.pathname === "/health") return new Response(JSON.stringify(routerHealth));
    if (port === 11400 && target.pathname === "/v1/models") {
      assert.equal(options.headers.authorization, `Bearer ${secrets.router}`);
      return new Response(JSON.stringify({ object: "list", data: [] }));
    }
    if (adapterPorts.has(port) && target.pathname === "/health") return new Response('{"status":"ok"}');
    if (adapterPorts.has(port) && target.pathname === "/v1/models") return new Response('{"error":"Unauthorized"}', { status: 401 });
    throw new Error("connection refused");
  };
  const report = await statusReport({ paths, env, fetchImpl, runner: LOGGED_IN });
  for (const account of report.accounts) {
    assert.equal(account.service.running, false, account.id);
    assert.equal(account.service.foreign, true, account.id);
    assert.match(account.service.error, new RegExp(`^포트 ${account.port}을 이 게이트웨이의 키를 모르는 다른 프로그램이 쓰고 있습니다`));
  }
  assert.equal(report.connected, false);
  assert.deepEqual(report.models.models, []);
  assert.match(report.models.reason, /어댑터가 키를 거절합니다 \(codex-1: HTTP 401, claude-1: HTTP 401\)/);
  assert.equal(report.models.reason.includes("연결된 계정이 없습니다"), false, "not mistaken for no account at all");
  for (const value of Object.values(secrets)) assert.equal(JSON.stringify(report).includes(value), false);

  // Connecting reports it instead of counting those adapters as already up.
  const processes = { listeners: async () => [], describe: async () => null, stop: async () => assert.fail("nothing is stopped") };
  const result = await connect({
    paths,
    env,
    fetchImpl,
    runner: LOGGED_IN,
    starter: async (entry, options) => (entry.kind === "router"
      ? { ok: true }
      : startService(entry, { ...options, processes, spawnImpl: () => assert.fail("nothing is spawned") })),
    stopper: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.map(step => [step.service, step.ok, step.alreadyRunning, step.foreign]), [
    ["codex-1", false, false, true],
    ["claude-1", false, false, true],
    ["router", true, undefined, undefined],
  ]);
  assert.match(result.error, new RegExp(`포트 ${codex.port}을 이 게이트웨이의 키를 모르는`));
});

test("an empty model list with nothing refused still says no account is connected", async (t) => {
  const { paths } = await tempPaths(t);
  const env = { GATEWAY_ROUTER_PORT: "11400" };
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  await fsp.writeFile(paths.pidFile("router"), JSON.stringify({ pid: process.pid }));
  const fetchImpl = async (url) => {
    const target = new URL(String(url));
    if (target.pathname === "/health") return new Response(JSON.stringify({ status: "ok", backends: [] }));
    if (target.pathname === "/v1/models") return new Response(JSON.stringify({ data: [] }));
    throw new Error("connection refused");
  };
  const report = await statusReport({ paths, env, fetchImpl, runner: async () => ({ stdout: "", stderr: "" }) });
  assert.match(report.models.reason, /연결된 계정이 없습니다/);
});

test("the account and mode endpoints refuse what they do not know", async (t) => {
  const { paths } = await tempPaths(t);
  const handler = createHandler({ paths, env: {}, fetchImpl: async () => { throw new Error("down"); }, port: 11450 });
  const post = async (url, body) => {
    const response = fakeResponse();
    await handler(fakeRequest({ method: "POST", url, contentType: "application/json", body: JSON.stringify(body) }), response);
    return { status: response.captured.status, body: JSON.parse(response.captured.body || "{}") };
  };

  assert.equal((await post("/api/accounts/add", { backend: "gemini" })).status, 400);
  assert.equal((await post("/api/mode", { mode: "random" })).status, 400);
  const mode = await post("/api/mode", { mode: "balance" });
  assert.equal(mode.status, 200);
  assert.equal((await readAccounts({ paths })).mode, "balance");
  assert.equal((await post("/api/accounts/move", { account: "codex-9", direction: "up" })).status, 404);
  assert.equal((await post("/api/login", { account: "codex-9" })).status, 404);
  assert.equal((await post("/api/accounts/remove", { account: "codex-9" })).status, 404);
  assert.equal((await post("/api/start", { service: "codex-9" })).status, 404);
});

test("the gateway keeps what it connected running, except what was stopped from the screen", async (t) => {
  const { paths } = await tempPaths(t);
  const codex = await addAccount("codex", { paths, env: {} });
  const router = routerService({});
  const up = new Set();
  const fetchImpl = async (url) => {
    if (up.has(Number(new URL(String(url)).port))) return new Response("{}", { status: 200 });
    throw new Error("connection refused");
  };
  const started = [];
  let failing = false;
  const starter = async (entry) => {
    if (failing) return { ok: false, error: "did not start" };
    started.push(entry.key);
    up.add(entry.port);
    return { ok: true };
  };
  const stopper = async (entry) => { up.delete(entry.port); return { ok: true }; };
  const lines = [];
  let clock = 0;
  const keeper = createKeeper({
    paths,
    env: {},
    fetchImpl,
    starter,
    stopper,
    now: () => clock,
    log: line => lines.push(line),
    runner: async () => ({ stdout: "", stderr: "Logged in using ChatGPT\n" }),
  });

  // Nothing is kept before a connect, so a tick on a fresh start does nothing.
  await keeper.tick();
  assert.deepEqual(started, []);

  // At startup: whatever is logged in comes up, adapters before the router.
  await keeper.resume();
  assert.deepEqual(started, ["codex-1", "router"]);
  assert.deepEqual(keeper.wanted(), ["codex-1", "router"]);
  assert.equal(lines.at(-1).event, "resumed");

  // Both die; the next tick brings both back, and says so.
  up.clear();
  started.length = 0;
  await keeper.tick();
  assert.deepEqual(started, ["codex-1", "router"]);
  assert.deepEqual(lines.slice(-2).map(line => [line.event, line.service, line.ok]), [["restarted", "codex-1", true], ["restarted", "router", true]]);

  // Stopped from the screen: it stays down until the next connect.
  keeper.hold(codex.id);
  up.delete(codex.port);
  started.length = 0;
  await keeper.tick();
  assert.deepEqual(started, []);
  await keeper.connect();
  assert.ok(started.includes("codex-1"), "a connect keeps everything up again");

  // A start that fails is retried later, not on every tick.
  up.clear();
  started.length = 0;
  failing = true;
  await keeper.tick();
  failing = false;
  await keeper.tick();
  assert.deepEqual(started, [], "the same clock: still backing off");
  clock += 10 * 60_000;
  await keeper.tick();
  assert.deepEqual(started, ["codex-1", "router"]);

  // A removed account is not brought back.
  keeper.forget(codex.id);
  up.clear();
  started.length = 0;
  await keeper.tick();
  assert.deepEqual(started, ["router"]);
  assert.equal(up.has(router.port), true);
});
