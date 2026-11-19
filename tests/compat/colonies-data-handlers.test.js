/**
 * Route-level tests for the official colony-management and data-browser
 * compatibility handlers.
 *
 * Every test builds a fresh RouteRegistry and a temp PI_HIVE_HOME. Assertions
 * are against returned `{ status, body }` descriptors and the real files /
 * SQLite rows on disk — no sockets, no model, no network.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RouteRegistry } from "../../src/compat/router.js";
import {
  COLONIES_DATA_ROUTES,
  GLOBAL_DATA_CODE,
  registerColoniesDataRoutes,
} from "../../src/compat/handlers/colonies-data.js";
import { colonyDir } from "../../src/config.js";
import { colonyPaths, createColony } from "../../src/domain/colony.js";
import { openTracker } from "../../src/domain/tracker.js";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-colonies-data-")));
process.env.PI_HIVE_HOME = HOME;

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

function makeRegistry() {
  const registry = new RouteRegistry();
  registerColoniesDataRoutes(registry, {});
  return registry;
}

async function call(registry, method, pathname, { body } = {}) {
  const match = registry.match(method, pathname);
  assert.ok(match, `expected a registered route for ${method} ${pathname}`);
  const req = { method, url: pathname };
  if (body !== undefined) req.body = body;
  const result = await match.route.handler({
    req,
    res: { headersSent: false },
    params: match.params,
    pathname: match.pathname,
    ctx: {},
  });
  assert.equal(typeof result, "object", `${method} ${pathname} must return a descriptor`);
  assert.equal(typeof result.status, "number", `${method} ${pathname} must return a status`);
  assert.ok(result.body !== undefined, `${method} ${pathname} must return a body`);
  return result;
}

function seedColony(name, { tracker = true, queenId = "queen_growth" } = {}) {
  createColony({ name, queenId, goal: `goal for ${name}` });
  if (tracker) {
    const t = openTracker(name);
    t.exec(`
      CREATE TABLE leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        score INTEGER,
        active INTEGER
      );
      CREATE TABLE notes (
        slug TEXT PRIMARY KEY,
        body TEXT,
        done INTEGER
      );
      INSERT INTO leads (name, score, active) VALUES
        ('Ada', 10, 1),
        ('Bob', 20, 0),
        ('Cy', 30, 1),
        ('Dee', 40, 0),
        ('Eve', 50, 1);
      INSERT INTO notes (slug, body, done) VALUES ('n1', 'first', 0);
    `);
    t.close();
  }
  return colonyDir(name);
}

/** Add the official host's change-log tables and triggers to a colony. */
function seedChangeLog(name) {
  const t = openTracker(name);
  t.exec(`
    CREATE TABLE _tracker_registry (
      table_name TEXT PRIMARY KEY,
      write_columns TEXT NOT NULL,
      key_columns TEXT NOT NULL,
      mode TEXT NOT NULL,
      registered_at TEXT NOT NULL
    );
    CREATE TABLE _tracker_changes (
      id INTEGER PRIMARY KEY,
      table_name TEXT NOT NULL,
      pk TEXT NOT NULL,
      op TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );
    INSERT INTO _tracker_registry (table_name, write_columns, key_columns, mode, registered_at)
      VALUES ('leads', '["name"]', '["id"]', 'upsert', '2026-01-01T00:00:00Z');
    CREATE TRIGGER _tracker_chg__leads__ins AFTER INSERT ON leads BEGIN
      INSERT INTO _tracker_changes (table_name, pk, op, changed_at)
        VALUES ('leads', json_object('id', NEW.id), 'insert', strftime('%Y-%m-%dT%H:%M:%SZ','now'));
    END;
    CREATE TRIGGER _tracker_chg__leads__upd AFTER UPDATE ON leads BEGIN
      INSERT INTO _tracker_changes (table_name, pk, op, changed_at)
        VALUES ('leads', json_object('id', NEW.id), 'update', strftime('%Y-%m-%dT%H:%M:%SZ','now'));
    END;
  `);
  t.close();
}

// --- registration ----------------------------------------------------------

