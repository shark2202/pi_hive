/**
 * The team-wide SQLite DB behind `/api/global/data/*`.
 *
 * Hive proxies this surface to a cloud team DB. pi_hive keeps the same
 * row-level shape against a local file, `hiveHome()/global-data/team.db`, so the
 * official Data page works without a cloud account. Tables, columns, primary
 * keys and foreign-key edges are all read from the live schema; every value is
 * bound as a parameter and every identifier is validated first.
 *
 * The row-level feed is our own append-only log `_global_changes` (the official
 * cursor is a max-`updated_at` stamp; ours is the last log id, passed back
 * verbatim, which the client treats the same way).
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import { hiveHome } from "../../config.js";
import { openTrackerAt } from "../../domain/tracker.js";
import { ROUTE_STATUS } from "../router.js";
import {
  bindCell,
  cellToJson,
  fail,
  intQuery,
  isCellValue,
  isPlainObject,
  listUserTables,
  plainRow,
  primaryKeyOf,
  queryParam,
  quoteIdent,
  readJsonBody,
  rowsOrderClause,
  tableColumns,
  tableExists,
  tableOverview,
} from "./colonies-data.js";

const MAX_ROW_LIMIT = 500;
const DEFAULT_ROW_LIMIT = 100;
const CHANGE_SCAN_LIMIT = 2000;
const UPDATED_AT = "updated_at";
const CHANGE_LOG = "_global_changes";

/** Absolute path of the team DB; also what the report cites. */
export function globalDbPath() {
  return path.join(hiveHome(), "global-data", "team.db");
}

function openDb() {
  const db = openTrackerAt(globalDbPath());
  db.exec(`CREATE TABLE IF NOT EXISTS ${CHANGE_LOG} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    pk TEXT NOT NULL,
    op TEXT NOT NULL,
    changed_at TEXT NOT NULL
  )`);
  return db;
}

function withDb(fn) {
  let db;
  try {
    db = openDb();
  } catch (err) {
    return fail(500, `failed to open the global DB: ${err.message}`, "global_data_unavailable");
  }
  try {
    return fn(db);
  } catch (err) {
    return fail(500, `global data error: ${err.message}`, "global_data_error");
  } finally {
    db.close();
  }
}

function requireTable(db, table) {
  if (!tableExists(db, table)) {
    return { error: fail(404, `unknown table '${table}'`, "unknown_table") };
  }
  const columns = tableColumns(db, table);
  return { columns, primaryKey: primaryKeyOf(columns) };
}

function pkWhere(primaryKey, pk) {
  return {
    clause: primaryKey.map((column) => `${quoteIdent(column)} = ?`).join(" AND "),
    values: primaryKey.map((column) => bindCell(pk[column])),
  };
}

function pkObject(primaryKey, row) {
  const out = {};
  for (const column of primaryKey) out[column] = row[column] ?? null;
  return out;
}

function recordChange(db, table, pk, op) {
  db.run(
    `INSERT INTO ${CHANGE_LOG} (table_name, pk, op, changed_at) VALUES (?, ?, ?, ?)`,
    [table, JSON.stringify(pk), op, new Date().toISOString()],
  );
}

/** Tables that can appear in the feed: they have a primary key and a stamp. */
function coveredTables(db) {
  return listUserTables(db).filter((table) => {
    const columns = tableColumns(db, table);
    return primaryKeyOf(columns).length > 0 && columns.some((column) => column.name === UPDATED_AT);
  });
}

