/**
 * Route-level tests for `/api/global/data/*` (the team DB lane).
 *
 * Each test builds a fresh RouteRegistry and one temp PI_HIVE_HOME, seeds the
 * SQLite file directly, and then asserts on response bodies and on the rows
 * that are really in the file afterwards.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RouteRegistry } from "../../src/compat/router.js";
import { GLOBAL_DATA_ROUTES, globalDbPath, registerGlobalDataRoutes } from "../../src/compat/handlers/global-data.js";
import { openTrackerAt } from "../../src/domain/tracker.js";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-global-data-")));
process.env.PI_HIVE_HOME = HOME;

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

function makeRegistry() {
  const registry = new RouteRegistry();
  registerGlobalDataRoutes(registry, {});
  return registry;
}

async function call(registry, method, pathname, { body } = {}) {
  const match = registry.match(method, pathname);
  assert.ok(match, `expected a registered route for ${method} ${pathname}`);
  const req = { method, url: pathname };
  if (body !== undefined) req.body = body;
  const result = await match.route.handler({ req, res: { headersSent: false }, params: match.params, ctx: {} });
  assert.equal(typeof result?.status, "number", `${method} ${pathname} must return a status`);
  assert.ok(result.body !== undefined, `${method} ${pathname} must return a body`);
  return result;
}

/** Fresh schema per test: drop the file so no test sees another's rows. */
function resetDb() {
  fs.rmSync(path.dirname(globalDbPath()), { recursive: true, force: true });
  const db = openTrackerAt(globalDbPath());
  db.exec(`
    CREATE TABLE leads (
      lead_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stage TEXT,
      score INTEGER,
      updated_at TEXT
    );
    CREATE TABLE interactions (
      id INTEGER PRIMARY KEY,
      lead_id TEXT,
      note TEXT,
      updated_at TEXT
    );
    CREATE TABLE notes (body TEXT);
  `);
  db.close();
}

