// Running the `codex` and `claude` CLIs, and npm, without a shell on every platform.
//
// On macOS and Linux a command is handed to spawn exactly as it was given, which is
// what this code has always done. Windows breaks a bare spawn("codex") twice over:
// spawn looks on PATH only for .exe and .com, and the CLIs npm installs are .cmd
// shims, which Node refuses to start without a shell since CVE-2024-27980. A shell
// is exactly what must not see text from a request, so on Windows a command is
// looked up on PATH with PATHEXT, as cmd.exe would, and then:
//
//   - an .exe or .com runs as it is;
//   - an npm shim (what cmd-shim writes) is read to find what it would run: its
//     JavaScript entry runs under this Node (process.execPath), a native target
//     runs directly;
//   - any other .cmd or .bat runs through `cmd.exe /d /s /c`, every argument
//     escaped for cmd, unless the caller forbids a shell (`allowShell: false`)
//     because an argument carries text from a request.
import fs from "node:fs";
import path from "node:path";

const win = path.win32;
const RUNNABLE = new Set([".com", ".exe", ".bat", ".cmd"]);
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const MAX_SHIM_BYTES = 64 * 1024;

const realFiles = Object.freeze({
  isFile(target) {
    try {
      return fs.statSync(target).isFile();
    } catch {
      return false;
    }
  },
  read(target) {
    return fs.readFileSync(target, "utf8");
  },
});

/**
 * One variable of an environment meant for Windows, where names are
 * case-insensitive but a copied `{...process.env}` is not. Node's spawn keeps the
 * first spelling in sorted order when there are several, so this does too.
 */
export function envValue(env, name) {
  const wanted = name.toUpperCase();
  const key = Object.keys(env || {}).sort().find(candidate => candidate.toUpperCase() === wanted);
  return key === undefined ? undefined : env[key];
}

function pathExtensions(env) {
  const listed = String(envValue(env, "PATHEXT") || DEFAULT_PATHEXT)
    .split(";")
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => RUNNABLE.has(entry));
  // Only what CreateProcess or cmd.exe can start: PATHEXT also names .js and .vbs,
  // which Windows would hand to the script host rather than to Node.
  return listed.length ? [...new Set(listed)] : [".com", ".exe", ".bat", ".cmd"];
}

function candidates(base, extensions) {
  const given = win.extname(base).toLowerCase();
  return [...(RUNNABLE.has(given) ? [base] : []), ...extensions.map(extension => `${base}${extension}`)];
}

/**
 * Where cmd.exe would find `command`: a name is looked for in every PATH folder
 * with every PATHEXT extension, in that order; a path is only completed with an
 * extension. The current directory is not searched: nothing this gateway runs
 * lives there, and a request's working directory must not be able to supply one.
 */
export function findOnPath(command, { env = process.env, files = realFiles } = {}) {
  const name = String(command || "").trim();
  if (!name) return null;
  const extensions = pathExtensions(env);
  if (/[\\/]/.test(name)) {
    return candidates(name, extensions).find(candidate => files.isFile(candidate)) || null;
  }
  const folders = String(envValue(env, "PATH") || "")
    .split(";")
    .map(entry => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  for (const folder of folders) {
    const found = candidates(win.join(folder, name), extensions).find(candidate => files.isFile(candidate));
    if (found) return found;
  }
  return null;
}

// The line of an npm shim that runs its target, in the forms cmd-shim and pnpm write:
//   npm 7+, JavaScript:  endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
//   npm 6.10+:           "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
//   npm 6+, native:      "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
//   older npm, pnpm:     "%~dp0\node.exe"  "%~dp0\..\@openai\codex\bin\codex.js" %*   and   node  "..." %*
//   older npm, native:   @"%~dp0\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
const EXEC_LINES = Object.freeze([
  { kind: "node", pattern: /^(?:endLocal\s*&\s*goto\s+#_undefined_#\s+2>NUL\s*\|\|\s*title\s+%COMSPEC%\s*&\s*)?"%_prog%"\s+"%dp0%\\([^"%]+)"\s+%\*$/i },
  { kind: "native", pattern: /^"%dp0%\\([^"%]+)"\s+%\*$/i },
  { kind: "node", pattern: /^@?(?:"%~dp0\\node\.exe"|node)\s+"%~dp0\\([^"%]+)"\s+%\*$/i },
  { kind: "native", pattern: /^@?"%~dp0\\([^"%]+)"\s+%\*$/i },
]);
// Every other line a shim may have. A batch file with any line not listed here
// does something besides starting its target (a cd, another SET, a call), which
// running the target directly would skip, so it is left to cmd.exe.
const SHIM_LINES = Object.freeze([
  /^$/,
  /^(?:::|@?rem\b)/i,
  /^@?echo\s+off$/i,
  /^goto\s+start$/i,
  /^:(?:find_dp0|start)$/i,
  /^@?set\s+dp0=%~dp0$/i,
  /^exit\s+\/b(?:\s+%errorlevel%)?$/i,
  /^@?setlocal$/i,
  /^@?endlocal$/i,
  /^call\s+:find_dp0$/i,
  /^@?if\s+exist\s+"%(?:~dp0|dp0%)\\node\.exe"\s+\($/i,
  /^@?if\s+not\s+defined\s+node_path\s+\($/i,
  /^@?set\s+"_prog=(?:%dp0%\\node\.exe|node)"$/i,
  /^@?set\s+"node_path=[^"]*"$/i,
  /^@?set\s+pathext=%pathext:;\.js;=;%$/i,
  /^\)\s*else\s*\($/i,
  /^\)$/,
]);

