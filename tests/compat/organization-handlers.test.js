import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RouteRegistry } from "../../src/compat/router.js";
import { colonyDir, coloniesDir } from "../../src/config.js";
import { createColony } from "../../src/domain/colony.js";
import { createTask } from "../../src/domain/plan.js";
import {
  BUILT_IN_QUEENS,
  DISCOVER_CATEGORY,
  buildDiscoverResult,
  listColonySummaries,
  registerOrganizationRoutes,
} from "../../src/compat/handlers/organization.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-organization-"));
let homeCounter = 0;

after(() => {
  delete process.env.PI_HIVE_HOME;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Fresh PI_HIVE_HOME per test; config reads the env at call time. */
function useHome() {
  const home = path.join(TMP_ROOT, `home-${(homeCounter += 1)}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.PI_HIVE_HOME = home;
  return home;
}

function makeRegistry(ctx = {}) {
  const registry = new RouteRegistry();
  registerOrganizationRoutes(registry, ctx);
  return registry;
}

/** Call a registered handler with fake req/res and assert it only returns a descriptor. */
async function invoke(registry, method, pathname, ctx) {
  const match = registry.match(method, pathname);
  assert.ok(match, `no route for ${method} ${pathname}`);

  const req = { method, url: pathname, headers: {} };
  let wrote = false;
  const res = {
    headersSent: false,
    writeHead() {
      wrote = true;
      res.headersSent = true;
    },
    end() {
      wrote = true;
    },
  };
  const args = { req, res, params: match.params };
  if (ctx !== undefined) args.ctx = ctx;

  const result = await match.route.handler(args);
  assert.equal(wrote, false, `${method} ${pathname} wrote to res instead of returning a descriptor`);
  assert.equal(res.headersSent, false);
  assert.equal(result.status, 200, `${method} ${pathname} status`);
  assert.equal(typeof result.body, "object");
  return result.body;
}

/**
 * Four colonies: acme (allowlist), beta (none), gamma (explicit empty
 * allowlist), zombie (soft-deleted). Plus a malformed metadata dir and a stray
 * file that must not break or pollute the list.
 */
function seedColonies() {
  createColony({ name: "acme", queenId: "queen_tech", goal: "ship a vertical slice" });
  fs.writeFileSync(
    path.join(colonyDir("acme"), "tools.json"),
    JSON.stringify({ enabled_mcp_tools: ["pdf_read", "web_search"], updated_at: new Date().toISOString() }),
  );

  createColony({ name: "beta", queenId: "queen_finance", goal: "" });

  createColony({ name: "gamma", queenId: "queen_ops", goal: "keep the lights on" });
  fs.writeFileSync(
    path.join(colonyDir("gamma"), "tools.json"),
    JSON.stringify({ enabled_mcp_tools: [], updated_at: new Date().toISOString() }),
  );

  createColony({ name: "zombie", queenId: "queen_growth", goal: "gone" });
  const zombieMetaPath = path.join(colonyDir("zombie"), "metadata.json");
  const zombieMeta = JSON.parse(fs.readFileSync(zombieMetaPath, "utf8"));
  zombieMeta.deleted = true;
  fs.writeFileSync(zombieMetaPath, JSON.stringify(zombieMeta, null, 2));

  fs.mkdirSync(path.join(coloniesDir(), "broken"), { recursive: true });
  fs.writeFileSync(path.join(coloniesDir(), "broken", "metadata.json"), "{not json");

  fs.writeFileSync(path.join(coloniesDir(), "notes.txt"), "ignore me");
}

function readMeta(name) {
  return JSON.parse(fs.readFileSync(path.join(colonyDir(name), "metadata.json"), "utf8"));
}

test("registers the official organization routes with honest statuses", () => {
  const registry = new RouteRegistry();
  const returned = registerOrganizationRoutes(registry, {});
  assert.equal(returned, registry);

  const expected = new Map([
    ["GET /api/queen/profiles", "implemented"],
    ["GET /api/colonies/tools-index", "implemented"],
    ["GET /api/colonies", "partial"],
    ["GET /api/sessions", "implemented"],
    ["GET /api/sessions/history", "implemented"],
    ["GET /api/discover", "implemented"],
  ]);

  for (const [key, status] of expected) {
    const [method, routePath] = key.split(" ");
    const match = registry.match(method, routePath);
    assert.ok(match, `missing ${key}`);
    assert.equal(match.route.status, status, key);
    assert.equal(match.route.meta.official, true, `${key} must be marked official`);
    assert.equal(typeof match.route.handler, "function", `${key} needs a handler`);
  }

  assert.equal(registry.list().length, expected.size);
  assert.ok(registry.match("HEAD", "/api/queen/profiles"), "HEAD falls back to the GET route");

  assert.throws(() => registerOrganizationRoutes(null), /RouteRegistry/);
  assert.throws(() => registerOrganizationRoutes({}, {}), /RouteRegistry/);
});

test("queen profiles expose exactly pi_hive's four built-in queens", async () => {
  useHome();
  const body = await invoke(makeRegistry(), "GET", "/api/queen/profiles");

  assert.ok(Array.isArray(body.queens));
  assert.equal(body.queens.length, 4);
  assert.deepEqual(
    body.queens.map((queen) => queen.id),
    ["queen_growth", "queen_tech", "queen_finance", "queen_ops"],
  );
  assert.deepEqual(body.queens, BUILT_IN_QUEENS);

  for (const queen of body.queens) {
    assert.equal(typeof queen.name, "string");
    assert.ok(queen.name.length > 0, `${queen.id} needs a name`);
    assert.equal(typeof queen.title, "string");
    assert.ok(queen.title.length > 0, `${queen.id} needs a title`);
    assert.equal(queen.custom, false);
    assert.equal(queen.has_avatar, false);
  }

  assert.equal(new Set(body.queens.map((queen) => queen.id)).size, 4, "ids must be unique");
});

test("tools-index is built from real colony metadata and tools.json", async () => {
  useHome();
  seedColonies();
  const body = await invoke(makeRegistry(), "GET", "/api/colonies/tools-index");

  assert.ok(Array.isArray(body.colonies));
  // broken/ is skipped (malformed metadata), notes.txt is not a directory,
  // zombie stays listed here because the official tools index lists every
  // colony with metadata (discovery is what hides soft-deleted colonies).
  assert.deepEqual(
    body.colonies.map((colony) => colony.name),
    ["acme", "beta", "gamma", "zombie"],
  );

  const acme = body.colonies.find((colony) => colony.name === "acme");
  const acmeMeta = readMeta("acme");
  assert.deepEqual(acme, {
    name: "acme",
    queen_name: "queen_tech",
    created_at: acmeMeta.created_at,
    has_allowlist: true,
    enabled_count: 2,
  });
  assert.deepEqual(Object.keys(acme).sort(), [
    "created_at",
    "enabled_count",
    "has_allowlist",
    "name",
    "queen_name",
  ]);
  assert.equal("goal" in acme, false, "raw metadata must not leak into ColonySummary");

  const beta = body.colonies.find((colony) => colony.name === "beta");
  assert.equal(beta.queen_name, "queen_finance");
  assert.equal(beta.has_allowlist, false);
  assert.equal(beta.enabled_count, null);

  const gamma = body.colonies.find((colony) => colony.name === "gamma");
  assert.equal(gamma.has_allowlist, true, "an explicit empty allowlist is still an allowlist");
  assert.equal(gamma.enabled_count, 0);

  assert.deepEqual(body.colonies, listColonySummaries());
});

test("tools-index is empty when no colonies exist", async () => {
  useHome();
  const body = await invoke(makeRegistry(), "GET", "/api/colonies/tools-index");
  assert.deepEqual(body, { colonies: [] });
  assert.deepEqual(listColonySummaries(), []);
});

test("GET /api/colonies serves the official summary shape but stays partial", async () => {
  useHome();
  seedColonies();
  const registry = makeRegistry();

  const body = await invoke(registry, "GET", "/api/colonies");
  assert.deepEqual(body, { colonies: listColonySummaries() });
  assert.equal(body.colonies.length, 4);

  const match = registry.match("GET", "/api/colonies");
  assert.equal(match.route.status, "partial");
  assert.equal(match.route.meta.native, true);
  assert.match(match.route.meta.description, /native/);
});

test("sessions list is empty without a provider and passes real rows through", async () => {
  useHome();
  const registry = makeRegistry();

  assert.deepEqual(await invoke(registry, "GET", "/api/sessions"), { sessions: [] });

  const live = [
    {
      session_id: "s-1",
      colony_id: "acme",
      has_worker: true,
      agent_path: "",
      description: "",
      goal: "",
      node_count: 0,
      loaded_at: 1,
      uptime_seconds: 2,
      queen_id: "queen_tech",
      queen_name: "queen_tech",
    },
  ];
  assert.deepEqual((await invoke(registry, "GET", "/api/sessions", { listLiveSessions: () => ({ sessions: live }) })).sessions, live);
  assert.deepEqual((await invoke(registry, "GET", "/api/sessions", { liveSessions: live })).sessions, live);

  // The registration ctx is the fallback when a call has no ctx.
  const bound = makeRegistry({ listLiveSessions: () => live });
  assert.deepEqual((await invoke(bound, "GET", "/api/sessions")).sessions, live);

  // Rows without a real session_id are dropped, never fabricated.
  const filtered = await invoke(registry, "GET", "/api/sessions", {
    liveSessions: [{ session_id: "" }, {}, null, { session_id: "ok" }],
  });
  assert.deepEqual(filtered.sessions, [{ session_id: "ok" }]);

  await assert.rejects(
    invoke(registry, "GET", "/api/sessions", { listLiveSessions: () => "nope" }),
    /must return an array/,
  );
});

test("session history is empty by default and passes provider rows through", async () => {
  useHome();
  const registry = makeRegistry();

  assert.deepEqual(await invoke(registry, "GET", "/api/sessions/history"), { sessions: [] });

  const history = [
    {
      session_id: "s-2",
      cold: true,
      live: false,
      has_messages: true,
      created_at: 1700000000000,
      queen_id: "queen_ops",
      title: "nightly ops",
    },
  ];
  const viaFunction = await invoke(registry, "GET", "/api/sessions/history", {
    listHistorySessions: () => ({ sessions: history }),
  });
  assert.deepEqual(viaFunction, { sessions: history });

  const viaArray = await invoke(registry, "GET", "/api/sessions/history", { historySessions: history });
  assert.deepEqual(viaArray, { sessions: history });

  const filtered = await invoke(registry, "GET", "/api/sessions/history", {
    historySessions: [{ cold: true, live: false }, { session_id: "s-3" }],
  });
  assert.deepEqual(filtered.sessions, [{ session_id: "s-3" }]);
});

test("discover returns the official DiscoverEntry envelope from real colonies", async () => {
  useHome();
  assert.deepEqual(buildDiscoverResult({}), {}, "empty home yields an empty envelope");

  seedColonies();
  fs.writeFileSync(path.join(colonyDir("acme"), "sessions", "s1.json"), "{}");
  fs.writeFileSync(path.join(colonyDir("acme"), "sessions", "s2.json"), "{}");
  createTask("acme", { subject: "first task" });
  createTask("acme", { subject: "second task" });

  const registry = makeRegistry();
  const body = await invoke(registry, "GET", "/api/discover", { runtimes: new Map([["acme", {}]]) });

  assert.deepEqual(Object.keys(body), [DISCOVER_CATEGORY]);
  const entries = body[DISCOVER_CATEGORY];
  assert.ok(Array.isArray(entries));
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["Acme", "Beta", "Gamma"],
  );
  assert.equal(entries.some((entry) => entry.name === "Zombie"), false, "soft-deleted colonies stay hidden");

  const acme = entries.find((entry) => entry.name === "Acme");
  const acmeMeta = readMeta("acme");
  assert.deepEqual(Object.keys(acme).sort(), [
    "category",
    "created_at",
    "description",
    "icon",
    "is_loaded",
    "last_active",
    "name",
    "node_count",
    "path",
    "run_count",
    "session_count",
    "tags",
    "tool_count",
    "workers",
  ]);
  assert.equal(acme.path, path.resolve(colonyDir("acme")));
  assert.equal(acme.category, DISCOVER_CATEGORY);
  assert.equal(acme.description, "ship a vertical slice");
  assert.equal(acme.created_at, acmeMeta.created_at);
  assert.equal(acme.last_active, acmeMeta.updated_at);
  assert.equal(acme.session_count, 2);
  assert.equal(acme.node_count, 2);
  assert.equal(acme.run_count, 0);
  assert.equal(acme.tool_count, 0);
  assert.deepEqual(acme.tags, []);
  assert.deepEqual(acme.workers, []);
  assert.equal(acme.icon, null);
  assert.equal(acme.is_loaded, true);

  const beta = entries.find((entry) => entry.name === "Beta");
  assert.equal(beta.is_loaded, false);
  assert.equal(beta.description, "");

  const gamma = entries.find((entry) => entry.name === "Gamma");
  assert.equal(gamma.description, "keep the lights on");
  assert.equal(gamma.is_loaded, false);
});
