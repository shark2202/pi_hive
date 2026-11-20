/**
 * Official frontend compatibility handlers for the session surface.
 *
 * Every handler returns `{status, body}` and never writes to `res`, with one
 * unavoidable exception: GET .../attachment/:filename streams binary bytes, so
 * it writes the response directly (the dispatcher skips JSON when
 * `res.headersSent` is true).
 *
 * Sessions are real rows from `SessionStore` under PI_HIVE_HOME, bound to a
 * colony and its QueenRuntime. There is no in-memory session registry to
 * consult, so every unknown id is a 404 and nothing is fabricated.
 *
 * `ctx` is the integration seam: the PiHiveServer instance (or a test double).
 * Resolution order for a queen runtime:
 *   ctx.getQueenRuntime(colony) -> ctx.runtime(colony) -> ctx.runtimes.get()
 *   -> ctx.server.runtime(colony)
 * Trigger routes prefer `queen.triggerManager` and otherwise build the real
 * `TriggerManager` for the colony. Body readers accept `req.body` (tests),
 * `req.json()` (framework-style), or the node:http async iterable.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";

import { colonyDir, hiveHome } from "../../config.js";
import { loadMetadata } from "../../domain/colony.js";
import { listTasks } from "../../domain/plan.js";
import { TriggerManager } from "../../runtime/triggers.js";
import { ROUTE_STATUS } from "../router.js";
import { SessionStore, isSafeSessionId, newSessionId } from "../sessions.js";

export const SUPPORTED_QUEEN_IDS = Object.freeze([
  "queen_growth",
  "queen_tech",
  "queen_finance",
  "queen_ops",
]);

/**
 * The official client sends the selected profile's display name, while
 * pi_hive's own catalog exposes ids. Accept both so a session created from
 * the queen picker resolves to the same built-in identity.
 */
const QUEEN_ALIASES = new Map([
  ["queen_growth", { id: "queen_growth", name: "Growth Queen" }],
  ["growth queen", { id: "queen_growth", name: "Growth Queen" }],
  ["queen_tech", { id: "queen_tech", name: "Technology Queen" }],
  ["technology queen", { id: "queen_tech", name: "Technology Queen" }],
  ["queen_finance", { id: "queen_finance", name: "Finance Queen" }],
  ["finance queen", { id: "queen_finance", name: "Finance Queen" }],
  ["queen_ops", { id: "queen_ops", name: "Operations Queen" }],
  ["operations queen", { id: "queen_ops", name: "Operations Queen" }],
]);

export function resolveQueenAlias(value) {
  if (typeof value !== "string") return null;
  return QUEEN_ALIASES.get(value.trim().toLowerCase()) || null;
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const DEFAULT_EVENT_LIMIT = 500;

const MIME_BY_EXT = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** One store per PI_HIVE_HOME, so repeated requests see the same instance. */
const storesByHome = new Map();

export function clearSessionStoreCache() {
  storesByHome.clear();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function storeFor(ctx = {}) {
  if (ctx.sessionStore && typeof ctx.sessionStore.get === "function") return ctx.sessionStore;
  if (ctx.server?.sessionStore && typeof ctx.server.sessionStore.get === "function") {
    return ctx.server.sessionStore;
  }
  const home = ctx.hiveHome || process.env.PI_HIVE_HOME || hiveHome();
  let store = storesByHome.get(home);
  if (!store) {
    store = new SessionStore({ home });
    storesByHome.set(home, store);
  }
  return store;
}

/**
 * Session id -> colony id using only the durable store. Returns null for an
 * unknown id, an unsafe id, or a record with no colony (an independent queen
 * session is not attached to a colony).
 */
export function sessionColonyFromStore(ctx, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  try {
    const record = storeFor(ctx).get(sessionId);
    return record?.colony_id || record?.colony || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a session id to a colony through `ctx.resolveSession` when the host
 * provides one, otherwise through the durable store. Exported so non-session
 * lanes (autonomy worker/task routes) share one resolution rule.
 */
export async function resolveSessionColony(ctx, sessionId) {
  if (typeof ctx?.resolveSession === "function") {
    try {
      const value = await ctx.resolveSession(sessionId);
      if (value) return value;
    } catch {
      // A broken host resolver must not hide a real stored session.
    }
  }
  return sessionColonyFromStore(ctx, sessionId);
}

/**
 * Publish the durable store and a session -> colony resolver on the
 * integration context.
 *
 * The server registers handlers with itself as `ctx` and then passes the same
 * instance per call, so attaching here makes sessions created through
 * POST /api/sessions visible to handlers registered by other lanes (autonomy's
 * `/api/sessions/:session/workers|tasks|...` routes). Frozen or non-extensible
 * contexts are left untouched: those hosts still resolve through the store
 * fallback in `autonomy.js`.
 *
 * @returns {SessionStore} the store the context resolves through
 */
export function attachSessionContext(ctx) {
  const store = storeFor(ctx);
  if (!ctx || (typeof ctx !== "object" && typeof ctx !== "function")) return store;
  if (!Object.isExtensible(ctx)) return store;
  try {
    if (typeof ctx.sessionStore?.get !== "function") ctx.sessionStore = store;
    if (typeof ctx.resolveSession !== "function") {
      ctx.resolveSession = (sessionId) => sessionColonyFromStore(ctx, sessionId);
    }
  } catch {
    // A proxy-owned context may refuse writes; the store fallback still works.
  }
  return store;
}

class BodyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BodyError";
    this.status = 400;
  }
}

function parseJsonText(text) {
  if (!text || !text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError("Invalid JSON body");
  }
  if (!isPlainObject(parsed)) throw new BodyError("Request body must be a JSON object");
  return parsed;
}

/** Read a JSON object body without assuming a particular server framework. */
async function readJsonBody(req) {
  if (!req) return {};

  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return parseJsonText(req.body.toString("utf8"));
    if (typeof req.body === "string") return parseJsonText(req.body);
    if (isPlainObject(req.body)) return req.body;
    throw new BodyError("Request body must be a JSON object");
  }

  if (typeof req.json === "function") {
    let parsed;
    try {
      parsed = await req.json();
    } catch {
      throw new BodyError("Invalid JSON body");
    }
    if (!isPlainObject(parsed)) throw new BodyError("Request body must be a JSON object");
    return parsed;
  }

  if (typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new BodyError("request body too large");
      chunks.push(Buffer.from(chunk));
    }
    return parseJsonText(Buffer.concat(chunks).toString("utf8"));
  }

  return {};
}

