#!/usr/bin/env node
// The gateway's command line, for installers and other programs.
//
//   node gateway/cli.mjs install       npm dependencies, state and keys, per-user
//                                      autostart of the screen, started now
//   node gateway/cli.mjs uninstall     the autostart removed, the screen stopped, and
//                                      the router and adapters it started stopped;
//                                      logins, accounts and keys stay
//   node gateway/cli.mjs status        what answers, who is logged in, which models
//   node gateway/cli.mjs connect-info  the router's address, its client key, its models
//   node gateway/cli.mjs open          the screen's address, opened in a browser
//
// Every command prints exactly one JSON object on stdout and exits 0. A failure
// prints {"ok":false,"error":"..."} and exits non-zero. Anything else goes to
// stderr, so stdout always parses.
//
// connect-info is the one command that prints a secret: the router's client key,
// as `apiKey`. Whatever runs it must never log that output, echo it, or pass the
// key on a command line.
//
// The same overrides as the rest of the gateway apply: GATEWAY_HOME,
// GATEWAY_UI_PORT, GATEWAY_ROUTER_PORT, GATEWAY_ADAPTER_PORT_BASE (and on macOS
// proxyctl.py's GATEWAY_LAUNCHD_PREFIX and GATEWAY_STATE_DIR). `install` writes
// the gateway's own ones into the autostart, so the screen started at logon uses
// the same directory and ports.
import { execFile, spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { statusReport, uiPort } from "../ui/server.mjs";
import { readAccounts } from "./accounts.mjs";
import {
  askSupervisor,
  autostartKind,
  autostartStatus,
  installAutostart,
  preflightAutostart,
  uninstallAutostart,
} from "./autostart.mjs";
import { commandInvocation, invocationOptions } from "./command.mjs";
import { gatewayPaths, sourceRoot, userHome } from "./paths.mjs";
import { loadSecrets, readSecrets } from "./secrets.mjs";
import { adapterService, dependencyFolders, emptyModelsReason, probeHealth, routerService, serviceUrl, stopService } from "./services.mjs";

export const COMMANDS = Object.freeze(["install", "uninstall", "status", "connect-info", "open"]);
const USAGE = `사용법: node gateway/cli.mjs <${COMMANDS.join("|")}>`;
const HEALTH_TIMEOUT_MS = 30_000;
const NPM_CI_ARGS = Object.freeze(["ci", "--omit=dev", "--no-audit", "--no-fund"]);
const NPM_TIMEOUT_MS = 15 * 60_000;

/** execFile that reports instead of throwing: { code, stdout, stderr, error? }. */
export function runProcess(file, args, options = {}) {
  return new Promise(resolve => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...options }, (error, stdout, stderr) => {
      const out = { stdout: String(stdout || ""), stderr: String(stderr || "") };
      if (!error) return resolve({ code: 0, ...out });
      const exited = Number.isInteger(error.code);
      resolve({ code: exited ? error.code : null, ...out, error: exited ? undefined : (error.killed ? "timed out" : String(error.code || error.message)) });
    });
  });
}

function tail(text, lines = 5) {
  return String(text || "").trim().split(/\r?\n/).filter(Boolean).slice(-lines).join(" / ").slice(0, 600);
}

async function exists(file) {
  return fsp.access(file).then(() => true, () => false);
}

/** Everything a command needs, with every effect on the OS injectable for tests. */
export function cliContext({
  env = process.env,
  platform = process.platform,
  root = sourceRoot(),
  run = runProcess,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  ask = askSupervisor,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  execPath = process.execPath,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  which,
  files,
  runner,
  openBrowser,
  stopper = stopService,
} = {}) {
  const paths = gatewayPaths(env, platform);
  const port = uiPort(env);
  return {
    env,
    platform,
    root,
    paths,
    home: userHome(env),
    uiPort: port,
    uiUrl: `http://127.0.0.1:${port}`,
    routerUrl: `${serviceUrl(routerService(env))}/v1`,
    run,
    spawnImpl,
    fetchImpl,
    ask,
    sleep,
    now,
    execPath,
    uid,
    which,
    files,
    runner,
    stopper,
    openBrowser: openBrowser || (url => openInBrowser(url, { platform, env, spawnImpl })),
  };
}

// ------------------------------------------------------------------ install

