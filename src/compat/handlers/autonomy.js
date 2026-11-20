/**
 * Official Hive frontend compatibility handlers for the autonomy surface:
 * MCP server settings, Sentinel notification settings, runtime/browser
 * status, per-session tasks, and worker inspection/control.
 *
 * Handlers return `{status, body}` descriptors and never write to `res`, so
 * the registry stays usable from unit tests and the plain node:http server.
 * Every route is registered with `official: true` and a status that reflects
 * what pi_hive can actually do:
 *
 *   implemented - backed by real pi_hive state (colony metadata, plan.json,
 *                 notifications.json, inbox.jsonl, WorkerManager, run files,
 *                 the process log buffer)
 *   partial     - the route exists and stores/serves honest data, but the
 *                 upstream capability is absent (MCP servers are not loaded;
 *                 Telegram/Slack delivery is not implemented). These routes
 *                 answer with an explicit 4xx where an action cannot work,
 *                 never a fake success.
 *
 * `ctx` is the integration seam. The server passes itself per call; the ctx
 * captured at registration time is the fallback. Supported fields:
 *   ctx.runtimes / ctx.server.runtimes   Map or object of live colony runtimes
 *   ctx.getRuntime(name)                 optional runtime lookup (must not
 *                                        create one; handlers never instantiate)
 *   ctx.resolveSession(id)               session id -> colony name (see below)
 *   ctx.sessions                         rows or Map of {session_id, colony}
 *   ctx.runtimeLogs / ctx.getRuntimeLogs log provider
 *   ctx.logFile                          fallback log file for /runtime-logs
 *   ctx.browserStatus                    browser bridge snapshot provider
 *   ctx.credentialsStatus                Sentinel credential presence provider
 *   ctx.validateTelegram(token)          optional real Telegram check
 *   ctx.detectTelegramChat(token)        optional real getUpdates check
 *   ctx.validateSlack(token)             optional real Slack auth.test
 *   ctx.workerConversation(id)           optional transcript provider
 *
 * Session ids: pi_hive has no session store yet. A bare colony name resolves
 * to that colony, and `<colony>:<session>` / `<colony>/<session>` resolve to
 * the leading colony when it exists. Anything else needs
 * `ctx.resolveSession`.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

import { colonyDir, ensureDir, hiveHome } from "../../config.js";
import { colonyPaths, loadMetadata, saveMetadata } from "../../domain/colony.js";
import { getPlan } from "../../domain/plan.js";
import { listSkills } from "../../domain/skills.js";
import { fsTools } from "../../runtime/fs-tools.js";
import { memoryTools } from "../../runtime/memory-tools.js";
import { planTools, skillTools, soulTools, trackerTools } from "../../runtime/tools.js";
import { ROUTE_STATUS } from "../router.js";
import { sessionColonyFromStore } from "./sessions.js";

const IMPLEMENTED = ROUTE_STATUS.IMPLEMENTED;
const PARTIAL = ROUTE_STATUS.PARTIAL;

const VALID_MCP_TRANSPORTS = new Set(["stdio", "http", "sse", "unix"]);
const VALID_MCP_MODES = new Set(["tools", "cli"]);
const VALID_SENTINEL_CHANNELS = new Set(["hive", "telegram", "slack"]);

/** Category used by the config lane for colony-scoped skills. */
const COLONY_SKILL_SCOPE = "colony_ui";

const MCP_HINT =
  "Saved for configuration only: pi_hive does not load MCP servers yet, so " +
  "these tools are not available to agents. The entry is kept for the next loader.";
/** Says what a probe proves, so a green chip is not read as "tools loaded". */
const MCP_HEALTH_NOTE =
  "Reachability only: pi_hive connects to the endpoint but loads no MCP tools, so tools always reports 0.";
const MCP_PROBE_TIMEOUT_MS = 3000;
const SENTINEL_HTTP_TIMEOUT_MS = 8000;

const TELEGRAM_UNAVAILABLE =
  "pi_hive's Sentinel has a local inbox but no Telegram transport";
const SLACK_UNAVAILABLE =
  "pi_hive's Sentinel has a local inbox but no Slack transport";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ok(body, status = 200) {
  return { status, body };
}

function fail(status, message, extra = {}) {
  return { status, body: { error: message, ...extra } };
}

/** A 4xx that states what is missing, why, and what would fix it. */
function unavailable(status, message, { code = "integration_unavailable", what, why, fix } = {}) {
  return {
    status,
    body: {
      error: message,
      code,
      what: what || message,
      why: why || message,
      fix: fix || "Use the local Hive inbox, or add the integration to pi_hive first.",
    },
  };
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonFile(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return value;
}

/** ISO-8601 or epoch millis -> integer epoch seconds (the official unit). */
function epochSeconds(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value / 1000) : Math.round(value);
  }
  if (typeof value === "number") return fallback;
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.round(ms / 1000);
    if (/^\d+$/.test(value)) return Number(value);
  }
  return fallback;
}

function queryOf(req) {
  if (req?.query && typeof req.query.get === "function") return req.query;
  if (isPlainObject(req?.query)) return new URLSearchParams(req.query);
  const url = typeof req?.url === "string" ? req.url : "";
  const index = url.indexOf("?");
  return new URLSearchParams(index >= 0 ? url.slice(index + 1) : "");
}

function intQuery(query, name, fallback = 0) {
  const raw = query.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Read a JSON request body. The server hands handlers the raw node request;
 * tests and embedders may pass a pre-parsed `req.body`. A missing/empty body
 * is `{}` (the official client sends `{}` for several POSTs). Malformed JSON
 * is reported rather than thrown.
 */
async function readJsonBody(req) {
  let raw;
  if (req?.body !== undefined) {
    if (typeof req.body === "string") raw = req.body;
    else if (isPlainObject(req.body)) return { ok: true, body: req.body };
    else if (req.body === null) return { ok: true, body: {} };
    else return { ok: false, error: "Body must be a JSON object" };
  } else if (typeof req?.json === "function") {
    try {
      const parsed = await req.json();
      return isPlainObject(parsed) ? { ok: true, body: parsed } : { ok: false, error: "Body must be a JSON object" };
    } catch {
      return { ok: false, error: "Invalid JSON body" };
    }
  } else if (req && typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > 1024 * 1024) return { ok: false, error: "request body too large" };
        chunks.push(buffer);
      }
    } catch {
      return { ok: false, error: "Invalid request body" };
    }
    raw = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
  } else {
    return { ok: true, body: {} };
  }

  if (!raw.trim()) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? { ok: true, body: parsed } : { ok: false, error: "Body must be a JSON object" };
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
}

function activeContext(registeredCtx, invocationCtx) {
  if (invocationCtx && typeof invocationCtx === "object") return invocationCtx;
  return registeredCtx && typeof registeredCtx === "object" ? registeredCtx : {};
}

/** Wrap a `{ctx, req, params}` handler so the active ctx is resolved once. */
function withContext(handler, registeredCtx) {
  return async (args = {}) =>
    handler({
      ...args,
      ctx: activeContext(registeredCtx, args.ctx),
    });
}

// ---------------------------------------------------------------------------
// Colony + session resolution
// ---------------------------------------------------------------------------

/** Existing colony name or null. Invalid names and malformed metadata are null. */
function existingColonyName(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const name = value.trim();
  try {
    colonyDir(name);
  } catch {
    return null;
  }
  try {
    return loadMetadata(name) ? name : null;
  } catch {
    return null;
  }
}

function colonyFromReference(value) {
  if (typeof value === "string") return existingColonyName(value);
  if (isPlainObject(value)) {
    for (const key of ["colony", "colony_id", "colony_name", "colonyId"]) {
      const name = existingColonyName(value[key]);
      if (name) return name;
    }
  }
  return null;
}

/** `<colony>:<session>` / `<colony>/<session>`, or a bare colony name. */
function colonyFromSessionId(sessionId) {
  const raw = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!raw) return null;
  const direct = existingColonyName(raw);
  if (direct) return direct;
  const match = /^([a-z0-9][a-z0-9_-]{0,63})[:/](.+)$/.exec(raw);
  return match ? existingColonyName(match[1]) : null;
}

function rowsFromSessionSource(source) {
  if (!source) return [];
  if (source instanceof Map) return [...source.values()];
  if (Array.isArray(source)) return source;
  if (isPlainObject(source) && Array.isArray(source.sessions)) return source.sessions;
  return [];
}