/**
 * What an npm shim runs: `{ node: entry }` for a JavaScript entry that Node runs,
 * `{ exe: file }` for a native program, or null for a batch file that is not
 * recognisably a shim, which is then cmd.exe's to run.
 */
export function readNpmShim(shimPath, { files = realFiles } = {}) {
  let text;
  try {
    text = files.read(shimPath);
  } catch {
    return null;
  }
  if (typeof text !== "string" || text.length > MAX_SHIM_BYTES) return null;
  const found = [];
  for (const line of text.split(/\r?\n/).map(entry => entry.trim())) {
    if (/%\*$/.test(line)) {
      const known = EXEC_LINES.map(entry => ({ kind: entry.kind, match: line.match(entry.pattern) })).find(entry => entry.match);
      if (!known) return null;
      found.push({ kind: known.kind, target: known.match[1] });
    } else if (!SHIM_LINES.some(pattern => pattern.test(line))) {
      return null;
    }
  }
  if (!found.length) return null;
  if (found.some(entry => entry.kind !== found[0].kind || entry.target.toLowerCase() !== found[0].target.toLowerCase())) return null;

  const target = win.resolve(win.dirname(shimPath), found[0].target);
  if (!files.isFile(target)) return null;
  if (found[0].kind === "node") return { node: target };
  const extension = win.extname(target).toLowerCase();
  return extension === ".exe" || extension === ".com" ? { exe: target } : null;
}

// cmd.exe's metacharacters, escaped with a caret. Following the algorithm at
// https://qntm.org/cmd as cross-spawn implements it.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function cmdCommand(file) {
  return win.normalize(file).replace(CMD_META, "^$1");
}

/**
 * One argument of a batch file run by `cmd.exe /d /s /c`: quoted and
 * backslash-escaped for the program the batch file starts, then caret-escaped
 * twice, once for this cmd.exe and once more for the batch line that passes %*
 * on, which cmd parses again.
 */
export function cmdArgument(arg) {
  let quoted = String(arg);
  quoted = quoted.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  quoted = quoted.replace(/(?=(\\+?)?)\1$/, "$1$1");
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

function comspec(env) {
  return envValue(env, "ComSpec") || win.join(envValue(env, "SystemRoot") || "C:\\Windows", "System32", "cmd.exe");
}

/**
 * How to run `command` with `args` and no shell: `{ file, args }`, plus
 * `windowsVerbatimArguments: true` when the line for cmd.exe is already built.
 * Anywhere but Windows that is the command and the arguments as given.
 *
 * A command that is not found is returned as named, so spawn fails with ENOENT
 * exactly as it did before, and callers keep telling "not installed" apart.
 */
export function commandInvocation(command, args = [], {
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  allowShell = true,
  files = realFiles,
} = {}) {
  const list = [...args];
  if (platform !== "win32") return { file: command, args: list };
  const found = findOnPath(command, { env, files });
  if (!found) return { file: command, args: list };
  const extension = win.extname(found).toLowerCase();
  if (extension === ".exe" || extension === ".com") return { file: found, args: list };
  const shim = readNpmShim(found, { files });
  if (shim?.node) return { file: execPath, args: [shim.node, ...list] };
  if (shim?.exe) return { file: shim.exe, args: list };
  if (!allowShell) {
    throw Object.assign(
      new Error(`${found} is a batch file, not an npm shim this can read, and these arguments must not pass through cmd.exe. Point it at the program's .exe instead`),
      { code: "ESHELL" },
    );
  }
  const line = [cmdCommand(found), ...list.map(cmdArgument)].join(" ");
  return { file: comspec(env), args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * The spawn or execFile options for an invocation. On Windows: no console window
 * for the child, and cmd.exe's line passed through as built. Elsewhere the options
 * are returned untouched.
 */
export function invocationOptions(invocation, options = {}, platform = process.platform) {
  if (platform !== "win32") return options;
  return {
    ...options,
    windowsHide: true,
    ...(invocation?.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
}