/** `npm ci` in every service folder whose dependencies are missing. */
export async function installDependencies(ctx) {
  const installed = [];
  for (const entry of dependencyFolders()) {
    const folder = path.join(ctx.root, entry.subdirectory);
    if (await exists(path.join(folder, entry.marker))) continue;
    // npm.cmd on Windows: a batch file, so it runs through cmd.exe with fixed arguments.
    const call = commandInvocation("npm", NPM_CI_ARGS, { env: ctx.env, platform: ctx.platform, execPath: ctx.execPath, files: ctx.files });
    const result = await ctx.run(call.file, call.args, invocationOptions(call, { cwd: folder, env: ctx.env, timeout: NPM_TIMEOUT_MS }, ctx.platform));
    if (result.code !== 0) {
      const reason = result.error === "ENOENT" ? "npm 을 찾을 수 없습니다" : tail(result.stderr || result.stdout) || result.error || `exit ${result.code}`;
      throw new Error(`${entry.subdirectory} 의 의존성을 설치하지 못했습니다 (npm ${NPM_CI_ARGS.join(" ")}): ${reason}`);
    }
    if (!(await exists(path.join(folder, entry.marker)))) {
      throw new Error(`npm ci 뒤에도 ${entry.subdirectory}/${entry.marker} 가 없습니다`);
    }
    installed.push(entry.subdirectory);
  }
  return installed;
}

export async function waitForHealth(url, { fetchImpl, sleep, now, timeoutMs = HEALTH_TIMEOUT_MS }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const health = await probeHealth(url, { fetchImpl, timeoutMs: 2_000 });
    if (health.ok && health.body?.status === "ok") return true;
    if (now() >= deadline) return false;
    await sleep(500);
  }
}

async function install(ctx) {
  const kind = autostartKind(ctx.platform);
  // What cannot work at all is found out before anything is downloaded.
  await preflightAutostart(ctx);
  await installDependencies(ctx);
  await fsp.mkdir(ctx.paths.appHome, { recursive: true });
  await loadSecrets({ paths: ctx.paths });
  const registered = await installAutostart(ctx);
  if (!(await waitForHealth(ctx.uiUrl, ctx))) {
    throw new Error(`자동 시작(${kind})은 등록했지만 화면(${ctx.uiUrl})이 ${HEALTH_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다. ${registered.logHint} 를 보세요`);
  }
  return { ok: true, autostart: kind, uiUrl: ctx.uiUrl, routerUrl: ctx.routerUrl };
}

/** The router as the screen configured it: its port is in router-config.json. */
async function configuredRouter(ctx) {
  const router = routerService(ctx.env);
  try {
    const port = Number(JSON.parse(await fsp.readFile(ctx.paths.routerConfigFile, "utf8"))?.listen?.port);
    if (Number.isInteger(port) && port > 0 && port < 65_536) return { ...router, port };
  } catch {
    // Never connected: nothing wrote a config yet.
  }
  return router;
}

/**
 * Stops what the screen started, each by its pid file: the router first, then
 * every account's adapter. Returns the names of the services that were stopped.
 * A service something else started, or a pid that no longer answers on its port,
 * is left alone (see stopService).
 */
async function stopGatewayServices(ctx) {
  const { accounts } = await readAccounts({ paths: ctx.paths });
  const services = [await configuredRouter(ctx), ...accounts.map(adapterService)];
  const stopped = [];
  const failed = [];
  for (const entry of services) {
    const result = await ctx.stopper(entry, { paths: ctx.paths, fetchImpl: ctx.fetchImpl });
    if (result.stopped && result.ok) stopped.push(entry.key);
    else if (result.stopped || result.error) failed.push(result.error ? `${entry.key} (${result.error})` : entry.key);
  }
  if (failed.length) throw new Error(`자동 시작은 지웠지만 멈추지 못한 서비스가 있습니다: ${failed.join(", ")}`);
  return stopped;
}

/**
 * Leaves nothing of this checkout running, so the checkout can be replaced: on
 * Windows a process started from a folder keeps it from being renamed. The screen
 * goes first, since its keeper would start again whatever is stopped under it.
 * Logins, accounts.json, the keys and the router config stay, so the next
 * install's screen connects the same accounts again.
 */
async function uninstall(ctx) {
  await uninstallAutostart(ctx);
  return { ok: true, stopped: await stopGatewayServices(ctx) };
}

// ------------------------------------------------------------------- status

async function fetchJson(url, { fetchImpl, timeoutMs }) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * The screen's own report when the screen answers: it runs with the environment
 * its autostart gave it. Otherwise the same report made here, creating nothing.
 */
async function status(ctx) {
  const [autostart, health] = await Promise.all([
    autostartStatus(ctx),
    probeHealth(ctx.uiUrl, { fetchImpl: ctx.fetchImpl, timeoutMs: 2_000 }),
  ]);
  const uiOk = health.ok && health.body?.status === "ok";
  let report = uiOk ? await fetchJson(`${ctx.uiUrl}/api/status`, { fetchImpl: ctx.fetchImpl, timeoutMs: 20_000 }) : null;
  if (!report?.ok || !Array.isArray(report.accounts)) {
    report = await statusReport({
      paths: ctx.paths,
      env: ctx.env,
      fetchImpl: ctx.fetchImpl,
      ...(ctx.runner ? { runner: ctx.runner } : {}),
      secretsLoader: readSecrets,
    });
  }
  const router = (Array.isArray(report.services) ? report.services : []).find(entry => entry?.kind === "router");
  const serving = new Set(Array.isArray(report.servingAccounts) ? report.servingAccounts : []);
  return {
    ok: true,
    ui: { url: ctx.uiUrl, ok: uiOk },
    router: { url: typeof report.endpoint === "string" ? report.endpoint : ctx.routerUrl, ok: router?.running === true },
    autostart,
    accounts: report.accounts.map(account => ({
      id: account.id,
      backend: account.backend,
      loggedIn: account.login?.loggedIn === true,
      serving: serving.has(account.id),
      // A port held by something that refuses this gateway's key, in its words.
      ...(account.service?.foreign && typeof account.service.error === "string" ? { error: account.service.error } : {}),
    })),
    models: report.models?.ok && Array.isArray(report.models.models)
      ? report.models.models.map(model => model?.id).filter(id => typeof id === "string" && id)
      : [],
  };
}