async function resolveSessionColony(ctx, sessionId) {
  for (const key of ["resolveSession", "sessionColony", "colonyForSession"]) {
    const fn = ctx?.[key];
    if (typeof fn !== "function") continue;
    try {
      const name = colonyFromReference(await fn(sessionId, ctx));
      if (name) return name;
    } catch {
      // A broken provider must not mask the deterministic fallback.
    }
  }

  for (const key of ["sessions", "sessionRows"]) {
    const source = ctx?.[key];
    if (!source) continue;
    const rows = typeof source === "function" ? await source() : source;
    if (rows instanceof Map && rows.has(sessionId)) {
      const name = colonyFromReference(rows.get(sessionId));
      if (name) return name;
    }
    for (const row of rowsFromSessionSource(rows)) {
      if (!isPlainObject(row)) continue;
      if (row.session_id !== sessionId && row.id !== sessionId) continue;
      const name = colonyFromReference(row);
      if (name) return name;
    }
  }

  // Sessions created through the session lane's durable store are real even
  // when this invocation ctx is a different object than the registration ctx
  // and therefore carries no resolver. Ask the store directly before falling
  // back to the `<colony>:<session>` id heuristic.
  const stored = sessionColonyFromStore(ctx, sessionId);
  if (stored) {
    const name = colonyFromReference(stored);
    if (name) return name;
  }

  return colonyFromSessionId(sessionId);
}

async function sessionTarget(ctx, sessionId) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return { error: fail(400, "session_id required", { type: "invalid_request" }) };
  const colony = await resolveSessionColony(ctx, id);
  if (!colony) {
    return {
      error: fail(404, `unknown session: ${id}`, { type: "unknown_session", session_id: id }),
    };
  }
  return { session_id: id, colony };
}

/** Live colony runtime from ctx.runtimes / ctx.getRuntime; never creates one. */
function runtimeFor(ctx, colony) {
  const sources = [ctx?.runtimes, ctx?.server?.runtimes, ctx?.colonyRuntimes];
  for (const source of sources) {
    if (source instanceof Map && source.has(colony)) return source.get(colony);
    if (isPlainObject(source) && source[colony]) return source[colony];
  }
  if (typeof ctx?.getRuntime === "function") {
    try {
      return ctx.getRuntime(colony) || null;
    } catch {
      return null;
    }
  }
  return null;
}

function workerManagerFor(ctx, colony) {
  const runtime = runtimeFor(ctx, colony);
  const manager = runtime?.workerManager;
  return manager && typeof manager === "object" ? manager : null;
}

// ---------------------------------------------------------------------------
// MCP servers (configuration store; pi_hive has no MCP loader)
// ---------------------------------------------------------------------------

function mcpStorePath() {
  return path.join(hiveHome(), "mcp_servers.json");
}

function readMcpServers() {
  const data = readJsonFile(mcpStorePath());
  const servers = Array.isArray(data?.servers) ? data.servers : [];
  return servers.filter((entry) => isPlainObject(entry) && typeof entry.name === "string");
}

function writeMcpServers(servers) {
  return writeJsonFile(mcpStorePath(), { version: 1, servers });
}

/** McpServer summary. Connection secrets (env/headers) stay in the store. */
function mcpSummary(entry) {
  const manifest = isPlainObject(entry.manifest) ? entry.manifest : {};
  const tools = Array.isArray(manifest.tools) ? manifest.tools : null;
  return {
    name: entry.name,
    source: typeof entry.source === "string" ? entry.source : "local",
    transport: typeof entry.transport === "string" ? entry.transport : "stdio",
    mode: VALID_MCP_MODES.has(entry.mode) ? entry.mode : "tools",
    description: typeof entry.description === "string" ? entry.description : "",
    enabled: entry.enabled !== false,
    last_health_status:
      entry.last_health_status === "healthy" || entry.last_health_status === "unhealthy"
        ? entry.last_health_status
        : null,
    last_error: typeof entry.last_error === "string" ? entry.last_error : null,
    last_health_check_at:
      typeof entry.last_health_check_at === "string" ? entry.last_health_check_at : null,
    tool_count: tools ? tools.length : Number.isFinite(entry.last_tool_count) ? entry.last_tool_count : null,
    removable: entry.source !== "built-in",
  };
}

function validateMcpName(name) {
  if (typeof name !== "string" || !name.trim()) return "name is required";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name.trim())) {
    return "name must be 1-64 characters of letters, digits, dot, dash, or underscore";
  }
  return null;
}

function validateMcpConnection(body) {
  const transport = body.transport;
  if (!VALID_MCP_TRANSPORTS.has(transport)) {
    return `transport must be one of ${[...VALID_MCP_TRANSPORTS].sort().join(", ")}`;
  }
  if (transport === "stdio" && (typeof body.command !== "string" || !body.command.trim())) {
    return "command is required for stdio transport";
  }
  if ((transport === "http" || transport === "sse") && (typeof body.url !== "string" || !body.url.trim())) {
    return `url is required for ${transport} transport`;
  }
  if (transport === "unix" && (typeof body.socket_path !== "string" || !body.socket_path.trim())) {
    return "socket_path is required for unix transport";
  }
  if (body.mode !== undefined && !VALID_MCP_MODES.has(body.mode)) {
    return `mode must be one of ${[...VALID_MCP_MODES].sort().join(", ")}`;
  }
  for (const key of ["args", "env", "headers"]) {
    if (body[key] === undefined) continue;
    if (key === "args" ? !Array.isArray(body[key]) : !isPlainObject(body[key])) {
      return `${key} must be ${key === "args" ? "an array" : "an object"}`;
    }
  }
  return null;
}

