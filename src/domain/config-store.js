/**
 * Durable configuration store: the writable half of `/api/config`.
 *
 * Everything lives under `hiveHome()/config/`. Secrets are never stored here —
 * an LLM section may record `api_key_env_var` (the *name* of the variable), and
 * `api_key` in a payload is rejected.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const LLM_ROLES = Object.freeze(["llm", "worker_llm", "vision_fallback", "judge"]);
export const FEATURE_KEYS = Object.freeze(["adaptive_tool_budget", "email_senders", "stall_check"]);

// shortcut: hiveHome() is duplicated here so src/config.js can read the store
// without a circular import; upgrade when config.js stops owning home().
function home() {
  return process.env.PI_HIVE_HOME || path.join(os.homedir(), ".pi-hive");
}

function storeDir() {
  return path.join(home(), "config");
}

function fileFor(name) {
  return path.join(storeDir(), name);
}

function readJson(name, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(fileFor(name), "utf8"));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  fs.mkdirSync(storeDir(), { recursive: true });
  const target = fileFor(name);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, target);
}

/**
 * Validate one `LlmSection`. `null` clears a slot. `api_key` is refused: a key
 * belongs in the environment, not in a config file.
 */
export function sectionError(section) {
  if (section === null) return null;
  if (typeof section !== "object" || Array.isArray(section)) {
    return "section must be an object or null";
  }
  if ("api_key" in section) return "api_key is not accepted; name it through api_key_env_var";
  for (const key of ["provider", "model", "api_base", "api_key_env_var"]) {
    if (section[key] !== undefined && typeof section[key] !== "string") {
      return `${key} must be a string`;
    }
  }
  for (const key of ["max_tokens", "max_context_tokens"]) {
    if (section[key] !== undefined && section[key] !== null && typeof section[key] !== "number") {
      return `${key} must be a number or null`;
    }
  }
  return null;
}

/** Strip `undefined` so a stored section is exactly what the caller sent. */
export function cleanSection(section) {
  if (section === null) return null;
  const kept = {};
  for (const [key, value] of Object.entries(section)) {
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

// --- llm slot (the model the runtime actually runs) -------------------------

export function readLlmOverride() {
  return readJson("llm.json", null);
}

export function writeLlmOverride(section) {
  writeJson("llm.json", section);
  return section;
}


// --- provider slots ---------------------------------------------------------

export function readSections() {
  return readJson("llm-sections.json", {});
}

export function writeSection(role, section) {
  const sections = readSections();
  if (section === null) delete sections[role];
  else sections[role] = cleanSection(section);
  writeJson("llm-sections.json", sections);
  return sections;
}

// --- provider library -------------------------------------------------------

export function readLibrary() {
  return readJson("provider-library.json", {});
}

export function setLibraryEntry(name, section) {
  const library = readLibrary();
  if (section === null) delete library[name];
  else library[name] = cleanSection(section);
  writeJson("provider-library.json", library);
  return library;
}

// --- external skill roots ---------------------------------------------------

export function readSkillPaths() {
  const stored = readJson("external-skills.json", []);
  return Array.isArray(stored) ? stored : [];
}

export function writeSkillPaths(paths) {
  writeJson("external-skills.json", paths);
  return paths;
}

// --- feature flags ----------------------------------------------------------

export function readFeatures() {
  return readJson("features.json", {});
}

export function writeFeatures(features) {
  const merged = { ...readFeatures(), ...features };
  writeJson("features.json", merged);
  return merged;
}

// --- user profile -----------------------------------------------------------

export function readProfile() {
  return readJson("profile.json", {});
}

export function writeProfile(patch) {
  const merged = { ...readProfile(), ...patch };
  writeJson("profile.json", merged);
  return merged;
}

// --- social rate limits -----------------------------------------------------

export function readRateLimits() {
  const stored = readJson("rate-limits.json", []);
  return Array.isArray(stored) ? stored : [];
}

export function writeRateLimits(entries) {
  writeJson("rate-limits.json", entries);
  return entries;
}

// --- profile avatar ---------------------------------------------------------

export function saveAvatar({ bytes, contentType }) {
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.writeFileSync(fileFor("avatar.bin"), bytes);
  writeJson("avatar.json", { content_type: contentType, size: bytes.length });
  return { content_type: contentType, size: bytes.length };
}

export function readAvatar() {
  const meta = readJson("avatar.json", null);
  if (!meta) return null;
  try {
    return { bytes: fs.readFileSync(fileFor("avatar.bin")), content_type: meta.content_type };
  } catch {
    return null;
  }
}

export function hasAvatar() {
  return readAvatar() !== null;
}

export function deleteAvatar() {
  for (const name of ["avatar.bin", "avatar.json"]) {
    try {
      fs.rmSync(fileFor(name));
    } catch {
      // already gone
    }
  }
}
