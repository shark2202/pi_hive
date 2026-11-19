/**
 * Official queen, soul, and Claude Code queen handlers.
 *
 * The official frontend (core/frontend/src/api/queens.ts and
 * claudeCodeQueens.ts) expects 28 routes. pi_hive has a deliberately smaller
 * reality:
 *
 *   - four built-in queen role identities (queen_growth, queen_tech,
 *     queen_finance, queen_ops) whose ids are the `queen_id` values stored in
 *     colony metadata; there is no profile.yaml catalog,
 *   - one process-wide model from the environment, not a per-queen model,
 *   - durable memory in `$PI_HIVE_HOME/memory` and per-colony session files,
 *   - a Soul stored per colony (`<colony>/soul.json`), not per queen,
 *   - no avatar store, no queen DM session store, no Claude Code integration.
 *
 * Handlers therefore serve real pi_hive state where it exists and answer the
 * remaining operations with an explicit 4xx (`type: "unsupported"`) or a valid
 * empty collection. Nothing here fabricates success, calls a model, or invents
 * queens outside the four built-ins.
 *
 * A queen's soul is mapped to one colony: the most recently updated colony
 * that uses her queen_id and has the soul enabled, else her most recently
 * updated colony. The official `queen_id` is kept in the response and the
 * mapped `colony_id` is included so the source is visible.
 *
 * Every handler returns `{ status, body }` and never writes to `res`.
 */

import fs from "node:fs";
import path from "node:path";

import { colonyDir, coloniesDir, hiveHome, modelConfig } from "../../config.js";
import {
  applyProposal,
  listProposals,
  loadSoul,
  proposalsPath,
  saveSoul,
} from "../../domain/soul.js";
import { memoryTools } from "../../runtime/memory-tools.js";
import { planTools, skillTools, soulTools, trackerTools } from "../../runtime/tools.js";
import { ROUTE_STATUS } from "../router.js";
import { BUILT_IN_QUEENS } from "./organization.js";
import {
  deleteAvatar as deleteAvatarFile,
  hasAvatar,
  isRemoved,
  listQueenIds,
  MAX_AVATAR_BYTES,
  patchProfile,
  isSafeQueenId,
  queenExistsOnDisk,
  readAvatar,
  readDmSession,
  readLlm,
  readPersona,
  readProfile,
  readTools,
  saveAvatar,
  setRemoved,
  writeDmSession,
  writeLlm,
  writePersona,
  writeTools,
} from "../../domain/queen-state.js";
import { SessionStore } from "../sessions.js";
import { parseMultipart } from "./sessions.js";

const IMPLEMENTED = Object.freeze({ status: ROUTE_STATUS.IMPLEMENTED, official: true });
const PARTIAL = Object.freeze({ status: ROUTE_STATUS.PARTIAL, official: true });

/** All queen ids pi_hive knows. Kept in sync with `/api/queen/profiles`. */
export const QUEEN_IDS = Object.freeze(BUILT_IN_QUEENS.map((queen) => queen.id));

const QUEEN_BY_ID = new Map(BUILT_IN_QUEENS.map((queen) => [queen.id, queen]));

/**
 * Personas derived from the system prompt pi_hive actually uses in
 * src/runtime/queen.js. They are role identities, not editable profile files;
 * the summary/details are the behavior the runtime already encodes.
 */
export const QUEEN_PERSONAS = Object.freeze({
  queen_growth: Object.freeze({
    summary:
      "You are the Growth Queen: acquisition, experiments, and market insight. You are direct, evidence-driven, and allergic to vague growth advice.",
    skills: "Growth experiments, acquisition, market insight",
    details: [
      "Runs acquisition and growth experiments",
      "Demands evidence before scaling a channel",
      "Turns validated findings into repeatable playbooks",
    ],
  }),
  queen_tech: Object.freeze({
    summary:
      "You are the Technology Queen: engineering, architecture, and delivery. You are precise, skeptical of hand-waving, and prefer verifiable results.",
    skills: "Engineering delivery, architecture, code review",
    details: [
      "Owns architecture and delivery of the colony's technical work",
      "Prefers verifiable results over estimates",
      "Reviews implementation before it is called done",
    ],
  }),
  queen_finance: Object.freeze({
    summary:
      "You are the Finance Queen: models, budgets, and fundraising. You are conservative with assumptions and explicit about risk.",
    skills: "Financial models, budgeting, fundraising",
    details: [
      "Builds and checks financial models",
      "States assumptions and risk explicitly",
      "Guards budget and runway decisions",
    ],
  }),
  queen_ops: Object.freeze({
    summary:
      "You are the Operations Queen: process, back-office, and execution discipline. You make work repeatable.",
    skills: "Process design, back-office execution, repeatability",
    details: [
      "Turns ad-hoc work into repeatable processes",
      "Owns back-office and execution discipline",
      "Looks for the operational failure before it happens",
    ],
  }),
});

/** Section limits are pi_hive's own; the official config has different keys. */
const SOUL_SECTIONS = Object.freeze([
  Object.freeze({ key: "identity.mission", title: "Mission", limit: 300 }),
  Object.freeze({ key: "identity.voice", title: "Voice", limit: 800 }),
  Object.freeze({ key: "identity.principles", title: "Principles", limit: 800 }),
  Object.freeze({ key: "probes", title: "Probes", limit: 600 }),
]);

const SOUL_SECTION_KEYS = new Set(SOUL_SECTIONS.map((section) => section.key));

/** Maximum accepted JSON request body. Bodies are small config edits. */
const MAX_BODY_BYTES = 1_000_000;

const SOUL_VERSIONS_FILE = "soul_versions.json";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isoNow() {
  return new Date().toISOString();
}

function dayOf(value) {
  if (typeof value !== "string" || !value) return "";
  return value.slice(0, 10);
}

function isIsoDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function fail(status, error, extra = {}) {
  return { status, body: { error, ...extra } };
}

function unsupported(queenId, error, extra = {}) {
  return fail(400, error, { type: "unsupported", queen_id: queenId, ...extra });
}

function notFoundQueen(queenId) {
  return fail(404, `Queen '${queenId}' not found`, { type: "not_found", queen_id: queenId });
}

function conflict(error, extra = {}) {
  return fail(409, error, { type: "conflict", ...extra });
}

function invalid(error, extra = {}) {
  return fail(400, error, { type: "invalid_request", ...extra });
}

/**
 * Read a JSON object body from a Node request or from a test double.
 * `req.body` is supported so handlers can be exercised without a socket; a
 * real IncomingMessage is consumed as an async iterable. Non-object JSON is
 * rejected because every queen route expects an object.
 */