export async function readRawBody(req) {
  if (!req) return Buffer.alloc(0);
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new BodyError("request body too large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

function searchParams(req) {
  try {
    return new URL(req?.url || "/", "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function intParam(params, name) {
  const raw = params.get(name);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

function ok(body, status = 200) {
  return { status, body };
}

function fail(status, error, extra = {}) {
  return { status, body: { error, ...extra } };
}

function sessionNotFound(sessionId) {
  return fail(404, `Session '${sessionId}' not found`);
}

function colonyError(colonyId) {
  try {
    const dir = colonyDir(colonyId);
    if (!fs.existsSync(dir) || !loadMetadata(colonyId)) {
      return fail(404, `Colony '${colonyId}' not found`);
    }
    return null;
  } catch (err) {
    return fail(400, err.message);
  }
}

async function resolveRuntime(ctx, colonyId) {
  if (!colonyId) return { queen: null, error: "session has no colony" };

  const attempt = async (fn) => {
    try {
      const value = await fn();
      return value || null;
    } catch (err) {
      return { __error: err };
    }
  };

  let candidate = null;
  let lastError = null;

  if (ctx.runtimes instanceof Map) candidate = ctx.runtimes.get(colonyId) || null;

  if (!candidate && typeof ctx.getQueenRuntime === "function") {
    candidate = await attempt(() => ctx.getQueenRuntime(colonyId));
  }
  if (!candidate && typeof ctx.runtime === "function") {
    candidate = await attempt(() => ctx.runtime(colonyId));
  }
  if (!candidate && ctx.server && typeof ctx.server.runtime === "function") {
    candidate = await attempt(() => ctx.server.runtime(colonyId));
  }

  if (candidate && candidate.__error) {
    lastError = candidate.__error;
    candidate = null;
  }
  if (!candidate) {
    return { queen: null, error: lastError ? lastError.message : `colony '${colonyId}' is not loaded` };
  }
  return { queen: candidate, error: null };
}

/** Runtime already loaded in this process; never constructs one. */
function peekRuntime(ctx, colonyId) {
  if (!colonyId) return null;
  const registries = [ctx.runtimes, ctx.server?.runtimes];
  for (const registry of registries) {
    if (!registry) continue;
    if (registry instanceof Map) {
      const value = registry.get(colonyId);
      if (value) return value;
      continue;
    }
    if (typeof registry.get === "function") {
      const value = registry.get(colonyId);
      if (value) return value;
      continue;
    }
    if (typeof registry === "object" && registry[colonyId]) return registry[colonyId];
  }
  return null;
}

async function triggerManagerFor(ctx, record, queen) {
  if (!record.colony_id) return null;
  if (queen?.triggerManager) return queen.triggerManager;
  if (typeof ctx.getTriggerManager === "function") {
    const fromCtx = await ctx.getTriggerManager(record.colony_id, queen);
    if (fromCtx) return fromCtx;
  }
  const manager = new TriggerManager({
    colony: record.colony_id,
    tickMs: 60000,
    onFire: (name, payload) => queen?.injectTrigger?.(name, payload),
  });
  if (queen) queen.triggerManager = manager;
  return manager;
}

function triggerConfigOf(trigger) {
  if (trigger.type === "cron") return { cron: trigger.cron };
  return { interval_minutes: Number(trigger.interval_minutes) };
}

function nextDueAt(trigger) {
  if (trigger.type !== "interval" || !trigger.last_fired_at) return null;
  const last = Date.parse(trigger.last_fired_at);
  if (!Number.isFinite(last)) return null;
  return new Date(last + Number(trigger.interval_minutes) * 60000).toISOString();
}

function triggerView(trigger) {
  return {
    trigger_id: trigger.name,
    trigger_type: "timer",
    trigger_config: triggerConfigOf(trigger),
    name: trigger.name,
    task: trigger.prompt,
    enabled: Boolean(trigger.enabled),
    last_fired_at: trigger.last_fired_at || null,
    next_due_at: nextDueAt(trigger),
  };
}

function slugifyTriggerId(name, existing) {
  let base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (!base) base = "schedule";
  let candidate = `user-${base}`;
  if (!existing.has(candidate)) return candidate;
  let i = 2;
  while (existing.has(`${candidate}-${i}`)) i += 1;
  return `${candidate}-${i}`;
}

function normalizeTriggerConfig(raw) {
  if (!isPlainObject(raw)) throw new BodyError("'trigger_config' must be an object");
  const cron = raw.cron;
  const interval = raw.interval_minutes;

  if (cron !== undefined && cron !== null && typeof cron !== "string") {
    throw new BodyError("'trigger_config.cron' must be a string");
  }
  if (cron && cron.trim()) return { type: "cron", cron: cron.trim() };
  if (interval === undefined || interval === null) {
    throw new BodyError("Timer trigger needs 'cron' or 'interval_minutes' in trigger_config.");
  }
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0) {
    throw new BodyError("'trigger_config.interval_minutes' must be > 0");
  }
  return { type: "interval", intervalMinutes: interval };
}

function mergeTriggerConfig(trigger, patch) {
  const merged = { ...triggerConfigOf(trigger), ...patch };
  // Switching schedule kinds must drop the other one; otherwise a cron from
  // the previous config would keep overriding a fresh interval (and vice versa).
  if (Object.hasOwn(patch, "interval_minutes") && !Object.hasOwn(patch, "cron")) delete merged.cron;
  if (merged.cron) delete merged.interval_minutes;
  return merged;
}

export function parseMultipart(raw, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new BodyError("expected multipart/form-data");
  const boundary = (match[1] || match[2]).trim();
  const delimiter = Buffer.from(`--${boundary}`);

  let start = raw.indexOf(delimiter);
  if (start === -1) throw new BodyError("malformed multipart body");

  const parts = [];
  start += delimiter.length;
  while (start < raw.length) {
    if (raw[start] === 45 && raw[start + 1] === 45) break; // "--" closes the body
    if (raw[start] === 13 && raw[start + 1] === 10) start += 2;

    let next = raw.indexOf(delimiter, start);
    if (next === -1) next = raw.length;
    let chunk = raw.subarray(start, next);
    if (chunk.length >= 2 && chunk[chunk.length - 2] === 13 && chunk[chunk.length - 1] === 10) {
      chunk = chunk.subarray(0, chunk.length - 2);
    }

    const headerEnd = chunk.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const headers = chunk.subarray(0, headerEnd).toString("utf8");
      const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] || "";
      parts.push({
        name: /name="([^"]*)"/i.exec(disposition)?.[1] || null,
        filename: /filename="([^"]*)"/i.exec(disposition)?.[1] || null,
        contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || null,
        data: chunk.subarray(headerEnd + 4),
      });
    }

    start = next + delimiter.length;
  }
  return parts;
}

