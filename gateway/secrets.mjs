// The shared keys the three services authenticate each other with.
//
// Every service refuses an unauthenticated request, so something has to hold the
// keys. Generating them here — once, locally, into a file only this user can read
// — means no key is ever typed, pasted into a chat, or put on a command line. The
// control server reads them in process to spawn the services and to run the chat
// test; they never appear in an HTTP response.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { gatewayPaths } from "./paths.mjs";

// Each service reads its own key from this variable name.
export const SECRET_ENV = Object.freeze({
  codex: "CODEX_PROXY_SHARED_SECRET",
  claude: "CLAUDE_PROXY_SHARED_SECRET",
  router: "ROUTER_PROXY_SHARED_SECRET",
});

const FORMAT = 1;

function newSecret() {
  return crypto.randomBytes(32).toString("hex");
}

async function writePrivate(target, text) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}`;
  await fsp.rm(temporary, { force: true });
  // Create with the restrictive mode rather than relaxing it afterwards, so the
  // key is never briefly world-readable. Windows ignores the mode, so the file
  // also inherits the app directory's ACL, which is the user's own.
  const handle = await fsp.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, target);
}

async function readStored(paths) {
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.secretsFile, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.secrets && typeof parsed.secrets === "object") {
      return parsed.secrets;
    }
  } catch {
    // no file yet, or not ours to read
  }
  return {};
}

/**
 * Reads the keys, creating any that are missing. Callers get the values; nothing
 * here logs or returns them anywhere a response could pick them up.
 */
export async function loadSecrets({ paths = gatewayPaths(), services = Object.keys(SECRET_ENV) } = {}) {
  const stored = await readStored(paths);
  const secrets = {};
  const created = [];
  for (const service of services) {
    const existing = String(stored[service] || "").trim();
    if (existing) {
      secrets[service] = existing;
      continue;
    }
    secrets[service] = newSecret();
    created.push(service);
  }
  if (created.length) {
    // Keep any key belonging to a service this call did not ask about, so a
    // narrower call never discards one.
    const merged = { ...stored, ...secrets };
    await writePrivate(paths.secretsFile, `${JSON.stringify({ format: FORMAT, secrets: merged }, null, 2)}\n`);
  }
  return { secrets, created };
}

/** The keys that exist, creating none: for a caller that only looks, such as `cli.mjs status`. */
export async function readSecrets({ paths = gatewayPaths(), services = Object.keys(SECRET_ENV) } = {}) {
  const stored = await readStored(paths);
  const secrets = {};
  for (const service of services) {
    const existing = String(stored[service] || "").trim();
    if (existing) secrets[service] = existing;
  }
  return { secrets, created: [] };
}

/** The environment a service needs to recognize its own callers. */
export function secretEnvironment(service, secrets) {
  const name = SECRET_ENV[service];
  if (!name) return {};
  const value = secrets[service];
  return value ? { [name]: value } : {};
}