test("registers exactly the 19 official routes: 10 implemented, 9 partial", () => {
  const registry = makeRegistry();
  assert.equal(registry.routes.length, COLONIES_DATA_ROUTES.length);
  assert.equal(COLONIES_DATA_ROUTES.length, 19);

  for (const { method, path: pattern } of COLONIES_DATA_ROUTES) {
    const concrete = pattern.replace(":colony", "acme").replace(":table", "leads");
    const match = registry.match(method, concrete);
    assert.ok(match, `missing ${method} ${pattern}`);
    assert.equal(match.route.meta.official, true);
  }

  const counts = registry.counts();
  assert.deepEqual(counts, { implemented: 10, partial: 9, missing: 0, total: 19 });
});

// --- scaffold --------------------------------------------------------------

test("scaffold creates the colony folder without booting a queen", async () => {
  const registry = makeRegistry();
  const result = await call(registry, "POST", "/api/colonies/scaffold_test/scaffold", {
    body: { queen_name: "queen_tech" },
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    colony_id: "scaffold_test",
    scaffolded: true,
    created: true,
  });

  const dir = colonyDir("scaffold_test");
  assert.ok(fs.existsSync(dir));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
  assert.equal(meta.id, "scaffold_test");
  assert.equal(meta.queen_id, "queen_tech");
  assert.equal(meta.scaffolded, true);

  const worker = JSON.parse(fs.readFileSync(path.join(dir, "worker.json"), "utf8"));
  assert.deepEqual(worker.tools, []);
  assert.equal(worker.queen_name, "queen_tech");
  assert.ok(fs.existsSync(path.join(dir, "tracker")));
});

test("scaffold is idempotent and preserves existing metadata", async () => {
  const registry = makeRegistry();
  seedColony("scaffold_existing", { tracker: false });
  const metaPath = path.join(colonyDir("scaffold_existing"), "metadata.json");
  const before = JSON.parse(fs.readFileSync(metaPath, "utf8"));

  const result = await call(registry, "POST", "/api/colonies/scaffold_existing/scaffold", {});
  assert.equal(result.status, 200);
  assert.equal(result.body.created, false);
  assert.equal(result.body.scaffolded, true);

  const afterMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.equal(afterMeta.goal, before.goal);
  assert.equal(afterMeta.scaffolded, true);
});

test("scaffold rejects invalid names and queen slugs", async () => {
  const registry = makeRegistry();
  const badName = await call(registry, "POST", "/api/colonies/Not_A_Name/scaffold", {});
  assert.equal(badName.status, 400);

  const badQueen = await call(registry, "POST", "/api/colonies/scaffold_badq/scaffold", {
    body: { queen_name: "../escape" },
  });
  assert.equal(badQueen.status, 400);
  assert.equal(badQueen.body.code, "invalid_queen_name");
});

// --- tools -----------------------------------------------------------------

test("getTools reports the persisted allowlist and real pi_hive lifecycle tools", async () => {
  const registry = makeRegistry();
  seedColony("tools_get", { tracker: false });

  const result = await call(registry, "GET", "/api/colony/tools_get/tools");
  assert.equal(result.status, 200);
  assert.equal(result.body.colony_id, "tools_get");
  assert.equal(result.body.enabled_mcp_tools, null);
  assert.equal(result.body.stale, true);
  assert.deepEqual(result.body.synthetic, []);
  assert.deepEqual(result.body.mcp_servers, []);

  const names = result.body.lifecycle.map((tool) => tool.name);
  for (const expected of ["tracker_query", "tracker_upsert", "task_create", "write_skill", "soul_apply"]) {
    assert.ok(names.includes(expected), `lifecycle is missing ${expected}`);
  }
  for (const tool of result.body.lifecycle) {
    assert.equal(tool.editable, false);
    assert.equal(typeof tool.description, "string");
  }
});