function mcpEntryFromBody(body) {
  const config = {};
  for (const key of ["command", "cwd", "url", "socket_path"]) {
    if (typeof body[key] === "string" && body[key]) config[key] = body[key];
  }
  if (Array.isArray(body.args)) config.args = body.args.map(String);
  if (isPlainObject(body.env)) config.env = { ...body.env };
  if (isPlainObject(body.headers)) config.headers = { ...body.headers };

  return {
    name: body.name.trim(),
    source: "local",
    transport: body.transport,
    mode: body.mode || "tools",
    description: typeof body.description === "string" ? body.description : "",
    enabled: true,
    last_health_status: null,
    last_error: null,
    last_health_check_at: null,
    last_tool_count: null,
    manifest: {},
    config,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Sentinel notifications (local inbox channel)
// ---------------------------------------------------------------------------

function notificationsPath(colony) {
  return path.join(colonyPaths(colony).dir, "notifications.json");
}

function telegramToken() {
  return process.env.PI_HIVE_TELEGRAM_TOKEN || process.env.PI_HIVE_TELEGRAM_BOT_TOKEN || "";
}

function slackBotToken() {
  return process.env.PI_HIVE_SLACK_BOT_TOKEN || process.env.PI_HIVE_SLACK_TOKEN || "";
}

function slackAppToken() {
  return process.env.PI_HIVE_SLACK_APP_TOKEN || "";
}

/** SentinelCredentialStatus: presence only, never the token value. */
function credentialStatus(ctx) {
  const provided = typeof ctx?.credentialsStatus === "function" ? ctx.credentialsStatus() : ctx?.credentialsStatus;
  if (isPlainObject(provided)) {
    const telegram = isPlainObject(provided.telegram) ? Boolean(provided.telegram.configured) : false;
    const slack = isPlainObject(provided.slack) ? provided.slack : {};
    return {
      telegram: { configured: telegram },
      slack: { bot: Boolean(slack.bot), app: Boolean(slack.app) },
    };
  }
  return {
    telegram: { configured: Boolean(telegramToken()) },
    slack: { bot: Boolean(slackBotToken()), app: Boolean(slackAppToken()) },
  };
}

function buildSentinelConfig(colony, ctx) {
  const meta = loadMetadata(colony) || {};
  const stored = readJsonFile(notificationsPath(colony)) || {};

  const enabled =
    typeof stored.sentinel_enabled === "boolean"
      ? stored.sentinel_enabled
      : Boolean(meta.sentinel_enabled);
  const channel =
    stored.channel === null
      ? null
      : VALID_SENTINEL_CHANNELS.has(stored.channel)
        ? stored.channel
        : enabled
          ? "hive"
          : null;
  const target = isPlainObject(stored.target)
    ? Object.fromEntries(Object.entries(stored.target).map(([key, value]) => [key, String(value)]))
    : {};
  const allowlist = Array.isArray(stored.allowlist) ? stored.allowlist.map(String) : [];
  const classify =
    typeof stored.classify_after_seconds === "number" && stored.classify_after_seconds > 0
      ? stored.classify_after_seconds
      : null;

  return {
    colony_id: colony,
    sentinel_enabled: enabled,
    channel,
    target,
    allowlist,
    thread: isPlainObject(stored.thread) ? stored.thread : {},
    classify_after_seconds: classify,
    credentials: credentialStatus(ctx),
  };
}

/** Append one record to the colony's local Sentinel inbox (inbox.jsonl). */
function appendInboxRecord(colony, record) {
  const file = path.join(colonyPaths(colony).dir, "inbox.jsonl");
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return record;
}

async function providerResult(ctx, key, payload) {
  const fn = ctx?.[key];
  if (typeof fn !== "function") return null;
  const value = await fn(payload, ctx);
  return isPlainObject(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Runtime logs (in-memory ring + optional log file)
// ---------------------------------------------------------------------------

const LOG_LIMIT = 500;
const LOG_CONTENT_LIMIT = 20_000;
const BOOT_ID = `pi_hive_${process.pid}_${Date.now().toString(36)}`;
const runtimeLogState = { boot: BOOT_ID, entries: [], nextSeq: 1 };

/**
 * Append server output to the process-local runtime log buffer. Server
 * integration can call this for stdout/stderr lines; `GET /api/runtime-logs`
 * serves them with monotonically increasing sequence numbers.
 */
export function appendRuntimeLog(stream, text) {
  const source = stream === "stderr" ? "stderr" : "stdout";
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (!line) continue;
    runtimeLogState.entries.push({
      seq: runtimeLogState.nextSeq++,
      stream: source,
      text: line.slice(0, LOG_CONTENT_LIMIT),
    });
  }
  if (runtimeLogState.entries.length > LOG_LIMIT) {
    runtimeLogState.entries.splice(0, runtimeLogState.entries.length - LOG_LIMIT);
  }
  return runtimeLogState.entries.length;
}

/** Reset the in-memory buffer (test helper; a fresh process starts empty). */
export function resetRuntimeLogs() {
  runtimeLogState.entries = [];
  runtimeLogState.nextSeq = 1;
  return runtimeLogState.boot;
}

/** `{boot, entries}` snapshot with the official after/boot cursor semantics. */
export function runtimeLogsSnapshot(after = 0, boot = "") {
  const mismatched = boot !== runtimeLogState.boot;
  const from = mismatched ? 0 : after;
  return {
    boot: runtimeLogState.boot,
    entries: runtimeLogState.entries.filter((entry) => entry.seq > from),
  };
}

function normalizeLogEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => isPlainObject(entry))
    .map((entry, index) => ({
      seq: Number.isFinite(entry.seq) ? entry.seq : index + 1,
      stream: entry.stream === "stderr" ? "stderr" : "stdout",
      text: String(entry.text ?? "").slice(0, LOG_CONTENT_LIMIT),
    }));
}

/**
 * Snapshot an on-disk log file. The boot id is derived from the inode (stable
 * across appends, so polling does not re-send everything); seq is the line
 * number. A truncated file resets the cursor, mirroring a new boot.
 */
function logFileSnapshot(file, after, boot = "") {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { boot: BOOT_ID, entries: [] };
  }
  if (!stat.isFile()) return { boot: BOOT_ID, entries: [] };
  const bootId = `file_${stat.ino}_${Math.round(stat.birthtimeMs)}`;
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
  } catch {
    return { boot: bootId, entries: [] };
  }
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const entries = lines.map((text, index) => ({
    seq: index + 1,
    stream: text.startsWith("[stderr]") ? "stderr" : "stdout",
    text: (text.startsWith("[stderr]") ? text.slice(8).trimStart() : text).slice(0, LOG_CONTENT_LIMIT),
  }));
  const from = boot && boot !== bootId ? 0 : after > entries.length ? 0 : after;
  return { boot: bootId, entries: entries.filter((entry) => entry.seq > from).slice(-LOG_LIMIT) };
}

function normalizeLogPayload(value, after, boot) {
  if (!isPlainObject(value)) return runtimeLogsSnapshot(after, boot);
  const bootId = typeof value.boot === "string" && value.boot ? value.boot : BOOT_ID;
  const entries = normalizeLogEntries(value.entries);
  const from = bootId === boot ? after : 0;
  return { boot: bootId, entries: entries.filter((entry) => entry.seq > from).slice(-LOG_LIMIT) };
}

// ---------------------------------------------------------------------------
// Tasks (plan.json mapped onto the official TaskRecord shape)
// ---------------------------------------------------------------------------

/** FNV-1a -> positive 31-bit integer; stable across reads for string ids. */
function stableNumericId(raw) {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  let hash = 0x811c9dc5;
  for (const char of raw) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2_147_483_647 || 1;
}

/**
 * Map plan tasks to official integer ids. Ids are derived only from the
 * task's own id, so they survive reads; a rare collision is resolved by
 * walking to the next free number in plan order.
 */
function taskIdMap(tasks) {
  const used = new Set();
  const map = new Map();
  for (const task of tasks) {
    if (!isPlainObject(task)) continue;
    let numeric = stableNumericId(String(task.id ?? ""));
    while (used.has(numeric)) numeric = (numeric % 2_147_483_646) + 1;
    used.add(numeric);
    map.set(numeric, task);
  }
  return map;
}

/** pi_hive statuses -> the official TaskStatus union. */
function taskStatus(status) {
  const value = String(status || "pending");
  if (["pending", "in_progress", "completed", "abandoned", "archived"].includes(value)) return value;
  // "blocked" has no official equivalent; keep it visible in metadata.
  return "pending";
}

function taskRecord(task, numericId, meta = {}) {
  const created = epochSeconds(task.created_at, epochSeconds(meta.created_at, 0));
  const updated = epochSeconds(task.updated_at, created);
  const status = String(task.status || "pending");
  return {
    id: numericId,
    subject: String(task.subject || ""),
    description: String(task.description || ""),
    active_form: typeof task.active_form === "string" ? task.active_form : null,
    owner: typeof task.owner === "string" ? task.owner : null,
    status: taskStatus(status),
    blocks: Array.isArray(task.blocks) ? task.blocks.filter(Number.isInteger) : [],
    blocked_by: Array.isArray(task.blocked_by) ? task.blocked_by.filter(Number.isInteger) : [],
    metadata: {
      ...(isPlainObject(task.metadata) ? task.metadata : {}),
      pi_hive_id: String(task.id ?? ""),
      ...(taskStatus(status) === status ? {} : { pi_hive_status: status }),
    },
    created_at: created,
    updated_at: updated,
  };
}

function buildTaskSnapshot(colony, sessionId) {
  const meta = loadMetadata(colony) || {};
  const plan = getPlan(colony);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const map = taskIdMap(tasks);
  const created = epochSeconds(meta.created_at, 0);
  return {
    session_id: sessionId,
    role: "session",
    meta: {
      role: "session",
      creator_agent_id: null,
      goal: (typeof plan.goal === "string" && plan.goal) || meta.goal || null,
      created_at: created,
      schema_version: 1,
    },
    tasks: [...map.entries()].map(([id, task]) => taskRecord(task, id, meta)),
  };
}

/** Read-modify-write plan.json once; returns the plan on success. */
function mutatePlan(colony, mutate) {
  const plan = getPlan(colony);
  const next = { ...plan, tasks: Array.isArray(plan.tasks) ? [...plan.tasks] : [] };
  mutate(next);
  writeJsonFile(colonyPaths(colony).plan, next);
  return next;
}

// ---------------------------------------------------------------------------
// Workers (WorkerManager live state + on-disk run files)
// ---------------------------------------------------------------------------

function startMsFromRunName(name) {
  const base = name.replace(/\.json$/i, "").split("_")[0];
  const value = Number.parseInt(base, 36);
  // Files created by runWorker start with Date.now().toString(36).
  return Number.isFinite(value) && value > 1_000_000_000_000 ? value : null;
}

