/**
 * Official frontend compatibility handlers for colony management and the
 * tracker data browser.
 *
 * The official client (`core/frontend/src/api/colonies.ts`, `colonyData.ts`,
 * `globalData.ts`) talks to a surface pi_hive did not implement:
 *
 *   colony lifecycle  scaffold / tools / rename / reveal / delete
 *   data browser      tables / rows / change feed / row update (per colony)
 *   global team DB    /global/data/*  (pi_hive has no global database)
 *
 * Colony state comes from real files under `PI_HIVE_HOME/colonies/<name>`
 * (metadata.json, tools.json, worker.json) and the per-colony
 * `tracker/tracker.db` opened through `src/domain/tracker.js`, whose
 * `query()` guard only accepts SELECT/WITH. Every identifier that reaches SQL
 * is validated against the live schema (`sqlite_master`, `pragma_table_info`)
 * and every value is bound as a parameter, so no request text is concatenated
 * into a statement.
 *
 * Handlers return `{status, body}` descriptors and never write to `res`; the
 * dispatcher (or a test harness) serializes the body.
 *
 * `ctx` is accepted for dispatcher parity. pi_hive ships no global team
 * database, so the nine `/global/data/*` routes answer with a valid empty
 * schema (the two collection reads) or an explicit 404 that names the missing
 * capability (the table-scoped writes/reads). They never invent rows.
 */
import fs from "node:fs";
import path from "node:path";

import { colonyDir, ensureDir, hiveHome } from "../../config.js";
import { colonyPaths, createColony, loadMetadata, saveMetadata } from "../../domain/colony.js";
import { openTracker } from "../../domain/tracker.js";
import { planTools, skillTools, soulTools, trackerTools } from "../../runtime/tools.js";
import { ROUTE_STATUS } from "../router.js";
import { readColonyAllowlist } from "./organization.js";

/** Identifier shape used by pi_hive for table/column names. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ROW_LIMIT = 500;
const DEFAULT_ROW_LIMIT = 100;
/** Bound on change-log rows read per poll; keeps one poll cheap. */
const CHANGE_SCAN_LIMIT = 5000;

/** Why every /global/data route is empty or refuses. */
export const GLOBAL_DATA_REASON =
  "pi_hive has no global team database; the official /global/data surface proxies a cloud team DB this host does not configure";

/** Stable error code for the absent global database. */
export const GLOBAL_DATA_CODE = "global_data_unavailable";

/** The 19 method+pattern pairs this module owns, in contract order. */
export const COLONIES_DATA_ROUTES = Object.freeze([
  ["POST", "/api/colonies/:colony/scaffold"],
  ["GET", "/api/colony/:colony/tools"],
  ["PATCH", "/api/colony/:colony/tools"],
  ["POST", "/api/colonies/:colony/rename"],
  ["POST", "/api/colonies/:colony/reveal"],
  ["DELETE", "/api/colonies/:colony"],
  ["GET", "/api/colonies/:colony/data/tables"],
  ["GET", "/api/colonies/:colony/data/tables/:table/rows"],
  ["GET", "/api/colonies/:colony/data/changes"],
  ["PATCH", "/api/colonies/:colony/data/tables/:table/rows"],
  ["GET", "/api/global/data/tables"],
  ["GET", "/api/global/data/changes"],
  ["GET", "/api/global/data/tables/:table/rows"],
  ["PATCH", "/api/global/data/tables/:table/rows"],
  ["POST", "/api/global/data/tables/:table/query"],
  ["POST", "/api/global/data/tables/:table/group-counts"],
  ["POST", "/api/global/data/tables/:table/rows"],
  ["DELETE", "/api/global/data/tables/:table/rows"],
  ["GET", "/api/global/data/foreign-keys"],
].map(([method, routePath]) => Object.freeze({ method, path: routePath })));


// --- small helpers ---------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(status, message, code, extra = {}) {
  return { status, body: { error: message, ...(code ? { code } : {}), ...extra } };
}

function colonyNotFound(name) {
  return fail(404, `colony '${name}' not found`, "colony_not_found");
}

/** Validate a colony name without touching the filesystem. */
function validateColonyName(name) {
  if (typeof name !== "string" || name.length === 0) {
    return { error: fail(400, "colony name is required", "invalid_colony_name") };
  }
  try {
    return { name, dir: colonyDir(name) };
  } catch (err) {
    return { error: fail(400, err.message, "invalid_colony_name") };
  }
}