function sanitizeAttachmentName(original) {
  let base = path.basename(String(original || "upload"));
  base = base.replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  if (!base || base === "." || base === "..") base = "upload";
  return base.slice(0, 120);
}

function resultText(result) {
  if (typeof result === "string") return result;
  if (result && typeof result.text === "string") return result.text;
  return "";
}

function sendBinary(res, data, contentType) {
  if (!res || typeof res.writeHead !== "function" || typeof res.end !== "function") {
    return fail(500, "response stream unavailable");
  }
  res.writeHead(200, {
    "content-type": contentType || "application/octet-stream",
    "content-length": data.length,
    "access-control-allow-origin": "*",
  });
  res.end(data);
  return undefined;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function createSession({ req, ctx = {} }) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return fail(400, err.message);
  }

  const store = storeFor(ctx);
  const rawColony = body.colony_id;
  let colonyId = null;
  if (rawColony !== undefined && rawColony !== null && rawColony !== "") {
    if (typeof rawColony !== "string") return fail(400, "'colony_id' must be a string");
    const invalid = colonyError(rawColony);
    if (invalid) return invalid;
    colonyId = rawColony;
  }

  let queenId = null;
  let queenName = null;
  if (body.queen_name !== undefined && body.queen_name !== null) {
    if (typeof body.queen_name !== "string") return fail(400, "'queen_name' must be a string");
    const alias = resolveQueenAlias(body.queen_name);
    if (!alias) {
      return fail(404, `Queen '${body.queen_name}' not found`);
    }
    queenId = alias.id;
    queenName = alias.name;
  }

  if (body.model !== undefined && body.model !== null && typeof body.model !== "string") {
    return fail(400, "'model' must be a string");
  }

  let initialPrompt = null;
  if (body.initial_prompt !== undefined && body.initial_prompt !== null) {
    if (typeof body.initial_prompt !== "string") return fail(400, "'initial_prompt' must be a string");
    initialPrompt = body.initial_prompt;
  }

  let phase = null;
  if (body.initial_phase !== undefined && body.initial_phase !== null) {
    const legacyPhases = { working: "colony", reviewing: "colony", incubating: "independent" };
    const normalizedPhase =
      typeof body.initial_phase === "string"
        ? legacyPhases[body.initial_phase] || body.initial_phase
        : body.initial_phase;
    if (!["independent", "colony"].includes(normalizedPhase)) {
      return fail(400, `Invalid initial_phase '${body.initial_phase}'`, {
        valid: ["colony", "independent"],
      });
    }
    phase = normalizedPhase;
  }

  let sourceSessionId = null;
  if (body.source_session_id !== undefined && body.source_session_id !== null) {
    if (typeof body.source_session_id !== "string") {
      return fail(400, "'source_session_id' must be a string");
    }
    if (!store.get(body.source_session_id)) {
      return sessionNotFound(body.source_session_id);
    }
    sourceSessionId = body.source_session_id;
  }

  let customId = null;
  if (body.session_id !== undefined && body.session_id !== null) {
    if (!isSafeSessionId(body.session_id)) return fail(400, "invalid session_id");
    customId = body.session_id;
  }

  const customIdCandidate = customId || newSessionId();
  if (store.get(customIdCandidate)) {
    return fail(409, `Session '${customIdCandidate}' already exists`);
  }

  let record;
  try {
    record = store.create({
      colonyId,
      sessionId: customIdCandidate,
      queenId,
      queenName,
      model: body.model || null,
      initialPrompt,
      phase,
      sourceSessionId,
    });
  } catch (err) {
    if (/already exists/.test(err.message)) return fail(409, err.message);
    return fail(400, err.message);
  }

  const extra = {};
  if (initialPrompt && initialPrompt.trim()) {
    const { queen, error } = await resolveRuntime(ctx, record.colony_id);
    store.appendEvent(record.session_id, {
      type: "client_input_received",
      data: { content: initialPrompt, image_count: 0 },
    });
    if (queen && typeof queen.chat === "function") {
      try {
        const result = await queen.chat(initialPrompt);
        const text = resultText(result);
        if (text) {
          store.appendEvent(record.session_id, {
            type: "llm_text_delta",
            data: { content: text, snapshot: text },
          });
        }
      } catch (err) {
        store.appendEvent(record.session_id, {
          type: "execution_failed",
          data: { error: err.message },
        });
        extra.initial_prompt_error = err.message;
      }
    } else if (error) {
      extra.initial_prompt_error = error;
    }
  }

  record = store.get(record.session_id);
  return ok({ ...store.toLive(record), ...extra }, 201);
}

async function listSessions({ req, ctx = {} }) {
  const store = storeFor(ctx);
  const colonyId = searchParams(req).get("colony_id");
  const records = store.list({ colonyId: colonyId || null, includeStopped: false });
  return ok({ sessions: records.map((record) => store.toLive(record)) });
}