function listWorkerRuns(colony) {
  const dir = colonyPaths(colony).workers;
  if (!fs.existsSync(dir)) return [];
  const runs = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    const data = readJsonFile(file);
    if (!data) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      mtime = 0;
    }
    const startedMs = startMsFromRunName(entry.name) || mtime;
    runs.push({ id: `run_${entry.name.replace(/\.json$/i, "")}`, file, data, startedMs });
  }
  runs.sort((a, b) => (b.startedMs || 0) - (a.startedMs || 0));
  return runs;
}

function safeWorkerRun(colony, workerId) {
  if (!/^run_[A-Za-z0-9_-]+$/.test(workerId)) return null;
  const base = workerId.slice(4);
  const dir = path.resolve(colonyPaths(colony).workers);
  const file = path.resolve(dir, `${base}.json`);
  if (!file.startsWith(dir + path.sep)) return null;
  const data = readJsonFile(file);
  if (!data) return null;
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    mtime = 0;
  }
  return { id: workerId, file, data, startedMs: startMsFromRunName(`${base}.json`) || mtime };
}

function normalizeWorkerResult(report) {
  if (!isPlainObject(report)) return null;
  return {
    status: String(report.status || "partial"),
    summary: String(report.summary || ""),
    error: report.error == null ? null : String(report.error),
    tokens_used: Number(report.tokens_used) || 0,
    duration_seconds: Number(report.duration_seconds) || 0,
  };
}

function liveWorkerRow(handle, status) {
  const startedAt = Number(handle.startedAt) || Number(handle.started_at) || 0;
  const startedSeconds = startedAt ? Math.round(startedAt / 1000) : 0;
  const report = isPlainObject(handle.report) ? handle.report : null;
  const active = status === "running" || status === "pending";
  return {
    worker_id: String(handle.id || ""),
    task: String(handle.task || ""),
    goal: typeof handle.goal === "string" && handle.goal ? handle.goal : null,
    status,
    started_at: startedSeconds,
    result: normalizeWorkerResult(report),
    task_summary: null,
    batch: null,
    // LiveWorker fields (workers.ts).
    is_active: active,
    duration_seconds:
      startedAt && status !== "pending"
        ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
        : 0,
    explicit_report: report,
    result_status: report ? String(report.status || "") : null,
    result_summary: report ? String(report.summary || "") : null,
  };
}

function historicalWorkerRow(run) {
  const report = isPlainObject(run.data.report) ? run.data.report : null;
  const endedMs = report?.at ? Date.parse(report.at) : NaN;
  const duration =
    Number.isFinite(endedMs) && run.startedMs
      ? Math.max(0, Math.round((endedMs - run.startedMs) / 1000))
      : 0;
  return {
    worker_id: run.id,
    task: String(run.data.task || ""),
    goal: null,
    status: "historical",
    started_at: run.startedMs ? Math.round(run.startedMs / 1000) : 0,
    result: normalizeWorkerResult(report),
    task_summary: null,
    batch: null,
    is_active: false,
    duration_seconds: duration,
    explicit_report: report,
    result_status: report ? String(report.status || "") : null,
    result_summary: report ? String(report.summary || "") : null,
  };
}

function workerRows(colony, ctx) {
  const rows = [];
  const manager = workerManagerFor(ctx, colony);
  if (manager) {
    const active = manager.active instanceof Map ? manager.active : null;
    if (active) {
      for (const handle of active.values()) {
        rows.push(liveWorkerRow(handle, handle.status === "stopped" ? "stopped" : "running"));
      }
    }
    if (Array.isArray(manager.queue)) {
      for (const handle of manager.queue) rows.push(liveWorkerRow(handle, "pending"));
    }
  }
  for (const run of listWorkerRuns(colony)) rows.push(historicalWorkerRow(run));
  rows.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  return rows;
}

function findLiveHandle(manager, workerId) {
  if (!manager) return null;
  for (const source of [manager.active, manager.handles]) {
    if (source instanceof Map && source.has(workerId)) return source.get(workerId);
  }
  if (Array.isArray(manager.queue)) {
    const queued = manager.queue.find((handle) => handle?.id === workerId);
    if (queued) return queued;
  }
  return null;
}

function liveWorkerDetail(handle, manager) {
  const status =
    handle.status === "queued"
      ? "pending"
      : handle.status === "stopped"
        ? "stopped"
        : manager?.active instanceof Map && manager.active.has(handle.id)
          ? "running"
          : "completed";
  return {
    ...liveWorkerRow(handle, status),
    profile_name: typeof handle.profile === "string" ? handle.profile : "default",
    batch: { batch_id: "", batch_index: 0, batch_size: 0, worker_seq: 0 },
    tasks: [],
  };
}

function historicalWorkerDetail(run) {
  return {
    ...historicalWorkerRow(run),
    profile_name: String(run.data.profile || "default"),
    batch: { batch_id: "", batch_index: 0, batch_size: 0, worker_seq: 0 },
    tasks: [],
  };
}

/** Extract text from a pi-agent message without importing the kernel. */
function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function toolCallsOf(message) {
  const raw = message?.toolCalls ?? message?.tool_calls;
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw
    .filter(isPlainObject)
    .map((call) => {
      const fn = isPlainObject(call.function) ? call.function : call;
      return {
        name: String(fn.name || ""),
        arguments:
          typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      };
    });
}

const CONVERSATION_MAX_PARTS = 2000;
const CONVERSATION_CONTENT_CAP = 20_000;

function transcriptFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const truncated = list.length > CONVERSATION_MAX_PARTS;
  const out = list.slice(0, CONVERSATION_MAX_PARTS).map((message, index) => {
    const entry = {
      seq: index + 1,
      role: String(message?.role || "assistant"),
      content: messageText(message).slice(0, CONVERSATION_CONTENT_CAP),
    };
    const calls = toolCallsOf(message);
    if (calls) entry.tool_calls = calls;
    if (typeof message?.tool_use_id === "string") entry.tool_use_id = message.tool_use_id;
    return entry;
  });
  return { messages: out, total: list.length, truncated };
}