function filterClauses(columns, filter) {
  if (filter === undefined || filter === null) return { clauses: [], values: [] };
  if (!Array.isArray(filter)) {
    return { error: fail(400, "filter must be an array", "invalid_query") };
  }
  const clauses = [];
  const values = [];
  for (const condition of filter) {
    if (!isPlainObject(condition) || typeof condition.column !== "string") {
      return { error: fail(400, "each filter needs a column", "invalid_query") };
    }
    if (!columns.some((column) => column.name === condition.column)) {
      return { error: fail(400, `unknown column '${condition.column}'`, "invalid_query") };
    }
    const op = String(condition.op ?? "eq");
    const column = quoteIdent(condition.column);
    const nullary = op === "is_empty" || op === "is_not_empty";
    if (!nullary) {
      if (!isCellValue(condition.value)) {
        return { error: fail(400, `filter on '${condition.column}' needs a scalar value`, "invalid_query") };
      }
      values.push(bindCell(condition.value));
    }
    switch (op) {
      case "eq":
        clauses.push(`${column} = ?`);
        break;
      case "ne":
        clauses.push(`${column} != ?`);
        break;
      case "gt":
        clauses.push(`${column} > ?`);
        break;
      case "gte":
        clauses.push(`${column} >= ?`);
        break;
      case "lt":
        clauses.push(`${column} < ?`);
        break;
      case "lte":
        clauses.push(`${column} <= ?`);
        break;
      case "contains":
        clauses.push(`CAST(${column} AS TEXT) LIKE ?`);
        values[values.length - 1] = `%${condition.value}%`;
        break;
      case "starts_with":
        clauses.push(`CAST(${column} AS TEXT) LIKE ?`);
        values[values.length - 1] = `${condition.value}%`;
        break;
      case "ends_with":
        clauses.push(`CAST(${column} AS TEXT) LIKE ?`);
        values[values.length - 1] = `%${condition.value}`;
        break;
      case "is_empty":
        clauses.push(`(${column} IS NULL OR ${column} = '')`);
        break;
      case "is_not_empty":
        clauses.push(`(${column} IS NOT NULL AND ${column} != '')`);
        break;
      default:
        return { error: fail(400, `unsupported filter op '${op}'`, "invalid_query") };
    }
  }
  return { clauses, values };
}