export async function readJsonBody(req) {
  if (!req || typeof req !== "object") return { ok: true, body: {} };

  if (req.body !== undefined) {
    if (req.body === null || req.body === "") return { ok: true, body: {} };
    if (typeof req.body === "string") {
      try {
        const parsed = JSON.parse(req.body);
        return isPlainObject(parsed) ? { ok: true, body: parsed } : { ok: false };
      } catch {
        return { ok: false };
      }
    }
    return isPlainObject(req.body) ? { ok: true, body: req.body } : { ok: false };
  }

  if (typeof req[Symbol.asyncIterator] !== "function") return { ok: true, body: {} };

  let raw = "";
  let size = 0;
  try {
    for await (const chunk of req) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      size += text.length;
      if (size > MAX_BODY_BYTES) return { ok: false };
      raw += text;
    }
  } catch {
    return { ok: false };
  }

  if (!raw.trim()) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? { ok: true, body: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Colony / queen data
// ---------------------------------------------------------------------------

/**
 * Same shape src/config.js `colonyDir` accepts. Directories that do not match
 * are skipped before any path helper (which throws) is called on them.
 */
const COLONY_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Every non-deleted colony with parseable metadata, read tolerantly: a broken
 * metadata.json or stray file must not take the whole queen surface down.
 */
function listColonyRecords() {
  const root = coloniesDir();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !COLONY_NAME_RE.test(entry.name)) continue;
    const metadataPath = path.join(root, entry.name, "metadata.json");
    try {
      if (!fs.existsSync(metadataPath)) continue;
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (!isPlainObject(metadata) || metadata.deleted === true) continue;
      records.push({ name: entry.name, metadata });
    } catch {
      // Unreadable colony: skip it rather than break every queen route.
    }
  }
  return records;
}

function colonyQueenId(metadata) {
  if (typeof metadata.queen_id === "string" && metadata.queen_id) return metadata.queen_id;
  if (typeof metadata.queen_name === "string" && metadata.queen_name) return metadata.queen_name;
  return null;
}

function timestampOf(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isNaN(ms) ? 0 : ms;
}