/** Read `<worker dir>/conversations/parts/*.json` when a run persisted one. */
function transcriptFromParts(dir) {
  const partsDir = path.join(dir, "conversations", "parts");
  if (!fs.existsSync(partsDir)) return { messages: [], total: 0, truncated: false };
  let files;
  try {
    files = fs.readdirSync(partsDir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { messages: [], total: 0, truncated: false };
  }
  const total = files.length;
  const messages = [];
  for (const file of files.slice(0, CONVERSATION_MAX_PARTS)) {
    const data = readJsonFile(path.join(partsDir, file));
    if (!data) continue;
    const content = typeof data.content === "string" ? data.content : JSON.stringify(data.content ?? "");
    messages.push({
      seq: Number.isFinite(data.seq) ? data.seq : messages.length + 1,
      role: String(data.role || ""),
      content: content.slice(0, CONVERSATION_CONTENT_CAP),
      ...(Array.isArray(data.tool_calls) && data.tool_calls.length
        ? {
            tool_calls: data.tool_calls.filter(isPlainObject).map((call) => ({
              name: String(call.name || call.function?.name || ""),
              arguments:
                typeof call.arguments === "string"
                  ? call.arguments
                  : JSON.stringify(call.function?.arguments ?? call.arguments ?? {}),
            })),
          }
        : {}),
      ...(typeof data.tool_use_id === "string" ? { tool_use_id: data.tool_use_id } : {}),
    });
  }
  return { messages, truncated: total > CONVERSATION_MAX_PARTS, total };
}

/** Real pi_hive toolset for the colony. Runtime tools win when available. */
function colonyToolCatalog(colony, ctx) {
  const runtime = runtimeFor(ctx, colony);
  let tools = null;
  try {
    if (typeof runtime?.tools === "function") tools = runtime.tools();
    else if (Array.isArray(runtime?.tools)) tools = runtime.tools;
  } catch {
    tools = null;
  }
  if (!Array.isArray(tools)) {
    const queenId = (loadMetadata(colony) || {}).queen_id || "queen_growth";
    tools = [
      ...trackerTools({}),
      ...planTools(colony),
      ...skillTools(colony),
      ...memoryTools({ colony, queenId, writable: true }),
      ...fsTools(colony),
      ...soulTools({ engine: () => null }),
    ];
  }
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!isPlainObject(tool) || typeof tool.name !== "string" || !tool.name) continue;
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push({
      name: tool.name,
      description: String(tool.description || ""),
      // pi_hive tools are local; none are bound to an external credential.
      provider: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListMcpServers({ ctx }) {
  return ok({ servers: readMcpServers().map(mcpSummary) });
}

async function handleAddMcpServer({ req, ctx }) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, parsed.error);
  const body = parsed.body;

  const nameError = validateMcpName(body.name);
  if (nameError) return fail(400, nameError);
  const connectionError = validateMcpConnection(body);
  if (connectionError) return fail(400, connectionError);

  const name = body.name.trim();
  if (name.startsWith("hive_") || name.startsWith("__hive")) {
    return fail(400, `Server '${name}' uses a reserved prefix`);
  }

  const servers = readMcpServers();
  if (servers.some((entry) => entry.name === name)) {
    return fail(409, `Server '${name}' already exists`, {
      code: "already_exists",
      what: `an MCP server named '${name}' is already stored`,
      why: "names are unique in the MCP registry",
      fix: "Remove the existing entry or choose another name.",
    });
  }

  const entry = mcpEntryFromBody(body);
  writeMcpServers([...servers, entry]);
  return ok({ server: mcpSummary(entry), hint: MCP_HINT }, 201);
}

async function handleRemoveMcpServer({ params, ctx }) {
  const name = String(params?.server || "");
  const servers = readMcpServers();
  const entry = servers.find((row) => row.name === name);
  if (!entry) return fail(404, `Server '${name}' not installed`);
  if (entry.source === "built-in") {
    return fail(400, `Server '${name}' is a built-in; it cannot be removed from the UI.`);
  }
  writeMcpServers(servers.filter((row) => row.name !== name));
  return ok({ removed: name });
}

async function handleSetMcpEnabled({ params, ctx }, enabled) {
  const name = String(params?.server || "");
  const servers = readMcpServers();
  const entry = servers.find((row) => row.name === name);
  if (!entry) return fail(404, `Server '${name}' not installed`);
  if (entry.source === "built-in") {
    return fail(400, `Server '${name}' is a built-in; it cannot be toggled from the UI.`);
  }
  entry.enabled = Boolean(enabled);
  entry.updated_at = new Date().toISOString();
  writeMcpServers(servers);
  return ok({ name, enabled: entry.enabled });
}

async function handleSetMcpMode({ req, params, ctx }) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, parsed.error);
  const mode = parsed.body.mode;
  if (!VALID_MCP_MODES.has(mode)) {
    return fail(400, `mode must be one of ${[...VALID_MCP_MODES].sort().join(", ")}`);
  }
  const name = String(params?.server || "");
  const servers = readMcpServers();
  const entry = servers.find((row) => row.name === name);
  if (!entry) return fail(404, `Server '${name}' not installed`);
  if (entry.source === "built-in") {
    return fail(400, `Server '${name}' is a built-in; its mode cannot be changed from the UI.`);
  }
  entry.mode = mode;
  entry.updated_at = new Date().toISOString();
  writeMcpServers(servers);
  return ok({ name, mode, hint: "Saved. pi_hive does not load MCP servers yet, so no session applies it." });
}

/**
 * Reachability probe for one kind of transport. It answers "can pi_hive reach
 * this endpoint right now", not "does this server list tools": pi_hive loads no
 * MCP tools, so a probe that claimed a tool count would be inventing data.
 */
function probeTarget(entry) {
  const config = isPlainObject(entry.config) ? entry.config : {};
  const transport = String(entry.transport || "stdio");
  if (transport === "stdio") {
    const command = typeof config.command === "string" ? config.command.trim() : "";
    if (!command) return Promise.resolve({ ok: false, error: "no command configured" });
    const resolved = resolveCommand(command);
    if (!resolved) return Promise.resolve({ ok: false, error: `command not found on PATH: ${command}` });
    return Promise.resolve({ ok: true, detail: `command resolves to ${resolved}` });
  }
  if (transport === "unix") {
    const socketPath = typeof config.socket_path === "string" ? config.socket_path : "";
    if (!socketPath) return Promise.resolve({ ok: false, error: "no socket_path configured" });
    return probeSocket({ path: socketPath });
  }
  const raw = typeof config.url === "string" ? config.url : "";
  if (!raw) return Promise.resolve({ ok: false, error: "no url configured" });
  let url;
  try {
    url = new URL(raw);
  } catch {
    return Promise.resolve({ ok: false, error: `url is not absolute: ${raw}` });
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return probeSocket({ host: url.hostname, port, tls: url.protocol === "https:" });
}

/** PATH lookup without spawning: same search order the shell would use. */
function resolveCommand(command) {
  if (command.includes("/") || command.includes("\\")) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return path.resolve(command);
    } catch {
      return null;
    }
  }
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** TCP connect with a hard timeout; resolves instead of throwing. */
function probeSocket({ host, port, path: socketPath, tls = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = socketPath
      ? net.connect({ path: socketPath })
      : tls
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port });
    socket.setTimeout(MCP_PROBE_TIMEOUT_MS);
    socket.once("connect", () => done({ ok: true, detail: `accepted a connection on port ${port}` }));
    socket.once("secureConnect", () => done({ ok: true, detail: `TLS handshake completed with ${host}:${port}` }));
    socket.once("timeout", () => done({ ok: false, error: `no answer within ${MCP_PROBE_TIMEOUT_MS} ms` }));
    socket.once("error", (err) => done({ ok: false, error: err?.code ? `${err.code}: ${err.message}` : String(err?.message || err) }));
  });
}

async function handleMcpHealth({ params } = {}) {
  const name = String(params?.server || "");
  const servers = readMcpServers();
  const entry = servers.find((row) => row.name === name);
  if (!entry) return fail(404, `Server '${name}' not installed`);

  const probe = await probeTarget(entry);
  const status = probe.ok ? "healthy" : "unhealthy";
  const checkedAt = new Date().toISOString();
  entry.last_health_status = status;
  entry.last_error = probe.ok ? null : probe.error;
  entry.last_health_check_at = checkedAt;
  entry.updated_at = checkedAt;
  writeMcpServers(servers);

  return ok({
    name,
    status,
    tools: 0,
    error: probe.ok ? null : probe.error,
    detail: probe.ok ? probe.detail : null,
    checked_at: checkedAt,
    note: MCP_HEALTH_NOTE,
  });
}

async function handleGetNotifications({ params, ctx }) {
  const colony = existingColonyName(String(params?.colony || ""));
  if (!colony) return fail(404, `Colony '${params?.colony}' not found`);
  return ok(buildSentinelConfig(colony, ctx));
}

async function handlePutNotifications({ req, params, ctx }) {
  const colony = existingColonyName(String(params?.colony || ""));
  if (!colony) return fail(404, `Colony '${params?.colony}' not found`);

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, parsed.error);
  const body = parsed.body;

  const enabled = Boolean(body.sentinel_enabled);
  const channel = body.channel ?? null;
  if (channel !== null && !VALID_SENTINEL_CHANNELS.has(channel)) {
    return fail(400, "channel must be 'hive', 'telegram', 'slack', or null");
  }
  if (enabled && channel === null) {
    return fail(400, "channel must be 'hive', 'telegram', or 'slack' when enabled");
  }

  const target = isPlainObject(body.target) ? body.target : {};
  if (body.allowlist !== undefined && body.allowlist !== null && !Array.isArray(body.allowlist)) {
    return fail(400, "allowlist must be a list");
  }
  const allowlist = Array.isArray(body.allowlist) ? body.allowlist.map(String) : [];

  let classifyAfterSeconds = null;
  if (body.classify_after_seconds !== undefined && body.classify_after_seconds !== null) {
    const value = Number(body.classify_after_seconds);
    if (!Number.isFinite(value)) return fail(400, "classify_after_seconds must be a number or null");
    if (value <= 0) return fail(400, "classify_after_seconds must be positive");
    classifyAfterSeconds = value;
  }

  const previous = readJsonFile(notificationsPath(colony)) || {};
  const next = {
    ...previous,
    sentinel_enabled: enabled,
    channel,
    target: Object.fromEntries(Object.entries(target).map(([key, value]) => [key, String(value)])),
    allowlist,
    thread: isPlainObject(previous.thread) ? previous.thread : {},
    classify_after_seconds: classifyAfterSeconds,
    updated_at: new Date().toISOString(),
  };
  writeJsonFile(notificationsPath(colony), next);

  // pi_hive's Sentinel.start() reads metadata.sentinel_enabled, so enabling
  // the local channel must be reflected there to take effect on next start.
  const meta = loadMetadata(colony) || {};
  if (Boolean(meta.sentinel_enabled) !== enabled) {
    saveMetadata(colony, { ...meta, sentinel_enabled: enabled });
  }

  return ok(buildSentinelConfig(colony, ctx));
}