/** Validate the name and require the colony directory to exist. */
function requireColony(name) {
  const resolved = validateColonyName(name);
  if (resolved.error) return resolved;
  let stat = null;
  try {
    stat = fs.statSync(resolved.dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) return { error: colonyNotFound(resolved.name) };
  return resolved;
}

/** metadata.json as an object, or null when missing/malformed. Never throws. */
function safeMetadata(name) {
  try {
    const meta = loadMetadata(name);
    return isPlainObject(meta) ? meta : null;
  } catch {
    return null;
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Parse a request body. Supports a pre-parsed `req.body`, `req.json()`, and
 *  a raw Node readable stream. Returns whatever JSON parsed to. */
async function readJsonBody(req) {
  if (!req) return {};
  if (req.body !== undefined) {
    const raw = req.body;
    if (raw === null || raw === "") return {};
    if (typeof raw === "string") return JSON.parse(raw);
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8"));
    return raw;
  }
  if (typeof req.json === "function") return await req.json();
  if (typeof req[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return text ? JSON.parse(text) : {};
  }
  return {};
}

/** First value for `name` from req.query (object or URLSearchParams) or req.url. */
function queryParam(req, name) {
  const source = req?.query;
  if (source instanceof URLSearchParams) return source.get(name) ?? undefined;
  if (isPlainObject(source) && Object.prototype.hasOwnProperty.call(source, name)) {
    const value = source[name];
    return Array.isArray(value) ? value[0] : value;
  }
  if (typeof req?.url === "string") {
    try {
      return new URL(req.url, "http://localhost").searchParams.get(name) ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Read an integer query parameter.
 * `fallback: undefined` means required; a missing required value is a 400.
 */
function intQuery(req, name, { min, max, fallback }) {
  const raw = queryParam(req, name);
  if (raw === undefined || raw === null || raw === "") {
    if (fallback === undefined) {
      return { error: fail(400, `${name} is required`, "invalid_query") };
    }
    return { value: fallback };
  }
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) {
    return { error: fail(400, `${name} must be an integer`, "invalid_query") };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { error: fail(400, `${name} must be between ${min} and ${max}`, "invalid_query") };
  }
  return { value };
}

function truthyFlag(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

// --- colony lifecycle ------------------------------------------------------

function minimalWorker(name, queenName) {
  return {
    name: name.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (ch) => ch.toUpperCase()),
    description: `Colony ${name}`,
    tools: [],
    goal: { description: `Work on tasks for colony ${name}` },
    ...(queenName ? { queen_name: queenName } : {}),
  };
}

/** Create the colony folder without booting a queen (official scaffold). */
async function handleScaffold({ req, params } = {}) {
  const resolved = validateColonyName(params?.colony);
  if (resolved.error) return resolved.error;

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return fail(400, "invalid JSON body", "invalid_json");
  }
  if (!isPlainObject(body)) return fail(400, "body must be a JSON object", "invalid_body");

  let queenName = null;
  if (body.queen_name !== undefined && body.queen_name !== null && body.queen_name !== "") {
    if (typeof body.queen_name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.queen_name)) {
      return fail(400, "queen_name must be a slug of letters, digits, '_' or '-'", "invalid_queen_name");
    }
    queenName = body.queen_name;
  }

  try {
    const dirExists = fs.existsSync(resolved.dir);
    if (!dirExists) {
      createColony(queenName ? { name: resolved.name, queenId: queenName } : { name: resolved.name });
    } else {
      ensureDir(resolved.dir);
    }

    const metaPath = path.join(resolved.dir, "metadata.json");
    if (fs.existsSync(metaPath) && !safeMetadata(resolved.name)) {
      return fail(500, "cannot scaffold: metadata.json is not valid JSON", "scaffold_failed");
    }
    if (!fs.existsSync(metaPath)) {
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          { id: resolved.name, queen_id: queenName, created_at: new Date().toISOString() },
          null,
          2,
        ),
      );
    }

    const workerPath = path.join(resolved.dir, "worker.json");
    if (!fs.existsSync(workerPath)) {
      fs.writeFileSync(workerPath, JSON.stringify(minimalWorker(resolved.name, queenName), null, 2));
    }

    const meta = safeMetadata(resolved.name) || { id: resolved.name };
    saveMetadata(resolved.name, { ...meta, id: meta.id || resolved.name, scaffolded: true });
    return {
      status: 200,
      body: { colony_id: resolved.name, scaffolded: true, created: !dirExists },
    };
  } catch (err) {
    return fail(500, `failed to scaffold colony: ${err.message}`, "scaffold_failed");
  }
}

/** pi_hive's non-MCP tool families, as the official lifecycle list. */
function lifecycleEntries() {
  const stubColony = { name: "", dir: "" };
  const stubTracker = { query() {}, run() {}, exec() {}, upsert() {} };
  const tools = [
    ...trackerTools(stubTracker),
    ...planTools(stubColony),
    ...skillTools(stubColony),
    ...soulTools({ engine: () => null }),
  ];
  return tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      editable: false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function handleGetTools({ params } = {}) {
  const resolved = requireColony(params?.colony);
  if (resolved.error) return resolved.error;

  const enabled = readColonyAllowlist(resolved.name, safeMetadata(resolved.name));
  return {
    status: 200,
    body: {
      colony_id: resolved.name,
      enabled_mcp_tools: enabled,
      // pi_hive ships no MCP catalog, so the official client should show the
      // surface as stale rather than imply a populated catalog.
      stale: true,
      lifecycle: lifecycleEntries(),
      synthetic: [],
      mcp_servers: [],
    },
  };
}

/** Persist `enabled_mcp_tools` into the colony's tools.json sidecar. */
async function handleUpdateTools({ req, params } = {}) {
  const resolved = requireColony(params?.colony);
  if (resolved.error) return resolved.error;

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return fail(400, "invalid JSON body", "invalid_json");
  }
  if (!isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, "enabled_mcp_tools")) {
    return fail(
      400,
      "body must be an object with an 'enabled_mcp_tools' field",
      "invalid_body",
    );
  }

  const enabled = body.enabled_mcp_tools;
  if (enabled !== null) {
    if (!Array.isArray(enabled) || enabled.some((name) => typeof name !== "string" || !name.trim())) {
      return fail(400, "'enabled_mcp_tools' must be null or a list of non-empty strings", "invalid_body");
    }
  }

  const sidecar = path.join(resolved.dir, "tools.json");
  const tmp = `${sidecar}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ enabled_mcp_tools: enabled, updated_at: new Date().toISOString() }, null, 2),
    );
    fs.renameSync(tmp, sidecar);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    return fail(500, `failed to persist tool allowlist: ${err.message}`, "tools_write_failed");
  }

  return {
    status: 200,
    body: {
      colony_id: resolved.name,
      enabled_mcp_tools: enabled,
      refreshed_runtimes: 0,
      note: "pi_hive has no MCP catalog; the allowlist applies to the next worker spawn.",
    },
  };
}

/** Move `colonies/<old>` (and `agents/<old>` when present) to the new name. */
async function handleRename({ req, params } = {}) {
  const from = requireColony(params?.colony);
  if (from.error) return from.error;

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return fail(400, "invalid JSON body", "invalid_json");
  }
  if (!isPlainObject(body)) return fail(400, "body must be a JSON object", "invalid_body");

  const to = validateColonyName(body.new_name);
  if (to.error) return to.error;

  if (from.name === to.name) {
    return { status: 200, body: { renamed: false, old_name: from.name, new_name: to.name } };
  }

  const agentsRoot = path.join(hiveHome(), "agents");
  const oldAgentDir = path.join(agentsRoot, from.name);
  const newAgentDir = path.join(agentsRoot, to.name);

  if (fs.existsSync(to.dir) || fs.existsSync(newAgentDir)) {
    return fail(409, `colony '${to.name}' already exists`, "colony_exists");
  }

  try {
    fs.renameSync(from.dir, to.dir);
  } catch (err) {
    return fail(500, `failed to rename colony directory: ${err.message}`, "rename_failed");
  }

  let agentMoved = false;
  if (fs.existsSync(oldAgentDir)) {
    try {
      fs.renameSync(oldAgentDir, newAgentDir);
      agentMoved = true;
    } catch (err) {
      // Restore the colony directory so the on-disk state stays consistent.
      try {
        fs.renameSync(to.dir, from.dir);
      } catch {
        /* rollback failed; report the original error below */
      }
      return fail(500, `failed to rename agent directory: ${err.message}`, "rename_failed");
    }
  }

  const metaPath = path.join(to.dir, "metadata.json");
  const metaExists = fs.existsSync(metaPath);
  const meta = metaExists ? safeMetadata(to.name) : {};
  if (metaExists && !meta) {
    return {
      status: 200,
      body: {
        renamed: true,
        old_name: from.name,
        new_name: to.name,
        agent_dir_moved: agentMoved,
        metadata_updated: false,
        warning: "metadata.json is not valid JSON and was left unchanged",
      },
    };
  }

  try {
    const next = { ...(meta || {}), id: to.name };
    if (typeof meta?.name === "string") next.name = to.name;
    saveMetadata(to.name, next);
  } catch (err) {
    return fail(
      500,
      `colony directories were renamed but metadata.json could not be updated: ${err.message}`,
      "rename_metadata_failed",
    );
  }

  return {
    status: 200,
    body: {
      renamed: true,
      old_name: from.name,
      new_name: to.name,
      agent_dir_moved: agentMoved,
      metadata_updated: true,
    },
  };
}

/** Return the colony folder path; never launches an OS file manager. */
async function handleReveal({ params } = {}) {
  const resolved = requireColony(params?.colony);
  if (resolved.error) return resolved.error;
  return {
    status: 200,
    body: {
      path: path.resolve(resolved.dir),
      opened: false,
      note: "reveal returns the folder path; pi_hive does not launch OS file managers",
    },
  };
}

/** Soft delete (`deleted: true` in metadata) or purge (`?purge=true`). */
async function handleDelete({ req, params } = {}) {
  const resolved = validateColonyName(params?.colony);
  if (resolved.error) return resolved.error;

  const purge = truthyFlag(queryParam(req, "purge"));
  const colonyD = resolved.dir;
  const agentD = path.join(hiveHome(), "agents", resolved.name);
  const colonyExists = fs.existsSync(colonyD);
  const agentExists = fs.existsSync(agentD);

  // Idempotent: the desktop may delete a pushed copy and then the local one.
  if (!colonyExists && !agentExists) {
    return { status: 200, body: { deleted: resolved.name, purged: purge } };
  }

  if (purge) {
    for (const dir of [colonyD, agentD]) {
      if (!fs.existsSync(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        return fail(500, `failed to delete colony directory: ${err.message}`, "delete_failed");
      }
    }
    return { status: 200, body: { deleted: resolved.name, purged: true } };
  }

  if (colonyExists) {
    const metaPath = path.join(colonyD, "metadata.json");
    const metaExists = fs.existsSync(metaPath);
    const meta = metaExists ? safeMetadata(resolved.name) : null;
    if (metaExists && !meta) {
      return fail(500, "cannot mark colony deleted: metadata.json is not valid JSON", "delete_failed");
    }
    try {
      saveMetadata(resolved.name, { ...(meta || { id: resolved.name }), id: meta?.id || resolved.name, deleted: true });
    } catch (err) {
      return fail(500, `failed to mark colony deleted: ${err.message}`, "delete_failed");
    }
  }
  return { status: 200, body: { deleted: resolved.name, purged: false } };
}

// --- tracker data browser --------------------------------------------------

function openTrackerIfPresent(name) {
  const file = colonyPaths(name).tracker;
  if (!fs.existsSync(file)) return null;
  return openTracker(name);
}

/** User tables: everything SQLite owns that is not `_framework`/`sqlite_`. */
function listUserTables(tracker) {
  return tracker
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name)
    .filter((name) => IDENT.test(name) && !name.startsWith("_") && !name.startsWith("sqlite_"));
}

function tableExists(tracker, table) {
  if (typeof table !== "string" || !IDENT.test(table)) return false;
  if (table.startsWith("_") || table.startsWith("sqlite_")) return false;
  return tracker.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]).length > 0;
}

function tableColumns(tracker, table) {
  return tracker
    .query(
      'SELECT name, type, "notnull" AS notnull_flag, dflt_value, pk, cid FROM pragma_table_info(?) ORDER BY cid',
      [table],
    )
    .map((column) => ({
      name: column.name,
      type: column.type ?? "",
      notnull: Boolean(column.notnull_flag),
      pk: Number(column.pk) || 0,
      dflt_value: column.dflt_value ?? null,
    }));
}

function primaryKeyOf(columns) {
  return columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
}

function rowCount(tracker, table) {
  const row = tracker.query(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`)[0];
  return Number(row?.count ?? 0);
}

