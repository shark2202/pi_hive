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

/** Resolve the queen or return a 404 descriptor. */
function resolveQueen(params) {
  const queenId = typeof params?.queen === "string" ? params.queen : "";
  const queen = QUEEN_BY_ID.get(queenId) || null;
  return { queenId, queen, error: queen ? null : notFoundQueen(queenId) };
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
  if (!queen) return null;
  const persona = personaOf(queenId);
  const colonies = colonyNamesFor(queenId);
  const profile = {
    id: queen.id,
    name: queen.name,
    title: queen.title,
    summary: persona.summary,
    experience: persona.details.length
      ? [{ role: queen.title, details: [...persona.details] }]
      : [],
    skills: persona.skills,
    portrait: null,
    has_avatar: false,
    custom: false,
  };
  if (colonies.length) {
    profile.signature_achievement = `Leads ${colonies.length} pi_hive colon${
      colonies.length === 1 ? "y" : "ies"
    }: ${colonies.join(", ")}.`;
  }
  return profile;
}

function buildQueenPersona(queenId) {
  const queen = QUEEN_BY_ID.get(queenId);
  const persona = personaOf(queenId);
  return {
    queen_id: queenId,
    persona: {
      name: queen.name,
      title: queen.title,
      core_traits: persona.summary,
      skills: persona.skills,
    },
  };
}

/** The one process-wide pi_hive model. Queens share it. */
function buildQueenLlm(queenId) {
  return {
    queen_id: queenId,
    section: null,
    default_model: modelConfig().modelId,
  };
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
  return {
    queen_id: queenId,
    // No per-queen allowlist exists; the role default is the effective surface.
    enabled_mcp_tools: null,
    is_role_default: true,
    stale: false,
    lifecycle,
    synthetic: [],
    mcp_servers: [],
    categories: TOOL_CATEGORIES.map((category) => ({
      name: category.name,
      tools: category.tools.filter((name) => byName.has(name)),
      in_role_default: true,
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

const getRemoved = async () => ({ status: 200, body: { queens: [] } });

const createQueen = async ({ req }) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  return unsupported(
    null,
    "Custom queens are not supported: pi_hive's catalog is the four built-in role identities and there is no profile.yaml store",
    { supported: QUEEN_IDS },
  );
};

const removeQueen = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return unsupported(
    queenId,
    `Queen '${queenId}' cannot be removed: she is a built-in role identity and colonies bind to her queen_id`,
    { queen_id: queenId },
  );
};

const restoreQueen = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return unsupported(
    queenId,
    `Queen '${queenId}' cannot be restored: she was never removed and pi_hive has no queen catalog store`,
    { queen_id: queenId },
  );
};

const getProfile = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenProfile(queenId) };
};

const updateProfile = async ({ params, req }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  return unsupported(
    queenId,
    "Queen profiles are code-defined role identities; pi_hive has no editable profile.yaml store, so PATCH is not supported",
    { queen_id: queenId },
  );
};

const getLlm = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenLlm(queenId) };
};

const putLlm = async ({ params, req }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  return unsupported(
    queenId,
    "Per-queen models are not supported: pi_hive runs one process-wide model from PI_HIVE_MODEL and has no queen_llm section store",
    { queen_id: queenId },
  );
};

const getPersona = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenPersona(queenId) };
};

const putPersona = async ({ params, req }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  return unsupported(
    queenId,
    "Queen personas cannot be replaced: pi_hive builds queen identity from code in src/runtime/queen.js and stores no profile.yaml",
    { queen_id: queenId },
  );
};

const getOverview = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenOverview(queenId) };
};

const postAvatar = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return unsupported(
    queenId,
    "Avatar upload is not supported: pi_hive has no queen avatar file store and queen portraits are not images on disk",
    { queen_id: queenId },
  );
};

const deleteAvatar = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return unsupported(
    queenId,
    "Avatar deletion is not supported: pi_hive has no queen avatar file store",
    { queen_id: queenId },
  );
};

const getAvatar = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return fail(404, `No avatar found for queen '${queenId}': pi_hive has no queen avatar store`, {
    type: "not_found",
    queen_id: queenId,
  });
};