/** Colonies for one queen, most recently updated first. */
function queenColonies(queenId) {
  return listColonyRecords()
    .filter((record) => colonyQueenId(record.metadata) === queenId)
    .sort(
      (a, b) =>
        timestampOf(b.metadata.updated_at) - timestampOf(a.metadata.updated_at) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * The colony whose soul represents this queen. Prefer a colony with the soul
 * enabled so `enabled: false` means "none of her colonies has a soul", not
 * "the first one happened to be off".
 */
function primaryQueenColony(queenId) {
  const colonies = queenColonies(queenId);
  for (const colony of colonies) {
    if (loadSoul(colony.name).mode !== "off") return colony;
  }
  return colonies[0] || null;
}

function queenFromParams(params) {
  const queenId = typeof params?.queen === "string" ? params.queen : "";
  return QUEEN_BY_ID.get(queenId) || null;
}

/** Catalog row for one queen: built-in identity overlaid with stored state. */
function catalogEntry(queenId) {
  const builtIn = QUEEN_BY_ID.get(queenId);
  const stored = readProfile(queenId);
  return {
    id: queenId,
    name: stored?.name ?? builtIn?.name ?? queenId,
    title: stored?.title ?? builtIn?.title ?? "",
    has_avatar: hasAvatar(queenId),
    custom: !builtIn,
  };
}

/** Every queen pi_hive can serve: the built-ins plus custom rows, minus removed. */
export function queenCatalog() {
  const rows = [];
  for (const builtIn of BUILT_IN_QUEENS) {
    if (isRemoved(builtIn.id)) continue;
    rows.push(catalogEntry(builtIn.id));
  }
  for (const id of listQueenIds()) {
    if (QUEEN_BY_ID.has(id) || isRemoved(id)) continue;
    rows.push(catalogEntry(id));
  }
  return rows;
}

/** Removed queens, so the UI's restore list reflects the removal markers. */
export function removedQueenCatalog() {
  const ids = new Set([...BUILT_IN_QUEENS.map((queen) => queen.id), ...listQueenIds()]);
  return [...ids].filter((id) => isRemoved(id)).map((id) => catalogEntry(id));
}

/** Turn a display name into a safe queen id. */
function queenIdFromName(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  const candidate = slug ? `queen_${slug}` : `queen_${Date.now()}`;
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate) ? candidate : null;
}

/** Resolve the queen or return a 404 descriptor. Removed queens are unknown. */
function resolveQueen(params) {
  const queenId = typeof params?.queen === "string" ? params.queen : "";
  const known = QUEEN_BY_ID.has(queenId) || queenExistsOnDisk(queenId);
  const queen = known && !isRemoved(queenId) ? catalogEntry(queenId) : null;
  return { queenId, queen, error: queen ? null : notFoundQueen(queenId) };
}

/**
 * Resolve a queen that may be removed. Restore and removal bookkeeping need
 * her id even while she is hidden from the catalog.
 */
function resolveKnownQueen(params) {
  const queenId = typeof params?.queen === "string" ? params.queen : "";
  const known = QUEEN_BY_ID.has(queenId) || queenExistsOnDisk(queenId);
  return {
    queenId,
    error: known ? null : notFoundQueen(queenId),
  };
}

/**
 * Resolve the queen plus the colony that holds her soul. Returns
 * `{ queenId, queen, colony, error }`; `colony` is null when she has none.
 */
function resolveQueenSoul(params) {
  const resolved = resolveQueen(params);
  if (resolved.error) return { ...resolved, colony: null };
  const colony = primaryQueenColony(resolved.queenId);
  if (!colony) {
    return {
      ...resolved,
      colony: null,
      error: conflict(
        `Queen '${resolved.queenId}' has no colony: pi_hive stores the soul per colony, so there is no soul to read or edit yet`,
        { queen_id: resolved.queenId },
      ),
    };
  }
  return { ...resolved, colony };
}

// ---------------------------------------------------------------------------
// Profile / persona / llm / overview
// ---------------------------------------------------------------------------

function personaOf(queenId) {
  return QUEEN_PERSONAS[queenId] || {
    summary: "",
    skills: "",
    details: [],
  };
}

function colonyNamesFor(queenId) {
  return queenColonies(queenId).map((colony) => colony.name);
}

export function buildQueenProfile(queenId) {
  const queen = QUEEN_BY_ID.get(queenId);
  const stored = readProfile(queenId);
  if (!queen && !stored) return null;
  const persona = personaOf(queenId);
  const colonies = colonyNamesFor(queenId);
  const avatar = readAvatar(queenId);
  const profile = {
    id: queenId,
    name: stored?.name ?? queen?.name ?? queenId,
    title: stored?.title ?? queen?.title ?? "",
    summary: stored?.summary ?? persona.summary,
    experience:
      stored?.experience ??
      (persona.details.length ? [{ role: queen?.title ?? "", details: [...persona.details] }] : []),
    skills: stored?.skills ?? persona.skills,
    portrait: avatar ? `/api/queen/${queenId}/avatar` : (stored?.portrait ?? null),
    has_avatar: Boolean(avatar),
    custom: !queen,
  };
  if (stored?.signature_achievement !== undefined) {
    profile.signature_achievement = stored.signature_achievement;
  } else if (colonies.length) {
    profile.signature_achievement = `Leads ${colonies.length} pi_hive colon${
      colonies.length === 1 ? "y" : "ies"
    }: ${colonies.join(", ")}.`;
  }
  return profile;
}

function buildQueenPersona(queenId) {
  const queen = QUEEN_BY_ID.get(queenId);
  const persona = personaOf(queenId);
  const stored = readPersona(queenId);
  if (stored) return { queen_id: queenId, persona: structuredClone(stored) };
  const storedProfile = readProfile(queenId);
  return {
    queen_id: queenId,
    persona: {
      name: storedProfile?.name ?? queen?.name ?? queenId,
      title: storedProfile?.title ?? queen?.title ?? "",
      core_traits: persona.summary,
      skills: persona.skills,
    },
  };
}

/** Per-queen LLM section; when unset the queen follows the process model. */
function buildQueenLlm(queenId) {
  return {
    queen_id: queenId,
    section: readLlm(queenId),
    default_model: modelConfig().modelId,
  };
}

/**
 * Sessions bound to this queen, newest first. Used by the tool allowlist and
 * LLM routes, which report how many durable sessions they re-bound.
 */
function queenSessionRecords(store, queenId) {
  return store
    .list({ includeStopped: true })
    .filter((record) => record.queen_id === queenId);
}

const sessionStoresByHome = new Map();

function sessionStoreFor(ctx = {}) {
  const home = ctx.hiveHome || process.env.PI_HIVE_HOME || hiveHome();
  let store = sessionStoresByHome.get(home);
  if (!store) {
    store = new SessionStore({ home });
    sessionStoresByHome.set(home, store);
  }
  return store;
}
function countMemoryFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function queenSessionFiles(queenId) {
  const files = [];
  for (const colony of queenColonies(queenId)) {
    const file = path.join(colonyDir(colony.name), "sessions", `queen_${queenId}.json`);
    try {
      if (fs.existsSync(file)) files.push(file);
    } catch {
      // Invalid colony name cannot happen here (readdir names); stay tolerant.
    }
  }
  return files;
}

export function buildQueenOverview(queenId) {
  const globalCount = countMemoryFiles(path.join(hiveHome(), "memory", "global"));
  const queenCount = countMemoryFiles(path.join(hiveHome(), "memory", "queens", queenId));
  let colonyCount = 0;
  for (const colony of queenColonies(queenId)) {
    colonyCount += countMemoryFiles(path.join(colonyDir(colony.name), "memory"));
  }
  const memoryCount = globalCount + queenCount + colonyCount;

  const sessionStats = [];
  for (const file of queenSessionFiles(queenId)) {
    try {
      const stat = fs.statSync(file);
      const born = stat.birthtime && stat.birthtime.getTime() ? stat.birthtime : stat.mtime;
      sessionStats.push({ born, active: stat.mtime });
    } catch {
      // A file that vanished between list and stat is not a session.
    }
  }

  const first = sessionStats.length
    ? sessionStats.map((entry) => entry.born.getTime()).sort((a, b) => a - b)[0]
    : null;
  const last = sessionStats.length
    ? sessionStats.map((entry) => entry.active.getTime()).sort((a, b) => b - a)[0]
    : null;

  return {
    queen_id: queenId,
    memory: {
      count: memoryCount,
      // pi_hive enforces no file cap; 0 means "no limit" rather than a guess.
      limit: 0,
      by_type: memoryCount ? { note: memoryCount } : {},
      // Extra, factual breakdown: pi_hive memory is scoped, not typed.
      by_scope: { global: globalCount, queen: queenCount, colony: colonyCount },
    },
    sessions: {
      count: sessionStats.length,
      first: first === null ? null : new Date(first).toISOString().slice(0, 10),
      last_active: last === null ? null : new Date(last).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Tool metadata from the real factories. Factories only build closures; their
 * `execute` functions are never called while building a catalog, so passing
 * inert arguments here is safe. File/orchestration tools are declared because
 * `fsTools` needs a colony workspace and the queen-only tools live inline in
 * QueenRuntime.tools().
 */
const EXTRA_QUEEN_TOOLS = Object.freeze([
  Object.freeze({
    name: "file_read",
    description: "Read a UTF-8 text file under the colony workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }),
  Object.freeze({
    name: "file_write",
    description: "Write a UTF-8 text file under the colony workspace. Creates parent directories.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  }),
  Object.freeze({
    name: "file_edit",
    description: "Replace one exact string in a text file. Fails if the old string is not unique.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
      required: ["path", "old", "new"],
    },
  }),
  Object.freeze({
    name: "file_search",
    description: "Search text files under the colony workspace for a fixed string.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  }),
  Object.freeze({
    name: "terminal_exec",
    description: "Run a shell command with cwd under the colony workspace.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  }),
  Object.freeze({
    name: "spawn_worker",
    description: "Spawn one ephemeral worker for a well-scoped task; the report arrives later.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        data: { type: "object" },
        profile: { type: "string" },
        goal: { type: "string" },
      },
      required: ["task"],
    },
  }),
  Object.freeze({
    name: "run_playbook",
    description: "Run a saved JavaScript playbook over the tracker, or an inline playbook script.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, script: { type: "string" }, args: { type: "object" } },
    },
  }),
  Object.freeze({
    name: "set_trigger",
    description: "Create or replace a timer trigger for this colony (interval or cron).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string", enum: ["interval", "cron"] },
        interval_minutes: { type: "number" },
        cron: { type: "string" },
        prompt: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["name", "type"],
    },
  }),
  Object.freeze({
    name: "list_queens",
    description: "List the other Queens you can write to (empty when Queen Mail is not configured).",
    parameters: { type: "object", properties: {} },
  }),
  Object.freeze({
    name: "message_queen",
    description: "Send a letter to another Queen. The reply arrives later as a [LETTER] turn.",
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, text: { type: "string" } },
      required: ["to", "text"],
    },
  }),
]);

/** Tool categories exposed to the official tools editor. */
const TOOL_CATEGORIES = Object.freeze([
  Object.freeze({ name: "tracker", tools: ["tracker_query", "tracker_upsert", "tracker_sql"] }),
  Object.freeze({ name: "plan", tools: ["task_create", "task_update", "task_list"] }),
  Object.freeze({ name: "skills", tools: ["list_skills", "write_skill"] }),
  Object.freeze({ name: "memory", tools: ["memory_read", "memory_search", "memory_write"] }),
  Object.freeze({
    name: "file_ops",
    tools: ["file_read", "file_write", "file_edit", "file_search", "terminal_exec"],
  }),
  Object.freeze({ name: "soul", tools: ["soul_read", "soul_review", "soul_apply"] }),
  Object.freeze({ name: "orchestration", tools: ["spawn_worker", "run_playbook", "set_trigger"] }),
  Object.freeze({ name: "queen_mail", tools: ["list_queens", "message_queen"] }),
]);

function toolMeta(tool) {
  return {
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.parameters || { type: "object", properties: {} },
    // pi_hive's tool surface is fixed in code; nothing is editable per queen.
    editable: false,
    // No tool depends on an OAuth provider, so it is callable now.
    provider: null,
    provider_connected: true,
  };
}

function buildLifecycleTools() {
  const tools = [
    ...trackerTools({}),
    ...planTools(""),
    ...skillTools(""),
    ...memoryTools({ colony: "", queenId: "queen_growth" }),
    ...soulTools({ engine: () => null }),
  ];
  return [...tools, ...EXTRA_QUEEN_TOOLS].map(toolMeta);
}

export function buildQueenTools(queenId) {
  const lifecycle = buildLifecycleTools();
  const byName = new Map(lifecycle.map((tool) => [tool.name, tool]));
  const allowlist = readTools(queenId);
  const enabled = allowlist === null ? null : new Set(allowlist);
  return {
    queen_id: queenId,
    // null is the role default; a list is an explicit per-queen allowlist.
    enabled_mcp_tools: allowlist,
    is_role_default: allowlist === null,
    stale: false,
    lifecycle,
    synthetic: [],
    mcp_servers: [],
    categories: TOOL_CATEGORIES.map((category) => ({
      name: category.name,
      tools: category.tools.filter((name) => byName.has(name)),
      in_role_default: enabled === null || category.tools.some((name) => enabled.has(name)),
      // QueenRuntime hands every tool to the agent; nothing is search-on-demand.
      always_enabled: true,
    })),
    connected_providers: [],
  };
}

// ---------------------------------------------------------------------------
// Soul
// ---------------------------------------------------------------------------

function soulVersionsPath(colonyName) {
  return path.join(colonyDir(colonyName), SOUL_VERSIONS_FILE);
}

function readVersionLog(colonyName) {
  try {
    const data = JSON.parse(fs.readFileSync(soulVersionsPath(colonyName), "utf8"));
    return isPlainObject(data) && Array.isArray(data.versions) ? data.versions : [];
  } catch {
    return [];
  }
}

function writeVersionLog(colonyName, versions) {
  const file = soulVersionsPath(colonyName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ versions }, null, 2));
  return versions;
}

/** Record a soul version once; later saves of the same version are no-ops. */
function snapshotVersion(colonyName, soul, { author = "system", note = "", changes = 0 } = {}) {
  if (!isPlainObject(soul)) return null;
  const version = Number(soul.version) || 1;
  const log = readVersionLog(colonyName);
  if (log.some((entry) => entry.version === version)) return null;
  const entry = {
    version,
    at: typeof soul.updated_at === "string" && soul.updated_at ? soul.updated_at : isoNow(),
    author,
    note,
    changes,
    soul: structuredClone(soul),
  };
  log.push(entry);
  log.sort((a, b) => a.version - b.version);
  writeVersionLog(colonyName, log);
  return entry;
}

function bumpSoulVersion(colonyName, soul, { author, note, changes }) {
  // The caller snapshots the pre-mutation state; this records the new version.
  const next = { ...soul, version: (Number(soul.version) || 1) + 1 };
  const saved = saveSoul(colonyName, next);
  snapshotVersion(colonyName, saved, { author, note, changes });
  return saved;
}

function soulDateFor(soul, section, text) {
  const history = Array.isArray(soul.history) ? soul.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!isPlainObject(entry)) continue;
    if (entry.change !== text) continue;
    if (entry.section && entry.section !== section) continue;
    const day = dayOf(entry.at);
    if (day) return day;
  }
  return dayOf(soul.updated_at) || dayOf(isoNow());
}