function tableOverview(tracker, table) {
  const columns = tableColumns(tracker, table);
  return {
    name: table,
    columns,
    row_count: rowCount(tracker, table),
    primary_key: primaryKeyOf(columns),
  };
}

/** JSON-safe cell values (BLOB -> base64, big ints -> number/string). */
function cellToJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

function plainRow(row) {
  const out = {};
  for (const key of Object.keys(row)) out[key] = cellToJson(row[key]);
  return out;
}

function isCellValue(value) {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  return typeof value === "number" && Number.isFinite(value);
}

/** SQLite bindings: booleans become 0/1 (node:sqlite has no boolean type). */
function bindCell(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

async function handleListTables({ params } = {}) {
  const resolved = requireColony(params?.colony);
  if (resolved.error) return resolved.error;

  let tracker;
  try {
    tracker = openTrackerIfPresent(resolved.name);
  } catch (err) {
    return fail(500, `failed to open tracker.db: ${err.message}`, "tracker_open_failed");
  }
  if (!tracker) return { status: 200, body: { tables: [] } };

  try {
    return {
      status: 200,
      body: { tables: listUserTables(tracker).map((table) => tableOverview(tracker, table)) },
    };
  } catch (err) {
    return fail(500, `failed to read tracker tables: ${err.message}`, "tracker_read_failed");
  } finally {
    tracker.close();
  }
}

function rowsOrderClause(columns, primaryKey, req) {
  const orderByRaw = queryParam(req, "order_by");
  let orderBy = null;
  if (orderByRaw !== undefined && orderByRaw !== null && String(orderByRaw).trim() !== "") {
    const candidate = String(orderByRaw).trim();
    if (!columns.some((column) => column.name === candidate)) {
      return {
        error: fail(
          400,
          `order_by must be a column of this table: ${columns.map((c) => c.name).join(", ")}`,
          "invalid_query",
        ),
      };
    }
    orderBy = candidate;
  }

  const dirRaw = queryParam(req, "order_dir");
  let dir = "asc";
  if (dirRaw !== undefined && dirRaw !== null && String(dirRaw).trim() !== "") {
    dir = String(dirRaw).trim().toLowerCase();
    if (dir !== "asc" && dir !== "desc") {
      return { error: fail(400, "order_dir must be 'asc' or 'desc'", "invalid_query") };
    }
  }

  if (orderBy) return { clause: ` ORDER BY ${quoteIdent(orderBy)} ${dir.toUpperCase()}` };
  if (primaryKey.length > 0) {
    return { clause: ` ORDER BY ${primaryKey.map(quoteIdent).join(", ")} ASC` };
  }
  return { clause: "" };
}

async function handleListRows({ req, params } = {}) {
  const resolved = requireColony(params?.colony);
  if (resolved.error) return resolved.error;
  const table = params?.table;

  const limit = intQuery(req, "limit", {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: DEFAULT_ROW_LIMIT,
  });
  if (limit.error) return limit.error;
  // The official client documents "server enforces limit <= 500"; clamp rather
  // than reject so a caller that asks for more still gets a usable page.
  const effectiveLimit = Math.min(limit.value, MAX_ROW_LIMIT);
  const offset = intQuery(req, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
  if (offset.error) return offset.error;

  let tracker;
  try {
    tracker = openTrackerIfPresent(resolved.name);
  } catch (err) {
    return fail(500, `failed to open tracker.db: ${err.message}`, "tracker_open_failed");
  }
  if (!tracker || !tableExists(tracker, table)) {
    tracker?.close();
    return fail(404, `table '${table}' not found`, "table_not_found");
  }

  try {
    const columns = tableColumns(tracker, table);
    const primaryKey = primaryKeyOf(columns);
    const order = rowsOrderClause(columns, primaryKey, req);
    if (order.error) return order.error;

    const rows = tracker.query(
      `SELECT * FROM ${quoteIdent(table)}${order.clause} LIMIT ? OFFSET ?`,
      [effectiveLimit, offset.value],
    );
    return {
      status: 200,
      body: {
        table,
        columns,
        primary_key: primaryKey,
        rows: rows.map(plainRow),
        total: rowCount(tracker, table),
        limit: effectiveLimit,
        offset: offset.value,
      },
    };
  } catch (err) {
    return fail(500, `failed to read tracker rows: ${err.message}`, "tracker_read_failed");
  } finally {
    tracker.close();
  }
}

/** Tables that participate in the row-level change log. */
function changeCoverage(tracker, existingTables) {
  const existing = new Set(existingTables);
  let registered = [];
  try {
    registered = tracker
      .query("SELECT table_name FROM _tracker_registry")
      .map((row) => row.table_name)
      .filter((name) => typeof name === "string");
  } catch {
    registered = [];
  }
  if (registered.length === 0) {
    // Older databases carry triggers but no registry rows.
    registered = tracker
      .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_tracker_chg__%__ins'")
      .map((row) => String(row.name).slice("_tracker_chg__".length, -"__ins".length));
  }
  return [...new Set(registered)].filter((name) => existing.has(name)).sort();
}

function hasTable(tracker, table) {
  return (
    tracker.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]).length > 0
  );
}


