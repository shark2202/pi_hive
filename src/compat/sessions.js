/**
 * Durable session registry for the official-frontend compatibility shell.
 *
 * pi_hive has no long-lived session manager: a QueenRuntime is keyed by
 * colony and its conversation lives in the colony's
 * `sessions/queen_<queen_id>.json`. The official frontend, however, talks in
 * session ids. This module stores one real session record per id under
 * `PI_HIVE_HOME/sessions/<session_id>/session.json` and maps that record onto
 * a colony + queen runtime. Nothing is synthesized: `list()` only returns
 * records that exist on disk, and an unknown id is a miss.
 *
 * Layout:
 *   <PI_HIVE_HOME>/sessions/<session_id>/session.json   metadata (atomic write)
 *   <PI_HIVE_HOME>/sessions/<session_id>/events.jsonl   AgentEvent log
 *   <PI_HIVE_HOME>/sessions/<session_id>/attachments/   uploads
 *
 * The store is intentionally synchronous and dependency-free. Files are
 * small; the event log is append-only. Tests create one store per temp home.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { colonyDir, hiveHome } from "../config.js";
import { listTasks } from "../domain/plan.js";
import { loadMetadata } from "../domain/colony.js";

export const SESSION_SCHEMA = "pi_hive.session.v1";
export const SESSION_ROOT_NAME = "sessions";

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 10000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** True for ids that are safe as one path segment and cannot traverse. */
export function isSafeSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value) && !value.includes("..");
}

/** Collision-resistant, path-safe id. */
export function newSessionId(prefix = "sess") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function metadataFor(colonyId) {
  if (!colonyId) return null;
  try {
    return loadMetadata(colonyId);
  } catch {
    return null;
  }
}

function pathForColony(colonyId) {
  if (!colonyId) return "";
  try {
    return colonyDir(colonyId);
  } catch {
    return "";
  }
}

function openTaskCount(colonyId) {
  if (!colonyId) return 0;
  try {
    return listTasks(colonyId).filter((task) => !["completed", "archived"].includes(task.status)).length;
  } catch {
    return 0;
  }
}