/**
 * Send one real message over a channel.
 *
 * The token comes from the request's target (or the environment) and is used as
 * a URL segment / bearer header only. The result is recorded in the inbox and
 * returned as `{ok, message_id, error}` — a provider refusal is a result, not a
 * missing capability.
 */
async function sendToTransport(colony, { channel, target, body }) {
  const text =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : `Sentinel test for colony "${colony}". Deliveries will arrive here.`;

  if (channel === "telegram") {
    const token = typeof target.token === "string" && target.token ? target.token : telegramToken();
    const chatId = target.chat_id ?? target.chatId ?? null;
    if (!token) return fail(400, "no Telegram token provided or saved", { ok: false });
    if (!chatId) return fail(400, "target.chat_id is required to send a Telegram message", { ok: false });
    const probe = await telegramApi(token, "sendMessage", `?chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent(text)}`);
    const messageId = probe.ok ? String(probe.result?.message_id ?? "") || null : null;
    appendInboxRecord(colony, {
      at: new Date().toISOString(),
      colony,
      kind: "test",
      channel: "telegram",
      message_id: messageId,
      reason: text,
      last_message: probe.ok ? text : "",
      ...(probe.ok ? {} : { error: probe.error }),
    });
    return ok({ ok: probe.ok, message_id: messageId, error: probe.ok ? null : probe.error });
  }

  const token = typeof target.token === "string" && target.token ? target.token : slackBotToken();
  const slackChannel = target.channel_id ?? target.channel ?? target.chat_id ?? null;
  if (!token) return fail(400, "no Slack token provided or saved", { ok: false });
  if (!slackChannel) return fail(400, "target.channel is required to send a Slack message", { ok: false });
  const result = await slackPostMessage(token, slackChannel, text);
  const messageId = result.ok ? String(result.result?.ts ?? "") || null : null;
  appendInboxRecord(colony, {
    at: new Date().toISOString(),
    colony,
    kind: "test",
    channel: "slack",
    message_id: messageId,
    reason: text,
    last_message: result.ok ? text : "",
    ...(result.ok ? {} : { error: result.error }),
  });
  return ok({ ok: result.ok, message_id: messageId, error: result.ok ? null : result.error });
}

/** Slack `chat.postMessage`, same token rules as `auth.test`. */
async function slackPostMessage(token, channelId, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SENTINEL_HTTP_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ channel: String(channelId), text });
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: body.toString(),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!payload) return { ok: false, error: `HTTP ${response.status}` };
    if (payload.ok !== true) return { ok: false, error: payload.error || `HTTP ${response.status}` };
    return { ok: true, result: payload };
  } catch (err) {
    const reason = err?.name === "AbortError" ? `no answer within ${SENTINEL_HTTP_TIMEOUT_MS} ms` : err?.message || String(err);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

async function handleTestNotification({ req, params, ctx }) {
  const colony = existingColonyName(String(params?.colony || ""));
  if (!colony) return fail(404, `Colony '${params?.colony}' not found`);

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, parsed.error);
  const body = parsed.body;
  const cfg = buildSentinelConfig(colony, ctx);

  const channel = body.channel || cfg.channel;
  const target = isPlainObject(body.target) ? body.target : cfg.target;
  if (!VALID_SENTINEL_CHANNELS.has(channel) || !isPlainObject(target)) {
    return fail(400, "channel and target required to send a test");
  }

  if (channel === "telegram" || channel === "slack") {
    return sendToTransport(colony, { channel, target, body });
  }

  const messageId = `inbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  appendInboxRecord(colony, {
    at: new Date().toISOString(),
    colony,
    kind: "test",
    channel: "hive",
    message_id: messageId,
    reason: `Sentinel test for colony "${colony}". If you can read this, escalations will reach the local inbox.`,
    last_message: "",
  });
  return ok({ ok: true, message_id: messageId, error: null });
}

async function handleSentinelCredentials({ ctx }) {
  return ok(credentialStatus(ctx));
}

/**
 * A real Telegram Bot API call. The token comes from the request or the saved
 * sentinel config and is only used as a URL segment — never logged, echoed or
 * returned.
 */
async function telegramApi(token, method, query = "") {
  const url = `https://api.telegram.org/bot${token}/${method}${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SENTINEL_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!payload || payload.ok !== true) {
      const description = payload?.description || `HTTP ${response.status}`;
      return { ok: false, error: description };
    }
    return { ok: true, result: payload.result };
  } catch (err) {
    const reason = err?.name === "AbortError" ? `no answer within ${SENTINEL_HTTP_TIMEOUT_MS} ms` : err?.message || String(err);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Slack's `auth.test`, same rules: the token travels in a header, never in a response. */
async function slackAuthTest(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SENTINEL_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!payload) return { ok: false, error: `HTTP ${response.status}` };
    if (payload.ok !== true) return { ok: false, error: payload.error || `HTTP ${response.status}` };
    return { ok: true, result: payload };
  } catch (err) {
    const reason = err?.name === "AbortError" ? `no answer within ${SENTINEL_HTTP_TIMEOUT_MS} ms` : err?.message || String(err);
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

async function handleTelegramValidate({ req, ctx }) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, parsed.error);
  const token = typeof parsed.body.token === "string" ? parsed.body.token : telegramToken();

  const provided = await providerResult(ctx, "validateTelegram", token || null);
  if (provided) return ok(provided);
  if (!token) return fail(400, "no token provided or saved", { ok: false });

  const probe = await telegramApi(token, "getMe");
  if (!probe.ok) {
    // A refused token is a real answer, not a broken capability.
    return ok({ ok: false, error: probe.error });
  }
  return ok({
    ok: true,
    bot_username: probe.result?.username ?? null,
    bot_name: probe.result?.first_name ?? null,
  });
}

async function handleTelegramDetectChat({ req, ctx }) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, parsed.error);
  const token = typeof parsed.body.token === "string" ? parsed.body.token : telegramToken();
  const provided = await providerResult(ctx, "detectTelegramChat", token || null);
  if (provided) return ok(provided);
  if (!token) return fail(400, "save the bot token first", { ok: false });

  // getUpdates reports messages the bot has not consumed yet, which is exactly
  // how the desktop discovers a chat id for its own bot.
  const probe = await telegramApi(token, "getUpdates", "?limit=10&timeout=0");
  if (!probe.ok) return ok({ ok: false, pending: false, error: probe.error });
  const updates = Array.isArray(probe.result) ? probe.result : [];
  const message = updates.map((update) => update.message || update.edited_message || update.channel_post).find(Boolean);
  if (!message) {
    return ok({ ok: true, pending: true, chat_id: null, chat_title: null, sender_id: null, sender_name: null });
  }
  const sender = message.from || {};
  return ok({
    ok: true,
    pending: false,
    chat_id: message.chat?.id != null ? String(message.chat.id) : null,
    chat_title: message.chat?.title ?? message.chat?.username ?? null,
    sender_id: sender.id != null ? String(sender.id) : null,
    sender_name: [sender.first_name, sender.last_name].filter(Boolean).join(" ") || sender.username || null,
  });
}

async function handleSlackValidate({ req, ctx }) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, parsed.error);
  const token = typeof parsed.body.token === "string" ? parsed.body.token : slackBotToken();

  const provided = await providerResult(ctx, "validateSlack", token || null);
  if (provided) return ok(provided);
  if (!token) return fail(400, "no token provided or saved", { ok: false });

  const probe = await slackAuthTest(token);
  if (!probe.ok) return ok({ ok: false, error: probe.error });
  return ok({
    ok: true,
    team: probe.result?.team ?? null,
    bot_user: probe.result?.user ?? null,
  });
}