function parseChangePk(raw) {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function handleChanges({ req, params } = {}) {
  const resolved = requireColony(params?.colony);
  if (resolved.error) return resolved.error;

  const since = intQuery(req, "since", {
    min: -1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: undefined,
  });
  if (since.error) return since.error;

  let tracker;
  try {
    tracker = openTrackerIfPresent(resolved.name);
  } catch (err) {
    return fail(500, `failed to open tracker.db: ${err.message}`, "tracker_open_failed");
  }
  if (!tracker) {
    return { status: 200, body: { cursor: 0, covered: [], truncated: false, tables: {} } };
  }

  try {
    if (!hasTable(tracker, "_tracker_changes")) {
      return { status: 200, body: { cursor: 0, covered: [], truncated: false, tables: {} } };
    }
    const covered = changeCoverage(tracker, listUserTables(tracker));
    const cursor = Number(
      tracker.query("SELECT COALESCE(MAX(id), 0) AS cursor FROM _tracker_changes")[0]?.cursor ?? 0,
    );

    // since = -1 is the init call: current cursor + coverage, no history.
    if (since.value === -1) {
      return { status: 200, body: { cursor, covered, truncated: false, tables: {} } };
    }

    const min = tracker.query("SELECT MIN(id) AS min_id FROM _tracker_changes")[0]?.min_id ?? null;
    let truncated = min !== null && since.value < Number(min) - 1;

    const rows = tracker.query(
      "SELECT id, table_name, pk, op FROM _tracker_changes WHERE id > ? ORDER BY id ASC LIMIT ?",
      [since.value, CHANGE_SCAN_LIMIT],
    );
    if (rows.length >= CHANGE_SCAN_LIMIT) truncated = true;

    const grouped = new Map();
    for (const row of rows) {
      const tableName = typeof row.table_name === "string" ? row.table_name : null;
      if (!tableName) continue;
      const pk = parseChangePk(row.pk);
      if (!pk) continue;
      const key = JSON.stringify(pk);
      let bucket = grouped.get(tableName);
      if (!bucket) {
        bucket = { order: [], byKey: new Map() };
        grouped.set(tableName, bucket);
      }
      const existing = bucket.byKey.get(key);
      if (existing) {
        existing.op = row.op === "insert" ? "insert" : "update";
      } else {
        const entry = { pk, op: row.op === "insert" ? "insert" : "update" };
        bucket.byKey.set(key, entry);
        bucket.order.push(entry);
      }
    }

    const tables = {};
    for (const [tableName, bucket] of grouped) {
      tables[tableName] = { count: bucket.order.length, rows: bucket.order };
    }
    return { status: 200, body: { cursor, covered, truncated, tables } };
  } catch (err) {
    return fail(500, `failed to read tracker changes: ${err.message}`, "tracker_read_failed");
  } finally {
    tracker.close();
  }
}

/** Apply validated column/value pairs to one row addressed by its primary key. */
function applyRowUpdate(tracker, table, columns, primaryKey, pk, updates) {
  const columnNames = columns.map((column) => column.name);
  const updateNames = Object.keys(updates);

  for (const name of Object.keys(pk)) {
    if (!columnNames.includes(name)) {
      return { error: fail(400, `unknown primary-key column '${name}'`, "invalid_body") };
    }
  }
  for (const name of updateNames) {
    if (!columnNames.includes(name)) {
      return { error: fail(400, `unknown column '${name}'`, "invalid_body") };
    }
    if (primaryKey.includes(name)) {
      return { error: fail(400, `cannot update primary-key column '${name}'`, "invalid_body") };
    }
  }

  const sql =
    `UPDATE ${quoteIdent(table)} SET ${updateNames.map((name) => `${quoteIdent(name)} = ?`).join(", ")} ` +
    `WHERE ${primaryKey.map((name) => `${quoteIdent(name)} = ?`).join(" AND ")}`;
  const params = [
    ...updateNames.map((name) => bindCell(updates[name])),
    ...primaryKey.map((name) => bindCell(pk[name])),
  ];

  try {
    const result = tracker.run(sql, params);
    return { updated: Number(result.changes ?? 0) };
  } catch (err) {
    const message = String(err.message || err);
    if (/constraint/i.test(message)) {
      return { error: fail(409, message, "constraint_violation") };
    }
    return { error: fail(400, `failed to update row: ${message}`, "update_failed") };
  }
}

async function handleUpdateRow({ req, params } = {}) {
  const resolved = requireColony(params?.colony);
  if (resolved.error) return resolved.error;
  const table = params?.table;

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return fail(400, "invalid JSON body", "invalid_json");
  }
  if (!isPlainObject(body)) return fail(400, "body must be a JSON object", "invalid_body");
  if (!isPlainObject(body.pk) || Object.keys(body.pk).length === 0) {
    return fail(400, "'pk' must be a non-empty object of primary-key values", "invalid_body");
  }
  if (!isPlainObject(body.updates) || Object.keys(body.updates).length === 0) {
    return fail(400, "'updates' must be a non-empty object of column values", "invalid_body");
  }
  for (const [name, value] of [...Object.entries(body.pk), ...Object.entries(body.updates)]) {
    if (!isCellValue(value)) {
      return fail(400, `value for '${name}' must be a string, number, boolean, or null`, "invalid_body");
    }
  }

  let tracker;
  try {
    tracker = openTrackerIfPresent(resolved.name);
  } catch (err) {
    return fail(500, `failed to open tracker.db: ${err.message}`, "tracker_open_failed");
  }
  if (!tracker || !tableExists(tracker, table)) {
    tracker?.close();
    return fail(404, `table '${table}' not found`, "table_not_found");
  }

  try {
    const columns = tableColumns(tracker, table);
    const primaryKey = primaryKeyOf(columns);
    if (primaryKey.length === 0) {
      return fail(400, `table '${table}' has no primary key`, "no_primary_key");
    }
    const missing = primaryKey.filter((name) => !Object.prototype.hasOwnProperty.call(body.pk, name));
    if (missing.length > 0) {
      return fail(400, `'pk' must include every primary-key column: ${missing.join(", ")}`, "invalid_body");
    }

    const result = applyRowUpdate(tracker, table, columns, primaryKey, body.pk, body.updates);
    if (result.error) return result.error;
    return { status: 200, body: { updated: result.updated } };
  } catch (err) {
    return fail(500, `failed to update tracker row: ${err.message}`, "update_failed");
  } finally {
    tracker.close();
  }
}