async function getSession({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);

  let entryPoints = [];
  if (record.colony_id) {
    const queen = peekRuntime(ctx, record.colony_id);
    const manager = await triggerManagerFor(ctx, record, queen);
    if (manager) entryPoints = manager.list().map(triggerView);
  }

  return ok(store.toDetail(record, { entryPoints }));
}

async function stopSession({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);
  store.stop(sessionId, { reason: "api_delete" });
  return ok({ session_id: sessionId, stopped: true });
}

/**
 * DELETE /api/sessions/history/:session — remove one stored session record.
 * The live feed must not lose a running session, so a live record is a 409
 * until it is stopped; cold/stopped records are purged from disk.
 */
async function deleteHistorySession({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return fail(404, `Session '${sessionId}' not found`, { deleted: false });
  if (store.isLive(sessionId) && !record.stopped_at) {
    return fail(409, "Session is live; stop it before deleting its history", {
      deleted: false,
      session_id: sessionId,
    });
  }
  store.stop(sessionId, { purge: true, reason: "history_delete" });
  return ok({ deleted: true, session_id: sessionId });
}

async function sessionStats({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);

  let taskCounts = { total: 0, open: 0 };
  if (record.colony_id) {
    try {
      const tasks = listTasks(record.colony_id);
      taskCounts = {
        total: tasks.length,
        open: tasks.filter((task) => !["completed", "archived"].includes(task.status)).length,
      };
    } catch {
      taskCounts = { total: 0, open: 0 };
    }
  }

  const queen = peekRuntime(ctx, record.colony_id);
  const workers = queen?.workerManager?.list?.() || [];

  return ok({
    session_id: sessionId,
    colony_id: record.colony_id,
    queen_id: record.queen_id,
    queen_name: record.queen_name,
    title: record.title || null,
    status: record.stopped_at ? "stopped" : "live",
    created_at: record.created_at,
    uptime_seconds: Math.round((Date.now() - Number(record.created_at_ms || Date.now())) / 100) / 10,
    messages: Number(record.message_count || 0),
    events: store.eventCount(sessionId),
    tasks: taskCounts,
    workers: Array.isArray(workers) ? workers.length : 0,
  });
}

async function listColonySessions({ params, ctx = {} }) {
  const colonyId = params.colony;
  const invalid = colonyError(colonyId);
  if (invalid) return invalid;

  const store = storeFor(ctx);
  const records = store.list({ colonyId, includeStopped: true });
  return ok({ sessions: records.map((record) => store.toHistory(record)) });
}

async function getActiveColonySession({ params, ctx = {} }) {
  const colonyId = params.colony;
  const invalid = colonyError(colonyId);
  if (invalid) return invalid;

  const store = storeFor(ctx);
  const record = store.activeForColony(colonyId);
  return ok({ session: record ? store.toHistory(record) : null });
}

async function setSessionTitle({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  if (!store.get(sessionId)) return sessionNotFound(sessionId);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return fail(400, err.message);
  }
  if (typeof body.title !== "string") return fail(400, "'title' must be a string");

  const title = body.title.trim() ? body.title : null;
  const updated = store.update(sessionId, { title });
  return ok({ session_id: sessionId, title: updated.title });
}

// ---------------------------------------------------------------------------
// Chat / events
// ---------------------------------------------------------------------------

async function chatSession({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);

  if (record.colony_spawned) {
    return fail(409, "session_locked", {
      reason: "colony_spawned",
      spawned_colony_id: record.spawned_colony_id || null,
      message:
        "This session is locked because a colony has been spawned from it. Compact and start a new session with the same queen to continue.",
    });
  }
  if (record.stopped_at) {
    return fail(409, "session_stopped", { message: "This session was stopped. Start a new session." });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return fail(400, err.message);
  }

  if (typeof body.message !== "string") {
    return fail(400, "'message' is required");
  }
  const images = Array.isArray(body.images) ? body.images : [];
  if (!body.message.trim() && images.length === 0) {
    return fail(400, "'message' is required");
  }
  if (body.display_message !== undefined && typeof body.display_message !== "string") {
    return fail(400, "'display_message' must be a string");
  }

  const { queen, error } = await resolveRuntime(ctx, record.colony_id);
  if (!queen || typeof queen.chat !== "function") {
    return fail(409, "queen_unavailable", {
      reason: error || "colony runtime unavailable",
      colony_id: record.colony_id,
    });
  }

  store.appendEvent(sessionId, {
    type: "client_input_received",
    data: {
      content: body.display_message ?? body.message,
      image_count: images.length,
    },
  });
  // A successful /chat revives a cold session; the live feed should show it.
  store.markLive(sessionId);

  let text = "";
  try {
    const result = await queen.chat(body.message);
    text = resultText(result);
    if (text) {
      store.appendEvent(sessionId, {
        type: "llm_text_delta",
        data: { content: text, snapshot: text },
      });
    }
  } catch (err) {
    store.appendEvent(sessionId, {
      type: "execution_failed",
      data: { error: err.message },
    });
    return fail(502, err.message, { type: "queen_error", session_id: sessionId });
  }

  return ok({ status: "queen", delivered: true, execution_id: sessionId, reply: text });
}

async function sessionEventsHistory({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  if (!store.get(sessionId)) return sessionNotFound(sessionId);

  const query = searchParams(req);
  const page = store.readEvents(sessionId, {
    limit: intParam(query, "limit") ?? DEFAULT_EVENT_LIMIT,
    beforeOffset: intParam(query, "before_offset"),
    beforeIndex: intParam(query, "before_index"),
  });
  return ok(page);
}

async function sessionSnapshot({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);

  const queen = peekRuntime(ctx, record.colony_id);
  const running = Boolean(queen?.running);
  const tail = store.readEvents(sessionId, { limit: 1 });

  return ok({
    snapshot_seq: store.eventCount(sessionId),
    is_executing: running,
    current_execution_id: running ? sessionId : null,
    current_tool_calls: [],
    awaiting_input: false,
    queen_busy_reason: running ? "llm" : null,
    park_reason: running ? null : "idle",
    interrupted: false,
    interrupt_cause: null,
    last_event_at: tail.events[0]?.timestamp || null,
  });
}

async function sessionLiveTools({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);

  const queen = peekRuntime(ctx, record.colony_id);
  let tools = [];
  if (queen && typeof queen.tools === "function") {
    try {
      tools = queen
        .tools()
        .filter((tool) => tool && typeof tool.name === "string" && tool.name)
        .map((tool) => ({
          name: tool.name,
          description: tool.description || "",
          kind: "lifecycle",
        }));
    } catch {
      tools = [];
    }
  }

  return ok({
    session_id: sessionId,
    phase: record.phase || (record.colony_id ? "colony" : "independent"),
    phase_state_ready: tools.length > 0,
    workers: [],
    tools,
    actual_tools: tools,
    expected_tools: tools.map((tool) => ({ ...tool, status: "callable" })),
    framework_added: [],
    connected_providers: [],
    diagnostic: {},
    mcp_tool_count_registered: 0,
  });
}

// ---------------------------------------------------------------------------
// Attachments / reports
// ---------------------------------------------------------------------------

async function uploadAttachment({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  if (!store.get(sessionId)) return sessionNotFound(sessionId);

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    return fail(400, err.message);
  }
  const contentType = req?.headers?.["content-type"] || req?.headers?.["Content-Type"] || "";
  if (!raw.length) return fail(400, "expected a 'file' field");

  let parts;
  try {
    parts = parseMultipart(raw, contentType);
  } catch (err) {
    return fail(400, err.message);
  }
  const file = parts.find((part) => part.name === "file") || null;
  if (!file) return fail(400, "expected a 'file' field");

  const originalName = file.filename || "upload";
  const safeName = sanitizeAttachmentName(originalName);
  const filename = `${Date.now()}_${safeName}`;
  const dir = store.ensureAttachmentsDir(sessionId);
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, file.data);

  return ok({
    filename,
    path: filepath,
    session_id: sessionId,
    content_type: file.contentType || "application/octet-stream",
    original_name: originalName,
    extracted_text: "",
    page_images: [],
  });
}

async function getAttachment({ res, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  if (!store.get(sessionId)) return sessionNotFound(sessionId);

  const filename = params.attachment;
  if (
    typeof filename !== "string" ||
    !filename ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    return fail(400, "Invalid filename");
  }

  const dir = store.attachmentsDir(sessionId);
  const filepath = path.join(dir, filename);
  if (!filepath.startsWith(`${dir}${path.sep}`) || !fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) {
    return fail(404, `Attachment '${filename}' not found`);
  }

  const data = fs.readFileSync(filepath);
  return sendBinary(res, data, MIME_BY_EXT[path.extname(filepath).toLowerCase()] || "application/octet-stream");
}

async function reportBundle({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }

  const description = typeof body.description === "string" ? body.description : "";
  const severity = ["low", "medium", "high", "critical"].includes(body.severity)
    ? body.severity
    : "medium";
  const reportsDir = path.join(store.home, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const generatedAt = new Date();
  const stamp = generatedAt.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const filename = `report_${stamp}_${sessionId}.tar.gz`;

  const events = store.readEvents(sessionId, { limit: 5000 }).events;
  const transcript = events
    .filter((event) => event.type === "client_input_received" || event.type === "assistant_message")
    .map((event) => `[${event.ts ?? event.created_at ?? ""}] ${event.type}: ${event.data?.content ?? ""}`)
    .join("\n");

  // Screenshots need a browser; the bundle says so instead of inventing images.
  const files = [
    { name: "report.json", data: JSON.stringify({ description, severity, generated_at: generatedAt.toISOString(), session_id: sessionId, event_count: events.length }, null, 2) },
    { name: "session.json", data: JSON.stringify(record, null, 2) },
    { name: "events.jsonl", data: events.map((event) => JSON.stringify(event)).join("\n") },
    { name: "transcript.txt", data: transcript },
    { name: "README.txt", data: `pi_hive diagnostic bundle\nseverity: ${severity}\ndescription: ${description || "(none)"}\nimages: none (no browser bridge on this host)\n` },
  ];
  const archive = tarGz(files);
  const bundlePath = path.join(reportsDir, filename);
  fs.writeFileSync(bundlePath, archive);

  return ok({
    ok: true,
    filename,
    bundle_path: bundlePath,
    size: archive.length,
    sha256: crypto.createHash("sha256").update(archive).digest("hex"),
    content_type: "application/gzip",
    marker: { description, severity, user_reported: true },
    stats: {
      files: files.length,
      text_files: files.length,
      binary_files: 0,
      binary_omitted: 0,
      images_stripped: 0,
    },
  });
}

/** One 512-byte ustar header. Sizes stay under 8 GiB, so the octal field fits. */
function tarHeader(name, size, mtimeSeconds) {
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 99), 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write(`${Math.floor(mtimeSeconds).toString(8).padStart(11, "0")}\0`, 136, "ascii");
  header.write("        ", 148, "ascii"); // checksum placeholder
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/** A minimal ustar archive: regular files only, plus the 1024-byte trailer. */
function tarGz(entries) {
  const chunks = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    chunks.push(tarHeader(entry.name, data.length, mtime), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

// ---------------------------------------------------------------------------
// Queen control
// ---------------------------------------------------------------------------

async function queenContext({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return fail(400, err.message);
  }
  if (typeof body.message !== "string" || !body.message.trim()) {
    return fail(400, "'message' is required");
  }

  const queen = peekRuntime(ctx, record.colony_id);
  if (queen && Array.isArray(queen.queue)) {
    queen.queue.push({ kind: "context", text: `[External event]: ${body.message}` });
    return ok({ status: "queued", delivered: true });
  }

  const pending = Array.isArray(record.pending_context) ? record.pending_context.slice(-49) : [];
  pending.push({ message: body.message, queued_at: new Date().toISOString() });
  store.update(sessionId, { pending_context: pending });
  return ok({ status: "queued_persisted", delivered: false });
}

async function recordMessage({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  if (!store.get(sessionId)) return sessionNotFound(sessionId);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return fail(400, err.message);
  }
  if (typeof body.message !== "string" || !body.message.trim()) {
    return fail(400, "'message' is required");
  }

  const event = store.appendEvent(sessionId, {
    type: "client_input_received",
    data: { content: body.message, image_count: 0 },
  });
  return ok({ status: "recorded", seq: event.seq });
}

async function cancelQueen({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);

  const queen = peekRuntime(ctx, record.colony_id);
  if (!queen || !queen.agent || typeof queen.agent.abort !== "function") {
    return ok({ cancelled: false, error: "Queen not active" });
  }
  try {
    queen.agent.abort();
    return ok({ cancelled: true });
  } catch (err) {
    return ok({ cancelled: false, error: err.message });
  }
}

async function markPresence({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  if (!store.get(sessionId)) return sessionNotFound(sessionId);
  return ok({ ok: true, resumed: false });
}

async function markColonySpawned({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  if (!store.get(sessionId)) return sessionNotFound(sessionId);

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return fail(400, err.message);
  }
  const colonyId = typeof body.colony_id === "string" ? body.colony_id.trim() : "";
  if (!colonyId) return fail(400, "colony_id is required");

  store.update(sessionId, { colony_spawned: true, spawned_colony_id: colonyId });
  return ok({ session_id: sessionId, colony_spawned: true, spawned_colony_id: colonyId });
}

async function compactAndFork({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const source = store.get(sessionId);
  if (!source) return sessionNotFound(sessionId);
  if (!source.colony_id) return fail(400, "session has no colony to fork");

  const page = store.readEvents(sessionId, { limit: 10000 });
  const messages = page.events
    .filter(
      (event) =>
        event.type === "client_input_received" &&
        typeof event.data?.content === "string" &&
        !event.data.content.startsWith("<hive-internal>"),
    )
    .map((event) => event.data.content);

  // Compaction is a model call when a runtime is reachable; the extract keeps the
  // route usable without a key, and says which one ran instead of hiding it.
  const extracted = messages.join("\n").slice(0, 4000);
  let runtime = null;
  try {
    // The getter builds a runtime on demand and throws when no key is configured.
    runtime = ctx?.modelRuntime ?? ctx?.server?.modelRuntime ?? null;
  } catch {
    runtime = null;
  }
  let summary = extracted;
  let mode = "extract";
  let note = "no model runtime was reachable, so the fork carries a verbatim extract";
  if (runtime?.streamFn) {
    try {
      const prompt = [
        "Summarize this conversation for a continuation context. Keep decisions, open",
        "questions, file paths and constraints. Answer with the summary only.",
        "",
        messages.join("\n").slice(-12000),
      ].join("\n");
      let text = "";
      for await (const chunk of runtime.streamFn({
        messages: [{ role: "user", content: prompt }],
        model: runtime.model,
        maxTokens: 1200,
      })) {
        if (typeof chunk?.delta === "string") text += chunk.delta;
        else if (typeof chunk?.text === "string") text += chunk.text;
      }
      if (text.trim()) {
        summary = text.trim().slice(0, 8000);
        mode = "model";
        note = "the fork carries a model-generated summary";
      }
    } catch (err) {
      note = `model compaction failed (${err.message}); the fork carries a verbatim extract`;
    }
  }

  const forked = store.create({
    colonyId: source.colony_id,
    queenId: source.queen_id,
    queenName: source.queen_name,
    forkedFrom: sessionId,
    title: source.title ? `${source.title} (continued)` : null,
  });
  store.update(forked.session_id, { compaction_summary: summary, compaction_mode: mode });

  return ok({
    new_session_id: forked.session_id,
    queen_id: forked.queen_id,
    compacted_from: sessionId,
    summary_chars: summary.length,
    messages_compacted: messages.length,
    compaction: mode,
    note,
  });
}


async function dismissColonyPivot({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  if (!store.get(sessionId)) return sessionNotFound(sessionId);
  return ok({ dismissed: false, reason: "no_pending_pivot" });
}

async function revealSession({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  if (!store.get(sessionId)) return sessionNotFound(sessionId);

  const folder = store.sessionDir(sessionId);
  fs.mkdirSync(folder, { recursive: true });

  const options = ctx.options || {};
  if (ctx.revealFolders === true || options.revealFolders === true) {
    const [command, args] =
      process.platform === "darwin"
        ? ["open", [folder]]
        : process.platform === "win32"
          ? ["explorer", [folder]]
          : ["xdg-open", [folder]];
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.unref?.();
    } catch {
      return fail(500, "failed to open the session folder");
    }
    return ok({ path: folder, revealed: true });
  }

  return ok({ path: folder, revealed: false });
}

async function forkSession({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const source = store.get(sessionId);
  if (!source) return sessionNotFound(sessionId);

  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return fail(400, err.message);
  }

  const beforeInputAt = body.before_input_at;
  let cutoff = null;
  if (beforeInputAt !== undefined && beforeInputAt !== null) {
    if (typeof beforeInputAt !== "string") return fail(400, "'before_input_at' must be a string");
    cutoff = Date.parse(beforeInputAt);
    if (!Number.isFinite(cutoff)) return fail(400, "'before_input_at' must be an ISO timestamp");
  }

  const forked = store.create({
    colonyId: source.colony_id,
    queenId: source.queen_id,
    queenName: source.queen_name,
    forkedFrom: sessionId,
  });

  const page = store.readEvents(sessionId, { limit: 10000 });
  let copied = 0;
  for (const event of page.events) {
    const eventTime = Date.parse(event.timestamp);
    if (cutoff !== null && Number.isFinite(eventTime) && eventTime >= cutoff) continue;
    store.appendEvent(forked.session_id, {
      type: event.type,
      data: event.data,
      streamId: event.stream_id,
      nodeId: event.node_id,
      correlationId: event.correlation_id,
      timestamp: event.timestamp,
    });
    copied += 1;
  }

  return ok({ session_id: forked.session_id, queen_id: forked.queen_id, copied_events: copied });
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

async function listTriggers({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);
  if (!record.colony_id) return fail(400, "session has no colony");

  const queen = peekRuntime(ctx, record.colony_id);
  const manager = await triggerManagerFor(ctx, record, queen);
  if (!manager) return fail(400, "trigger manager unavailable");
  return ok({ triggers: manager.list().map(triggerView) });
}

async function createTrigger({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);
  if (!record.colony_id) return fail(400, "session has no colony");

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return fail(400, err.message);
  }

  if (typeof body.name !== "string" || !body.name.trim()) return fail(400, "'name' is required");
  if (typeof body.task !== "string" || !body.task.trim()) return fail(400, "'task' is required");
  if (body.trigger_type !== undefined && body.trigger_type !== "timer") {
    return fail(400, "Only 'timer' schedules can be created here.");
  }

  let config;
  try {
    config = normalizeTriggerConfig(body.trigger_config);
  } catch (err) {
    return fail(400, err.message);
  }

  const queen = peekRuntime(ctx, record.colony_id);
  const manager = await triggerManagerFor(ctx, record, queen);
  if (!manager) return fail(400, "trigger manager unavailable");

  const existing = new Set(manager.list().map((trigger) => trigger.name));
  const triggerId = slugifyTriggerId(body.name, existing);

  let created;
  try {
    created = manager.set({
      name: triggerId,
      type: config.type,
      interval_minutes: config.intervalMinutes,
      cron: config.cron,
      prompt: body.task.trim(),
      enabled: true,
    });
    manager.start?.();
  } catch (err) {
    return fail(400, err.message);
  }

  return ok({
    trigger_id: triggerId,
    name: body.name.trim(),
    trigger_type: "timer",
    trigger_config: triggerConfigOf(created),
  });
}

async function updateTrigger({ req, params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);
  if (!record.colony_id) return fail(400, "session has no colony");

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return fail(400, err.message);
  }

  const queen = peekRuntime(ctx, record.colony_id);
  const manager = await triggerManagerFor(ctx, record, queen);
  if (!manager) return fail(400, "trigger manager unavailable");

  const triggerId = params.trigger;
  const existing = manager.list().find((trigger) => trigger.name === triggerId);
  if (!existing) return fail(404, `Trigger '${triggerId}' not found`);

  const hasTask = Object.hasOwn(body, "task");
  const hasConfig = Object.hasOwn(body, "trigger_config");
  if (!hasTask && !hasConfig) {
    return fail(400, "Provide at least one of 'task' or 'trigger_config'");
  }

  let prompt = existing.prompt;
  if (hasTask) {
    if (typeof body.task !== "string") return fail(400, "'task' must be a string");
    prompt = body.task;
  }

  let config = triggerConfigOf(existing);
  if (hasConfig) {
    if (!isPlainObject(body.trigger_config)) return fail(400, "'trigger_config' must be an object");
    config = mergeTriggerConfig(existing, body.trigger_config);
    try {
      config = normalizeTriggerConfig(config);
    } catch (err) {
      return fail(400, err.message);
    }
  }

  let updated;
  try {
    updated = manager.set({
      name: triggerId,
      type: config.type,
      interval_minutes: config.intervalMinutes,
      cron: config.cron,
      prompt,
      enabled: Boolean(existing.enabled),
    });
  } catch (err) {
    return fail(400, err.message);
  }

  return ok({
    trigger_id: triggerId,
    task: updated.prompt,
    trigger_config: triggerConfigOf(updated),
  });
}

async function setTriggerEnabled({ params, ctx = {}, enabled }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);
  if (!record.colony_id) return fail(400, "session has no colony");

  const queen = peekRuntime(ctx, record.colony_id);
  const manager = await triggerManagerFor(ctx, record, queen);
  if (!manager) return fail(400, "trigger manager unavailable");

  const triggerId = params.trigger;
  const existing = manager.list().find((trigger) => trigger.name === triggerId);
  if (!existing) return fail(404, `Trigger '${triggerId}' not found`);

  try {
    manager.set({
      name: triggerId,
      type: existing.type,
      interval_minutes: existing.interval_minutes,
      cron: existing.cron,
      prompt: existing.prompt,
      enabled,
    });
    if (enabled) manager.start?.();
  } catch (err) {
    return fail(400, err.message);
  }

  return ok({ status: enabled ? "activated" : "deactivated", trigger_id: triggerId });
}

async function activateTrigger(args) {
  return setTriggerEnabled({ ...args, enabled: true });
}

async function deactivateTrigger(args) {
  return setTriggerEnabled({ ...args, enabled: false });
}

async function runTrigger({ params, ctx = {} }) {
  const store = storeFor(ctx);
  const sessionId = params.session;
  const record = store.get(sessionId);
  if (!record) return sessionNotFound(sessionId);
  if (!record.colony_id) return fail(400, "session has no colony");

  const { queen } = await resolveRuntime(ctx, record.colony_id);
  const manager = await triggerManagerFor(ctx, record, queen);
  if (!manager) return fail(400, "trigger manager unavailable");

  const triggerId = params.trigger;
  if (!manager.list().some((trigger) => trigger.name === triggerId)) {
    return fail(404, `Trigger '${triggerId}' not found`);
  }
  try {
    manager.fire(triggerId, { manual: true, source: "api" });
  } catch (err) {
    return fail(400, err.message);
  }

  return ok({ status: "triggered", trigger_id: triggerId });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const IMPLEMENTED = ROUTE_STATUS.IMPLEMENTED;
const PARTIAL = ROUTE_STATUS.PARTIAL;

/**
 * Older shell entries spelled the same official routes with `:id`/`:name`.
 * They match the same paths as this lane's `:session`/`:colony` patterns and
 * would shadow them (the router keeps the first equal-specificity match), so
 * they are retired when this lane registers. This is the same pattern
 * installCompatHandlers uses for the legacy events route.
 */
export const LEGACY_SESSION_ROUTES = Object.freeze([
  { method: "GET", path: "/api/sessions/:id" },
  { method: "POST", path: "/api/sessions/:id/chat" },
  { method: "GET", path: "/api/sessions/:id/events/history" },
  { method: "GET", path: "/api/colonies/:name/sessions" },
  { method: "GET", path: "/api/colonies/:name/active-session" },
]);

/** All 30 session routes with honest statuses. Exported for tests/reporting. */
export const SESSION_ROUTE_DEFINITIONS = Object.freeze([
  { method: "POST", path: "/api/sessions", handler: createSession, status: IMPLEMENTED, description: "create/open a real colony session" },
  { method: "GET", path: "/api/sessions", handler: listSessions, status: IMPLEMENTED, description: "durable live-session feed" },
  { method: "DELETE", path: "/api/sessions/history/:session", handler: deleteHistorySession, status: IMPLEMENTED, description: "purge one stopped session record from history" },
  { method: "GET", path: "/api/sessions/:session", handler: getSession, status: IMPLEMENTED, description: "LiveSessionDetail with trigger entry_points" },
  { method: "DELETE", path: "/api/sessions/:session", handler: stopSession, status: IMPLEMENTED, description: "stop a session (kept for history)" },
  { method: "GET", path: "/api/sessions/:session/stats", handler: sessionStats, status: IMPLEMENTED, description: "message/event/task counts" },
  { method: "GET", path: "/api/colonies/:colony/sessions", handler: listColonySessions, status: IMPLEMENTED, description: "stored sessions for one colony" },
  { method: "GET", path: "/api/colonies/:colony/active-session", handler: getActiveColonySession, status: IMPLEMENTED, description: "newest colony session with messages" },
  { method: "PATCH", path: "/api/sessions/:session/title", handler: setSessionTitle, status: IMPLEMENTED, description: "set or clear a session title" },
  { method: "POST", path: "/api/sessions/:session/chat", handler: chatSession, status: IMPLEMENTED, description: "forward to QueenRuntime.chat and log events" },
  { method: "GET", path: "/api/sessions/:session/events/history", handler: sessionEventsHistory, status: IMPLEMENTED, description: "paged events.jsonl tail" },
  { method: "GET", path: "/api/sessions/:session/snapshot", handler: sessionSnapshot, status: IMPLEMENTED, description: "state projection from the live runtime and event log" },
  { method: "GET", path: "/api/sessions/:session/live_tools", handler: sessionLiveTools, status: IMPLEMENTED, description: "tools exposed by the queen runtime" },
  { method: "POST", path: "/api/sessions/:session/upload-attachment", handler: uploadAttachment, status: IMPLEMENTED, description: "multipart upload to attachments/" },
  { method: "GET", path: "/api/sessions/:session/attachment/:attachment", handler: getAttachment, status: IMPLEMENTED, description: "serve a stored attachment" },
  { method: "POST", path: "/api/sessions/:session/report-bundle", handler: reportBundle, status: IMPLEMENTED, description: "writes a real .tar.gz (report.json, session.json, events.jsonl, transcript.txt, README) and reports size + sha256" },
  { method: "POST", path: "/api/sessions/:session/queen-context", handler: queenContext, status: IMPLEMENTED, description: "queue context without an LLM turn" },
  { method: "POST", path: "/api/sessions/:session/record-message", handler: recordMessage, status: IMPLEMENTED, description: "persist a user message without running the queen" },
  { method: "POST", path: "/api/sessions/:session/cancel-queen", handler: cancelQueen, status: IMPLEMENTED, description: "abort the queen's current turn" },
  { method: "POST", path: "/api/sessions/:session/presence", handler: markPresence, status: IMPLEMENTED, description: "chat re-entry acknowledgement" },
  { method: "POST", path: "/api/sessions/:session/mark-colony-spawned", handler: markColonySpawned, status: IMPLEMENTED, description: "persist the colony-spawn lock" },
  { method: "POST", path: "/api/sessions/:session/compact-and-fork", handler: compactAndFork, status: IMPLEMENTED, description: "forks the session with a model-generated summary when a runtime is reachable, else a verbatim extract (mode is reported)" },
  { method: "POST", path: "/api/sessions/:session/dismiss-colony-pivot", handler: dismissColonyPivot, status: IMPLEMENTED, description: "benign no-pending-pivot response" },
  { method: "POST", path: "/api/sessions/:session/reveal", handler: revealSession, status: IMPLEMENTED, description: "return the session folder (optionally open it)" },
  { method: "POST", path: "/api/sessions/:session/fork", handler: forkSession, status: IMPLEMENTED, description: "copy the transcript into a new session" },
  { method: "POST", path: "/api/sessions/:session/triggers", handler: createTrigger, status: IMPLEMENTED, description: "create and start a timer trigger" },
  { method: "GET", path: "/api/sessions/:session/triggers", handler: listTriggers, status: IMPLEMENTED, description: "colony triggers as official trigger cards" },
  { method: "PATCH", path: "/api/sessions/:session/triggers/:trigger", handler: updateTrigger, status: IMPLEMENTED, description: "update task/schedule through TriggerManager" },
  { method: "POST", path: "/api/sessions/:session/triggers/:trigger/activate", handler: activateTrigger, status: IMPLEMENTED, description: "enable a trigger" },
  { method: "POST", path: "/api/sessions/:session/triggers/:trigger/deactivate", handler: deactivateTrigger, status: IMPLEMENTED, description: "disable a trigger" },
  { method: "POST", path: "/api/sessions/:session/triggers/:trigger/run", handler: runTrigger, status: IMPLEMENTED, description: "fire a trigger now" },
]);

/**
 * Register every session route on `registry`.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] PiHiveServer instance or test double
 */
export function registerSessionRoutes(registry, ctx = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registerSessionRoutes requires a RouteRegistry");
  }

  const boundCtx = ctx || {};
  // Publish the durable store so handlers from other lanes (autonomy tasks /
  // workers) can resolve a session id created here without a host resolver.
  attachSessionContext(boundCtx);
  for (const legacy of LEGACY_SESSION_ROUTES) {
    registry.remove(legacy.method, legacy.path);
  }
  for (const definition of SESSION_ROUTE_DEFINITIONS) {
    const wrapped = async (args = {}) =>
      definition.handler({ ...args, ctx: args.ctx || boundCtx });
    registry.register(definition.method, definition.path, wrapped, {
      official: true,
      status: definition.status,
      description: definition.description,
      ...(definition.reason ? { reason: definition.reason } : {}),
    });
  }
  return registry;
}

export default registerSessionRoutes;