function rows(table) {
  const db = openTrackerAt(globalDbPath());
  try {
    return db.query(`SELECT * FROM ${table}`).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test("route table pins all nine official global-data routes as implemented", () => {
  const registry = makeRegistry();
  assert.equal(GLOBAL_DATA_ROUTES.length, 9);
  for (const { method, path: routePath } of GLOBAL_DATA_ROUTES) {
    const match = registry.match(method, routePath.replace(/:table/g, "leads"));
    assert.ok(match, `${method} ${routePath} must be registered`);
    assert.equal(match.route.status, "implemented", `${method} ${routePath}`);
  }
});

test("listTables reports the live schema, primary keys and row counts", async () => {
  resetDb();
  const registry = makeRegistry();
  const result = await call(registry, "GET", "/api/global/data/tables");
  assert.equal(result.status, 200);
  const names = result.body.tables.map((table) => table.name);
  assert.deepEqual(names, ["interactions", "leads", "notes"]);
  const leads = result.body.tables.find((table) => table.name === "leads");
  assert.deepEqual(leads.primary_key, ["lead_id"]);
  assert.equal(leads.row_count, 0);
  assert.deepEqual(
    leads.columns.map((column) => column.name),
    ["lead_id", "name", "stage", "score", "updated_at"],
  );
});

test("insert mints a primary key, stamps updated_at and refuses a duplicate", async () => {
  resetDb();
  const registry = makeRegistry();

  const created = await call(registry, "POST", "/api/global/data/tables/leads/rows", {
    body: { row: { name: "Ada", stage: "new", score: 7 } },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.inserted, 1);
  assert.match(created.body.pk.lead_id, /^leads-[0-9a-f-]{36}$/);

  const stored = rows("leads");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, "Ada");
  assert.equal(stored[0].stage, "new");
  assert.equal(typeof stored[0].updated_at, "string");

  const duplicate = await call(registry, "POST", "/api/global/data/tables/leads/rows", {
    body: { row: { lead_id: created.body.pk.lead_id, name: "Ada again" } },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "conflict");
  assert.equal(duplicate.body.pk.lead_id, created.body.pk.lead_id);
  assert.equal(rows("leads").length, 1, "the conflict must not write a second row");
});

test("insert refuses unknown columns and tables without a primary key", async () => {
  resetDb();
  const registry = makeRegistry();
  const badColumn = await call(registry, "POST", "/api/global/data/tables/leads/rows", {
    body: { row: { name: "Ada", nope: 1 } },
  });
  assert.equal(badColumn.status, 400);
  assert.match(badColumn.body.error, /unknown column 'nope'/);

  const noPk = await call(registry, "POST", "/api/global/data/tables/notes/rows", {
    body: { row: { body: "hello" } },
  });
  assert.equal(noPk.status, 400);
  assert.match(noPk.body.error, /no primary key/);

  const unknown = await call(registry, "GET", "/api/global/data/tables/ghosts/rows");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "unknown_table");
});

test("update rewrites the row it is addressed at and reports the change count", async () => {
  resetDb();
  const registry = makeRegistry();
  const created = await call(registry, "POST", "/api/global/data/tables/leads/rows", {
    body: { row: { lead_id: "L1", name: "Ada", stage: "new" } },
  });
  assert.equal(created.status, 200);

  const patched = await call(registry, "PATCH", "/api/global/data/tables/leads/rows", {
    body: { pk: { lead_id: "L1" }, updates: { stage: "won", score: 9 } },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.updated, 1);
  const stored = rows("leads")[0];
  assert.equal(stored.stage, "won");
  assert.equal(stored.score, 9);
  assert.equal(stored.name, "Ada");

  const missing = await call(registry, "PATCH", "/api/global/data/tables/leads/rows", {
    body: { pk: { lead_id: "absent" }, updates: { stage: "x" } },
  });
  assert.equal(missing.body.updated, 0);

  const pkChange = await call(registry, "PATCH", "/api/global/data/tables/leads/rows", {
    body: { pk: { lead_id: "L1" }, updates: { lead_id: "L2" } },
  });
  assert.equal(pkChange.status, 400);
  assert.match(pkChange.body.error, /primary key/);

  const noPkField = await call(registry, "PATCH", "/api/global/data/tables/leads/rows", {
    body: { pk: {}, updates: { stage: "x" } },
  });
  assert.equal(noPkField.status, 400);
  assert.match(noPkField.body.error, /must include 'lead_id'/);
});

test("delete removes exactly the addressed row", async () => {
  resetDb();
  const registry = makeRegistry();
  for (const id of ["L1", "L2"]) {
    await call(registry, "POST", "/api/global/data/tables/leads/rows", { body: { row: { lead_id: id, name: id } } });
  }
  const deleted = await call(registry, "DELETE", "/api/global/data/tables/leads/rows", { body: { pk: { lead_id: "L1" } } });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, 1);
  assert.deepEqual(rows("leads").map((row) => row.lead_id), ["L2"]);
});

test("rows are paginated, ordered and capped at 500", async () => {
  resetDb();
  const registry = makeRegistry();
  for (const [id, score] of [["L1", 3], ["L2", 1], ["L3", 2]]) {
    await call(registry, "POST", "/api/global/data/tables/leads/rows", { body: { row: { lead_id: id, name: id, score } } });
  }
  const page = await call(registry, "GET", "/api/global/data/tables/leads/rows?limit=2&offset=1&order_by=score&order_dir=desc");
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 3);
  assert.equal(page.body.limit, 2);
  assert.equal(page.body.offset, 1);
  assert.deepEqual(page.body.rows.map((row) => row.lead_id), ["L3", "L2"]);

  const tooBig = await call(registry, "GET", "/api/global/data/tables/leads/rows?limit=501");
  assert.equal(tooBig.status, 400);

  const badOrder = await call(registry, "GET", "/api/global/data/tables/leads/rows?order_by=nope");
  assert.equal(badOrder.status, 400);
  assert.match(badOrder.body.error, /order_by must be a column/);
});

test("query filters, searches and sorts server-side with an accurate total", async () => {
  resetDb();
  const registry = makeRegistry();
  const seed = [
    { lead_id: "L1", name: "Ada Lovelace", stage: "new", score: 5 },
    { lead_id: "L2", name: "Grace Hopper", stage: "won", score: 9 },
    { lead_id: "L3", name: "Alan Turing", stage: "won", score: 7 },
  ];
  for (const row of seed) {
    await call(registry, "POST", "/api/global/data/tables/leads/rows", { body: { row } });
  }

  const filtered = await call(registry, "POST", "/api/global/data/tables/leads/query", {
    body: { filter: [{ column: "stage", op: "eq", value: "won" }], order_by: "score", order_dir: "desc", limit: 10 },
  });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.total, 2);
  assert.deepEqual(filtered.body.rows.map((row) => row.lead_id), ["L2", "L3"]);

  const searched = await call(registry, "POST", "/api/global/data/tables/leads/query", {
    body: { search: "hopper" },
  });
  assert.equal(searched.body.total, 1);
  assert.equal(searched.body.rows[0].lead_id, "L2");

  const contains = await call(registry, "POST", "/api/global/data/tables/leads/query", {
    body: { filter: [{ column: "name", op: "contains", value: "Turing" }] },
  });
  assert.equal(contains.body.total, 1);

  const empty = await call(registry, "POST", "/api/global/data/tables/leads/query", {
    body: { filter: [{ column: "stage", op: "is_empty" }] },
  });
  assert.equal(empty.body.total, 0);

  const badOp = await call(registry, "POST", "/api/global/data/tables/leads/query", {
    body: { filter: [{ column: "stage", op: "sounds_like", value: "won" }] },
  });
  assert.equal(badOp.status, 400);
  assert.match(badOp.body.error, /unsupported filter op/);

  const badColumn = await call(registry, "POST", "/api/global/data/tables/leads/query", {
    body: { filter: [{ column: "nope", op: "eq", value: 1 }] },
  });
  assert.equal(badColumn.status, 400);
});