function whereOf(columns, filter, search) {
  const built = filterClauses(columns, filter);
  if (built.error) return built;
  const clauses = [...built.clauses];
  const values = [...built.values];
  if (typeof search === "string" && search.trim() !== "") {
    const like = `%${search.trim()}%`;
    clauses.push(`(${columns.map((c) => `CAST(${quoteIdent(c.name)} AS TEXT) LIKE ?`).join(" OR ")})`);
    for (let i = 0; i < columns.length; i += 1) values.push(like);
  }
  return { clause: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}

function rowsBody(db, table, columns, primaryKey, req, where, order) {
  const limit = intQuery(req, "limit", { min: 1, max: MAX_ROW_LIMIT, fallback: DEFAULT_ROW_LIMIT });
  if (limit.error) return limit.error;
  const offset = intQuery(req, "offset", { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
  if (offset.error) return offset.error;
  const total = Number(
    db.query(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}${where.clause}`, where.values)[0]?.count ?? 0,
  );
  const rows = db
    .query(
      `SELECT * FROM ${quoteIdent(table)}${where.clause}${order} LIMIT ? OFFSET ?`,
      [...where.values, limit.value, offset.value],
    )
    .map(plainRow);
  return {
    status: 200,
    body: { table, columns, primary_key: primaryKey, rows, total, limit: limit.value, offset: offset.value },
  };
}

// --- handlers --------------------------------------------------------------

async function listTables() {
  return withDb((db) => ({
    status: 200,
    body: { tables: listUserTables(db).map((table) => tableOverview(db, table)) },
  }));
}

async function listRows({ req, params } = {}) {
  return withDb((db) => {
    const resolved = requireTable(db, params?.table);
    if (resolved.error) return resolved.error;
    const order = rowsOrderClause(resolved.columns, resolved.primaryKey, req);
    if (order.error) return order.error;
    return rowsBody(db, params.table, resolved.columns, resolved.primaryKey, req, { clause: "", values: [] }, order.clause);
  });
}

async function queryRows({ req, params } = {}) {
  const parsed = await readJsonBody(req);
  return withDb((db) => {
    const resolved = requireTable(db, params?.table);
    if (resolved.error) return resolved.error;
    const where = whereOf(resolved.columns, parsed.filter, parsed.search);
    if (where.error) return where.error;
    const orderBy = typeof parsed.order_by === "string" && parsed.order_by.trim() ? parsed.order_by.trim() : null;
    if (orderBy && !resolved.columns.some((column) => column.name === orderBy)) {
      return fail(400, `order_by must be a column of this table`, "invalid_query");
    }
    const dir = String(parsed.order_dir ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const order = orderBy
      ? ` ORDER BY ${quoteIdent(orderBy)} ${dir}`
      : resolved.primaryKey.length
        ? ` ORDER BY ${resolved.primaryKey.map(quoteIdent).join(", ")} ASC`
        : "";
    return rowsBody(db, params.table, resolved.columns, resolved.primaryKey, { query: { limit: parsed.limit, offset: parsed.offset } }, where, order);
  });
}

async function groupCounts({ req, params } = {}) {
  const parsed = await readJsonBody(req);
  return withDb((db) => {
    const resolved = requireTable(db, params?.table);
    if (resolved.error) return resolved.error;
    const groupBy = typeof parsed.group_by === "string" ? parsed.group_by.trim() : "";
    if (!resolved.columns.some((column) => column.name === groupBy)) {
      return fail(400, "group_by must be a column of this table", "invalid_query");
    }
    const where = whereOf(resolved.columns, parsed.filter, parsed.search);
    if (where.error) return where.error;
    const groups = db
      .query(
        `SELECT ${quoteIdent(groupBy)} AS value, COUNT(*) AS count FROM ${quoteIdent(params.table)}` +
          `${where.clause} GROUP BY ${quoteIdent(groupBy)} ORDER BY count DESC, value ASC`,
        where.values,
      )
      .map((row) => ({ value: cellToJson(row.value), count: Number(row.count) }));
    return { status: 200, body: { table: params.table, group_by: groupBy, groups } };
  });
}

function mintPk(table, primaryKey, row) {
  const pk = {};
  for (const column of primaryKey) {
    if (row[column] !== undefined && row[column] !== null && row[column] !== "") {
      pk[column] = row[column];
    } else {
      pk[column] = primaryKey.length === 1 ? `${table}-${randomUUID()}` : `${primaryKey.length}-${randomUUID()}`;
    }
  }
  return pk;
}

async function insertRow({ req, params } = {}) {
  const parsed = await readJsonBody(req);
  const row = parsed?.row;
  if (!isPlainObject(row)) return fail(400, "row must be an object", "invalid_request");
  return withDb((db) => {
    const resolved = requireTable(db, params?.table);
    if (resolved.error) return resolved.error;
    if (resolved.primaryKey.length === 0) {
      return fail(400, `table '${params.table}' has no primary key`, "invalid_table");
    }
    const known = new Set(resolved.columns.map((column) => column.name));
    for (const [column, value] of Object.entries(row)) {
      if (!known.has(column)) return fail(400, `unknown column '${column}'`, "invalid_request");
      if (!isCellValue(value)) return fail(400, `'${column}' is not a scalar value`, "invalid_request");
    }
    const pk = mintPk(params.table, resolved.primaryKey, row);
    const where = pkWhere(resolved.primaryKey, pk);
    if (db.query(`SELECT 1 AS hit FROM ${quoteIdent(params.table)} WHERE ${where.clause}`, where.values).length) {
      return { status: 409, body: { error: "conflict", pk } };
    }
    const insert = { ...row, ...pk };
    if (known.has(UPDATED_AT)) insert[UPDATED_AT] = new Date().toISOString();
    const columns = Object.keys(insert);
    db.run(
      `INSERT INTO ${quoteIdent(params.table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      columns.map((column) => bindCell(insert[column])),
    );
    recordChange(db, params.table, pk, "insert");
    return { status: 200, body: { inserted: 1, pk } };
  });
}

async function updateRow({ req, params } = {}) {
  const parsed = await readJsonBody(req);
  const pk = parsed?.pk;
  const updates = parsed?.updates;
  if (!isPlainObject(pk) || !isPlainObject(updates)) {
    return fail(400, "pk and updates must be objects", "invalid_request");
  }
  return withDb((db) => {
    const resolved = requireTable(db, params?.table);
    if (resolved.error) return resolved.error;
    if (resolved.primaryKey.length === 0) {
      return fail(400, `table '${params.table}' has no primary key`, "invalid_table");
    }
    for (const column of resolved.primaryKey) {
      if (pk[column] === undefined) return fail(400, `pk must include '${column}'`, "invalid_request");
    }
    const setColumns = Object.keys(updates);
    if (setColumns.length === 0) return fail(400, "updates must not be empty", "invalid_request");
    const known = new Set(resolved.columns.map((column) => column.name));
    for (const column of setColumns) {
      if (!known.has(column)) return fail(400, `unknown column '${column}'`, "invalid_request");
      if (resolved.primaryKey.includes(column)) return fail(400, "updates cannot change primary key columns", "invalid_request");
      if (!isCellValue(updates[column])) return fail(400, `'${column}' is not a scalar value`, "invalid_request");
    }
    if (known.has(UPDATED_AT)) updates[UPDATED_AT] = new Date().toISOString();
    const all = Object.keys(updates);
    const where = pkWhere(resolved.primaryKey, pk);
    const result = db.run(
      `UPDATE ${quoteIdent(params.table)} SET ${all.map((c) => `${quoteIdent(c)} = ?`).join(", ")} WHERE ${where.clause}`,
      [...all.map((column) => bindCell(updates[column])), ...where.values],
    );
    const updated = Number(result?.changes ?? 0);
    if (updated > 0) recordChange(db, params.table, pkObject(resolved.primaryKey, pk), "update");
    return { status: 200, body: { updated } };
  });
}

async function deleteRow({ req, params } = {}) {
  const parsed = await readJsonBody(req);
  const pk = parsed?.pk;
  if (!isPlainObject(pk)) return fail(400, "pk must be an object", "invalid_request");
  return withDb((db) => {
    const resolved = requireTable(db, params?.table);
    if (resolved.error) return resolved.error;
    if (resolved.primaryKey.length === 0) {
      return fail(400, `table '${params.table}' has no primary key`, "invalid_table");
    }
    for (const column of resolved.primaryKey) {
      if (pk[column] === undefined) return fail(400, `pk must include '${column}'`, "invalid_request");
    }
    const where = pkWhere(resolved.primaryKey, pk);
    const result = db.run(`DELETE FROM ${quoteIdent(params.table)} WHERE ${where.clause}`, where.values);
    return { status: 200, body: { deleted: Number(result?.changes ?? 0) } };
  });
}

async function listChanges({ req } = {}) {
  const since = queryParam(req, "since");
  return withDb((db) => {
    const covered = coveredTables(db);
    const max = Number(db.query(`SELECT COALESCE(MAX(id), 0) AS id FROM ${CHANGE_LOG}`)[0]?.id ?? 0);
    if (since === undefined || since === null || String(since).trim() === "") {
      return { status: 200, body: { cursor: max ? String(max) : null, covered, truncated: false, tables: {} } };
    }
    const after = Number(String(since).trim());
    if (!Number.isSafeInteger(after) || after < 0) {
      return fail(400, "since must be a cursor returned by this route", "invalid_query");
    }
    const rows = db.query(
      `SELECT id, table_name, pk, op FROM ${CHANGE_LOG} WHERE id > ? ORDER BY id ASC LIMIT ?`,
      [after, CHANGE_SCAN_LIMIT + 1],
    );
    const truncated = rows.length > CHANGE_SCAN_LIMIT;
    const tables = {};
    const seen = new Map();
    for (const row of rows.slice(0, CHANGE_SCAN_LIMIT)) {
      const bucket = covered.includes(row.table_name) ? row.table_name : null;
      if (!bucket) continue;
      const entry = tables[bucket] ?? { count: 0, rows: [] };
      let pk = {};
      try {
        pk = JSON.parse(row.pk);
      } catch {
        pk = {};
      }
      const key = `${bucket} ${row.pk} ${row.op}`;
      const existing = seen.get(key);
      if (existing) {
        existing.op = row.op;
        continue;
      }
      const record = { pk, op: row.op };
      seen.set(key, record);
      entry.rows.push(record);
      entry.count = entry.rows.length;
      tables[bucket] = entry;
    }
    const cursor = rows.length ? String(rows[Math.min(rows.length, CHANGE_SCAN_LIMIT) - 1].id) : String(after);
    return { status: 200, body: { cursor, covered, truncated, tables } };
  });
}

async function foreignKeys() {
  return withDb((db) => {
    const tables = listUserTables(db);
    const edges = [];
    for (const table of tables) {
      for (const column of tableColumns(db, table)) {
        if (!column.name.endsWith("_id") || column.name === "id") continue;
        const base = column.name.slice(0, -3);
        const target = tables.includes(base) ? base : tables.includes(`${base}s`) ? `${base}s` : null;
        if (!target) continue;
        // A self reference (leads.lead_id → leads.lead_id) is the primary key, not an edge.
        if (target === table && column.name === primaryKeyOf(tableColumns(db, table))[0]) continue;
        const targetPk = primaryKeyOf(tableColumns(db, target));
        if (targetPk.length !== 1) continue;
        edges.push({ table, column: column.name, ref_table: target, ref_column: targetPk[0] });
      }
    }
    return { status: 200, body: { foreign_keys: edges } };
  });
}

const ROUTE_TABLE = [
  ["GET", "/api/global/data/tables", listTables, "tables in hiveHome()/global-data/team.db with columns, primary key and row counts"],
  ["GET", "/api/global/data/changes", listChanges, "_global_changes feed after a cursor; no cursor is the init call (cursor + coverage only)"],
  ["GET", "/api/global/data/tables/:table/rows", listRows, "paginated rows, limit <= 500, order_by/order_dir, 404 for an unknown table"],
  ["PATCH", "/api/global/data/tables/:table/rows", updateRow, "single-row update addressed by the full primary key; stamps updated_at"],
  ["POST", "/api/global/data/tables/:table/query", queryRows, "server-side filter/search/sort; 11 comparison ops on live columns"],
  ["POST", "/api/global/data/tables/:table/group-counts", groupCounts, "distinct values of group_by with accurate counts, highest first"],
  ["POST", "/api/global/data/tables/:table/rows", insertRow, "true insert with a minted primary key; 409 {error:'conflict', pk} on duplicates"],
  ["DELETE", "/api/global/data/tables/:table/rows", deleteRow, "delete one row by primary key"],
  ["GET", "/api/global/data/foreign-keys", foreignKeys, "edges inferred from <table>_id columns pointing at real tables"],
];

/** Method + path pins, for contract checks and tests. */
export const GLOBAL_DATA_ROUTES = Object.freeze(
  ROUTE_TABLE.map(([method, routePath]) => Object.freeze({ method, path: routePath })),
);

/**
 * Register the nine `/api/global/data/*` routes.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] dispatcher context (unused: these read the filesystem)
 */
export function registerGlobalDataRoutes(registry, ctx = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registerGlobalDataRoutes requires a RouteRegistry");
  }
  void ctx;
  for (const [method, routePath, handler, description] of ROUTE_TABLE) {
    registry.register(method, routePath, handler, {
      status: ROUTE_STATUS.IMPLEMENTED,
      official: true,
      description,
    });
  }
  return registry;
}

export default registerGlobalDataRoutes;
