/**
 * The custom prompt library, one JSON file under `hiveHome()/prompts/`.
 *
 * Ids are minted here (`prm-<12 hex>`), skills and tags are lowercased and
 * de-duplicated on the way in, and the file is replaced atomically so a crash
 * mid-write cannot leave a half prompt behind.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureDir, hiveHome } from "../config.js";

function promptsPath() {
  return path.join(hiveHome(), "prompts", "prompts.json");
}

function readDocument() {
  const file = promptsPath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.prompts) ? parsed.prompts : [];
    return list.filter((entry) => entry && typeof entry.id === "string" && typeof entry.title === "string");
  } catch {
    return [];
  }
}

function writeDocument(prompts) {
  const file = promptsPath();
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, prompts }, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** Lowercase, trim, drop empties, keep the first occurrence. */
function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim().toLowerCase();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** Newest first, the order the prompt library panel expects. */
export function listPrompts() {
  return readDocument().slice().reverse();
}

export function getPrompt(id) {
  return readDocument().find((entry) => entry.id === id) ?? null;
}

export function createPrompt({ title, category, content, skills, tags } = {}) {
  const document = readDocument();
  const entry = {
    id: `prm-${randomBytes(6).toString("hex")}`,
    title: String(title).trim(),
    category: typeof category === "string" && category.trim() ? category.trim() : "General",
    content: String(content),
    skills: normalizeList(skills),
    tags: normalizeList(tags),
    custom: true,
    created_at: new Date().toISOString(),
  };
  writeDocument([...document, entry]);
  return entry;
}

/** @returns {boolean} whether a prompt with that id existed */
export function deletePrompt(id) {
  const document = readDocument();
  const kept = document.filter((entry) => entry.id !== id);
  if (kept.length === document.length) return false;
  writeDocument(kept);
  return true;
}
