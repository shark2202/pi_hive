/**
 * Per-queen mutable state: catalog entries, persona, LLM section, tool
 * allowlist, avatar bytes, and the queen's DM session id.
 *
 * Layout: `$PI_HIVE_HOME/queens/<queen_id>/`
 *   profile.json    catalog + profile overrides (also marks custom queens)
 *   persona.json    full QueenPersona replacement
 *   llm.json        per-queen LLM section (null clears it)
 *   tools.json      enabled_mcp_tools allowlist (absent = role default)
 *   removed.json    removal marker; restore deletes it
 *   avatar.bin      + avatar.json (content type, size)
 *   dm_session.json the queen's currently selected DM session
 *
 * Writes go through a temp file and `rename`, so a crash never leaves a
 * half-written row that later reads would mis-parse.
 */

import fs from "node:fs";
import path from "node:path";

import { ensureDir, hiveHome } from "../config.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export function isSafeQueenId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

export function queenStateDir(id) {
  if (!isSafeQueenId(id)) throw new Error(`unsafe queen id: ${JSON.stringify(id)}`);
  return path.join(hiveHome(), "queens", id);
}

function fileIn(id, name) {
  return path.join(queenStateDir(id), name);
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    // A missing or corrupt row is "no state", not a crash: the API must still
    // answer for a queen whose file was written by an older build.
    return null;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
  return value;
}

function removeFile(file) {
  fs.rmSync(file, { force: true });
}

/** Profile overrides layered on top of the code-defined role identity. */
export function readProfile(id) {
  return readJson(fileIn(id, "profile.json"));
}

export function patchProfile(id, patch) {
  const next = { ...(readProfile(id) || {}), ...patch };
  writeJson(fileIn(id, "profile.json"), next);
  return next;
}

export function readPersona(id) {
  return readJson(fileIn(id, "persona.json"))?.persona ?? null;
}

/** `null` clears the override so the derived role persona is used again. */
export function writePersona(id, persona) {
  if (persona === null) {
    removeFile(fileIn(id, "persona.json"));
    return null;
  }
  writeJson(fileIn(id, "persona.json"), { persona });
  return persona;
}

export function readLlm(id) {
  const row = readJson(fileIn(id, "llm.json"));
  return row && row.section !== undefined ? row.section : null;
}

export function writeLlm(id, section) {
  if (section === null) {
    removeFile(fileIn(id, "llm.json"));
    return null;
  }
  writeJson(fileIn(id, "llm.json"), { section });
  return section;
}

/** `null` means "role default": no explicit allowlist on disk. */
export function readTools(id) {
  const row = readJson(fileIn(id, "tools.json"));
  return row && Array.isArray(row.enabled_mcp_tools) ? row.enabled_mcp_tools : null;
}

export function writeTools(id, list) {
  if (list === null) {
    removeFile(fileIn(id, "tools.json"));
    return null;
  }
  writeJson(fileIn(id, "tools.json"), {
    enabled_mcp_tools: list,
    updated_at: new Date().toISOString(),
  });
  return list;
}

export function isRemoved(id) {
  return readJson(fileIn(id, "removed.json"))?.removed === true;
}

export function setRemoved(id, removed) {
  if (removed) {
    writeJson(fileIn(id, "removed.json"), { removed: true, at: new Date().toISOString() });
  } else {
    removeFile(fileIn(id, "removed.json"));
  }
  return removed;
}

export function hasAvatar(id) {
  return fs.existsSync(fileIn(id, "avatar.bin"));
}

export function saveAvatar(id, { bytes, contentType }) {
  ensureDir(queenStateDir(id));
  fs.writeFileSync(fileIn(id, "avatar.bin"), bytes);
  writeJson(fileIn(id, "avatar.json"), {
    content_type: contentType,
    size: bytes.length,
    at: new Date().toISOString(),
  });
  return { avatar_url: `/api/queen/${id}/avatar`, size: bytes.length, content_type: contentType };
}

/** @returns {{buffer: Buffer, content_type: string, size: number} | null} */
export function readAvatar(id) {
  const meta = readJson(fileIn(id, "avatar.json"));
  if (!meta) return null;
  try {
    return { buffer: fs.readFileSync(fileIn(id, "avatar.bin")), ...meta };
  } catch {
    return null;
  }
}

export function deleteAvatar(id) {
  const existed = hasAvatar(id);
  removeFile(fileIn(id, "avatar.bin"));
  removeFile(fileIn(id, "avatar.json"));
  return existed;
}

/** Queen ids that exist on disk (custom queens and any state for built-ins). */
export function listQueenIds() {
  const root = path.join(hiveHome(), "queens");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeQueenId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function queenExistsOnDisk(id) {
  return isSafeQueenId(id) && fs.existsSync(queenStateDir(id));
}

export function readDmSession(id) {
  return readJson(fileIn(id, "dm_session.json"))?.session_id ?? null;
}

export function writeDmSession(id, sessionId) {
  writeJson(fileIn(id, "dm_session.json"), { session_id: sessionId, at: new Date().toISOString() });
  return sessionId;
}