/** Write via a sibling temp file + rename so readers never see a partial JSON. */
function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export class SessionStore {
  constructor({ home = hiveHome(), root = null } = {}) {
    this.home = home;
    this.root = root || path.join(home, SESSION_ROOT_NAME);
    /**
     * Ids loaded in THIS process. The official GET /sessions is an in-memory
     * live feed, so a record that survived a restart stays on disk (and in
     * colony history) as cold until a chat revives it.
     */
    this.liveIds = new Set();
  }

  /** Mark a session live after creation or a successful revival. */
  markLive(sessionId) {
    if (isSafeSessionId(sessionId)) this.liveIds.add(sessionId);
    return sessionId;
  }

  isLive(sessionId) {
    return this.liveIds.has(sessionId);
  }

  /** Root directory holding every session directory. */
  rootDir() {
    return this.root;
  }

  sessionDir(sessionId) {
    if (!isSafeSessionId(sessionId)) {
      throw new Error(`invalid session id: ${sessionId}`);
    }
    return path.join(this.root, sessionId);
  }

  sessionFile(sessionId) {
    return path.join(this.sessionDir(sessionId), "session.json");
  }

  eventsFile(sessionId) {
    return path.join(this.sessionDir(sessionId), "events.jsonl");
  }

  attachmentsDir(sessionId) {
    return path.join(this.sessionDir(sessionId), "attachments");
  }

  ensureAttachmentsDir(sessionId) {
    const dir = this.attachmentsDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Create a real session record bound to a colony (or an independent queen
   * when `colonyId` is absent). The colony must already exist.
   */
  create({
    colonyId = null,
    sessionId = null,
    queenId = null,
    queenName = null,
    model = null,
    initialPrompt = null,
    phase = null,
    sourceSessionId = null,
    forkedFrom = null,
    title = null,
  } = {}) {
    const meta = metadataFor(colonyId);
    if (colonyId && !meta) throw new Error(`colony '${colonyId}' not found`);

    const id = sessionId || newSessionId();
    if (!isSafeSessionId(id)) throw new Error(`invalid session id: ${id}`);
    const dir = this.sessionDir(id);
    if (fs.existsSync(dir)) throw new Error(`session '${id}' already exists`);

    const resolvedQueenId = queenId || meta?.queen_id || "queen_growth";
    const resolvedQueenName = queenName || meta?.queen_name || resolvedQueenId;
    const createdAt = nowIso();
    const createdAtMs = Date.now();

    const record = {
      schema: SESSION_SCHEMA,
      session_id: id,
      colony_id: colonyId || null,
      queen_id: resolvedQueenId,
      queen_name: resolvedQueenName,
      model: model || null,
      title: title || null,
      description: "",
      goal: typeof meta?.goal === "string" ? meta.goal : "",
      initial_prompt: initialPrompt || null,
      agent_path: pathForColony(colonyId),
      phase: phase || (colonyId ? "colony" : "independent"),
      created_at: createdAt,
      created_at_ms: createdAtMs,
      loaded_at: Math.floor(createdAtMs / 1000),
      updated_at: createdAt,
      last_active_at: createdAtMs,
      message_count: 0,
      last_message: null,
      colony_spawned: false,
      spawned_colony_id: null,
      source_session_id: sourceSessionId || null,
      forked_from: forkedFrom || null,
      compaction_summary: null,
      pending_context: [],
      stopped_at: null,
      stop_reason: null,
    };

    fs.mkdirSync(this.attachmentsDir(id), { recursive: true });
    writeJsonAtomic(this.sessionFile(id), record);
    this.markLive(id);
    return record;
  }

  /** Read one record, or null when the directory/file is missing or corrupt. */
  get(sessionId) {
    if (!isSafeSessionId(sessionId)) return null;
    const file = this.sessionFile(sessionId);
    if (!fs.existsSync(file)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isPlainObject(record) || record.session_id !== sessionId) return null;
      return record;
    } catch {
      return null;
    }
  }

  /** Merge fields into a record and persist atomically. Returns the record. */
  update(sessionId, patch = {}) {
    const record = this.get(sessionId);
    if (!record) return null;
    const next = { ...record, ...patch, updated_at: nowIso(), last_active_at: Date.now() };
    writeJsonAtomic(this.sessionFile(sessionId), next);
    return next;
  }

  /**
   * Every real record on disk, newest first. `includeStopped` defaults to
   * false because the official GET /sessions is a live-session feed; colony
   * history asks for the full list.
   */
  list({ colonyId = null, includeStopped = false } = {}) {
    if (!fs.existsSync(this.root)) return [];
    const records = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isSafeSessionId(entry.name)) continue;
      const record = this.get(entry.name);
      if (!record) continue;
      if (colonyId && record.colony_id !== colonyId) continue;
      if (!includeStopped && (record.stopped_at || !this.isLive(record.session_id))) continue;
      records.push(record);
    }
    records.sort(
      (a, b) =>
        Number(b.last_active_at || b.created_at_ms || 0) -
          Number(a.last_active_at || a.created_at_ms || 0) ||
        String(a.session_id).localeCompare(String(b.session_id)),
    );
    return records;
  }

  /** Stop a session. With `purge`, remove its directory entirely. */
  stop(sessionId, { purge = false, reason = "stopped" } = {}) {
    const record = this.get(sessionId);
    if (!record) return null;
    this.liveIds.delete(sessionId);
    if (purge) {
      fs.rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
      return record;
    }
    return this.update(sessionId, { stopped_at: nowIso(), stop_reason: reason });
  }

  /** Latest non-stopped session for a colony with at least one message. */
  activeForColony(colonyId) {
    return (
      this.list({ colonyId, includeStopped: true })
        .filter((record) => Number(record.message_count || 0) > 0)
        .sort(
          (a, b) =>
            Number(b.last_active_at || 0) - Number(a.last_active_at || 0),
        )[0] || null
    );
  }

  /** Official HistorySession row for a stored record. */
  toHistory(record, { live = null } = {}) {
    const isLive = live === null ? !record.stopped_at && this.isLive(record.session_id) : Boolean(live);
    return {
      session_id: record.session_id,
      cold: !isLive,
      live: isLive,
      has_messages: Number(record.message_count || 0) > 0,
      created_at: Number(record.created_at_ms || 0),
      last_active_at: Number(record.last_active_at || record.created_at_ms || 0),
      agent_name: record.colony_id || null,
      agent_path: record.agent_path || null,
      queen_id: record.queen_id || null,
      last_message: record.last_message || null,
      message_count: Number(record.message_count || 0),
      title: record.title || null,
      forked_from: record.forked_from || null,
    };
  }

  /** Official LiveSession row. All values come from the stored record/colony. */
  toLive(record, { now = Date.now() } = {}) {
    const meta = metadataFor(record.colony_id);
    const createdAtMs = Number(record.created_at_ms || now);
    const loadedAt = Number(record.loaded_at || createdAtMs / 1000);
    return {
      session_id: record.session_id,
      colony_id: record.colony_id || null,
      has_worker: Boolean(record.colony_id),
      agent_path: record.agent_path || pathForColony(record.colony_id),
      description: record.description || "",
      goal: record.goal || meta?.goal || "",
      node_count: openTaskCount(record.colony_id),
      loaded_at: loadedAt,
      uptime_seconds: Math.round(Math.max(0, now - createdAtMs) / 100) / 10,
      queen_phase: record.phase || (record.colony_id ? "colony" : "independent"),
      queen_supports_images: true,
      queen_id: record.queen_id || null,
      queen_name: record.queen_name || null,
      colony_spawned: Boolean(record.colony_spawned),
      spawned_colony_id: record.spawned_colony_id || null,
    };
  }

  /** LiveSessionDetail: live fields plus entry points / cold flag. */
  toDetail(record, { entryPoints = null, cold = null, now = Date.now() } = {}) {
    return {
      ...this.toLive(record, { now }),
      title: record.title || null,
      forked_from: record.forked_from || null,
      message_count: Number(record.message_count || 0),
      last_active_at: Number(record.last_active_at || record.created_at_ms || 0),
      colonies: record.colony_id ? [record.colony_id] : [],
      entry_points: entryPoints || [],
      cold: cold === null ? Boolean(record.stopped_at) || !this.isLive(record.session_id) : Boolean(cold),
    };
  }

  /**
   * Append one official AgentEvent-shaped line. Updates the record's message
   * counters for user/assistant events and persists it atomically.
   */
  appendEvent(
    sessionId,
    {
      type = "custom",
      data = {},
      streamId = "queen",
      nodeId = "queen",
      executionId = null,
      correlationId = null,
      timestamp = null,
      runId = null,
    } = {},
  ) {
    const record = this.get(sessionId);
    if (!record) return null;

    const event = {
      type,
      stream_id: streamId,
      node_id: nodeId,
      execution_id: executionId || sessionId,
      data: isPlainObject(data) ? data : {},
      timestamp: timestamp || nowIso(),
      correlation_id: correlationId,
      colony_id: record.colony_id || null,
      run_id: runId,
      seq: this.nextSeq(sessionId),
    };

    fs.mkdirSync(this.sessionDir(sessionId), { recursive: true });
    fs.appendFileSync(this.eventsFile(sessionId), `${JSON.stringify(event)}\n`);

    const patch = {};
    if (type === "client_input_received" || type === "llm_text_delta") {
      patch.message_count = Number(record.message_count || 0) + 1;
      const content = typeof event.data.content === "string" ? event.data.content : "";
      if (content) patch.last_message = content.slice(0, 500);
    }
    // An appended event is activity: update() also stamps last_active_at.
    if (Object.keys(patch).length) this.update(sessionId, patch);
    return event;
  }

  /** Highest seq in the log + 1; 0 for an empty log. */
  nextSeq(sessionId) {
    const file = this.eventsFile(sessionId);
    if (!fs.existsSync(file)) return 0;
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const seq = JSON.parse(lines[i]).seq;
          if (Number.isInteger(seq)) return seq + 1;
        } catch {
          // Keep walking back past a corrupt tail line.
        }
      }
    } catch {
      return 0;
    }
    return 0;
  }

  eventCount(sessionId) {
    const file = this.eventsFile(sessionId);
    if (!fs.existsSync(file)) return 0;
    try {
      return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  /**
   * Backward page of the persisted event log, matching the official
   * EventsHistoryPage. Cursors are offsets into the raw file, so pages stay
   * stable while new events are appended.
   */
  readEvents(
    sessionId,
    { limit = DEFAULT_EVENT_LIMIT, beforeOffset = null, beforeIndex = null } = {},
  ) {
    const file = this.eventsFile(sessionId);
    const effectiveLimit = clamp(Number(limit) || DEFAULT_EVENT_LIMIT, 1, MAX_EVENT_LIMIT);

    const empty = {
      events: [],
      session_id: sessionId,
      total: 0,
      returned: 0,
      truncated: false,
      limit: effectiveLimit,
      start_index: 0,
      start_offset: 0,
      has_more_older: false,
    };
    if (!fs.existsSync(file)) return empty;

    const raw = fs.readFileSync(file);
    const lines = [];
    let offset = 0;
    while (offset < raw.length) {
      const nl = raw.indexOf(10, offset);
      const end = nl === -1 ? raw.length : nl;
      if (end > offset) lines.push({ offset, text: raw.subarray(offset, end).toString("utf8") });
      if (nl === -1) break;
      offset = nl + 1;
    }

    const cursor =
      Number.isInteger(beforeOffset) && beforeOffset >= 0
        ? lines.filter((line) => line.offset < beforeOffset)
        : lines;
    const end = cursor.length;
    const start = Math.max(0, end - effectiveLimit);

    const events = [];
    for (let i = start; i < end; i += 1) {
      try {
        const parsed = JSON.parse(cursor[i].text);
        if (isPlainObject(parsed)) events.push(parsed);
      } catch {
        // A torn line is skipped; the rest of the page stays usable.
      }
    }

    return {
      events,
      session_id: sessionId,
      total: beforeOffset === null ? lines.length : -1,
      returned: events.length,
      truncated: false,
      limit: effectiveLimit,
      start_index: events.length ? start + 1 : 0,
      start_offset: events.length ? cursor[start].offset : 0,
      has_more_older: start > 0,
    };
  }
}

export default SessionStore;
