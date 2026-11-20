/**
 * Local credential vault: `hiveHome()/credentials/vault.json`, mode 0600.
 *
 * This is the one place pi_hive writes a secret. Rules the module enforces:
 *   - the file is created 0600 (POSIX) and never leaves the state directory;
 *   - reads expose a per-field presence map (`has_keys`), never a value;
 *   - nothing here logs, so a secret cannot leak through a log line;
 *   - an empty/absent value deletes that field rather than storing "".
 *
 * `resyncAden()` talks to a configured Aden instance; without one the routes
 * answer an explicit 400 instead of pretending to have synced.
 */
import fs from "node:fs";
import path from "node:path";

import { ensureDir, hiveHome } from "../config.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_FIELDS = 24;
const MAX_VALUE_BYTES = 8192;

export function vaultPath() {
  return path.join(hiveHome(), "credentials", "vault.json");
}

function readVault() {
  try {
    const parsed = JSON.parse(fs.readFileSync(vaultPath(), "utf8"));
    return {
      credentials: parsed?.credentials && typeof parsed.credentials === "object" ? parsed.credentials : {},
      local: parsed?.local && typeof parsed.local === "object" ? parsed.local : {},
    };
  } catch {
    return { credentials: {}, local: {} };
  }
}

function writeVault(vault) {
  const file = vaultPath();
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, ...vault }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort: an unwritable mode must not fail the save
    }
  }
}

export function isSafeCredentialId(value) {
  return ID_RE.test(String(value || ""));
}

/** Validate a `keys` map; returns `{ error }` or `{ keys }` with only real strings. */
export function normalizeKeys(keys) {
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    return { error: "keys must be an object of field -> value" };
  }
  const entries = Object.entries(keys);
  if (entries.length === 0) return { error: "keys must not be empty" };
  if (entries.length > MAX_FIELDS) return { error: `keys may hold at most ${MAX_FIELDS} fields` };
  const out = {};
  for (const [field, value] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(field)) return { error: `invalid key field '${field}'` };
    if (typeof value !== "string") return { error: `'${field}' must be a string` };
    if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return { error: `'${field}' is too long` };
    out[field] = value; // "" means "remove this field" on save
  }
  return { keys: out };
}

/** Presence only: the caller learns which fields exist, never their values. */
export function credentialSummary(credentialId) {
  const entry = readVault().credentials[credentialId];
  if (!entry) return null;
  return {
    credential_id: credentialId,
    has_keys: Object.keys(entry.keys || {}).sort(),
    updated_at: entry.updated_at ?? null,
  };
}

export function listCredentials() {
  const { credentials } = readVault();
  return Object.keys(credentials).sort().map((id) => credentialSummary(id));
}

/** Save (merge) the fields of one credential. An empty value removes the field. */
export function saveCredential(credentialId, keys) {
  const vault = readVault();
  const existing = vault.credentials[credentialId] || { keys: {} };
  const merged = { ...existing.keys };
  for (const [field, value] of Object.entries(keys)) {
    if (value === "") delete merged[field];
    else merged[field] = value;
  }
  vault.credentials[credentialId] = {
    keys: merged,
    created_at: existing.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeVault(vault);
  return credentialSummary(credentialId);
}

export function deleteCredential(credentialId) {
  const vault = readVault();
  if (!vault.credentials[credentialId]) return false;
  delete vault.credentials[credentialId];
  writeVault(vault);
  return true;
}

function localKey(credentialId, alias) {
  return `${credentialId}::${alias}`;
}

export function listLocal(credentialId = null) {
  const { local } = readVault();
  return Object.entries(local)
    .filter(([, entry]) => (credentialId ? entry.credential_id === credentialId : true))
    .map(([, entry]) => ({
      credential_id: entry.credential_id,
      account: entry.account,
      has_keys: Object.keys(entry.keys || {}).sort(),
      created_at: entry.created_at ?? null,
    }));
}

/** A named local account. `alias` defaults to the provider id. */
export function saveLocal({ credentialId, alias, account, keys }) {
  const vault = readVault();
  const kept = Object.fromEntries(Object.entries(keys || {}).filter(([, value]) => value !== ""));
  const id = alias || account || credentialId;
  const existing = vault.local[localKey(credentialId, id)];
  vault.local[localKey(credentialId, id)] = {
    credential_id: credentialId,
    account: account || id,
    keys: kept,
    created_at: existing?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeVault(vault);
  return {
    saved: credentialId,
    status: "saved",
    identity: { account: account || id },
    has_keys: Object.keys(kept).sort(),
  };
}

export function deleteLocal(credentialId, alias) {
  const vault = readVault();
  const key = localKey(credentialId, alias);
  if (!vault.local[key]) return false;
  delete vault.local[key];
  writeVault(vault);
  return true;
}

/** The account map the client renders, built from what is actually stored. */
export function accountsByProvider() {
  const out = {};
  for (const entry of listLocal()) {
    const list = out[entry.credential_id] ?? [];
    list.push({ account: entry.account, valid: null, has_keys: entry.has_keys });
    out[entry.credential_id] = list;
  }
  return out;
}

/**
 * Merge an Aden account list into the local registry.
 *
 * @returns {{ synced: boolean, accounts_by_provider: object, imported: number }}
 */
export function mergeAdenAccounts(accounts) {
  const vault = readVault();
  let imported = 0;
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const credentialId = typeof account?.credential_id === "string" ? account.credential_id : null;
    const name = typeof account?.account === "string" ? account.account : null;
    if (!credentialId || !name || !isSafeCredentialId(credentialId)) continue;
    const key = localKey(credentialId, name);
    if (vault.local[key]) continue; // a local account of the same name wins
    vault.local[key] = {
      credential_id: credentialId,
      account: name,
      // Aden never returns the secret; the entry records that a key exists remotely.
      keys: {},
      aden: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    imported += 1;
  }
  if (imported) writeVault(vault);
  return { synced: true, accounts_by_provider: accountsByProvider(), imported };
}

export function adenConfig() {
  const base = process.env.PI_HIVE_ADEN_URL || "";
  const key = process.env.PI_HIVE_ADEN_KEY || "";
  return base && key ? { base: base.replace(/\/+$/, ""), key } : null;
}
