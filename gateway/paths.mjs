// Where this installation keeps what it owns.
//
// The credentials this gateway uses are its own, not the ones the user's own
// `codex` and `claude` CLIs hold. Each backend gets a private config directory
// and the CLI is told to use it (CODEX_HOME, CLAUDE_CONFIG_DIR), so a login here
// never reads, writes, or invalidates the developer's own login. That matters
// beyond tidiness: the Codex adapter rewrites the rotated refresh token, and two
// writers of one token chain invalidate each other.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ID = "subscription-gateway";
const APP_DIR_NAME = "SubscriptionGateway";

export function userHome(env = process.env) {
  return path.resolve(env.GATEWAY_USER_HOME || os.homedir());
}

export function appHome(env = process.env, platform = process.platform) {
  if (env.GATEWAY_HOME) return path.resolve(env.GATEWAY_HOME);
  const home = userHome(env);
  if (platform === "win32") {
    return path.join(path.resolve(env.LOCALAPPDATA || path.join(home, "AppData", "Local")), APP_DIR_NAME);
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_DIR_NAME);
  return path.join(path.resolve(env.XDG_DATA_HOME || path.join(home, ".local", "share")), APP_ID);
}

export function gatewayPaths(env = process.env, platform = process.platform) {
  const home = appHome(env, platform);
  return {
    appHome: home,
    // One directory per account, handed to the CLI as its whole config home.
    authDir: (backend, accountId) => path.join(home, "auth", backend, accountId),
    accountsFile: path.join(home, "accounts.json"),
    secretsFile: path.join(home, "secrets.json"),
    routerConfigFile: path.join(home, "router-config.json"),
    runtimeDir: path.join(home, "runtime"),
    pidFile: (service) => path.join(home, "runtime", `${service}.pid.json`),
    logDir: path.join(home, "logs"),
    logFile: (service) => path.join(home, "logs", `${service}.log`),
  };
}

export function sourceRoot() {
  // fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/...".
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
