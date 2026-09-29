// Per-user autostart for the gateway's screen (ui/server.mjs), one kind per OS.
// The screen then brings up the router and the adapters itself (see createKeeper
// in ui/server.mjs), so the screen is the only thing registered with the OS.
//
//   launchd      ~/Library/LaunchAgents/subscription-gateway.ui.plist, the same
//                LaunchAgent `proxyctl.py install ui` writes: RunAtLoad, KeepAlive,
//                logs under ~/.local/share/subscription-gateway/logs.
//   windows-run  the value "SubscriptionGateway" under HKCU\...\CurrentVersion\Run.
//                At logon wscript runs <app>\autostart\ui.vbs, which starts
//                gateway/supervise.mjs with no window; the supervisor starts the
//                screen and starts it again whenever it exits.
//   systemd      ~/.config/systemd/user/subscription-gateway-ui.service,
//                Restart=always, when `systemctl --user` works.
//
// None of these needs admin rights. What the screen runs with is decided here,
// not inherited from whoever ran the installer: its port, PATH built from where
// node, codex and claude are plus the system's folders, and the gateway's own
// overrides (CARRIED_ENV) when the installer was given any. Session variables
// of the installing shell are never copied.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { envValue, findOnPath } from "./command.mjs";
import { askSupervisor, supervisorEndpoint } from "./supervise.mjs";

