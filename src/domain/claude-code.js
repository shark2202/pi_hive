/**
 * Claude Code queens: read-only access to the transcripts Claude Code writes.
 *
 * A "Claude Code queen" is a queen whose mail is handled by a Claude Code
 * session instead of an in-process agent (`queen_mail.claude_code` in
 * `configuration.json`). This host does not drive that session; it reads the
 * transcript Claude Code already writes under `~/.claude/projects/<slug>/<id>.jsonl`
 * and shapes it as the official `TranscriptEntry` list.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hiveHome } from "../config.js";

const LETTER_MARKER = /<\/?hive[-_]?letter\b|hive_letter|from queen/i;

/** `~/.claude` unless CLAUDE_CONFIG_DIR says otherwise. */
export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
}

/**
 * The queens configured for Claude Code mail.
 *
 * Accepts the two shapes Hive has used: a map keyed by queen id, and a list of
 * `{id, ...}` records. Anything else is ignored rather than guessed at.
 */
export function configuredQueens() {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(hiveHome(), "configuration.json"), "utf8"));
  } catch {
    return [];
  }
  const section = doc?.queen_mail?.claude_code;
  const entries = [];
  if (Array.isArray(section)) {
    for (const entry of section) {
      if (entry && typeof entry.id === "string") entries.push({ id: entry.id, ...entry });
    }
  } else if (section && typeof section === "object") {
    for (const [id, entry] of Object.entries(section)) {
      if (entry && typeof entry === "object") entries.push({ id, ...entry });
    }
  }
  return entries.map((entry) => ({
    id: entry.id,
    name: typeof entry.name === "string" ? entry.name : entry.id,
    title: typeof entry.title === "string" ? entry.title : "",
    permission_mode: typeof entry.permission_mode === "string" ? entry.permission_mode : "default",
    auth: entry.auth === "subscription" ? "subscription" : "api_key",
    model: typeof entry.model === "string" ? entry.model : null,
    /** Where Claude Code runs for her; the transcript slug derives from it. */
    workspace: typeof entry.workspace === "string" ? entry.workspace : typeof entry.cwd === "string" ? entry.cwd : null,
  }));
}

function projectDirs() {
  const root = path.join(claudeConfigDir(), "projects");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

/** Locate `<conversation>.jsonl` in any project dir (the slug is cwd-derived). */
function findTranscript(conversation) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(conversation || ""))) return null;
  for (const dir of projectDirs()) {
    const candidate = path.join(dir, `${conversation}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Session ids per project dir, newest file first, for the queen listing. */
export function conversationIds(limit = 20) {
  const found = [];
  for (const dir of projectDirs()) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        found.push({ session_id: name.slice(0, -6), last_at: stat.mtime.toISOString(), file });
      } catch {
        // a file that vanished mid-listing is simply skipped
      }
    }
  }
  return found.sort((a, b) => (a.last_at < b.last_at ? 1 : -1)).slice(0, limit);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.text || ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Map one Claude Code JSONL record to zero or more `TranscriptEntry` rows.
 * Unknown record types are dropped: the panel renders four kinds only.
 */
function entriesOf(record) {
  const at = typeof record?.timestamp === "string" ? record.timestamp : new Date(0).toISOString();
  const message = record?.message;
  const role = message?.role || record?.type;
  const out = [];

  if (role === "user") {
    const text = textOf(message?.content);
    if (text) out.push({ at, kind: LETTER_MARKER.test(text) ? "letter" : "text", text });
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_result") {
          const body = textOf(part.content);
          out.push({ at, kind: "result", text: body.slice(0, 4000), error: part.is_error === true });
        }
      }
    }
    return out;
  }

  if (role === "assistant") {
    const text = textOf(message?.content);
    if (text) out.push({ at, kind: "text", text });
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_use") {
          out.push({
            at,
            kind: "tool",
            tool: typeof part.name === "string" ? part.name : "tool",
            text: JSON.stringify(part.input ?? {}, null, 2).slice(0, 4000),
          });
        }
      }
    }
  }
  return out;
}

/**
 * The transcript of one conversation.
 *
 * @returns {{ entries: object[] } | null} null when the file does not exist
 */
export function readTranscript(conversation) {
  const file = findTranscript(conversation);
  if (!file) return null;
  const entries = [];
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a half-written trailing line is not a transcript entry
    }
    entries.push(...entriesOf(record));
  }
  return { entries };
}