test("group-counts returns distinct values highest first under the same filter", async () => {
  resetDb();
  const registry = makeRegistry();
  for (const row of [
    { lead_id: "L1", name: "a", stage: "won", score: 1 },
    { lead_id: "L2", name: "b", stage: "won", score: 1 },
    { lead_id: "L3", name: "c", stage: "new", score: 1 },
  ]) {
    await call(registry, "POST", "/api/global/data/tables/leads/rows", { body: { row } });
  }
  const all = await call(registry, "POST", "/api/global/data/tables/leads/group-counts", { body: { group_by: "stage" } });
  assert.equal(all.status, 200);
  assert.equal(all.body.table, "leads");
  assert.equal(all.body.group_by, "stage");
  assert.deepEqual(all.body.groups, [
    { value: "won", count: 2 },
    { value: "new", count: 1 },
  ]);

  const filtered = await call(registry, "POST", "/api/global/data/tables/leads/group-counts", {
    body: { group_by: "stage", filter: [{ column: "score", op: "gte", value: 1 }], search: "b" },
  });
  assert.equal(filtered.body.groups.length, 1);
  assert.deepEqual(filtered.body.groups[0], { value: "won", count: 1 });

  const bad = await call(registry, "POST", "/api/global/data/tables/leads/group-counts", { body: { group_by: "nope" } });
  assert.equal(bad.status, 400);
});

test("the change feed starts with an init cursor, then reports inserts and updates", async () => {
  resetDb();
  const registry = makeRegistry();

  const init = await call(registry, "GET", "/api/global/data/changes");
  assert.equal(init.status, 200);
  assert.equal(init.body.cursor, null);
  assert.deepEqual(init.body.tables, {});
  assert.deepEqual(init.body.covered, ["interactions", "leads"]);

  await call(registry, "POST", "/api/global/data/tables/leads/rows", { body: { row: { lead_id: "L1", name: "a" } } });
  const afterInsert = await call(registry, "GET", "/api/global/data/changes?since=0");
  assert.equal(afterInsert.status, 200);
  assert.match(afterInsert.body.cursor, /^\d+$/);
  assert.deepEqual(afterInsert.body.tables.leads.rows, [{ pk: { lead_id: "L1" }, op: "insert" }]);
  assert.equal(afterInsert.body.tables.leads.count, 1);

  const cursor = afterInsert.body.cursor;
  await call(registry, "PATCH", "/api/global/data/tables/leads/rows", {
    body: { pk: { lead_id: "L1" }, updates: { name: "b" } },
  });
  const afterUpdate = await call(registry, "GET", `/api/global/data/changes?since=${cursor}`);
  assert.deepEqual(afterUpdate.body.tables.leads.rows, [{ pk: { lead_id: "L1" }, op: "update" }]);
  assert.notEqual(afterUpdate.body.cursor, cursor);

  const quiet = await call(registry, "GET", `/api/global/data/changes?since=${afterUpdate.body.cursor}`);
  assert.deepEqual(quiet.body.tables, {});
  assert.equal(quiet.body.cursor, afterUpdate.body.cursor);

  const badCursor = await call(registry, "GET", "/api/global/data/changes?since=not-a-cursor");
  assert.equal(badCursor.status, 400);
});

test("foreign-keys infers edges from _id columns that point at real tables", async () => {
  resetDb();
  const registry = makeRegistry();
  const result = await call(registry, "GET", "/api/global/data/foreign-keys");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.foreign_keys, [
    { table: "interactions", column: "lead_id", ref_table: "leads", ref_column: "lead_id" },
  ]);
});
