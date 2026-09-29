// Keeps the gateway's screen (ui/server.mjs) running where nothing else will.
//
// launchd (KeepAlive) and systemd (Restart=always) start the screen again when it
// exits. Windows has nothing of the kind that a user can register without admin
// rights, so there `cli.mjs install` registers this file instead: an HKCU Run
// value has wscript start it at logon, which is what keeps a console window from
// opening, and this file starts the screen and starts it again whenever it exits.
// A run that ended within a minute counts as a failure, and each failure in a row
// doubles the wait before the next start, from 2 s up to a minute.
//
// One supervisor per app directory. The copy that holds the control endpoint (a
// named pipe on Windows) is the supervisor; a second copy exits at once. That
// endpoint is also how `cli.mjs` asks whether it runs and tells it to stop, which
// stops the screen with it. The router and the adapters the screen started are
// detached and keep running, as they do when launchd stops the screen.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gatewayPaths, sourceRoot } from "./paths.mjs";

export const SUPERVISOR_KEY = "ui-supervisor";
// A run shorter than this is a failed start, not a crash after useful work.
export const HEALTHY_RUN_MS = 60_000;
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/** Where the supervisor of one app directory listens for `status` and `stop`. */
export function supervisorEndpoint(appHome, platform = process.platform) {
  const key = platform === "win32" ? String(appHome).toLowerCase() : String(appHome);
  const id = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\subscription-gateway-ui-${id}`;
  // A Unix socket path is short-limited (104 bytes on macOS), so not under appHome.
  return path.join(os.tmpdir(), `subscription-gateway-ui-${id}.sock`);
}

/** Sends one command to a running supervisor; its JSON answer, or null when none answers. */
export function askSupervisor(endpoint, command, { timeoutMs = 3_000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let buffer = "";
    const socket = net.connect(endpoint);
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${command}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, end)));
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/** The wait before the next start, given how many runs in a row ended early. */
export function restartDelay(failures) {
  return failures <= 0 ? FIRST_DELAY_MS : Math.min(FIRST_DELAY_MS * 2 ** failures, MAX_DELAY_MS);
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

/**
 * Starts supervising. Resolves to null when another supervisor of this app
 * directory already runs, otherwise to a handle whose `stopped` promise settles
 * once a `stop` (from the endpoint or from `stop()`) has ended the screen.
 */
export async function superviseScreen({
  paths = gatewayPaths(),
  env = process.env,
  platform = process.platform,
  script = path.join(sourceRoot(), "ui", "server.mjs"),
  execPath = process.execPath,
  spawnImpl = spawn,
  now = Date.now,
  healthyRunMs = HEALTHY_RUN_MS,
  delay = restartDelay,
  endpoint = supervisorEndpoint(paths.appHome, platform),
} = {}) {
  await fsp.mkdir(paths.logDir, { recursive: true });
  await fsp.mkdir(paths.runtimeDir, { recursive: true });
  const logLine = entry => {
    try {
      fs.appendFileSync(paths.logFile(SUPERVISOR_KEY), `${JSON.stringify({ at: new Date(now()).toISOString(), ...entry })}\n`);
    } catch {
      // A full disk must not take the screen down with it.
    }
  };

  const server = net.createServer();
  try {
    await listen(server, endpoint);
  } catch (error) {
    if (error?.code !== "EADDRINUSE") throw error;
    if (platform === "win32" || await askSupervisor(endpoint, "status")) {
      logLine({ event: "already_running" });
      return null;
    }
    // A socket file left behind by a supervisor that died: nobody answers on it.
    await fsp.rm(endpoint, { force: true });
    await listen(server, endpoint);
  }

  const state = { child: null, startedAt: 0, failures: 0, restarts: 0, timer: null, stopping: false };
  const startedAt = new Date(now()).toISOString();
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });

  async function writePid() {
    const record = { pid: process.pid, startedAt, endpoint, screenPid: state.child?.pid ?? null };
    await fsp.writeFile(paths.pidFile(SUPERVISOR_KEY), `${JSON.stringify(record, null, 2)}\n`, "utf8").catch(() => {});
  }

  function start() {
    state.timer = null;
    if (state.stopping) return;
    let fd = null;
    try {
      fd = fs.openSync(paths.logFile("ui"), "a");
      state.child = spawnImpl(execPath, [script], {
        cwd: path.dirname(script),
        env,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
    } catch (error) {
      state.child = null;
      logLine({ event: "start_failed", error: String(error?.message || error).slice(0, 300) });
      schedule();
      return;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    const child = state.child;
    state.startedAt = now();
    logLine({ event: "started", pid: child.pid });
    writePid();
    let ended = false;
    const onEnd = (code, signal, error) => {
      if (ended) return;
      ended = true;
      if (state.child === child) state.child = null;
      const ranMs = now() - state.startedAt;
      if (state.stopping) {
        finishStop();
        return;
      }
      state.failures = ranMs >= healthyRunMs ? 0 : state.failures + 1;
      logLine({ event: "exited", pid: child.pid, code, signal, ranMs, ...(error ? { error } : {}) });
      schedule();
    };
    child.once("exit", (code, signal) => onEnd(code, signal));
    child.once("error", error => onEnd(null, null, String(error?.message || error).slice(0, 300)));
  }

  function schedule() {
    if (state.stopping) return;
    const wait = delay(state.failures);
    state.restarts += 1;
    logLine({ event: "restarting", inMs: wait, failures: state.failures });
    state.timer = setTimeout(start, wait);
  }

  let finished = false;
  function finishStop() {
    if (finished) return;
    finished = true;
    server.close();
    Promise.all([
      fsp.rm(paths.pidFile(SUPERVISOR_KEY), { force: true }),
      // A named pipe goes with its server; a socket file might not.
      platform === "win32" ? null : fsp.rm(endpoint, { force: true }),
    ])
      .catch(() => {})
      .then(() => {
        logLine({ event: "stopped" });
        resolveStopped();
      });
  }

  function stop() {
    if (!state.stopping) {
      state.stopping = true;
      clearTimeout(state.timer);
      logLine({ event: "stopping", screenPid: state.child?.pid ?? null });
      if (state.child) state.child.kill();
      else finishStop();
    }
    return stopped;
  }

  server.on("connection", socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const command = buffer.slice(0, end).trim();
      if (command === "status") {
        socket.end(`${JSON.stringify({ ok: true, pid: process.pid, screenPid: state.child?.pid ?? null, startedAt, restarts: state.restarts })}\n`);
      } else if (command === "stop") {
        socket.end(`${JSON.stringify({ ok: true, stopping: true })}\n`);
        stop();
      } else {
        socket.end(`${JSON.stringify({ ok: false, error: "unknown command" })}\n`);
      }
    });
  });

  logLine({ event: "supervising", pid: process.pid, script });
  start();
  return { endpoint, stop, stopped, state: () => ({ screenPid: state.child?.pid ?? null, restarts: state.restarts, failures: state.failures }) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const supervisor = await superviseScreen();
  if (!supervisor) process.exit(0);
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
    try {
      process.on(signal, () => { supervisor.stop(); });
    } catch {
      // Not every signal exists on every platform.
    }
  }
  await supervisor.stopped;
  process.exit(0);
}