const queenSessionUnsupported = (queenId) =>
  unsupported(
    queenId,
    "Queen DM sessions are not supported: pi_hive runs chat inside a colony (POST /api/colonies/:colony/chat) and has no queen session store",
    { queen_id: queenId },
  );

const getOrCreateSession = async ({ params, req }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  return queenSessionUnsupported(queenId);
};

const selectSession = async ({ params, req }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const sessionId = parsed.body.session_id;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return invalid("session_id is required", { queen_id: queenId });
  }
  return queenSessionUnsupported(queenId);
};

const newSession = async ({ params, req }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  return queenSessionUnsupported(queenId);
};

const getTools = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return { status: 200, body: buildQueenTools(queenId) };
};

const toolsUnsupported = (queenId, verb) =>
  unsupported(
    queenId,
    `${verb} is not supported: pi_hive has no per-queen tools.json sidecar; the queen tool surface is fixed in src/runtime/queen.js`,
    { queen_id: queenId },
  );

const patchTools = async ({ params, req }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  return toolsUnsupported(queenId, "Tool allowlist updates");
};

const deleteTools = async ({ params }) => {
  const { queenId, error } = resolveQueen(params);
  if (error) return error;
  return toolsUnsupported(queenId, "Tool allowlist reset");
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
    ["POST", "/api/queen/create", createQueen, PARTIAL, "custom queens are not supported; 400 with the four built-in ids"],
    ["POST", "/api/queen/:queen/remove", removeQueen, PARTIAL, "built-in queens cannot be removed; 400 for a known queen, 404 otherwise"],
    ["POST", "/api/queen/:queen/restore", restoreQueen, PARTIAL, "no removed-queen store; 400 for a known queen, 404 otherwise"],
    ["GET", "/api/queen/removed", getRemoved, IMPLEMENTED, "valid empty list: pi_hive never removes a built-in queen"],

    // Identity
    ["GET", "/api/queen/:queen/profile", getProfile, IMPLEMENTED, "role profile derived from the runtime persona and real colonies"],
    ["PATCH", "/api/queen/:queen/profile", updateProfile, PARTIAL, "profiles are code-defined; 400 unsupported"],
    ["GET", "/api/queen/:queen/llm", getLlm, IMPLEMENTED, "the single process model; section is always null"],
    ["PUT", "/api/queen/:queen/llm", putLlm, PARTIAL, "per-queen models are not supported; 400"],
    ["GET", "/api/queen/:queen/persona", getPersona, IMPLEMENTED, "persona fields derived from the runtime role identity"],
    ["PUT", "/api/queen/:queen/persona", putPersona, PARTIAL, "personas are not editable; 400"],
    ["GET", "/api/queen/:queen/overview", getOverview, IMPLEMENTED, "real memory file counts and queen session files"],
    ["POST", "/api/queen/:queen/avatar", postAvatar, PARTIAL, "no avatar store; 400 unsupported"],
    ["DELETE", "/api/queen/:queen/avatar", deleteAvatar, PARTIAL, "no avatar store; 400 unsupported"],
    ["GET", "/api/queen/:queen/avatar", getAvatar, PARTIAL, "no avatar store; explicit 404"],

    // Queen sessions
    ["POST", "/api/queen/:queen/session", getOrCreateSession, PARTIAL, "no queen DM session store; 400"],
    ["POST", "/api/queen/:queen/session/select", selectSession, PARTIAL, "no queen DM session store; validates session_id then 400"],
    ["POST", "/api/queen/:queen/session/new", newSession, PARTIAL, "no queen DM session store; 400"],

    // Tools
    ["GET", "/api/queen/:queen/tools", getTools, IMPLEMENTED, "the fixed QueenRuntime tool catalog"],
    ["PATCH", "/api/queen/:queen/tools", patchTools, PARTIAL, "no per-queen allowlist; 400"],
    ["DELETE", "/api/queen/:queen/tools", deleteTools, PARTIAL, "no per-queen allowlist; 400"],

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