test("getTools reads tools.json and the legacy metadata allowlist", async () => {
  const registry = makeRegistry();
  seedColony("tools_sidecar", { tracker: false });
  fs.writeFileSync(
    path.join(colonyDir("tools_sidecar"), "tools.json"),
    JSON.stringify({ enabled_mcp_tools: ["pdf_read", "web_search"] }),
  );

  const sidecar = await call(registry, "GET", "/api/colony/tools_sidecar/tools");
  assert.deepEqual(sidecar.body.enabled_mcp_tools, ["pdf_read", "web_search"]);

  seedColony("tools_legacy", { tracker: false });
  const metaPath = path.join(colonyDir("tools_legacy"), "metadata.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta.enabled_mcp_tools = [];
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  const legacy = await call(registry, "GET", "/api/colony/tools_legacy/tools");
  assert.deepEqual(legacy.body.enabled_mcp_tools, []);
});

test("getTools returns 404 for an unknown colony", async () => {
  const registry = makeRegistry();
  const result = await call(registry, "GET", "/api/colony/no_such_colony/tools");
  assert.equal(result.status, 404);
  assert.equal(result.body.code, "colony_not_found");
});

test("updateTools persists the sidecar and validates the body", async () => {
  const registry = makeRegistry();
  seedColony("tools_patch", { tracker: false });

  const set = await call(registry, "PATCH", "/api/colony/tools_patch/tools", {
    body: { enabled_mcp_tools: ["tool_a", "tool_b"] },
  });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.enabled_mcp_tools, ["tool_a", "tool_b"]);
  assert.equal(set.body.refreshed_runtimes, 0);

  const sidecar = JSON.parse(
    fs.readFileSync(path.join(colonyDir("tools_patch"), "tools.json"), "utf8"),
  );
  assert.deepEqual(sidecar.enabled_mcp_tools, ["tool_a", "tool_b"]);

  const reset = await call(registry, "PATCH", "/api/colony/tools_patch/tools", {
    body: { enabled_mcp_tools: null },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.enabled_mcp_tools, null);

  const readBack = await call(registry, "GET", "/api/colony/tools_patch/tools");
  assert.equal(readBack.body.enabled_mcp_tools, null);
});

test("updateTools rejects malformed bodies and unknown colonies", async () => {
  const registry = makeRegistry();
  seedColony("tools_patch_bad", { tracker: false });

  const missing = await call(registry, "PATCH", "/api/colony/tools_patch_bad/tools", {
    body: { enabled: [] },
  });
  assert.equal(missing.status, 400);

  const notStrings = await call(registry, "PATCH", "/api/colony/tools_patch_bad/tools", {
    body: { enabled_mcp_tools: ["ok", 3] },
  });
  assert.equal(notStrings.status, 400);

  const unknown = await call(registry, "PATCH", "/api/colony/nope_tools/tools", {
    body: { enabled_mcp_tools: [] },
  });
  assert.equal(unknown.status, 404);
});

// --- rename / reveal / delete ---------------------------------------------

test("rename moves the directory and updates metadata id", async () => {
  const registry = makeRegistry();
  seedColony("rename_from", { tracker: true });

  const result = await call(registry, "POST", "/api/colonies/rename_from/rename", {
    body: { new_name: "rename_to" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.renamed, true);
  assert.equal(result.body.old_name, "rename_from");
  assert.equal(result.body.new_name, "rename_to");

  assert.equal(fs.existsSync(colonyDir("rename_from")), false);
  assert.equal(fs.existsSync(colonyDir("rename_to")), true);
  const meta = JSON.parse(fs.readFileSync(path.join(colonyDir("rename_to"), "metadata.json"), "utf8"));
  assert.equal(meta.id, "rename_to");
  assert.ok(fs.existsSync(colonyPaths("rename_to").tracker));
});

test("rename also moves a sibling agents directory", async () => {
  const registry = makeRegistry();
  seedColony("rename_agent_from", { tracker: false });
  const agentsDir = path.join(HOME, "agents", "rename_agent_from");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "worker.json"), "{}");

  const result = await call(registry, "POST", "/api/colonies/rename_agent_from/rename", {
    body: { new_name: "rename_agent_to" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.agent_dir_moved, true);
  assert.equal(fs.existsSync(path.join(HOME, "agents", "rename_agent_to", "worker.json")), true);
});

test("rename rejects conflicts, unknown colonies, and invalid names", async () => {
  const registry = makeRegistry();
  seedColony("rename_a", { tracker: false });
  seedColony("rename_b", { tracker: false });

  const conflict = await call(registry, "POST", "/api/colonies/rename_a/rename", {
    body: { new_name: "rename_b" },
  });
  assert.equal(conflict.status, 409);

  const missing = await call(registry, "POST", "/api/colonies/rename_missing/rename", {
    body: { new_name: "rename_c" },
  });
  assert.equal(missing.status, 404);

  const invalid = await call(registry, "POST", "/api/colonies/rename_a/rename", {
    body: { new_name: "Bad Name" },
  });
  assert.equal(invalid.status, 400);

  const same = await call(registry, "POST", "/api/colonies/rename_a/rename", {
    body: { new_name: "rename_a" },
  });
  assert.equal(same.status, 200);
  assert.equal(same.body.renamed, false);
});

test("rename leaves malformed metadata untouched and says so", async () => {
  const registry = makeRegistry();
  seedColony("rename_bad_meta", { tracker: false });
  const metaPath = path.join(colonyDir("rename_bad_meta"), "metadata.json");
  fs.writeFileSync(metaPath, "{not json");

  const result = await call(registry, "POST", "/api/colonies/rename_bad_meta/rename", {
    body: { new_name: "rename_bad_meta_2" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.renamed, true);
  assert.equal(result.body.metadata_updated, false);
  assert.equal(
    fs.readFileSync(path.join(colonyDir("rename_bad_meta_2"), "metadata.json"), "utf8"),
    "{not json",
  );
});

test("soft delete refuses to clobber malformed metadata", async () => {
  const registry = makeRegistry();
  seedColony("delete_bad_meta", { tracker: false });
  const metaPath = path.join(colonyDir("delete_bad_meta"), "metadata.json");
  fs.writeFileSync(metaPath, "{not json");

  const result = await call(registry, "DELETE", "/api/colonies/delete_bad_meta");
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "delete_failed");
  assert.equal(fs.readFileSync(metaPath, "utf8"), "{not json");
});

test("reveal returns the colony path without opening a file manager", async () => {
  const registry = makeRegistry();
  seedColony("reveal_me", { tracker: false });

  const result = await call(registry, "POST", "/api/colonies/reveal_me/reveal");
  assert.equal(result.status, 200);
  assert.equal(result.body.path, path.resolve(colonyDir("reveal_me")));
  assert.equal(result.body.opened, false);

  const missing = await call(registry, "POST", "/api/colonies/reveal_none/reveal");
  assert.equal(missing.status, 404);
});

test("delete soft-deletes by default and purges on request", async () => {
  const registry = makeRegistry();
  seedColony("delete_soft", { tracker: false });

  const soft = await call(registry, "DELETE", "/api/colonies/delete_soft");
  assert.equal(soft.status, 200);
  assert.deepEqual(soft.body, { deleted: "delete_soft", purged: false });
  assert.equal(fs.existsSync(colonyDir("delete_soft")), true);
  const meta = JSON.parse(
    fs.readFileSync(path.join(colonyDir("delete_soft"), "metadata.json"), "utf8"),
  );
  assert.equal(meta.deleted, true);

  seedColony("delete_purge", { tracker: false });
  const purge = await call(registry, "DELETE", "/api/colonies/delete_purge?purge=true");
  assert.equal(purge.status, 200);
  assert.deepEqual(purge.body, { deleted: "delete_purge", purged: true });
  assert.equal(fs.existsSync(colonyDir("delete_purge")), false);

  // Idempotent when the directories are already gone.
  const again = await call(registry, "DELETE", "/api/colonies/delete_purge?purge=true");
  assert.equal(again.status, 200);
  assert.equal(again.body.purged, true);

  const invalid = await call(registry, "DELETE", "/api/colonies/%2e%2e");
  assert.equal(invalid.status, 400);
});

// --- tracker tables / rows -------------------------------------------------

test("data/tables lists only user tables with columns, primary key, and counts", async () => {
  const registry = makeRegistry();
  seedColony("data_tables", { tracker: true });

  const result = await call(registry, "GET", "/api/colonies/data_tables/data/tables");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.tables.map((table) => table.name), ["leads", "notes"]);

  const leads = result.body.tables.find((table) => table.name === "leads");
  assert.equal(leads.row_count, 5);
  assert.deepEqual(leads.primary_key, ["id"]);
  assert.deepEqual(leads.columns.map((c) => c.name), ["id", "name", "score", "active"]);
  assert.equal(leads.columns[0].type, "INTEGER");
  assert.equal(leads.columns[0].pk, 1);
  assert.equal(leads.columns[1].notnull, true);

  const notes = result.body.tables.find((table) => table.name === "notes");
  assert.deepEqual(notes.primary_key, ["slug"]);
});

test("data/tables is empty when the colony has no tracker.db", async () => {
  const registry = makeRegistry();
  seedColony("data_no_tracker", { tracker: false });
  const result = await call(registry, "GET", "/api/colonies/data_no_tracker/data/tables");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { tables: [] });
});

test("data/tables returns 404 for an unknown colony", async () => {
  const registry = makeRegistry();
  const result = await call(registry, "GET", "/api/colonies/data_missing/data/tables");
  assert.equal(result.status, 404);
});

test("data rows paginate, order, and report totals", async () => {
  const registry = makeRegistry();
  seedColony("data_rows", { tracker: true });

  const first = await call(registry, "GET", "/api/colonies/data_rows/data/tables/leads/rows");
  assert.equal(first.status, 200);
  assert.equal(first.body.total, 5);
  assert.equal(first.body.limit, 100);
  assert.equal(first.body.offset, 0);
  assert.deepEqual(first.body.primary_key, ["id"]);
  assert.deepEqual(first.body.rows.map((row) => row.name), ["Ada", "Bob", "Cy", "Dee", "Eve"]);

  const page = await call(
    registry,
    "GET",
    "/api/colonies/data_rows/data/tables/leads/rows?limit=2&offset=1&order_by=score&order_dir=desc",
  );
  assert.equal(page.status, 200);
  assert.equal(page.body.limit, 2);
  assert.equal(page.body.offset, 1);
  assert.deepEqual(page.body.rows.map((row) => row.name), ["Dee", "Cy"]);

  const clamped = await call(
    registry,
    "GET",
    "/api/colonies/data_rows/data/tables/leads/rows?limit=5000",
  );
  assert.equal(clamped.status, 200);
  assert.equal(clamped.body.limit, 500);
});

test("data rows reject injection-shaped identifiers and bad paging params", async () => {
  const registry = makeRegistry();
  seedColony("data_rows_bad", { tracker: true });

  for (const [method, pathname] of [
    ["GET", "/api/colonies/data_rows_bad/data/tables/leads%3B%20DROP%20TABLE%20leads/rows"],
    ["GET", "/api/colonies/data_rows_bad/data/tables/_tracker_changes/rows"],
    ["GET", "/api/colonies/data_rows_bad/data/tables/missing_table/rows"],
  ]) {
    const result = await call(registry, method, pathname);
    assert.equal(result.status, 404, pathname);
  }

  const badOrder = await call(
    registry,
    "GET",
    "/api/colonies/data_rows_bad/data/tables/leads/rows?order_by=id%3B%20DROP%20TABLE%20leads",
  );
  assert.equal(badOrder.status, 400);

  const badDir = await call(
    registry,
    "GET",
    "/api/colonies/data_rows_bad/data/tables/leads/rows?order_dir=sideways",
  );
  assert.equal(badDir.status, 400);

  const badLimit = await call(
    registry,
    "GET",
    "/api/colonies/data_rows_bad/data/tables/leads/rows?limit=abc",
  );
  assert.equal(badLimit.status, 400);

  const zeroLimit = await call(
    registry,
    "GET",
    "/api/colonies/data_rows_bad/data/tables/leads/rows?limit=0",
  );
  assert.equal(zeroLimit.status, 400);
});

// --- change feed -----------------------------------------------------------

test("data/changes init returns cursor and coverage without history", async () => {
  const registry = makeRegistry();
  seedColony("changes_init", { tracker: true });
  seedChangeLog("changes_init");

  const t = openTracker("changes_init");
  t.exec("INSERT INTO leads (name, score, active) VALUES ('Zoe', 90, 1)");
  t.close();

  const init = await call(registry, "GET", "/api/colonies/changes_init/data/changes?since=-1");
  assert.equal(init.status, 200);
  assert.deepEqual(init.body.covered, ["leads"]);
  assert.equal(init.body.truncated, false);
  assert.deepEqual(init.body.tables, {});
  assert.equal(init.body.cursor, 1);

  const history = await call(registry, "GET", "/api/colonies/changes_init/data/changes?since=0");
  assert.equal(history.status, 200);
  assert.equal(history.body.cursor, 1);
  assert.equal(history.body.tables.leads.count, 1);
  assert.deepEqual(history.body.tables.leads.rows, [{ pk: { id: 6 }, op: "insert" }]);

  const current = await call(
    registry,
    "GET",
    `/api/colonies/changes_init/data/changes?since=${history.body.cursor}`,
  );
  assert.deepEqual(current.body.tables, {});
});

test("data/changes dedupes repeated writes and flags a pruned window", async () => {
  const registry = makeRegistry();
  seedColony("changes_dedupe", { tracker: true });
  seedChangeLog("changes_dedupe");

  const t = openTracker("changes_dedupe");
  t.run("INSERT INTO leads (name, score, active) VALUES (?, ?, ?)", ["Zoe", 90, 1]);
  t.run("UPDATE leads SET score = ? WHERE id = ?", [91, 6]);
  t.run("UPDATE leads SET score = ? WHERE id = ?", [92, 6]);
  // Simulate a pruned log: drop the first two entries.
  t.exec("DELETE FROM _tracker_changes WHERE id <= 2");
  t.close();

  const result = await call(registry, "GET", "/api/colonies/changes_dedupe/data/changes?since=0");
  assert.equal(result.status, 200);
  assert.equal(result.body.truncated, true);
  assert.equal(result.body.tables.leads.count, 1);
  assert.deepEqual(result.body.tables.leads.rows, [{ pk: { id: 6 }, op: "update" }]);
});

test("data/changes requires since and tolerates a tracker without a log", async () => {
  const registry = makeRegistry();
  seedColony("changes_plain", { tracker: true });

  const missing = await call(registry, "GET", "/api/colonies/changes_plain/data/changes");
  assert.equal(missing.status, 400);

  const empty = await call(registry, "GET", "/api/colonies/changes_plain/data/changes?since=-1");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { cursor: 0, covered: [], truncated: false, tables: {} });

  seedColony("changes_no_tracker", { tracker: false });
  const noDb = await call(registry, "GET", "/api/colonies/changes_no_tracker/data/changes?since=0");
  assert.equal(noDb.status, 200);
  assert.deepEqual(noDb.body, { cursor: 0, covered: [], truncated: false, tables: {} });
});

// --- row updates -----------------------------------------------------------

test("PATCH rows updates one row by primary key and persists it", async () => {
  const registry = makeRegistry();
  seedColony("data_update", { tracker: true });

  const result = await call(registry, "PATCH", "/api/colonies/data_update/data/tables/leads/rows", {
    body: { pk: { id: 2 }, updates: { name: "Bobby", score: 21 } },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { updated: 1 });

  const readBack = await call(
    registry,
    "GET",
    "/api/colonies/data_update/data/tables/leads/rows?limit=10",
  );
  const bob = readBack.body.rows.find((row) => row.id === 2);
  assert.equal(bob.name, "Bobby");
  assert.equal(bob.score, 21);

  const missing = await call(registry, "PATCH", "/api/colonies/data_update/data/tables/leads/rows", {
    body: { pk: { id: 999 }, updates: { name: "Nobody" } },
  });
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body, { updated: 0 });
});

test("PATCH rows binds booleans and nulls safely", async () => {
  const registry = makeRegistry();
  seedColony("data_update_types", { tracker: true });

  const result = await call(
    registry,
    "PATCH",
    "/api/colonies/data_update_types/data/tables/notes/rows",
    { body: { pk: { slug: "n1" }, updates: { done: true, body: null } } },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { updated: 1 });

  const readBack = await call(
    registry,
    "GET",
    "/api/colonies/data_update_types/data/tables/notes/rows",
  );
  assert.equal(readBack.body.rows[0].done, 1);
  assert.equal(readBack.body.rows[0].body, null);
});

test("PATCH rows rejects primary-key edits, unknown columns, and missing keys", async () => {
  const registry = makeRegistry();
  seedColony("data_update_bad", { tracker: true });

  const pkEdit = await call(
    registry,
    "PATCH",
    "/api/colonies/data_update_bad/data/tables/leads/rows",
    { body: { pk: { id: 1 }, updates: { id: 2 } } },
  );
  assert.equal(pkEdit.status, 400);

  const unknownColumn = await call(
    registry,
    "PATCH",
    "/api/colonies/data_update_bad/data/tables/leads/rows",
    { body: { pk: { id: 1 }, updates: { nope: 1 } } },
  );
  assert.equal(unknownColumn.status, 400);

  const missingPk = await call(
    registry,
    "PATCH",
    "/api/colonies/data_update_bad/data/tables/leads/rows",
    { body: { pk: { name: "Ada" }, updates: { score: 1 } } },
  );
  assert.equal(missingPk.status, 400);

  const emptyUpdates = await call(
    registry,
    "PATCH",
    "/api/colonies/data_update_bad/data/tables/leads/rows",
    { body: { pk: { id: 1 }, updates: {} } },
  );
  assert.equal(emptyUpdates.status, 400);

  const badValue = await call(
    registry,
    "PATCH",
    "/api/colonies/data_update_bad/data/tables/leads/rows",
    { body: { pk: { id: 1 }, updates: { score: { nested: true } } } },
  );
  assert.equal(badValue.status, 400);

  const badTable = await call(
    registry,
    "PATCH",
    "/api/colonies/data_update_bad/data/tables/missing/rows",
    { body: { pk: { id: 1 }, updates: { score: 2 } } },
  );
  assert.equal(badTable.status, 404);
});

test("PATCH rows refuses a table without a primary key", async () => {
  const registry = makeRegistry();
  seedColony("data_update_nopk", { tracker: true });
  const t = openTracker("data_update_nopk");
  t.exec("CREATE TABLE loose (value TEXT)");
  t.exec("INSERT INTO loose (value) VALUES ('a')");
  t.close();

  const result = await call(
    registry,
    "PATCH",
    "/api/colonies/data_update_nopk/data/tables/loose/rows",
    { body: { pk: { value: "a" }, updates: { value: "b" } } },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "no_primary_key");
});

test("PATCH rows maps constraint violations to 409", async () => {
  const registry = makeRegistry();
  seedColony("data_update_conflict", { tracker: true });
  const t = openTracker("data_update_conflict");
  t.exec("CREATE TABLE uniq (id INTEGER PRIMARY KEY, code TEXT UNIQUE)");
  t.exec("INSERT INTO uniq (id, code) VALUES (1, 'a'), (2, 'b')");
  t.close();

  const result = await call(
    registry,
    "PATCH",
    "/api/colonies/data_update_conflict/data/tables/uniq/rows",
    { body: { pk: { id: 2 }, updates: { code: "a" } } },
  );
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "constraint_violation");
});