// --- global team database (absent in pi_hive) ------------------------------

function globalUnavailable(extra = {}) {
  return { available: false, code: GLOBAL_DATA_CODE, reason: GLOBAL_DATA_REASON, ...extra };
}

async function handleGlobalTables() {
  return { status: 200, body: { tables: [], ...globalUnavailable() } };
}

async function handleGlobalChanges() {
  return {
    status: 200,
    body: {
      cursor: null,
      covered: [],
      truncated: false,
      tables: {},
      ...globalUnavailable(),
    },
  };
}

async function handleGlobalForeignKeys() {
  return { status: 200, body: { foreign_keys: [], ...globalUnavailable() } };
}

/** Table-scoped global routes have no table to address, so they refuse. */
function globalTableUnavailable(table) {
  const label = typeof table === "string" && table ? ` table '${table}'` : "";
  return fail(
    404,
    `global data${label} is unavailable: ${GLOBAL_DATA_REASON}`,
    GLOBAL_DATA_CODE,
    { available: false },
  );
}

/** Table-scoped routes share one refusal; `params.table` is only for the message. */
function handleGlobalTableRoute({ params } = {}) {
  return globalTableUnavailable(params?.table);
}

// --- registration ----------------------------------------------------------

/**
 * Register the 19 colony-management and data-browser routes.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] dispatcher context (accepted for parity; unused)
 */
