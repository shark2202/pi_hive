/**
 * The shared (user-level) skill library and the per-session install queue.
 *
 * The library is plain directories under `hiveHome()/skills/<name>/SKILL.md`, so
 * an installed skill is readable by any tool that walks that root. Queued
 * requests live per session in `hiveHome()/sessions/<session>/skill-installs.json`;
 * approving one installs the stored copy into the library.
 */
import fs from "node:fs";
import path from "node:path";

import { ensureDir, hiveHome } from "../config.js";

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 256 * 1024;

export function libraryDir() {
  return path.join(hiveHome(), "skills");
}

/** Normalize a skill name the way the client does (lowercase, dashes). */
export function normalizeSkillName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function validSkillName(name) {
  return NAME_RE.test(String(name || ""));
}

/** `---\nname: x\ndescription: y\n---\n\nbody` */
export function renderSkill({ name, description, body }) {
  const front = [`---`, `name: ${name}`, `description: ${description || name}`, `---`, ""].join("\n");
  return `${front}\n${String(body || "").trim()}\n`;
}

/** Read `name:`/`description:` out of a SKILL.md front matter block. */
export function parseSkillMarkdown(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    const heading = text.match(/^#\s+(.+)$/m);
    return { name: heading ? normalizeSkillName(heading[1]) : "", description: "", body: text.trim() };
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (pair) fields[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return { name: normalizeSkillName(fields.name), description: fields.description || "", body: match[2].trim() };
}

export function listLibrarySkills() {
  const root = libraryDir();
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    const file = path.join(root, name, "SKILL.md");
    let description = "";
    try {
      description = parseSkillMarkdown(fs.readFileSync(file, "utf8")).description;
    } catch {
      continue; // a directory without SKILL.md is not a skill
    }
    out.push({ name, description, path: path.join(root, name) });
  }
  return out;
}

/**
 * Install into the library. `files` are extra documents stored beside SKILL.md;
 * a path that escapes the skill directory is refused, not sanitized silently.
 *
 * @returns {{ name: string, installed_path: string, replaced: boolean }}
 */
export function installSkill({ name, description, body, files = [] }) {
  if (!validSkillName(name)) throw new Error(`invalid skill name '${name}'`);
  if (files.length > MAX_FILES) throw new Error(`a skill may carry at most ${MAX_FILES} files`);
  const dir = path.join(libraryDir(), name);
  const replaced = fs.existsSync(path.join(dir, "SKILL.md"));
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, "SKILL.md"), renderSkill({ name, description, body }), "utf8");
  for (const file of files) {
    const relative = String(file?.path || "");
    if (!relative || relative.startsWith("/") || relative.split(/[\\/]/).includes("..")) {
      throw new Error(`file path must be relative and stay inside the skill: '${relative}'`);
    }
    const content = String(file?.content ?? "");
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`'${relative}' exceeds ${MAX_FILE_BYTES} bytes`);
    const target = path.join(dir, relative);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, content, "utf8");
  }
  return { name, installed_path: dir, replaced };
}

// --- per-session install requests ------------------------------------------

function requestsPath(sessionId) {
  return path.join(hiveHome(), "sessions", sessionId, "skill-installs.json");
}

export function readRequests(sessionId) {
  if (!SESSION_RE.test(String(sessionId || ""))) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(requestsPath(sessionId), "utf8"));
    return Array.isArray(parsed?.requests) ? parsed.requests : [];
  } catch {
    return [];
  }
}

function writeRequests(sessionId, requests) {
  const file = requestsPath(sessionId);
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, requests }, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

/** Queue one request; `replaces` is computed against the library as it stands. */
export function queueRequest(sessionId, { name, description, body, files = [] }) {
  if (!SESSION_RE.test(String(sessionId || ""))) throw new Error(`invalid session id '${sessionId}'`);
  if (!validSkillName(name)) throw new Error(`invalid skill name '${name}'`);
  const requests = readRequests(sessionId);
  const request = {
    id: `inst-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    description: description || name,
    body: String(body || ""),
    files: files.slice(0, MAX_FILES),
    requested_at: new Date().toISOString(),
    replaces: fs.existsSync(path.join(libraryDir(), name, "SKILL.md")),
  };
  writeRequests(sessionId, [...requests, request]);
  return request;
}

/**
 * Decide one queued request. Approving installs the stored copy; either way the
 * request leaves the queue so the client's poll stops offering it.
 *
 * @returns {{ request: object, installed: object | null } | null} null when unknown
 */
export function decideRequest(sessionId, requestId, decision) {
  const requests = readRequests(sessionId);
  const request = requests.find((entry) => entry.id === requestId);
  if (!request) return null;
  const installed =
    decision === "approve"
      ? installSkill({
          name: request.name,
          description: request.description,
          body: request.body,
          files: request.files || [],
        })
      : null;
  writeRequests(
    sessionId,
    requests.filter((entry) => entry.id !== requestId),
  );
  return { request, installed };
}