function stringItems(values, soul, section) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const items = [];
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push({ text, date: soulDateFor(soul, section, text) });
  }
  return items;
}

export function soulSectionItems(soul, sectionKey) {
  const identity = isPlainObject(soul.identity) ? soul.identity : {};
  if (sectionKey === "identity.mission") {
    const text = typeof identity.mission === "string" ? identity.mission.trim() : "";
    return text ? [{ text, date: soulDateFor(soul, sectionKey, text) }] : [];
  }
  if (sectionKey === "identity.voice") return stringItems(identity.voice, soul, sectionKey);
  if (sectionKey === "identity.principles") {
    return stringItems(identity.principles, soul, sectionKey);
  }
  if (sectionKey === "probes") {
    const probes = Array.isArray(soul.probes) ? soul.probes : [];
    const items = [];
    for (const probe of probes) {
      const text = typeof probe === "string" ? probe : probe?.text;
      if (typeof text !== "string" || !text.trim()) continue;
      const date =
        dayOf(typeof probe === "object" ? probe.added_at : "") ||
        soulDateFor(soul, sectionKey, text.trim());
      items.push({ text: text.trim(), date });
    }
    return items;
  }
  return [];
}

function soulProposalView(record, soul) {
  const change = String(record.change || "");
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.slice(0, 5).map((quote) => ({
        quote: String(quote),
        where: "soul_proposals.jsonl",
      }))
    : [];
  return {
    id: String(record.id || ""),
    created_at: typeof record.at === "string" ? record.at : "",
    base_version: Number(record.base_version) || Number(soul.version) || 1,
    edits: [
      {
        op: "add",
        section: String(record.section || ""),
        text: change,
        old: "",
        date: dayOf(record.at) || dayOf(soul.updated_at),
        evidence,
        reason: "pi_hive soul review proposal",
        expired: false,
      },
    ],
    summary: `${record.section || "soul"}: ${change}`.slice(0, 240),
    status: record.status === "applied" || record.status === "dismissed" ? record.status : "pending",
    // pi_hive proposal records keep evidence but no transcript/session refs.
    sources: [],
    bootstrap: false,
    probes: [],
  };
}

function soulHistoryView(colonyName, soul) {
  const log = readVersionLog(colonyName);
  if (log.length) {
    return log
      .slice()
      .sort((a, b) => b.version - a.version)
      .slice(0, 50)
      .map((entry) => ({
        version: Number(entry.version) || 1,
        at: typeof entry.at === "string" ? entry.at : "",
        author: typeof entry.author === "string" && entry.author ? entry.author : "pi_hive",
        note: typeof entry.note === "string" ? entry.note : "",
        changes: Number(entry.changes) || 0,
      }));
  }
  // Legacy change log entries predate compat snapshots; 0 marks unversioned.
  const history = Array.isArray(soul.history) ? soul.history : [];
  return history
    .slice(-50)
    .reverse()
    .map((entry) => ({
      version: 0,
      at: dayOf(entry?.at),
      author: typeof entry?.author === "string" && entry.author ? entry.author : "pi_hive",
      note: entry?.section ? `${entry.section}: ${entry.change || ""}` : "soul change",
      changes: 1,
    }));
}

export function buildQueenSoulView(queenId, colonyName, soul) {
  const sections = SOUL_SECTIONS.map((section) => {
    const items = soulSectionItems(soul, section.key);
    return {
      key: section.key,
      title: section.title,
      limit: section.limit,
      used: items.reduce((total, item) => total + item.text.length, 0),
      max_age_days: null,
      // pi_hive proposals carry at least one evidence string.
      evidence: 1,
      items,
    };
  });

  const proposals = listProposals(colonyName);
  const pending = proposals.find((proposal) => proposal.status === "pending") || null;

  return {
    queen_id: queenId,
    enabled: true,
    mode: soul.mode === "auto" ? "auto" : "review",
    // pi_hive has no scheduled daily reflection; 0 means "not scheduled".
    hour: 0,
    version: Number(soul.version) || 1,
    updated_at: typeof soul.updated_at === "string" ? soul.updated_at : null,
    sections,
    proposal: pending ? soulProposalView(pending, soul) : null,
    history: soulHistoryView(colonyName, soul),
    reflecting: false,
    probes: Array.isArray(soul.probes) ? soul.probes.length : 0,
    probing: false,
    last_run: null,
    last_result: null,
    // The colony whose soul.json backs this view.
    colony_id: colonyName,
  };
}