async function handleRuntimeLogs({ req, ctx }) {
  const query = queryOf(req);
  const after = intQuery(query, "after", 0);
  const boot = query.get("boot") || "";

  if (typeof ctx?.getRuntimeLogs === "function") {
    return ok(normalizeLogPayload(await ctx.getRuntimeLogs({ after, boot }), after, boot));
  }
  if (typeof ctx?.runtimeLogs === "function") {
    return ok(normalizeLogPayload(await ctx.runtimeLogs({ after, boot }), after, boot));
  }
  if (typeof ctx?.runtimeLogs?.snapshot === "function") {
    return ok(normalizeLogPayload(await ctx.runtimeLogs.snapshot(after, boot), after, boot));
  }
  if (isPlainObject(ctx?.runtimeLogs)) {
    const value = ctx.runtimeLogs;
    if (typeof value.since === "function") {
      return ok(normalizeLogPayload({ boot: value.boot, entries: value.since(after) }, after, boot));
    }
    if (Array.isArray(value.entries)) return ok(normalizeLogPayload(value, after, boot));
  }

  const file = ctx?.logFile || process.env.PI_HIVE_LOG_FILE;
  if (file) {
    const resolved = path.resolve(String(file));
    if (fs.existsSync(resolved)) return ok(logFileSnapshot(resolved, after, boot));
  }
  return ok(runtimeLogsSnapshot(after, boot));
}

function normalizeBrowserStatus(value) {
  const status = isPlainObject(value) ? value : {};
  const health = ["healthy", "stale", "disconnected", "offline"].includes(status.health)
    ? status.health
    : status.connected
      ? "healthy"
      : "offline";
  const tab = isPlainObject(status.active_tab) ? status.active_tab : null;
  return {
    bridge: Boolean(status.bridge),
    connected: Boolean(status.connected),
    health,
    last_pong_age_ms: Number.isFinite(status.last_pong_age_ms) ? status.last_pong_age_ms : null,
    extension_version:
      typeof status.extension_version === "string" ? status.extension_version : null,
    active_tab: tab
      ? {
          id: Number.isFinite(tab.id) ? tab.id : null,
          title: typeof tab.title === "string" ? tab.title : null,
          url: typeof tab.url === "string" ? tab.url : null,
        }
      : null,
  };
}

async function handleBrowserStatus({ req, ctx }) {
  const query = queryOf(req);
  const sessionId = query.get("session_id") || null;
  const provided =
    typeof ctx?.browserStatus === "function"
      ? await ctx.browserStatus(sessionId, ctx)
      : ctx?.browserStatus;
  if (isPlainObject(provided)) return ok(normalizeBrowserStatus(provided));
  // pi_hive ships no browser bridge. This is the official "offline" payload,
  // not a fabricated connection.
  return ok(
    normalizeBrowserStatus({
      bridge: false,
      connected: false,
      health: "offline",
      last_pong_age_ms: null,
      extension_version: null,
      active_tab: null,
    }),
  );
}

