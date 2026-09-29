// Several subscription logins per backend.
//
// Each account is one login: its own CLI config directory, and its own adapter
// process on its own port. The router is handed every account as a separate
// backend, in this file's order, and in "drain" mode that order is the order the
// accounts are used up in. A port is chosen once, when the account is added, and
// kept, so the router config and a running adapter never disagree about where
// the adapter is.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { accountDirectory, backend as authBackend } from "./auth.mjs";
import { gatewayPaths } from "./paths.mjs";

/** drain: one account until its limit, then the next. balance: spread evenly first. */
export const MODES = Object.freeze(["drain", "balance"]);
export const DEFAULT_MODE = "drain";

const FORMAT = 1;
const DEFAULT_PORT_BASE = 11460;
export const MAX_ACCOUNTS = 40;
const ID_PATTERN = /^(codex|claude)-(\d+)$/;

export function portBase(env = process.env) {
  const raw = Number.parseInt(String(env.GATEWAY_ADAPTER_PORT_BASE || ""), 10);
  return Number.isInteger(raw) && raw > 0 && raw + MAX_ACCOUNTS < 65_536 ? raw : DEFAULT_PORT_BASE;
}

// Ports something else in this gateway is configured to use; an adapter must not
// be handed one of them.
function reservedPorts(env) {
  const ports = new Set([11400, 11450]);
  for (const name of ["GATEWAY_ROUTER_PORT", "GATEWAY_UI_PORT"]) {
    const raw = Number.parseInt(String(env[name] || ""), 10);
    if (Number.isInteger(raw)) ports.add(raw);
  }
  return ports;
}

function validAccount(entry) {
  if (!entry || typeof entry !== "object") return false;
  const match = typeof entry.id === "string" ? entry.id.match(ID_PATTERN) : null;
  return Boolean(match) && match[1] === entry.backend && Number.isInteger(entry.port);
}

export async function readAccounts({ paths = gatewayPaths() } = {}) {
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.accountsFile, "utf8"));
    return {
      mode: MODES.includes(parsed?.mode) ? parsed.mode : DEFAULT_MODE,
      accounts: Array.isArray(parsed?.accounts) ? parsed.accounts.filter(validAccount) : [],
    };
  } catch {
    return { mode: DEFAULT_MODE, accounts: [] };
  }
}

async function writeAccounts(state, paths) {
  await fsp.mkdir(path.dirname(paths.accountsFile), { recursive: true });
  const temporary = `${paths.accountsFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  const body = { format: FORMAT, mode: state.mode, accounts: state.accounts };
  await fsp.writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, paths.accountsFile);
  return state;
}

// One writer at a time: two quick clicks must not both read the old file and
// each write back a list missing the other's change.
let queue = Promise.resolve();
function exclusive(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

export function findAccount(state, id) {
  return state.accounts.find(account => account.id === id) || null;
}

export async function addAccount(backendName, { paths = gatewayPaths(), env = process.env } = {}) {
  authBackend(backendName);
  return exclusive(async () => {
    const state = await readAccounts({ paths });
    if (state.accounts.length >= MAX_ACCOUNTS) throw new Error(`계정은 ${MAX_ACCOUNTS}개까지 추가할 수 있습니다`);
    const numbers = new Set(state.accounts
      .filter(account => account.backend === backendName)
      .map(account => Number(account.id.match(ID_PATTERN)[2])));
    let number = 1;
    while (numbers.has(number)) number += 1;
    const taken = new Set([...state.accounts.map(account => account.port), ...reservedPorts(env)]);
    const base = portBase(env);
    let port = base;
    while (taken.has(port)) port += 1;
    const account = { id: `${backendName}-${number}`, backend: backendName, port, createdAt: new Date().toISOString() };
    state.accounts.push(account);
    await writeAccounts(state, paths);
    await fsp.mkdir(accountDirectory(account, paths), { recursive: true });
    return account;
  });
}

/**
 * Forgets an account and deletes its CLI directory, which holds its credentials.
 * The caller stops its adapter and logs it out first.
 */
export async function removeAccount(id, { paths = gatewayPaths() } = {}) {
  return exclusive(async () => {
    const state = await readAccounts({ paths });
    const account = findAccount(state, id);
    if (!account) return null;
    state.accounts = state.accounts.filter(entry => entry.id !== id);
    await writeAccounts(state, paths);
    await fsp.rm(accountDirectory(account, paths), { recursive: true, force: true });
    return account;
  });
}

/** Swaps an account with its neighbour of the same backend; that order is drain priority. */
export async function moveAccount(id, direction, { paths = gatewayPaths() } = {}) {
  if (direction !== "up" && direction !== "down") throw new Error(`unknown direction: ${direction}`);
  return exclusive(async () => {
    const state = await readAccounts({ paths });
    const index = state.accounts.findIndex(account => account.id === id);
    if (index < 0) return null;
    const sameBackend = state.accounts
      .map((account, position) => ({ account, position }))
      .filter(entry => entry.account.backend === state.accounts[index].backend);
    const rank = sameBackend.findIndex(entry => entry.position === index);
    const neighbour = sameBackend[direction === "up" ? rank - 1 : rank + 1];
    if (!neighbour) return state;
    [state.accounts[index], state.accounts[neighbour.position]] = [state.accounts[neighbour.position], state.accounts[index]];
    return writeAccounts(state, paths);
  });
}

export async function setMode(mode, { paths = gatewayPaths() } = {}) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
  return exclusive(async () => {
    const state = await readAccounts({ paths });
    state.mode = mode;
    return writeAccounts(state, paths);
  });
}