function validateSoulSections(raw) {
  if (!isPlainObject(raw)) {
    return { error: "Body must be {'sections': {key: [{'text', 'date'}]}}" };
  }

  const unknown = Object.keys(raw).filter((key) => !SOUL_SECTION_KEYS.has(key));
  if (unknown.length) {
    return { error: `Unknown sections: ${unknown.sort().join(", ")}` };
  }

  const out = {};
  for (const key of Object.keys(raw)) {
    const items = raw[key];
    if (!Array.isArray(items)) return { error: `Section ${key} must be a list` };
    const clean = [];
    for (const item of items) {
      const text = typeof item === "string" ? item : isPlainObject(item) ? item.text : "";
      const trimmed = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
      if (!trimmed) continue;
      const day = isPlainObject(item) ? String(item.date || "") : "";
      if (day && !isIsoDay(day)) {
        return { error: `Bad date ${JSON.stringify(day)}: use YYYY-MM-DD` };
      }
      clean.push({ text: trimmed, date: day });
    }
    if (key === "identity.mission" && clean.length > 1) {
      return { error: "identity.mission holds at most one item" };
    }
    const limit = SOUL_SECTIONS.find((section) => section.key === key).limit;
    const used = clean.reduce((total, item) => total + item.text.length, 0);
    if (used > limit) {
      return { error: `Section ${key} is over its ${limit}-character limit` };
    }
    out[key] = clean;
  }
  return { sections: out };
}

function nextSoulFromSections(current, sections) {
  const identity = isPlainObject(current.identity) ? current.identity : {};
  const missionItems = sections["identity.mission"] || [];
  const nextIdentity = {
    ...identity,
    mission: missionItems.length ? missionItems[0].text : "",
    voice: (sections["identity.voice"] || []).map((item) => item.text),
    principles: (sections["identity.principles"] || []).map((item) => item.text),
  };

  const existingProbes = new Map();
  for (const probe of Array.isArray(current.probes) ? current.probes : []) {
    if (isPlainObject(probe) && typeof probe.text === "string") {
      existingProbes.set(probe.text, probe.added_at);
    }
  }
  const probeItems = sections.probes || [];
  const probes = probeItems.map((item) => ({
    text: item.text,
    added_at:
      existingProbes.get(item.text) ||
      (item.date ? `${item.date}T00:00:00.000Z` : isoNow()),
  }));

  // pi_hive stores soul items as plain strings. When the caller supplies an
  // item date, keep it in the existing change log so the next read can show
  // the real date instead of today's.
  const dated = [];
  for (const key of ["identity.mission", "identity.voice", "identity.principles"]) {
    for (const item of sections[key] || []) {
      if (!item.date) continue;
      dated.push({
        at: `${item.date}T00:00:00.000Z`,
        author: "owner",
        note: "item date",
        section: key,
        change: item.text,
        evidence: [],
      });
    }
  }

  return { soul: { ...current, identity: nextIdentity, probes }, dated };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const getRemoved = async () => ({ status: 200, body: { queens: removedQueenCatalog() } });

const createQueen = async ({ req }) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const body = parsed.body;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return invalid("name is required");
  const requested = typeof body.queen_id === "string" ? body.queen_id.trim() : "";
  const queenId = requested || queenIdFromName(name);
  if (!queenId || !isSafeQueenId(queenId)) {
    return invalid("queen_id must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  if (QUEEN_BY_ID.has(queenId)) {
    return fail(409, `Queen '${queenId}' is a built-in role and cannot be re-created`, {
      type: "conflict",
      queen_id: queenId,
    });
  }
  if (isRemoved(queenId)) {
    return fail(409, `Queen '${queenId}' is removed; restore her first`, {
      type: "conflict",
      queen_id: queenId,
    });
  }
  const title = typeof body.title === "string" ? body.title : "";
  patchProfile(queenId, { name, title, created_at: isoNow() });
  if (isPlainObject(body.persona)) writePersona(queenId, structuredClone(body.persona));
  return { status: 200, body: { queen: catalogEntry(queenId) } };
};

const removeQueen = async ({ params }) => {
  const resolved = resolveKnownQueen(params);
  if (resolved.error) return resolved.error;
  setRemoved(resolved.queenId, true);
  return { status: 200, body: { queen_id: resolved.queenId, removed: true } };
};

const restoreQueen = async ({ params }) => {
  const resolved = resolveKnownQueen(params);
  if (resolved.error) return resolved.error;
  if (!isRemoved(resolved.queenId)) {
    return fail(400, `Queen '${resolved.queenId}' cannot be restored: she was never removed`, {
      type: "invalid_request",
      queen_id: resolved.queenId,
    });
  }
  setRemoved(resolved.queenId, false);
  return { status: 200, body: { queen_id: resolved.queenId, removed: false } };
};


const getProfile = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenProfile(queenId) };
};

const updateProfile = async ({ params, req }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const body = parsed.body;
  const patch = {};
  for (const key of ["name", "title", "summary", "portrait", "signature_achievement"]) {
    if (typeof body[key] === "string") patch[key] = body[key];
  }
  if (Array.isArray(body.experience)) patch.experience = structuredClone(body.experience);
  if (Array.isArray(body.skills)) patch.skills = structuredClone(body.skills);
  if (!Object.keys(patch).length) {
    return invalid("No profile fields to update", {
      fields: ["name", "title", "summary", "experience", "skills", "portrait", "signature_achievement"],
    });
  }
  patchProfile(resolved.queenId, patch);
  return { status: 200, body: buildQueenProfile(resolved.queenId) };
};

const getLlm = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenLlm(queenId) };
};

const putLlm = async ({ params, req, ctx }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const body = parsed.body;
  if (!("section" in body)) return invalid("section is required");
  const section = body.section === null ? null : structuredClone(body.section);
  if (section !== null && !isPlainObject(section)) {
    return invalid("section must be an object or null");
  }
  writeLlm(resolved.queenId, section);
  // Sessions bound to this queen switch to the new model, or back to the
  // process-wide default when the section is cleared.
  const model = section?.model ?? modelConfig().modelId;
  const store = sessionStoreFor(ctx);
  const records = queenSessionRecords(store, resolved.queenId);
  let switched = 0;
  for (const record of records) {
    if (store.update(record.session_id, { model })) switched += 1;
  }
  return {
    status: 200,
    body: {
      queen_id: resolved.queenId,
      section,
      default_model: modelConfig().modelId,
      sessions_switched: switched,
    },
  };
};

const getPersona = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenPersona(queenId) };
};

const putPersona = async ({ params, req }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const body = parsed.body;
  if (!("persona" in body)) return invalid("persona is required");
  const persona = body.persona === null ? null : structuredClone(body.persona);
  if (persona !== null && !isPlainObject(persona)) {
    return invalid("persona must be an object or null");
  }
  if (persona !== null) {
    for (const key of ["name", "title", "core_traits"]) {
      if (persona[key] !== undefined && typeof persona[key] !== "string") {
        return invalid(`persona.${key} must be a string`);
      }
    }
    for (const key of ["skills", "behavior_triggers"]) {
      if (persona[key] !== undefined && !Array.isArray(persona[key])) {
        return invalid(`persona.${key} must be an array`);
      }
    }
  }
  writePersona(resolved.queenId, persona);
  return { status: 200, body: buildQueenPersona(resolved.queenId) };
};