export const KINDS = Object.freeze({ darwin: "launchd", win32: "windows-run", linux: "systemd" });
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
// Where Task Manager records a startup entry someone turned off.
const STARTUP_APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
export const RUN_VALUE = "SubscriptionGateway";
export const SYSTEMD_UNIT = "subscription-gateway-ui.service";
const LAUNCHD_SYSTEM_PATH = Object.freeze(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
const SYSTEMD_SYSTEM_PATH = Object.freeze(["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"]);
const LAUNCHCTL = "/bin/launchctl";

// Overrides the gateway reads, carried into the autostart when the installer was
// run with them, so the screen started at logon uses the directory and ports
// `install` just prepared. GATEWAY_UI_PORT is always written.
export const CARRIED_ENV = Object.freeze([
  "GATEWAY_HOME",
  "GATEWAY_USER_HOME",
  "GATEWAY_ROUTER_PORT",
  "GATEWAY_ADAPTER_PORT_BASE",
  "GATEWAY_OLLAMA_BASE_URL",
  "CODEX_BIN",
  "CLAUDE_BIN",
]);

export function autostartKind(platform = process.platform) {
  return KINDS[platform] || null;
}

// Directories are written out whole: the screen does not start where the installer ran.
const CARRIED_DIRECTORIES = new Set(["GATEWAY_HOME", "GATEWAY_USER_HOME"]);

/** The variables the screen is started with, besides PATH and HOME. */
export function screenEnvironment(env, uiPort) {
  const result = { GATEWAY_UI_PORT: String(uiPort) };
  for (const name of CARRIED_ENV) {
    const value = String(env[name] ?? "").trim();
    if (value) result[name] = CARRIED_DIRECTORIES.has(name) ? path.resolve(value) : value;
  }
  return result;
}

/** `shutil.which` for macOS and Linux: the first executable of that name on PATH. */
export function whichPosix(tool, env = process.env) {
  for (const folder of String(env.PATH || "").split(":").filter(Boolean)) {
    const candidate = path.join(folder, tool);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function toolFolders(env, which) {
  return ["node", "codex", "claude"].map(tool => which(tool, env)).filter(Boolean).map(file => path.dirname(file));
}

// ------------------------------------------------------------------ launchd

function xmlEscape(text) {
  return String(text).replace(/\r\n?/g, "\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistValue(value, depth) {
  const pad = "\t".repeat(depth);
  if (value === true) return `${pad}<true/>`;
  if (value === false) return `${pad}<false/>`;
  if (typeof value === "string") return `${pad}<string>${xmlEscape(value)}</string>`;
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}<array/>`;
    return [`${pad}<array>`, ...value.map(item => plistValue(item, depth + 1)), `${pad}</array>`].join("\n");
  }
  const keys = Object.keys(value).sort();
  if (!keys.length) return `${pad}<dict/>`;
  return [
    `${pad}<dict>`,
    ...keys.flatMap(key => [`${pad}\t<key>${xmlEscape(key)}</key>`, plistValue(value[key], depth + 1)]),
    `${pad}</dict>`,
  ].join("\n");
}

/** XML exactly as Python's plistlib.dumps writes it, so proxyctl.py and this agree byte for byte. */
export function renderPlist(data) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(data, 0),
    "</plist>",
    "",
  ].join("\n");
}

/** The LaunchAgent `proxyctl.py install ui` writes on a machine that had none. */
export function launchAgent({ env = process.env, root, home, uiPort, execPath = process.execPath, which = whichPosix }) {
  const prefix = String(env.GATEWAY_LAUNCHD_PREFIX || "subscription-gateway");
  const label = `${prefix}.ui`;
  const stateDir = path.resolve(env.GATEWAY_STATE_DIR || path.join(home, ".local", "share", "subscription-gateway"));
  const agents = path.join(home, "Library", "LaunchAgents");
  const data = {
    RunAtLoad: true,
    KeepAlive: true,
    EnvironmentVariables: {
      PATH: [...new Set([...toolFolders(env, which), ...LAUNCHD_SYSTEM_PATH])].join(":"),
      HOME: home,
      ...screenEnvironment(env, uiPort),
    },
    Label: label,
    ProgramArguments: [which("node", env) || execPath, path.join(root, "ui", "server.mjs")],
    WorkingDirectory: path.join(root, "ui"),
    StandardOutPath: path.join(stateDir, "logs", "ui.log"),
    StandardErrorPath: path.join(stateDir, "logs", "ui.error.log"),
  };
  return {
    label,
    stateDir,
    plistPath: path.join(agents, `${label}.plist`),
    // proxyctl's single-account router also listens on 11400; the two never run together.
    routerPlistPath: path.join(agents, `${prefix}.router.plist`),
    data,
    text: renderPlist(data),
    logHint: path.join(stateDir, "logs", "ui.error.log"),
  };
}

async function readText(file) {
  return fsp.readFile(file, "utf8").catch(() => null);
}

async function exists(file) {
  return fsp.access(file).then(() => true, () => false);
}

/** Written to a temporary file with mode 0600 and renamed, as proxyctl.py does. */
async function writePrivate(target, text) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}`;
  await fsp.rm(temporary, { force: true });
  const handle = await fsp.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, target);
}

function firstLine(text) {
  return String(text || "").trim().split(/\r?\n/)[0].slice(0, 300);
}

async function launchdPreflight(ctx) {
  const agent = launchAgent(ctx);
  if (await exists(agent.routerPlistPath)) {
    throw new Error(`${path.basename(agent.routerPlistPath, ".plist")} 가 설치돼 있고 같은 11400 에서 라우터를 띄웁니다. 먼저 지우세요 (python3 proxyctl.py stop router, 그다음 그 plist 삭제)`);
  }
  return agent;
}

async function installLaunchd(ctx) {
  const agent = await launchdPreflight(ctx);
  await fsp.mkdir(path.join(agent.stateDir, "logs"), { recursive: true, mode: 0o700 });
  const changed = (await readText(agent.plistPath)) !== agent.text;
  if (changed) await writePrivate(agent.plistPath, agent.text);
  const domain = `gui/${ctx.uid}`;
  const target = `${domain}/${agent.label}`;
  const loaded = (await ctx.run(LAUNCHCTL, ["print", target])).code === 0;
  // An unchanged agent that launchd already runs is left alone: KeepAlive keeps it
  // up, and a reload would restart the router for nothing.
  if (loaded && !changed) return { changed, started: false, logHint: agent.logHint };
  if (loaded) await ctx.run(LAUNCHCTL, ["bootout", target]);
  let result;
  // Right after a bootout, launchd can refuse a bootstrap for a moment (error 5).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await ctx.run(LAUNCHCTL, ["bootstrap", domain, agent.plistPath]);
    if (result.code === 0) return { changed, started: true, logHint: agent.logHint };
    await ctx.sleep(1_000);
  }
  throw new Error(`launchctl bootstrap 가 실패했습니다: ${firstLine(result.stderr || result.stdout) || `exit ${result.code}`}`);
}

async function uninstallLaunchd(ctx) {
  const agent = launchAgent(ctx);
  const target = `gui/${ctx.uid}/${agent.label}`;
  if ((await ctx.run(LAUNCHCTL, ["print", target])).code === 0) {
    const result = await ctx.run(LAUNCHCTL, ["bootout", target]);
    if (result.code !== 0 && (await ctx.run(LAUNCHCTL, ["print", target])).code === 0) {
      throw new Error(`launchctl bootout 이 실패했습니다: ${firstLine(result.stderr || result.stdout) || `exit ${result.code}`}`);
    }
  }
  await fsp.rm(agent.plistPath, { force: true });
}

// ---------------------------------------------------------------- Windows

function vbsString(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** The script wscript runs at logon. Written as UTF-16 so any path survives. */
export function renderVbs({ node, script, cwd, variables, pathFolders }) {
  const lines = [
    "' subscription-gateway: starts the gateway's screen at logon, with no window.",
    "' Written by `node gateway\\cli.mjs install`; `node gateway\\cli.mjs uninstall` removes it.",
    "Option Explicit",
    "Dim shell, files, env, node",
    'Set shell = CreateObject("WScript.Shell")',
    'Set files = CreateObject("Scripting.FileSystemObject")',
    'Set env = shell.Environment("Process")',
    ...Object.keys(variables).sort().map(name => `env(${vbsString(name)}) = ${vbsString(variables[name])}`),
    ...(pathFolders.length ? [`env("PATH") = ${vbsString(`${pathFolders.join(";")};`)} & env("PATH")`] : []),
    `node = ${vbsString(node)}`,
    "' An upgrade can move node.exe; the one on PATH is then the best guess.",
    'If Not files.FileExists(node) Then node = "node.exe"',
    `shell.CurrentDirectory = ${vbsString(cwd)}`,
    `shell.Run """" & node & """ " & ${vbsString(`"${script}"`)}, 0, False`,
    "",
  ];
  return lines.join("\r\n");
}

export function encodeVbs(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

/** Everything the Windows autostart consists of, computed without touching anything. */
export function windowsAutostart({ env = process.env, root, paths, uiPort, execPath = process.execPath, files }) {
  const system32 = path.win32.join(envValue(env, "SystemRoot") || "C:\\Windows", "System32");
  const wscript = path.win32.join(system32, "wscript.exe");
  const vbsPath = path.join(paths.appHome, "autostart", "ui.vbs");
  const found = ["codex", "claude"].map(tool => findOnPath(tool, { env, files })).filter(Boolean);
  const pathFolders = [...new Set([path.win32.dirname(execPath), ...found.map(file => path.win32.dirname(file))])];
  const vbs = renderVbs({
    node: execPath,
    script: path.join(root, "gateway", "supervise.mjs"),
    cwd: root,
    variables: screenEnvironment(env, uiPort),
    pathFolders,
  });
  return {
    reg: path.win32.join(system32, "reg.exe"),
    wscript,
    vbsPath,
    vbs,
    runValue: `"${wscript}" //B //NoLogo "${vbsPath}"`,
    endpoint: supervisorEndpoint(paths.appHome, "win32"),
    // No supervisor log at all means wscript never ran the script (VBScript turned off, say).
    logHint: `${paths.logFile("ui")} 와 ${paths.logFile("ui-supervisor")}`,
  };
}

async function waitUntilGone(ctx, endpoint, timeoutMs) {
  const deadline = ctx.now() + timeoutMs;
  while (ctx.now() < deadline) {
    if (!(await ctx.ask(endpoint, "status"))) return true;
    await ctx.sleep(250);
  }
  return !(await ctx.ask(endpoint, "status"));
}

async function installWindows(ctx) {
  const plan = windowsAutostart(ctx);
  await fsp.mkdir(path.dirname(plan.vbsPath), { recursive: true });
  const bytes = encodeVbs(plan.vbs);
  const previous = await fsp.readFile(plan.vbsPath).catch(() => null);
  const changed = !previous || !previous.equals(bytes);
  if (changed) await fsp.writeFile(plan.vbsPath, bytes);
  const added = await ctx.run(plan.reg, ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", plan.runValue, "/f"]);
  if (added.code !== 0) {
    throw new Error(`자동 시작을 등록하지 못했습니다 (reg add): ${firstLine(added.stderr || added.stdout) || `exit ${added.code}`}`);
  }
  let running = Boolean(await ctx.ask(plan.endpoint, "status"));
  // A supervisor started from an older script keeps its old environment; replace it.
  if (running && changed) {
    await ctx.ask(plan.endpoint, "stop");
    running = !(await waitUntilGone(ctx, plan.endpoint, 15_000));
    if (running) throw new Error("이전에 띄운 감시 프로세스가 멈추지 않았습니다");
  }
  if (running) return { changed, started: false, logHint: plan.logHint };
  // Started now exactly the way logon starts it.
  const child = ctx.spawnImpl(plan.wscript, ["//B", "//NoLogo", plan.vbsPath], { detached: true, stdio: "ignore", windowsHide: true });
  child.on?.("error", () => {});
  child.unref?.();
  return { changed, started: true, logHint: plan.logHint };
}

async function uninstallWindows(ctx) {
  const plan = windowsAutostart(ctx);
  const removed = await ctx.run(plan.reg, ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
  if (removed.code !== 0 && (await ctx.run(plan.reg, ["query", RUN_KEY, "/v", RUN_VALUE])).code === 0) {
    throw new Error(`자동 시작을 지우지 못했습니다 (reg delete): ${firstLine(removed.stderr || removed.stdout) || `exit ${removed.code}`}`);
  }
  // A startup entry once turned off in Task Manager would otherwise stay off after
  // a reinstall. There is usually nothing to delete here.
  await ctx.run(plan.reg, ["delete", STARTUP_APPROVED_KEY, "/v", RUN_VALUE, "/f"]);
  if (await ctx.ask(plan.endpoint, "status")) {
    await ctx.ask(plan.endpoint, "stop");
    if (!(await waitUntilGone(ctx, plan.endpoint, 15_000))) throw new Error("감시 프로세스가 멈추지 않았습니다");
  }
  await fsp.rm(plan.vbsPath, { force: true });
  await fsp.rmdir(path.dirname(plan.vbsPath)).catch(() => {});
}

// ---------------------------------------------------------------- systemd

// Quoting per systemd.syntax(7); % starts a specifier and $ a variable in ExecStart=.
function systemdQuote(value, { exec = false } = {}) {
  let text = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (exec) text = text.replace(/\$/g, "$$$$");
  return `"${text}"`;
}

export function systemdUnit({ env = process.env, root, home, uiPort, execPath = process.execPath, which = whichPosix }) {
  const configHome = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, ".config");
  const variables = {
    PATH: [...new Set([...toolFolders(env, which), ...SYSTEMD_SYSTEM_PATH])].join(":"),
    ...screenEnvironment(env, uiPort),
  };
  const text = [
    "# Written by `node gateway/cli.mjs install`; `node gateway/cli.mjs uninstall` removes it.",
    "[Unit]",
    "Description=Subscription gateway screen (ui/server.mjs)",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${path.join(root, "ui").replace(/%/g, "%%")}`,
    `ExecStart=${[which("node", env) || execPath, path.join(root, "ui", "server.mjs")].map(part => systemdQuote(part, { exec: true })).join(" ")}`,
    ...Object.keys(variables).sort().map(name => `Environment=${systemdQuote(`${name}=${variables[name]}`)}`),
    "Restart=always",
    "RestartSec=5",
    "# The router and the adapters the screen starts outlive it, as they do under launchd.",
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return { unitPath: path.join(configHome, "systemd", "user", SYSTEMD_UNIT), text, logHint: `journalctl --user -u ${SYSTEMD_UNIT}` };
}

async function systemctl(ctx, args, { check = true } = {}) {
  const result = await ctx.run("systemctl", ["--user", ...args]);
  if (check && result.code !== 0) {
    throw new Error(`systemctl --user ${args.join(" ")} 가 실패했습니다: ${firstLine(result.stderr || result.stdout) || `exit ${result.code}`}`);
  }
  return result;
}

async function systemdPreflight(ctx) {
  const probe = await ctx.run("systemctl", ["--user", "show-environment"]);
  if (probe.code !== 0) {
    throw new Error(`systemd --user 를 쓸 수 없어 자동 시작을 등록하지 못했습니다 (${firstLine(probe.stderr || probe.stdout) || probe.error || `exit ${probe.code}`}). 화면은 npm run ui 로 직접 띄울 수 있습니다`);
  }
}

async function installSystemd(ctx) {
  await systemdPreflight(ctx);
  const unit = systemdUnit(ctx);
  const changed = (await readText(unit.unitPath)) !== unit.text;
  if (changed) {
    await fsp.mkdir(path.dirname(unit.unitPath), { recursive: true });
    await fsp.writeFile(unit.unitPath, unit.text, "utf8");
  }
  await systemctl(ctx, ["daemon-reload"]);
  await systemctl(ctx, ["enable", SYSTEMD_UNIT]);
  await systemctl(ctx, [changed ? "restart" : "start", SYSTEMD_UNIT]);
  return { changed, started: true, logHint: unit.logHint };
}

async function uninstallSystemd(ctx) {
  const unit = systemdUnit(ctx);
  const present = await exists(unit.unitPath);
  if (present) await systemctl(ctx, ["disable", "--now", SYSTEMD_UNIT], { check: false });
  await fsp.rm(unit.unitPath, { force: true });
  if (present) await systemctl(ctx, ["daemon-reload"], { check: false });
}

// ------------------------------------------------------------------ entry

/**
 * `ctx`: { platform, env, root, paths, home, uiPort, uid, execPath, which,
 * run(file, args) -> {code, stdout, stderr}, spawnImpl, ask(endpoint, command),
 * sleep(ms), now() }. Everything that touches the OS goes through ctx, so tests
 * never reach launchctl, reg or systemctl.
 */
export async function preflightAutostart(ctx) {
  if (ctx.platform === "darwin") await launchdPreflight(ctx);
  else if (ctx.platform === "linux") await systemdPreflight(ctx);
  else if (ctx.platform !== "win32") throw new Error(`${ctx.platform} 에서는 자동 시작을 등록할 수 없습니다`);
}

/** Registers the autostart and starts the screen through it if it is not running as registered. */
export async function installAutostart(ctx) {
  if (ctx.platform === "darwin") return installLaunchd(ctx);
  if (ctx.platform === "win32") return installWindows(ctx);
  if (ctx.platform === "linux") return installSystemd(ctx);
  throw new Error(`${ctx.platform} 에서는 자동 시작을 등록할 수 없습니다`);
}

/** Removes the autostart and stops the screen it runs. Logins and state stay. */
export async function uninstallAutostart(ctx) {
  if (ctx.platform === "darwin") return uninstallLaunchd(ctx);
  if (ctx.platform === "win32") return uninstallWindows(ctx);
  if (ctx.platform === "linux") return uninstallSystemd(ctx);
  throw new Error(`${ctx.platform} 에서는 자동 시작을 지울 것이 없습니다`);
}

export async function autostartStatus(ctx) {
  const kind = autostartKind(ctx.platform);
  if (ctx.platform === "darwin") return { kind, installed: await exists(launchAgent(ctx).plistPath) };
  if (ctx.platform === "linux") return { kind, installed: await exists(systemdUnit(ctx).unitPath) };
  if (ctx.platform === "win32") {
    const plan = windowsAutostart(ctx);
    return { kind, installed: (await ctx.run(plan.reg, ["query", RUN_KEY, "/v", RUN_VALUE])).code === 0 };
  }
  return { kind, installed: false };
}

export { askSupervisor };