export function registerColoniesDataRoutes(registry, ctx = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registerColoniesDataRoutes requires a RouteRegistry");
  }
  // Kept intentionally unused: no pi_hive subsystem backs /global/data.
  void ctx;

  const add = (method, routePath, handler, status, description) =>
    registry.register(method, `/api${routePath}`, handler, {
      official: true,
      status,
      description,
    });

  const IMPLEMENTED = ROUTE_STATUS.IMPLEMENTED;
  const PARTIAL = ROUTE_STATUS.PARTIAL;

  add("POST", "/colonies/:colony/scaffold", handleScaffold, IMPLEMENTED,
    "creates colonies/<name> with metadata.json + worker.json and no queen boot");
  add("GET", "/colony/:colony/tools", handleGetTools, IMPLEMENTED,
    "ColonyToolsResponse: real tools.json allowlist, pi_hive lifecycle tools, no MCP catalog");
  add("PATCH", "/colony/:colony/tools", handleUpdateTools, IMPLEMENTED,
    "persists enabled_mcp_tools to the colony's tools.json sidecar");
  add("POST", "/colonies/:colony/rename", handleRename, IMPLEMENTED,
    "renames colonies/<old> (and agents/<old>) and updates metadata.json");
  add("POST", "/colonies/:colony/reveal", handleReveal, IMPLEMENTED,
    "returns the colony folder path; does not launch an OS file manager");
  add("DELETE", "/colonies/:colony", handleDelete, IMPLEMENTED,
    "soft delete by default; ?purge=true removes the colony directory");
  add("GET", "/colonies/:colony/data/tables", handleListTables, IMPLEMENTED,
    "user tables in tracker.db with columns, primary key, and row counts");
  add("GET", "/colonies/:colony/data/tables/:table/rows", handleListRows, IMPLEMENTED,
    "paginated tracker rows with limit <= 500, offset, order_by, order_dir");
  add("GET", "/colonies/:colony/data/changes", handleChanges, IMPLEMENTED,
    "_tracker_changes feed since a cursor, with trigger coverage");
  add("PATCH", "/colonies/:colony/data/tables/:table/rows", handleUpdateRow, IMPLEMENTED,
    "parameterized single-row update addressed by primary key");

  add("GET", "/global/data/tables", handleGlobalTables, PARTIAL,
    "no global team DB: valid empty {tables: []} plus an explicit reason");
  add("GET", "/global/data/changes", handleGlobalChanges, PARTIAL,
    "no global team DB: empty cursor/coverage envelope plus an explicit reason");
  add("GET", "/global/data/tables/:table/rows", handleGlobalTableRoute, PARTIAL,
    "no global team DB: explicit 404 global_data_unavailable");
  add("PATCH", "/global/data/tables/:table/rows", handleGlobalTableRoute, PARTIAL,
    "no global team DB: explicit 404 global_data_unavailable");
  add("POST", "/global/data/tables/:table/query", handleGlobalTableRoute, PARTIAL,
    "no global team DB: explicit 404 global_data_unavailable");
  add("POST", "/global/data/tables/:table/group-counts", handleGlobalTableRoute, PARTIAL,
    "no global team DB: explicit 404 global_data_unavailable");
  add("POST", "/global/data/tables/:table/rows", handleGlobalTableRoute, PARTIAL,
    "no global team DB: explicit 404 global_data_unavailable");
  add("DELETE", "/global/data/tables/:table/rows", handleGlobalTableRoute, PARTIAL,
    "no global team DB: explicit 404 global_data_unavailable");
  add("GET", "/global/data/foreign-keys", handleGlobalForeignKeys, PARTIAL,
    "no global team DB: valid empty {foreign_keys: []} plus an explicit reason");

  return registry;
}

export default registerColoniesDataRoutes;