const getOverview = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenOverview(queenId) };
};

/** Raw request bytes, from `req.body` or an async-iterable request. */
async function readRawRequest(req) {
  if (!req) return Buffer.alloc(0);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  if (req.body !== undefined && req.body !== null) {
    return Buffer.from(JSON.stringify(req.body));
  }
  if (typeof req[Symbol.asyncIterator] !== "function") return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_AVATAR_BYTES * 2) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const postAvatar = async ({ params, req }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  let parts;
  try {
    parts = parseMultipart(await readRawRequest(req), req.headers["content-type"]);
  } catch (error) {
    return invalid(error?.message || "Expected multipart/form-data with an avatar field");
  }
  const field = parts.find((part) => part.name === "avatar" && part.data?.length);
  if (!field) return invalid("multipart field 'avatar' is required");
  if (field.data.length > MAX_AVATAR_BYTES) {
    return invalid(`avatar exceeds ${MAX_AVATAR_BYTES} bytes`);
  }
  const contentType = field.contentType || "application/octet-stream";
  if (!/^(image\/|application\/octet-stream)/.test(contentType)) {
    return invalid("avatar must be an image", { content_type: contentType });
  }
  const saved = saveAvatar(resolved.queenId, { bytes: field.data, contentType });
  return { status: 200, body: saved };
};

const deleteAvatar = async ({ params }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  deleteAvatarFile(resolved.queenId);
  return { status: 200, body: { queen_id: resolved.queenId, has_avatar: false } };
};

const getAvatar = async ({ params }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  const avatar = readAvatar(resolved.queenId);
  if (!avatar) {
    return fail(404, `Queen '${resolved.queenId}' has no avatar`, { type: "not_found" });
  }
  // Raw bytes: the UI loads this as an <img> source.
  return { status: 200, body: avatar.buffer, content_type: avatar.content_type };
};

/**
 * Create a durable session bound to this queen and remember it as her DM
 * session. `crm_setup` is recorded on the record for the UI's CRM flow.
 */
function createQueenSession(store, queenId, body = {}) {
  const entry = catalogEntry(queenId);
  const record = store.create({
    queenId,
    queenName: entry.name,
    model: readLlm(queenId)?.model ?? modelConfig().modelId,
    initialPrompt: typeof body.initial_prompt === "string" ? body.initial_prompt : null,
    phase: typeof body.initial_phase === "string" ? body.initial_phase : null,
    title: entry.name,
  });
  if (body.crm_setup === true) store.update(record.session_id, { crm_setup: true });
  writeDmSession(queenId, record.session_id);
  return record;
}

function sessionBody(queenId, record, status) {
  return {
    session_id: record.session_id,
    queen_id: queenId,
    status,
    colony_id: record.colony_id ?? null,
  };
}

/** POST /queen/:q/session — resume the queen's DM session, else create one. */
const getOrCreateSession = async ({ params, req, ctx }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const store = sessionStoreFor(ctx);
  const storedId = readDmSession(resolved.queenId);
  if (storedId) {
    const record = store.get(storedId);
    if (record) {
      return {
        status: 200,
        body: sessionBody(
          resolved.queenId,
          record,
          store.isLive(storedId) ? "live" : "resumed",
        ),
      };
    }
  }
  const record = createQueenSession(store, resolved.queenId, parsed.body);
  return { status: 200, body: sessionBody(resolved.queenId, record, "created") };
};

/** POST /queen/:q/session/select — bind an existing session to this queen. */
const selectSession = async ({ params, req, ctx }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const sessionId = typeof parsed.body.session_id === "string" ? parsed.body.session_id : "";
  if (!sessionId) return invalid("session_id is required");
  const store = sessionStoreFor(ctx);
  const record = store.get(sessionId);
  if (!record) {
    return fail(404, `Session '${sessionId}' not found`, { type: "not_found", session_id: sessionId });
  }
  if (record.queen_id && record.queen_id !== resolved.queenId) {
    return fail(409, `Session '${sessionId}' belongs to queen '${record.queen_id}'`, {
      type: "conflict",
      session_id: sessionId,
      queen_id: record.queen_id,
    });
  }
  store.markLive(sessionId);
  writeDmSession(resolved.queenId, sessionId);
  return { status: 200, body: sessionBody(resolved.queenId, record, "resumed") };
};

/** POST /queen/:q/session/new — always start a fresh session for this queen. */
const newSession = async ({ params, req, ctx }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const record = createQueenSession(sessionStoreFor(ctx), resolved.queenId, parsed.body);
  return { status: 200, body: sessionBody(resolved.queenId, record, "created") };
};

const getTools = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenTools(queenId) };
};

/** Re-bind every session of this queen to the new allowlist. */
function refreshQueenSessions(store, queenId, allowlist) {
  let refreshed = 0;
  for (const record of queenSessionRecords(store, queenId)) {
    if (store.update(record.session_id, { tool_allowlist: allowlist })) refreshed += 1;
  }
  return refreshed;
}

/** PATCH /queen/:q/tools — set the per-queen MCP tool allowlist. */
const patchTools = async ({ params, req, ctx }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const body = parsed.body;
  if (!("enabled_mcp_tools" in body)) return invalid("enabled_mcp_tools is required");
  const allowlist = body.enabled_mcp_tools;
  if (allowlist !== null && (!Array.isArray(allowlist) || allowlist.some((n) => typeof n !== "string"))) {
    return invalid("enabled_mcp_tools must be an array of tool names or null");
  }
  writeTools(resolved.queenId, allowlist);
  const refreshed = refreshQueenSessions(sessionStoreFor(ctx), resolved.queenId, allowlist);
  return {
    status: 200,
    body: { ...buildQueenTools(resolved.queenId), refreshed_sessions: refreshed },
  };
};

/** DELETE /queen/:q/tools — drop the allowlist and return to the role default. */
const deleteTools = async ({ params, ctx }) => {
  const resolved = resolveQueen(params);
  if (resolved.error) return resolved.error;
  writeTools(resolved.queenId, null);
  const refreshed = refreshQueenSessions(sessionStoreFor(ctx), resolved.queenId, null);
  return {
    status: 200,
    body: { ...buildQueenTools(resolved.queenId), removed: true, refreshed_sessions: refreshed },
  };
};

const getSoul = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  const colony = primaryQueenColony(queenId);
  if (!colony) return { status: 200, body: { queen_id: queenId, enabled: false } };
  const soul = loadSoul(colony.name);
  if (soul.mode === "off") return { status: 200, body: { queen_id: queenId, enabled: false } };
  return { status: 200, body: buildQueenSoulView(queenId, colony.name, soul) };
};