// --- global data (absent) --------------------------------------------------

test("global collection routes return valid empty schemas with an explicit reason", async () => {
  const registry = makeRegistry();

  const tables = await call(registry, "GET", "/api/global/data/tables");
  assert.equal(tables.status, 200);
  assert.deepEqual(tables.body.tables, []);
  assert.equal(tables.body.available, false);
  assert.equal(tables.body.code, GLOBAL_DATA_CODE);
  assert.equal(typeof tables.body.reason, "string");

  const changes = await call(registry, "GET", "/api/global/data/changes");
  assert.equal(changes.status, 200);
  assert.deepEqual(changes.body, {
    cursor: null,
    covered: [],
    truncated: false,
    tables: {},
    available: false,
    code: GLOBAL_DATA_CODE,
    reason: changes.body.reason,
  });

  const fks = await call(registry, "GET", "/api/global/data/foreign-keys");
  assert.equal(fks.status, 200);
  assert.deepEqual(fks.body.foreign_keys, []);
  assert.equal(fks.body.available, false);
});

test("global table-scoped routes refuse with 404 and never invent rows", async () => {
  const registry = makeRegistry();
  const cases = [
    ["GET", "/api/global/data/tables/leads/rows"],
    ["PATCH", "/api/global/data/tables/leads/rows"],
    ["POST", "/api/global/data/tables/leads/query"],
    ["POST", "/api/global/data/tables/leads/group-counts"],
    ["POST", "/api/global/data/tables/leads/rows"],
    ["DELETE", "/api/global/data/tables/leads/rows"],
  ];

  for (const [method, pathname] of cases) {
    const result = await call(registry, method, pathname, {
      body: { row: { name: "fake" }, pk: { id: 1 } },
    });
    assert.equal(result.status, 404, `${method} ${pathname}`);
    assert.equal(result.body.code, GLOBAL_DATA_CODE);
    assert.equal(result.body.available, false);
    assert.equal(result.body.rows, undefined);
    assert.ok(result.body.error.includes("leads"));
  }
});