// ------------------------------------------------------------- connect-info

async function routerModels(ctx, apiKey) {
  let response;
  try {
    response = await ctx.fetchImpl(`${ctx.routerUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { models: [], reason: `라우터(${ctx.routerUrl})가 응답하지 않습니다. 게이트웨이 화면(${ctx.uiUrl})에서 Codex 나 Claude 에 로그인하면 연결됩니다` };
  }
  if (response.status === 401 || response.status === 403) {
    return { models: [], reason: `라우터가 이 키를 받지 않습니다. 이 설치(${ctx.paths.appHome})가 띄운 라우터가 아닐 수 있습니다` };
  }
  if (!response.ok) return { models: [], reason: `라우터가 HTTP ${response.status} 를 돌려줬습니다` };
  const body = await response.json().catch(() => null);
  const models = (Array.isArray(body?.data) ? body.data : []).map(entry => entry?.id).filter(id => typeof id === "string" && id);
  if (!models.length) {
    // Each backend's last discovery is on the router's /health: an adapter that
    // refuses the router's key is not the same as no account at all.
    const health = await probeHealth(ctx.routerUrl.replace(/\/v1$/, ""), { fetchImpl: ctx.fetchImpl, timeoutMs: 5_000 });
    const why = emptyModelsReason(health.body);
    if (why) return { models, reason: `${why}. 게이트웨이 화면: ${ctx.uiUrl}` };
    return { models, reason: `라우터에 연결된 계정이 없습니다. 게이트웨이 화면(${ctx.uiUrl})에서 로그인하세요` };
  }
  return { models };
}

/**
 * The only output with a secret in it: `apiKey`, the key the router expects as
 * `Authorization: Bearer`. Ready means the router listed at least one model for
 * that key just now.
 */
async function connectInfo(ctx) {
  const { secrets } = await loadSecrets({ paths: ctx.paths });
  const listed = await routerModels(ctx, secrets.router);
  const ready = listed.models.length > 0;
  return {
    ok: true,
    ready,
    baseUrl: ctx.routerUrl,
    apiKey: secrets.router,
    models: listed.models,
    ...(ready ? {} : { reason: listed.reason }),
  };
}

// --------------------------------------------------------------------- open

/** Best effort: whether a browser came up is not something this can know. */
export function openInBrowser(url, { platform = process.platform, env = process.env, spawnImpl = spawn } = {}) {
  const system32 = path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32");
  const [file, args] = platform === "darwin"
    ? ["/usr/bin/open", [url]]
    : platform === "win32"
      ? [path.win32.join(system32, "rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
  try {
    const child = spawnImpl(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

async function open(ctx) {
  ctx.openBrowser(ctx.uiUrl);
  return { ok: true, url: ctx.uiUrl };
}

// --------------------------------------------------------------------- main

const HANDLERS = Object.freeze({ install, uninstall, status, "connect-info": connectInfo, open });

/** Runs one command and returns what to print and the exit code, never throwing. */
export async function runCli(argv, deps = {}) {
  const [command, ...rest] = argv;
  if (!HANDLERS[command] || rest.length) return { code: 2, result: { ok: false, error: USAGE } };
  try {
    return { code: 0, result: await HANDLERS[command](cliContext(deps)) };
  } catch (error) {
    return { code: 1, result: { ok: false, error: String(error?.message || error).slice(0, 1000) } };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // stdout carries the one answer; whatever a module prints goes to stderr instead.
  for (const method of ["log", "info", "debug"]) console[method] = (...args) => console.error(...args);
  let answered = false;
  const answer = ({ code, result }) => {
    if (answered) return;
    answered = true;
    process.exitCode = code;
    // The process ends by itself once the answer is written. process.exit() is only
    // the fallback for something left running: on Windows, Node 24 aborts in libuv
    // (src\win\async.c) when it exits that way right after fetch() calls to a live
    // server, which turned a good answer into a crash code.
    process.stdout.write(`${JSON.stringify(result)}\n`, () => {
      setTimeout(() => process.exit(code), 5_000).unref();
    });
  };
  const crash = error => answer({ code: 1, result: { ok: false, error: String(error?.message || error).slice(0, 1000) } });
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  answer(await runCli(process.argv.slice(2)));
}