const putSoul = async ({ params, req }) => {
  const resolved = resolveQueenSoul(params);
  if (resolved.error) return resolved.error;
  const { queenId, colony } = resolved;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");

  const current = loadSoul(colony.name);
  if (current.mode === "off") {
    return conflict(`The soul is disabled for colony '${colony.name}'`, { queen_id: queenId });
  }

  const validated = validateSoulSections(parsed.body.sections);
  if (validated.error) return invalid(validated.error, { queen_id: queenId });

  snapshotVersion(colony.name, current, {
    author: "system",
    note: `version ${Number(current.version) || 1}`,
  });

  const built = nextSoulFromSections(current, validated.sections);
  const count = SOUL_SECTIONS.reduce(
    (total, section) =>
      total + (validated.sections[section.key] ? validated.sections[section.key].length : 0),
    0,
  );
  const at = isoNow();
  const next = {
    ...built.soul,
    version: (Number(current.version) || 1) + 1,
    updated_at: at,
    history: [
      ...(Array.isArray(current.history) ? current.history : []),
      ...built.dated,
      { at, author: "owner", note: "edited by hand", changes: count, version: Number(current.version) + 1 },
    ],
  };
  const saved = saveSoul(colony.name, next);
  snapshotVersion(colony.name, saved, {
    author: "owner",
    note: "edited by hand",
    changes: count,
  });
  return { status: 200, body: buildQueenSoulView(queenId, colony.name, saved) };
};

const decideSoulProposal = async ({ params, req }) => {
  const resolved = resolveQueenSoul(params);
  if (resolved.error) return resolved.error;
  const { queenId, colony } = resolved;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");

  const soul = loadSoul(colony.name);
  if (soul.mode === "off") {
    return conflict(`The soul is disabled for colony '${colony.name}'`, { queen_id: queenId });
  }

  const proposalId = typeof params?.proposal === "string" ? params.proposal : "";
  const proposals = listProposals(colony.name);
  const proposal = proposals.find((entry) => entry.id === proposalId);
  if (!proposal) {
    return fail(404, "No such proposal", { type: "not_found", queen_id: queenId });
  }
  if (proposal.status !== "pending") {
    return conflict(`This proposal was already ${proposal.status}`, { queen_id: queenId });
  }

  const accept = parsed.body.accept;
  if (accept !== undefined && accept !== null) {
    if (
      !Array.isArray(accept) ||
      !accept.every((value) => Number.isInteger(value) && !Number.isNaN(value))
    ) {
      return invalid("'accept' must be a list of change indexes, or null for all", {
        queen_id: queenId,
      });
    }
    const editCount = 1; // every pi_hive proposal is one section change
    const bad = accept.filter((index) => index < 0 || index >= editCount);
    if (bad.length) {
      return invalid(`Change index ${bad[0]} is out of range`, { queen_id: queenId });
    }
  }

  const dismissOnly = Array.isArray(accept) && accept.length === 0;
  const applyAll = accept === undefined || accept === null;
  const applySelected = Array.isArray(accept) && accept.includes(0);

  if (dismissOnly || (!applyAll && !applySelected)) {
    const at = isoNow();
    const next = proposals.map((entry) =>
      entry.id === proposalId ? { ...entry, status: "dismissed", decided_at: at } : entry,
    );
    const file = proposalsPath(colony.name);
    fs.writeFileSync(file, next.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return {
      status: 200,
      body: buildQueenSoulView(queenId, colony.name, loadSoul(colony.name)),
    };
  }

  let applied;
  try {
    // Snapshot the pre-apply soul first: applyProposal mutates soul.json in
    // place, so snapshotting afterwards would make "rollback" restore the
    // change it is supposed to undo.
    snapshotVersion(colony.name, soul, {
      author: "system",
      note: `version ${Number(soul.version) || 1}`,
    });
    applied = applyProposal(colony.name, proposalId);
  } catch (err) {
    return conflict(err.message, { queen_id: queenId });
  }
  const bumped = bumpSoulVersion(colony.name, applied, {
    author: "queen",
    note: `applied soul proposal ${proposalId}`,
    changes: 1,
  });
  return { status: 200, body: buildQueenSoulView(queenId, colony.name, bumped) };
};

const rollbackSoul = async ({ params, req }) => {
  const resolved = resolveQueenSoul(params);
  if (resolved.error) return resolved.error;
  const { queenId, colony } = resolved;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");

  const current = loadSoul(colony.name);
  if (current.mode === "off") {
    return conflict(`The soul is disabled for colony '${colony.name}'`, { queen_id: queenId });
  }

  const version = parsed.body.version;
  if (!Number.isInteger(version) || version < 1) {
    return invalid("'version' must be a version number", { queen_id: queenId });
  }

  const target = readVersionLog(colony.name).find((entry) => entry.version === version);
  if (!target || !isPlainObject(target.soul)) {
    return invalid(
      `No soul version ${version} is snapshotted; pi_hive snapshots versions written through this compat API`,
      { queen_id: queenId },
    );
  }

  snapshotVersion(colony.name, current, {
    author: "system",
    note: `version ${Number(current.version) || 1}`,
  });

  const now = isoNow();
  const restored = structuredClone(target.soul);
  const next = {
    ...restored,
    version: (Number(current.version) || 1) + 1,
    updated_at: now,
    history: [
      ...(Array.isArray(current.history) ? current.history : []),
      {
        at: now,
        author: "owner",
        note: `rolled back to version ${version}`,
        changes: 0,
        version: Number(current.version) + 1,
      },
    ],
  };
  const saved = saveSoul(colony.name, next);
  snapshotVersion(colony.name, saved, {
    author: "owner",
    note: `rolled back to version ${version}`,
    changes: 0,
  });
  return { status: 200, body: buildQueenSoulView(queenId, colony.name, saved) };
};

const probeSoulProposal = async ({ params }) => {
  const resolved = resolveQueenSoul(params);
  if (resolved.error) return resolved.error;
  const { queenId, colony } = resolved;
  const soul = loadSoul(colony.name);
  if (soul.mode === "off") {
    return conflict(`The soul is disabled for colony '${colony.name}'`, { queen_id: queenId });
  }
  const proposalId = typeof params?.proposal === "string" ? params.proposal : "";
  const proposal = listProposals(colony.name).find((entry) => entry.id === proposalId);
  if (!proposal || proposal.status !== "pending") {
    return fail(404, "No pending proposal by that id", {
      type: "not_found",
      queen_id: queenId,
    });
  }
  return unsupported(
    queenId,
    "Soul probes are not supported: pi_hive has no probe-question store and the compatibility layer does not call a model",
    { colony_id: colony.name },
  );
};

const reflectSoul = async ({ params }) => {
  const resolved = resolveQueenSoul(params);
  if (resolved.error) return resolved.error;
  const { queenId, colony } = resolved;
  const soul = loadSoul(colony.name);
  if (soul.mode === "off") {
    return conflict(`The soul is disabled for colony '${colony.name}'`, { queen_id: queenId });
  }
  if (listProposals(colony.name).some((proposal) => proposal.status === "pending")) {
    return conflict("Decide on the waiting proposal first", { queen_id: queenId });
  }
  return unsupported(
    queenId,
    `Soul reflection needs the model runtime; run POST /api/colonies/${colony.name}/soul/review (native pi_hive) and decide the resulting proposals here`,
    { colony_id: colony.name },
  );
};

const listClaudeCodeQueens = async () => ({ status: 200, body: { queens: [] } });

const claudeCodeTranscript = async ({ params }) => {
  const queenId = typeof params?.queen === "string" ? params.queen : "";
  const conversation = typeof params?.conversation === "string" ? params.conversation : "";
  return fail(
    404,
    `No conversation ${conversation} of ${queenId}: pi_hive has no Claude Code queen integration`,
    { type: "unsupported", queen_id: queenId, conversation_id: conversation },
  );
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the 28 official queen/soul/Claude Code routes.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] server instance or test context (unused: the routes
 *   read on-disk state and the process model env directly)
 * @returns {import("../router.js").RouteRegistry}
 */
export function registerQueenRoutes(registry, ctx = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registerQueenRoutes requires a RouteRegistry");
  }
  void ctx;

  // The shell registered two placeholder routes with a differently named
  // parameter (`/api/queen/:id/overview`, `/api/queen/:id/soul`). They match
  // the same paths as the official routes below, and the registry keeps the
  // first entry on a specificity tie, so the old structured-501 placeholders
  // would shadow the real handlers. Retire them exactly like install.js does
  // for the legacy session stream.
  if (typeof registry.remove === "function") {
    registry.remove("GET", "/api/queen/:id/overview");
    registry.remove("GET", "/api/queen/:id/soul");
  }

  const routes = [
    // Creation / catalog membership
    ["POST", "/api/queen/create", createQueen, IMPLEMENTED, "custom queens persist in the queen-state store"],
    ["POST", "/api/queen/:queen/remove", removeQueen, IMPLEMENTED, "removal persists; built-ins stay restorable"],
    ["POST", "/api/queen/:queen/restore", restoreQueen, IMPLEMENTED, "undoes a persisted removal; 400 when never removed"],
    ["GET", "/api/queen/removed", getRemoved, IMPLEMENTED, "lists queens whose removal is persisted"],

    // Identity
    ["GET", "/api/queen/:queen/profile", getProfile, IMPLEMENTED, "role profile derived from the runtime persona and real colonies"],
    ["PATCH", "/api/queen/:queen/profile", updateProfile, IMPLEMENTED, "profile overrides persist per queen"],
    ["GET", "/api/queen/:queen/llm", getLlm, IMPLEMENTED, "the process model plus this queen's stored llm section"],
    ["PUT", "/api/queen/:queen/llm", putLlm, IMPLEMENTED, "per-queen llm section persists and re-binds her sessions"],
    ["GET", "/api/queen/:queen/persona", getPersona, IMPLEMENTED, "persona fields derived from the runtime role identity"],
    ["PUT", "/api/queen/:queen/persona", putPersona, IMPLEMENTED, "persona overrides persist; null restores the role persona"],
    ["GET", "/api/queen/:queen/overview", getOverview, IMPLEMENTED, "real memory file counts and queen session files"],
    ["POST", "/api/queen/:queen/avatar", postAvatar, IMPLEMENTED, "multipart avatar bytes stored under the queen state dir"],
    ["DELETE", "/api/queen/:queen/avatar", deleteAvatar, IMPLEMENTED, "deletes the stored avatar bytes"],
    ["GET", "/api/queen/:queen/avatar", getAvatar, IMPLEMENTED, "serves stored avatar bytes with their content type"],

    // Queen sessions
    ["POST", "/api/queen/:queen/session", getOrCreateSession, IMPLEMENTED, "resumes or creates the queen's durable DM session"],
    ["POST", "/api/queen/:queen/session/select", selectSession, IMPLEMENTED, "binds an existing session; 404 unknown, 409 foreign queen"],
    ["POST", "/api/queen/:queen/session/new", newSession, IMPLEMENTED, "creates a fresh durable session for the queen"],

    // Tools
    ["GET", "/api/queen/:queen/tools", getTools, IMPLEMENTED, "the QueenRuntime catalog as this queen's allowlist has narrowed it"],
    ["PATCH", "/api/queen/:queen/tools", patchTools, IMPLEMENTED, "per-queen MCP allowlist persists and re-binds her sessions"],
    ["DELETE", "/api/queen/:queen/tools", deleteTools, IMPLEMENTED, "clears the allowlist back to the role default"],

    // Soul
    ["GET", "/api/queen/:queen/soul", getSoul, IMPLEMENTED, "soul.json of the queen's primary colony; disabled when absent"],
    ["PUT", "/api/queen/:queen/soul", putSoul, IMPLEMENTED, "writes soul.json, bumps the version and snapshots it"],
    ["POST", "/api/queen/:queen/soul/proposals/:proposal/decide", decideSoulProposal, IMPLEMENTED, "applies or dismisses a real soul_proposals.jsonl record"],
    ["POST", "/api/queen/:queen/soul/rollback", rollbackSoul, IMPLEMENTED, "restores a snapshotted soul version as a new version"],
    ["POST", "/api/queen/:queen/soul/proposals/:proposal/probe", probeSoulProposal, PARTIAL, "no probe-question store or model call; 400"],
    ["POST", "/api/queen/:queen/soul/reflect", reflectSoul, PARTIAL, "reflection needs the model runtime; 400 points at the native review route"],

    // Claude Code queens
    ["GET", "/api/claude-code-queens", listClaudeCodeQueens, IMPLEMENTED, "valid empty list: no Claude Code integration"],
    [
      "GET",
      "/api/claude-code-queens/:queen/conversations/:conversation",
      claudeCodeTranscript,
      PARTIAL,
      "no Claude Code transcripts; explicit 404",
    ],
  ];

  for (const [method, pattern, handler, meta, description] of routes) {
    registry.register(method, pattern, handler, { ...meta, description });
  }

  return registry;
}