async function handleGetTasks({ params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;

  if (!fs.existsSync(colonyPaths(target.colony).plan)) {
    return fail(404, `Task list for session '${target.session_id}' not found`, {
      session_id: target.session_id,
      tasks: [],
    });
  }
  return ok(buildTaskSnapshot(target.colony, target.session_id));
}

async function handleUnarchiveTasks({ req, params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return fail(400, parsed.error);
  const taskIds = parsed.body.task_ids;
  if (!Array.isArray(taskIds) || !taskIds.every(Number.isInteger)) {
    return fail(400, "task_ids must be a list of integers", { session_id: target.session_id });
  }

  const plan = getPlan(target.colony);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const map = taskIdMap(tasks);
  const restored = [];
  const wanted = new Set(taskIds);

  for (const [id, task] of map.entries()) {
    if (!wanted.has(id)) continue;
    if (task.status !== "archived") continue;
    restored.push({ id, rawId: task.id, status: task.archived_from || "pending" });
  }
  if (!restored.length) return ok({ session_id: target.session_id, restored: [] });

  const restoredRaw = new Map(restored.map((row) => [String(row.rawId), row.status]));
  mutatePlan(target.colony, (next) => {
    next.tasks = next.tasks.map((task) => {
      const status = restoredRaw.get(String(task.id));
      if (!status) return task;
      const updated = { ...task, status, updated_at: new Date().toISOString() };
      delete updated.archived_from;
      return updated;
    });
  });

  return ok({ session_id: target.session_id, restored: restored.map((row) => row.id) });
}

async function handleClearCompletedTasks({ params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;

  const plan = getPlan(target.colony);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const archivedRaw = new Set(
    tasks
      .filter((task) => isPlainObject(task) && task.status === "completed")
      .map((task) => String(task.id)),
  );
  const map = taskIdMap(tasks);
  const archived = [...map.entries()]
    .filter(([, task]) => archivedRaw.has(String(task.id)))
    .map(([id]) => id);
  if (!archived.length) return ok({ session_id: target.session_id, archived: [] });

  mutatePlan(target.colony, (next) => {
    next.tasks = next.tasks.map((task) => {
      if (!archivedRaw.has(String(task.id))) return task;
      return {
        ...task,
        status: "archived",
        archived_from: "completed",
        updated_at: new Date().toISOString(),
      };
    });
  });

  return ok({ session_id: target.session_id, archived });
}

async function handleListWorkers({ params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;
  return ok({ workers: workerRows(target.colony, ctx) });
}

async function handleGetWorker({ params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;
  const workerId = String(params?.worker || "");
  if (!workerId) return fail(400, "worker_id required", { session_id: target.session_id });

  const manager = workerManagerFor(ctx, target.colony);
  const live = findLiveHandle(manager, workerId);
  if (live) return ok({ worker: liveWorkerDetail(live, manager) });

  const run = safeWorkerRun(target.colony, workerId);
  if (run) return ok({ worker: historicalWorkerDetail(run) });

  return fail(404, `unknown worker: ${workerId}`, { session_id: target.session_id });
}

async function handleWorkerConversation({ params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;
  const workerId = String(params?.worker || "");
  if (!workerId) return fail(400, "worker_id required", { session_id: target.session_id });

  if (typeof ctx?.workerConversation === "function") {
    const provided = await ctx.workerConversation(workerId, target.session_id, ctx);
    if (isPlainObject(provided)) {
      return ok({
        worker_id: workerId,
        messages: Array.isArray(provided.messages) ? provided.messages : [],
        total: Number.isFinite(provided.total) ? provided.total : 0,
        truncated: Boolean(provided.truncated),
      });
    }
  }

  const manager = workerManagerFor(ctx, target.colony);
  const live = findLiveHandle(manager, workerId);
  if (live) {
    const agent = manager?.agents instanceof Map ? manager.agents.get(workerId) : null;
    const transcript = transcriptFromMessages(agent?.state?.messages);
    return ok({ worker_id: workerId, ...transcript });
  }

  if (/^[A-Za-z0-9_-]+$/.test(workerId)) {
    const dir = workerId.startsWith("run_")
      ? path.join(colonyPaths(target.colony).workers, workerId.slice(4))
      : path.join(colonyPaths(target.colony).workers, workerId);
    const resolved = path.resolve(dir);
    const root = path.resolve(colonyPaths(target.colony).workers);
    if (resolved.startsWith(root + path.sep) && fs.existsSync(resolved)) {
      return ok({ worker_id: workerId, ...transcriptFromParts(resolved) });
    }
  }

  if (!safeWorkerRun(target.colony, workerId)) {
    return fail(404, `unknown worker: ${workerId}`, { session_id: target.session_id });
  }
  // A flat run file carries only the final report; no transcript was stored.
  return ok({ worker_id: workerId, messages: [], total: 0, truncated: false });
}

async function handleColonySkills({ params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;
  const root = colonyPaths(target.colony).skills;
  return ok({
    skills: listSkills(target.colony).map((skill) => ({
      name: skill.name,
      description: skill.description || "",
      location: skill.path,
      base_dir: root,
      source_scope: COLONY_SKILL_SCOPE,
    })),
  });
}

async function handleColonyTools({ params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;
  return ok({ tools: colonyToolCatalog(target.colony, ctx) });
}

async function handleStopWorker({ params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;
  const workerId = String(params?.worker || "");
  if (!workerId) return fail(400, "worker_id required", { session_id: target.session_id });

  const manager = workerManagerFor(ctx, target.colony);
  if (!manager) return fail(404, `Worker '${workerId}' not found`, { stopped: false, worker_id: workerId });

  let result;
  if (typeof manager.stop === "function") {
    result = manager.stop(workerId);
  } else {
    const handle = findLiveHandle(manager, workerId);
    if (!handle) return fail(404, `Worker '${workerId}' not found`, { stopped: false, worker_id: workerId });
    const agent = manager.agents instanceof Map ? manager.agents.get(workerId) : null;
    if (agent && typeof agent.abort === "function") {
      agent.abort();
      result = { stopped: true, worker_id: workerId, status: "stopped" };
    } else {
      return unavailable(409, `Worker '${workerId}' cannot be stopped by this runtime`, {
        what: "no abort handle is registered for the worker",
        why: "the worker manager does not expose cancellation",
        fix: "Upgrade to a pi_hive WorkerManager with stop() support.",
      });
    }
  }

  if (!result || result.stopped !== true) {
    if (result?.reason === "not_found") {
      return fail(404, `Worker '${workerId}' not found`, { stopped: false, worker_id: workerId });
    }
    return ok({
      stopped: false,
      worker_id: workerId,
      reason: result?.reason || "already_terminated",
      status: result?.status || "completed",
    });
  }
  return ok({ stopped: true, worker_id: workerId, status: result.status || "stopped" });
}

async function handleStopAllWorkers({ params, ctx }) {
  const target = await sessionTarget(ctx, params?.session);
  if (target.error) return target.error;

  const manager = workerManagerFor(ctx, target.colony);
  if (!manager || typeof manager.stopAll !== "function") {
    return ok({ stopped: [], stopped_count: 0, errors: null });
  }
  const result = manager.stopAll();
  const stopped = Array.isArray(result?.stopped) ? result.stopped : [];
  return ok({
    stopped,
    stopped_count: Number.isFinite(result?.stopped_count) ? result.stopped_count : stopped.length,
    errors: Array.isArray(result?.errors) ? result.errors : null,
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the 26 autonomy/system routes on a RouteRegistry.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] integration context (see module docs)
 * @returns {import("../router.js").RouteRegistry}
 */
export function registerAutonomyRoutes(registry, ctx = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registerAutonomyRoutes requires a RouteRegistry (registry.register)");
  }

  const routes = [
    // --- MCP (configuration store only; no loader) ------------------------
    {
      method: "GET",
      path: "/api/mcp/servers",
      status: IMPLEMENTED,
      description: "the stored MCP servers from $PI_HIVE_HOME/mcp_servers.json",
      notes: "Definitions are real and durable; pi_hive has no MCP client, so nothing here is loaded into a session.",
      handler: handleListMcpServers,
    },
    {
      method: "POST",
      path: "/api/mcp/servers",
      status: IMPLEMENTED,
      description: "validates and stores an MCP server definition (409 on a duplicate name)",
      notes: "Validation, reserved prefixes, uniqueness and persistence are real; tool loading is not implemented.",
      handler: handleAddMcpServer,
    },
    {
      method: "DELETE",
      path: "/api/mcp/servers/:server",
      status: IMPLEMENTED,
      description: "removes a stored definition; built-ins are 400, unknown names 404",
      handler: handleRemoveMcpServer,
    },
    {
      method: "POST",
      path: "/api/mcp/servers/:server/enable",
      status: IMPLEMENTED,
      description: "persists enabled=true on a stored definition",
      handler: (args) => handleSetMcpEnabled(args, true),
    },
    {
      method: "POST",
      path: "/api/mcp/servers/:server/disable",
      status: IMPLEMENTED,
      description: "persists enabled=false on a stored definition",
      handler: (args) => handleSetMcpEnabled(args, false),
    },
    {
      method: "POST",
      path: "/api/mcp/servers/:server/mode",
      status: IMPLEMENTED,
      description: "persists tools/cli mode on a stored definition",
      handler: handleSetMcpMode,
    },
    {
      method: "POST",
      path: "/api/mcp/servers/:server/health",
      status: IMPLEMENTED,
      description: "real reachability probe (PATH lookup, TCP/TLS connect, unix socket); result is persisted",
      handler: handleMcpHealth,
    },

    // --- Sentinel ---------------------------------------------------------
    {
      method: "GET",
      path: "/api/colony/:colony/notifications",
      status: IMPLEMENTED,
      description: "Per-colony Sentinel config from notifications.json/metadata",
      handler: handleGetNotifications,
    },
    {
      method: "PUT",
      path: "/api/colony/:colony/notifications",
      status: IMPLEMENTED,
      description: "Save Sentinel config; enabling also updates metadata.sentinel_enabled",
      handler: handlePutNotifications,
    },
    {
      method: "POST",
      path: "/api/colony/:colony/notifications/test",
      status: IMPLEMENTED,
      description: "Send a test into the local inbox; Telegram/Slack return an explicit 400",
      handler: handleTestNotification,
    },
    {
      method: "GET",
      path: "/api/sentinel/credentials",
      status: IMPLEMENTED,
      description: "Channel token presence from env (values are never exposed)",
      handler: handleSentinelCredentials,
    },
    {
      method: "POST",
      path: "/api/sentinel/telegram/validate",
      status: IMPLEMENTED,
      description: "validates a bot token against Telegram getMe; a refused token answers ok:false",
      handler: handleTelegramValidate,
    },
    {
      method: "POST",
      path: "/api/sentinel/telegram/detect-chat",
      status: IMPLEMENTED,
      description: "Telegram listener is not implemented; explicit 400 unless ctx provides a detector",
      handler: handleTelegramDetectChat,
    },
    {
      method: "POST",
      path: "/api/sentinel/slack/validate",
      status: IMPLEMENTED,
      description: "validates a bot token against Slack auth.test",
      handler: handleSlackValidate,
    },

    // --- System -----------------------------------------------------------
    {
      method: "GET",
      path: "/api/runtime-logs",
      status: IMPLEMENTED,
      description: "Boot id + seq-cursored server log entries from memory or PI_HIVE_LOG_FILE",
      handler: handleRuntimeLogs,
    },
    {
      method: "GET",
      path: "/api/browser/status",
      status: IMPLEMENTED,
      description: "Honest offline bridge status; ctx.browserStatus can supply a live bridge",
      handler: handleBrowserStatus,
    },

    // --- Tasks ------------------------------------------------------------
    {
      method: "GET",
      path: "/api/sessions/:session/tasks",
      status: IMPLEMENTED,
      description: "TaskListSnapshot from the colony plan.json; 404 when no plan exists",
      handler: handleGetTasks,
    },
    {
      method: "POST",
      path: "/api/sessions/:session/tasks/unarchive",
      status: IMPLEMENTED,
      description: "Restore archived plan tasks to their pre-archive status",
      handler: handleUnarchiveTasks,
    },
    {
      method: "POST",
      path: "/api/sessions/:session/tasks/clear-completed",
      status: IMPLEMENTED,
      description: "Archive completed plan tasks non-destructively",
      handler: handleClearCompletedTasks,
    },

    // --- Workers ----------------------------------------------------------
    {
      method: "GET",
      path: "/api/sessions/:session/workers",
      status: IMPLEMENTED,
      description: "Live WorkerManager rows + on-disk run files (superset of both client shapes)",
      handler: handleListWorkers,
    },
    {
      method: "GET",
      path: "/api/sessions/:session/workers/:worker",
      status: IMPLEMENTED,
      description: "Worker detail from live state or its run file",
      handler: handleGetWorker,
    },
    {
      method: "GET",
      path: "/api/sessions/:session/workers/:worker/conversation",
      status: IMPLEMENTED,
      description: "Worker transcript from the live agent or persisted conversation parts",
      handler: handleWorkerConversation,
    },
    {
      method: "GET",
      path: "/api/sessions/:session/colony/skills",
      status: IMPLEMENTED,
      description: "Colony skills catalog from the skills/ directory",
      handler: handleColonySkills,
    },
    {
      method: "GET",
      path: "/api/sessions/:session/colony/tools",
      status: IMPLEMENTED,
      description: "Real pi_hive tool catalog for the colony",
      handler: handleColonyTools,
    },
    {
      method: "POST",
      path: "/api/sessions/:session/workers/:worker/stop",
      status: IMPLEMENTED,
      description: "Abort one live worker through WorkerManager.stop()",
      handler: handleStopWorker,
    },
    {
      method: "POST",
      path: "/api/sessions/:session/workers/stop-all",
      status: IMPLEMENTED,
      description: "Abort every queued/active worker through WorkerManager.stopAll()",
      handler: handleStopAllWorkers,
    },
  ];

  for (const route of routes) {
    registry.register(route.method, route.path, withContext(route.handler, ctx), {
      status: route.status,
      official: true,
      description: route.description,
      ...(route.notes ? { notes: route.notes } : {}),
    });
  }

  return registry;
}

export default registerAutonomyRoutes;
