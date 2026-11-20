/**
 * Durable colony event log: `colonies/<name>/events.jsonl`.
 *
 * The in-process EventEmitter loses everything on restart, so a reconnecting
 * client saw only what happened since the process started. Every emitted event is
 * appended here (one JSON object per line) and a reader can replay from a cursor,
 * which is the byte offset just past the last event it consumed.
 */
import fs from "node:fs";
import path from "node:path";

import { colonyPaths } from "./colony.js";

const MAX_EVENT_BYTES = 16 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export function eventLogPath(colony) {
  return path.join(colonyPaths(colony).dir, "events.jsonl");
}

/** Current cursor: the byte length of the log (0 when absent). */
export function eventCursor(colony) {
  try {
    return fs.statSync(eventLogPath(colony)).size;
  } catch {
    return 0;
  }
}

/** Trim an event so one huge tool result cannot bloat the log. */
function trim(event) {
  const json = JSON.stringify(event);
  if (Buffer.byteLength(json) <= MAX_EVENT_BYTES) return { line: json, truncated: false };
  const text = typeof event?.text === "string" ? event.text.slice(0, 4000) : undefined;
  const trimmed = {
    ...event,
    ...(text === undefined ? {} : { text }),
    truncated: true,
  };
  return { line: JSON.stringify(trimmed), truncated: true };
}

/**
 * Append one event. `type` is required; everything else is kept as given.
 *
 * @returns {{ cursor: number, event: object } | null} null when the event is unusable
 */
export function appendEvent(colony, event, { at = new Date() } = {}) {
  if (!event || typeof event !== "object" || typeof event.type !== "string" || !event.type) return null;
  const file = eventLogPath(colony);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { at: at.toISOString(), ...event };
  const { line } = trim(record);
  fs.appendFileSync(file, `${line}\n`, "utf8");
  return { cursor: eventCursor(colony), event: record };
}

/**
 * Replay events after `cursor`.
 *
 * A cursor that is not at a line boundary is aligned forward, so a half-written
 * line from a crash is skipped instead of corrupting the stream. A corrupt line
 * inside the window is reported in `skipped` rather than throwing.
 *
 * @returns {{ events: object[], cursor: number, skipped: number, truncated: boolean }}
 */
export function readEvents(colony, { cursor = 0, limit = DEFAULT_LIMIT } = {}) {
  const file = eventLogPath(colony);
  const effectiveLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch {
    return { events: [], cursor: 0, skipped: 0, truncated: false };
  }
  const total = buffer.length;
  let start = Math.min(Math.max(Number(cursor) || 0, 0), total);
  // Align to the next line start.
  if (start > 0 && buffer[start - 1] !== 0x0a) {
    const nextBreak = buffer.indexOf(0x0a, start);
    start = nextBreak === -1 ? total : nextBreak + 1;
  }

  const slice = buffer.subarray(start).toString("utf8");
  const lines = slice.split("\n");
  const events = [];
  let skipped = 0;
  let consumed = start;
  let truncated = false;
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    if (events.length >= effectiveLimit) {
      truncated = true;
      break;
    }
    // The last chunk has no trailing newline: the writer may still be appending,
    // so its bytes stay unconsumed and a resumed read retries them.
    const terminated = index < lines.length - 1;
    if (!terminated) break;
    try {
      JSON.parse(line);
    } catch {
      // A newline-terminated line that will not parse is corrupt, not pending.
      skipped += 1;
      consumed += Buffer.byteLength(`${line}\n`, "utf8");
      continue;
    }
    events.push(JSON.parse(line));
    consumed += Buffer.byteLength(`${line}\n`, "utf8");
  }
  return { events, cursor: consumed, skipped, truncated };
}

/** Attach a colony's emitter to the log: every event is appended, failures ignored. */
export function persistEvents(colony, emitter, { map = (type, payload) => ({ type, ...payload }) } = {}) {
  const original = emitter.emit.bind(emitter);
  emitter.emit = (type, payload) => {
    try {
      const event = map(type, payload && typeof payload === "object" ? payload : { value: payload });
      if (event) appendEvent(colony, event);
    } catch {
      // Persisting must never break the live event path.
    }
    return original(type, payload);
  };
  return emitter;
}