/** Machine-readable route inventory for integration reports/tests. */
export const QUEEN_ROUTE_PATHS = Object.freeze([
  "POST /api/queen/create",
  "POST /api/queen/:queen/remove",
  "POST /api/queen/:queen/restore",
  "GET /api/queen/removed",
  "GET /api/queen/:queen/profile",
  "PATCH /api/queen/:queen/profile",
  "GET /api/queen/:queen/llm",
  "PUT /api/queen/:queen/llm",
  "GET /api/queen/:queen/persona",
  "PUT /api/queen/:queen/persona",
  "GET /api/queen/:queen/overview",
  "POST /api/queen/:queen/avatar",
  "DELETE /api/queen/:queen/avatar",
  "GET /api/queen/:queen/avatar",
  "POST /api/queen/:queen/session",
  "POST /api/queen/:queen/session/select",
  "POST /api/queen/:queen/session/new",
  "GET /api/queen/:queen/tools",
  "PATCH /api/queen/:queen/tools",
  "DELETE /api/queen/:queen/tools",
  "GET /api/queen/:queen/soul",
  "PUT /api/queen/:queen/soul",
  "POST /api/queen/:queen/soul/proposals/:proposal/decide",
  "POST /api/queen/:queen/soul/rollback",
  "POST /api/queen/:queen/soul/proposals/:proposal/probe",
  "POST /api/queen/:queen/soul/reflect",
  "GET /api/claude-code-queens",
  "GET /api/claude-code-queens/:queen/conversations/:conversation",
]);

export default registerQueenRoutes;
