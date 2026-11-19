import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RouteRegistry } from "../../src/compat/router.js";
import { colonyDir, coloniesDir, modelConfig } from "../../src/config.js";
import { createColony } from "../../src/domain/colony.js";
import { QUEEN_ROUTE_PATHS, registerQueenRoutes } from "../../src/compat/handlers/queens.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-queens-"));
let homeCounter = 0;

after(() => {
  delete process.env.PI_HIVE_HOME;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Fresh PI_HIVE_HOME per test: src/config.js reads the env at call time. */
function useHome() {
  const home = path.join(TMP_ROOT, `home-${(homeCounter += 1)}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.PI_HIVE_HOME = home;
  return home;
}

function makeRegistry() {
  const registry = new RouteRegistry();
  registerQueenRoutes(registry, {});
  return registry;
}

/** Invoke a registered handler with a fake req/res and assert no socket write. */
async function call(registry, method, pathname, { body, ctx } = {}) {
  const match = registry.match(method, pathname);
  assert.ok(match, `no route for ${method} ${pathname}`);

  const req = { method, url: pathname, headers: {} };
  if (body !== undefined) req.body = body;

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
  assert.equal(typeof result.status, "number", `${method} ${pathname} needs a numeric status`);
  assert.ok(result.body !== undefined, `${method} ${pathname} needs a body`);
  assert.equal(typeof result.body, "object");
  return result;
}

/** Invoke a handler whose request body arrives as an async-iterable stream. */
async function callStream(registry, method, pathname, raw) {
  const match = registry.match(method, pathname);
  assert.ok(match, `no route for ${method} ${pathname}`);
  const req = {
    method,
    url: pathname,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(raw);
    },
  };
  const res = { headersSent: false, writeHead() {}, end() {} };
  const result = await match.route.handler({ req, res, params: match.params });
  assert.equal(typeof result.status, "number");
  return result;
}

const SOUL_FIXTURE = {
  version: 3,
  mode: "review",
  identity: {
    mission: "Ship evidence-backed work.",
    voice: ["Direct", "No hand-waving"],
    principles: ["Verify before claiming"],
  },
  probes: [{ text: "What did I learn?", added_at: "2026-11-18T00:00:00.000Z" }],
  updated_at: "2026-11-18T09:00:00.000Z",
  history: [
    {
      at: "2026-11-18T09:00:00.000Z",
      section: "identity.voice",
      change: "Direct",
      evidence: ["worker report"],
    },
  ],
};

const PROPOSALS_FIXTURE = [
  {
    id: "soul_p1",
    at: "2026-11-19T10:00:00.000Z",
    status: "pending",
    section: "identity.voice",
    change: "Cite the source before scaling",
    evidence: ["the tracker shows three failed pilots"],
    confidence: 0.8,
  },
  {
    id: "soul_p2",
    at: "2026-11-19T10:05:00.000Z",
    status: "pending",
    section: "identity.principles",
    change: "Prefer reversible experiments",
    evidence: ["a budget overrun followed a one-way door"],
    confidence: 0.7,
  },
];

/**
 * World:
 *   - growth-lab   queen_growth (no soul fixture)
 *   - tech-one     queen_tech   (soul review: mission/voice/principles/probes)
 *   - tech-two     queen_tech   (soul off: must not be the soul source)
 *   - finance-lab  queen_finance
 *   - memory: 1 global, 1 queen-scoped, 1 colony-scoped note
 *   - sessions: one queen_<id>.json under each queen_tech colony
 */
function seedWorld({ proposals = true } = {}) {
  const home = useHome();
  createColony({ name: "growth-lab", queenId: "queen_growth", goal: "validate a channel" });
  createColony({ name: "tech-one", queenId: "queen_tech", goal: "ship a vertical slice" });
  createColony({ name: "tech-two", queenId: "queen_tech", goal: "retire the legacy job" });
  createColony({ name: "finance-lab", queenId: "queen_finance", goal: "update the runway model" });

  const techOne = colonyDir("tech-one");
  const techTwo = colonyDir("tech-two");
  fs.writeFileSync(path.join(techOne, "soul.json"), JSON.stringify(SOUL_FIXTURE, null, 2));
  fs.writeFileSync(
    path.join(techTwo, "soul.json"),
    JSON.stringify({ version: 1, mode: "off", identity: { mission: "off", voice: [], principles: [] } }, null, 2),
  );
  fs.writeFileSync(
    path.join(colonyDir("finance-lab"), "soul.json"),
    JSON.stringify({ version: 2, mode: "off", identity: { mission: "paused", voice: [], principles: [] } }, null, 2),
  );
  if (proposals) {
    fs.writeFileSync(
      path.join(techOne, "soul_proposals.jsonl"),
      PROPOSALS_FIXTURE.map((proposal) => JSON.stringify(proposal)).join("\n") + "\n",
    );
  }

  for (const [dir, queenId] of [
    [techOne, "queen_tech"],
    [techTwo, "queen_tech"],
  ]) {
    const sessions = path.join(dir, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, `queen_${queenId}.json`),
      JSON.stringify({ queen_id: queenId, messages: [{ role: "user", content: "hi" }] }),
    );
  }

  const globalMemory = path.join(home, "memory", "global");
  fs.mkdirSync(globalMemory, { recursive: true });
  fs.writeFileSync(path.join(globalMemory, "preferences.md"), "# preferences\nbe direct");

  const queenMemory = path.join(home, "memory", "queens", "queen_tech");
  fs.mkdirSync(queenMemory, { recursive: true });
  fs.writeFileSync(path.join(queenMemory, "delivery.md"), "# delivery\nverify first");

  fs.writeFileSync(path.join(techOne, "memory", "colony-note.md"), "# colony\none slice at a time");

  // Noise that must not break or pollute any queen route.
  fs.mkdirSync(path.join(coloniesDir(), "broken"), { recursive: true });
  fs.writeFileSync(path.join(coloniesDir(), "broken", "metadata.json"), "{not json");
  fs.mkdirSync(path.join(coloniesDir(), "Bad Name"), { recursive: true });
  fs.writeFileSync(
    path.join(coloniesDir(), "Bad Name", "metadata.json"),
    JSON.stringify({ id: "Bad Name", queen_id: "queen_tech" }),
  );
  fs.writeFileSync(path.join(coloniesDir(), "notes.txt"), "ignore me");

  return home;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function proposalFileLines() {
  const file = path.join(colonyDir("tech-one"), "soul_proposals.jsonl");
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const EXPECTED_STATUS = new Map([
  ["POST /api/queen/create", "partial"],
  ["POST /api/queen/:queen/remove", "partial"],
  ["POST /api/queen/:queen/restore", "partial"],
  ["GET /api/queen/removed", "implemented"],
  ["GET /api/queen/:queen/profile", "implemented"],
  ["PATCH /api/queen/:queen/profile", "partial"],
  ["GET /api/queen/:queen/llm", "implemented"],
  ["PUT /api/queen/:queen/llm", "partial"],
  ["GET /api/queen/:queen/persona", "implemented"],
  ["PUT /api/queen/:queen/persona", "partial"],
  ["GET /api/queen/:queen/overview", "implemented"],
  ["POST /api/queen/:queen/avatar", "partial"],
  ["DELETE /api/queen/:queen/avatar", "partial"],
  ["GET /api/queen/:queen/avatar", "partial"],
  ["POST /api/queen/:queen/session", "partial"],
  ["POST /api/queen/:queen/session/select", "partial"],
  ["POST /api/queen/:queen/session/new", "partial"],
  ["GET /api/queen/:queen/tools", "implemented"],
  ["PATCH /api/queen/:queen/tools", "partial"],
  ["DELETE /api/queen/:queen/tools", "partial"],
  ["GET /api/queen/:queen/soul", "implemented"],
  ["PUT /api/queen/:queen/soul", "implemented"],
  ["POST /api/queen/:queen/soul/proposals/:proposal/decide", "implemented"],
  ["POST /api/queen/:queen/soul/rollback", "implemented"],
  ["POST /api/queen/:queen/soul/proposals/:proposal/probe", "partial"],
  ["POST /api/queen/:queen/soul/reflect", "partial"],
  ["GET /api/claude-code-queens", "implemented"],
  ["GET /api/claude-code-queens/:queen/conversations/:conversation", "partial"],
]);

test("registers exactly the 28 official routes with honest statuses", () => {
  const registry = new RouteRegistry();
  const returned = registerQueenRoutes(registry, {});
  assert.equal(returned, registry);
  assert.equal(QUEEN_ROUTE_PATHS.length, 28);
  assert.equal(registry.list().length, 28);

  for (const key of QUEEN_ROUTE_PATHS) {
    const [method, routePath] = key.split(" ");
    const match = registry.match(method, routePath);
    assert.ok(match, `missing ${key}`);
    assert.equal(match.route.status, EXPECTED_STATUS.get(key), `${key} status`);
    assert.equal(match.route.meta.official, true, `${key} must be marked official`);
    assert.equal(typeof match.route.handler, "function", `${key} needs a handler`);
  }

  const counts = registry.counts();
  assert.equal(counts.implemented, 11);
  assert.equal(counts.partial, 17);
  assert.equal(counts.missing, 0);
  assert.equal(counts.total, 28);

  assert.ok(registry.match("HEAD", "/api/queen/queen_tech/profile"), "HEAD falls back to GET");
  assert.throws(() => registerQueenRoutes(null), /RouteRegistry/);
  assert.throws(() => registerQueenRoutes({}, {}), /RouteRegistry/);
});

test("retires the shell's legacy :id placeholders so real handlers win", () => {
  const registry = new RouteRegistry();
  registry.register("GET", "/api/queen/:id/overview", null, { status: "missing" });
  registry.register("GET", "/api/queen/:id/soul", null, { status: "missing" });

  registerQueenRoutes(registry, {});

  for (const routePath of ["/api/queen/queen_tech/overview", "/api/queen/queen_tech/soul"]) {
    const match = registry.match("GET", routePath);
    assert.equal(match.route.path, routePath.replace("queen_tech", ":queen"));
    assert.equal(match.route.status, "implemented", `${routePath} must hit the real handler`);
  }
  assert.equal(
    registry.list().filter((route) => route.path.includes(":id")).length,
    0,
    "legacy :id placeholders must be gone",
  );
  assert.equal(registry.list().length, 28);
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("profiles describe the four real queen role identities and 404 unknown queens", async () => {
  seedWorld();
  const registry = makeRegistry();

  const expected = [
    ["queen_growth", "Growth Queen", "Head of Growth"],
    ["queen_tech", "Technology Queen", "Head of Technology"],
    ["queen_finance", "Finance Queen", "Head of Finance"],
    ["queen_ops", "Operations Queen", "Head of Operations"],
  ];

  for (const [queenId, name, title] of expected) {
    const { status, body } = await call(registry, "GET", `/api/queen/${queenId}/profile`);
    assert.equal(status, 200);
    assert.equal(body.id, queenId);
    assert.equal(body.name, name);
    assert.equal(body.title, title);
    assert.match(body.summary, new RegExp(title.split(" ").pop()));
    assert.equal(body.has_avatar, false);
    assert.equal(body.portrait, null);
    assert.equal(body.custom, false);
    assert.ok(Array.isArray(body.experience));
  }

  const tech = await call(registry, "GET", "/api/queen/queen_tech/profile");
  assert.match(tech.body.signature_achievement, /2 pi_hive colonies: tech-one, tech-two|2 pi_hive colonies: tech-two, tech-one/);

  const missing = await call(registry, "GET", "/api/queen/queen_nope/profile");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /not found/);

  const patch = await call(registry, "PATCH", "/api/queen/queen_tech/profile", {
    body: { summary: "new identity" },
  });
  assert.equal(patch.status, 400);
  assert.equal(patch.body.type, "unsupported");
  assert.match(patch.body.error, /code-defined role identities/);

  const badJson = await callStream(
    registry,
    "PATCH",
    "/api/queen/queen_tech/profile",
    "{not json",
  );
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.type, "invalid_request");
});

test("llm and persona read the real single model and role persona", async () => {
  seedWorld();
  const registry = makeRegistry();

  const llm = await call(registry, "GET", "/api/queen/queen_growth/llm");
  assert.equal(llm.status, 200);
  assert.equal(llm.body.queen_id, "queen_growth");
  assert.equal(llm.body.section, null);
  assert.equal(llm.body.default_model, modelConfig().modelId);

  const putLlm = await call(registry, "PUT", "/api/queen/queen_growth/llm", {
    body: { section: { provider: "anthropic", model: "claude" } },
  });
  assert.equal(putLlm.status, 400);
  assert.equal(putLlm.body.type, "unsupported");
  assert.match(putLlm.body.error, /one process-wide model/);

  const persona = await call(registry, "GET", "/api/queen/queen_finance/persona");
  assert.equal(persona.status, 200);
  assert.equal(persona.body.queen_id, "queen_finance");
  assert.match(persona.body.persona.core_traits, /Finance Queen/);
  assert.equal(persona.body.persona.name, "Finance Queen");
  assert.equal(persona.body.persona.title, "Head of Finance");

  const putPersona = await call(registry, "PUT", "/api/queen/queen_finance/persona", {
    body: { persona: { name: "Money Queen" } },
  });
  assert.equal(putPersona.status, 400);
  assert.equal(putPersona.body.type, "unsupported");
});

test("overview counts real memory files and queen session files", async () => {
  seedWorld();
  const registry = makeRegistry();

  const { status, body } = await call(registry, "GET", "/api/queen/queen_tech/overview");
  assert.equal(status, 200);
  assert.equal(body.queen_id, "queen_tech");
  assert.equal(body.memory.count, 3);
  assert.equal(body.memory.limit, 0);
  assert.deepEqual(body.memory.by_type, { note: 3 });
  assert.deepEqual(body.memory.by_scope, { global: 1, queen: 1, colony: 1 });
  assert.equal(body.sessions.count, 2);
  assert.match(body.sessions.first, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(body.sessions.last_active)));

  const empty = await call(registry, "GET", "/api/queen/queen_ops/overview");
  assert.equal(empty.status, 200);
  // Global memory is shared by every queen; she has no queen- or colony-scoped notes.
  assert.equal(empty.body.memory.count, 1);
  assert.deepEqual(empty.body.memory.by_type, { note: 1 });
  assert.deepEqual(empty.body.memory.by_scope, { global: 1, queen: 0, colony: 0 });
  assert.equal(empty.body.sessions.count, 0);
  assert.equal(empty.body.sessions.first, null);
  assert.equal(empty.body.sessions.last_active, null);
});

// ---------------------------------------------------------------------------
// Catalog membership
// ---------------------------------------------------------------------------

test("catalog mutations are explicit 4xx answers, never fake catalog writes", async () => {
  seedWorld();
  const registry = makeRegistry();

  const create = await call(registry, "POST", "/api/queen/create", {
    body: { name: "Growth Hacker", title: "Custom Queen" },
  });
  assert.equal(create.status, 400);
  assert.equal(create.body.type, "unsupported");
  assert.match(create.body.error, /Custom queens are not supported/);
  assert.deepEqual(create.body.supported, [
    "queen_growth",
    "queen_tech",
    "queen_finance",
    "queen_ops",
  ]);

  const remove = await call(registry, "POST", "/api/queen/queen_growth/remove");
  assert.equal(remove.status, 400);
  assert.equal(remove.body.type, "unsupported");
  assert.match(remove.body.error, /cannot be removed/);

  const removeMissing = await call(registry, "POST", "/api/queen/queen_nope/remove");
  assert.equal(removeMissing.status, 404);

  const restore = await call(registry, "POST", "/api/queen/queen_growth/restore");
  assert.equal(restore.status, 400);
  assert.equal(restore.body.type, "unsupported");
  assert.match(restore.body.error, /never removed/);

  const removed = await call(registry, "GET", "/api/queen/removed");
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { queens: [] });
});

// ---------------------------------------------------------------------------
// Avatars and sessions
// ---------------------------------------------------------------------------

test("avatar routes answer 400/404 with the missing store named", async () => {
  seedWorld();
  const registry = makeRegistry();

  const post = await call(registry, "POST", "/api/queen/queen_tech/avatar", {
    body: { avatar: "not-a-file" },
  });
  assert.equal(post.status, 400);
  assert.equal(post.body.type, "unsupported");
  assert.match(post.body.error, /no queen avatar file store/);

  const del = await call(registry, "DELETE", "/api/queen/queen_tech/avatar");
  assert.equal(del.status, 400);
  assert.equal(del.body.type, "unsupported");

  const get = await call(registry, "GET", "/api/queen/queen_tech/avatar");
  assert.equal(get.status, 404);
  assert.match(get.body.error, /No avatar found/);

  const missing = await call(registry, "GET", "/api/queen/queen_nope/avatar");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /Queen 'queen_nope' not found/);
});

test("queen session routes are explicit unsupported and validate session_id first", async () => {
  seedWorld();
  const registry = makeRegistry();

  const getOrCreate = await call(registry, "POST", "/api/queen/queen_tech/session", {
    body: { initial_prompt: "hello" },
  });
  assert.equal(getOrCreate.status, 400);
  assert.equal(getOrCreate.body.type, "unsupported");
  assert.match(getOrCreate.body.error, /colony/);

  const selectMissing = await call(registry, "POST", "/api/queen/queen_tech/session/select", {
    body: {},
  });
  assert.equal(selectMissing.status, 400);
  assert.equal(selectMissing.body.type, "invalid_request");
  assert.match(selectMissing.body.error, /session_id is required/);

  const select = await call(registry, "POST", "/api/queen/queen_tech/session/select", {
    body: { session_id: "session_20260101_000000_dead" },
  });
  assert.equal(select.status, 400);
  assert.equal(select.body.type, "unsupported");

  const fresh = await call(registry, "POST", "/api/queen/queen_tech/session/new", {
    body: { initial_prompt: "start" },
  });
  assert.equal(fresh.status, 400);
  assert.equal(fresh.body.type, "unsupported");
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

test("tools expose the real QueenRuntime catalog and reject per-queen edits", async () => {
  seedWorld();
  const registry = makeRegistry();

  const { status, body } = await call(registry, "GET", "/api/queen/queen_tech/tools");
  assert.equal(status, 200);
  assert.equal(body.queen_id, "queen_tech");
  assert.equal(body.enabled_mcp_tools, null);
  assert.equal(body.is_role_default, true);
  assert.equal(body.stale, false);
  assert.deepEqual(body.synthetic, []);
  assert.deepEqual(body.mcp_servers, []);
  assert.deepEqual(body.connected_providers, []);

  const names = body.lifecycle.map((tool) => tool.name);
  for (const expected of [
    "tracker_query",
    "task_create",
    "list_skills",
    "memory_read",
    "file_read",
    "terminal_exec",
    "soul_read",
    "spawn_worker",
    "run_playbook",
    "set_trigger",
    "list_queens",
    "message_queen",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const tool of body.lifecycle) {
    assert.equal(tool.editable, false);
    assert.equal(tool.provider, null);
    assert.equal(tool.provider_connected, true);
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.input_schema, "object");
  }

  assert.ok(body.categories.length >= 6);
  const classified = body.categories.flatMap((category) => category.tools);
  assert.deepEqual([...classified].sort(), [...names].sort());
  for (const category of body.categories) {
    assert.equal(category.in_role_default, true);
    assert.equal(category.always_enabled, true);
  }

  const patch = await call(registry, "PATCH", "/api/queen/queen_tech/tools", {
    body: { enabled_mcp_tools: [] },
  });
  assert.equal(patch.status, 400);
  assert.equal(patch.body.type, "unsupported");
  assert.match(patch.body.error, /no per-queen tools\.json/);

  const reset = await call(registry, "DELETE", "/api/queen/queen_tech/tools");
  assert.equal(reset.status, 400);
  assert.equal(reset.body.type, "unsupported");
});

// ---------------------------------------------------------------------------
// Soul
// ---------------------------------------------------------------------------

test("soul reads the primary colony's soul.json and reports real proposals", async () => {
  seedWorld();
  const registry = makeRegistry();

  const { status, body } = await call(registry, "GET", "/api/queen/queen_tech/soul");
  assert.equal(status, 200);
  assert.equal(body.queen_id, "queen_tech");
  assert.equal(body.enabled, true);
  assert.equal(body.mode, "review");
  assert.equal(body.version, 3);
  assert.equal(body.colony_id, "tech-one");
  assert.deepEqual(
    body.sections.map((section) => section.key),
    ["identity.mission", "identity.voice", "identity.principles", "probes"],
  );

  const mission = body.sections[0];
  assert.equal(mission.items.length, 1);
  assert.equal(mission.items[0].text, "Ship evidence-backed work.");
  assert.equal(mission.used, mission.items[0].text.length);

  const voice = body.sections[1];
  assert.deepEqual(voice.items.map((item) => item.text), ["Direct", "No hand-waving"]);
  // A legacy change-log entry maps to an unversioned history row (version 0).
  assert.equal(body.history.length, 1);
  assert.equal(body.history[0].version, 0);

  assert.equal(body.probes, 1);
  assert.equal(body.proposal.id, "soul_p1");
  assert.equal(body.proposal.status, "pending");
  assert.equal(body.proposal.edits.length, 1);
  assert.equal(body.proposal.edits[0].section, "identity.voice");
  assert.equal(body.proposal.edits[0].evidence[0].where, "soul_proposals.jsonl");

  const noColony = await call(registry, "GET", "/api/queen/queen_ops/soul");
  assert.equal(noColony.status, 200);
  assert.deepEqual(noColony.body, { queen_id: "queen_ops", enabled: false });

  // Her only colony has soul mode "off": the official enabled:false shape.
  const disabled = await call(registry, "GET", "/api/queen/queen_finance/soul");
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.body, { queen_id: "queen_finance", enabled: false });
});

test("soul PUT writes soul.json, bumps the version, and snapshots it for rollback", async () => {
  seedWorld();
  const registry = makeRegistry();

  const put = await call(registry, "PUT", "/api/queen/queen_tech/soul", {
    body: {
      sections: {
        "identity.mission": [{ text: "Make every claim verifiable.", date: "2026-11-19" }],
        "identity.voice": [
          { text: "Direct", date: "2026-11-19" },
          { text: "Plain words", date: "2026-11-01" },
        ],
        "identity.principles": [{ text: "Verify before claiming", date: "" }],
        probes: [{ text: "What changed this week?", date: "2026-11-19" }],
      },
    },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.version, 4);
  assert.equal(put.body.sections[0].items[0].text, "Make every claim verifiable.");
  assert.deepEqual(
    put.body.sections[1].items.map((item) => item.text),
    ["Direct", "Plain words"],
  );
  assert.deepEqual(
    put.body.sections[1].items.map((item) => item.date),
    ["2026-11-19", "2026-11-01"],
  );
  assert.equal(put.body.probes, 1);

  const onDisk = readJson(path.join(colonyDir("tech-one"), "soul.json"));
  assert.equal(onDisk.version, 4);
  assert.equal(onDisk.identity.mission, "Make every claim verifiable.");
  assert.deepEqual(onDisk.identity.voice, ["Direct", "Plain words"]);
  assert.equal(onDisk.probes[0].text, "What changed this week?");
  assert.ok(onDisk.probes[0].added_at.startsWith("2026-11-19"));
  assert.equal(onDisk.history.at(-1).author, "owner");

  const versions = readJson(path.join(colonyDir("tech-one"), "soul_versions.json"));
  assert.deepEqual(
    versions.versions.map((entry) => entry.version),
    [3, 4],
  );

  const unknown = await call(registry, "PUT", "/api/queen/queen_tech/soul", {
    body: { sections: { "identity.nope": [{ text: "x", date: "" }] } },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Unknown sections/);

  const badDate = await call(registry, "PUT", "/api/queen/queen_tech/soul", {
    body: { sections: { "identity.voice": [{ text: "x", date: "11/19/2026" }] } },
  });
  assert.equal(badDate.status, 400);
  assert.match(badDate.body.error, /YYYY-MM-DD/);

  const twoMissions = await call(registry, "PUT", "/api/queen/queen_tech/soul", {
    body: {
      sections: {
        "identity.mission": [
          { text: "one", date: "" },
          { text: "two", date: "" },
        ],
      },
    },
  });
  assert.equal(twoMissions.status, 400);
  assert.match(twoMissions.body.error, /at most one/);

  const overLimit = await call(registry, "PUT", "/api/queen/queen_tech/soul", {
    body: { sections: { "identity.mission": [{ text: "x".repeat(301), date: "" }] } },
  });
  assert.equal(overLimit.status, 400);
  assert.match(overLimit.body.error, /300-character limit/);

  const noColony = await call(registry, "PUT", "/api/queen/queen_ops/soul", {
    body: { sections: { "identity.mission": [{ text: "x", date: "" }] } },
  });
  assert.equal(noColony.status, 409);
  assert.equal(noColony.body.type, "conflict");
  assert.match(noColony.body.error, /stores the soul per colony/);

  const disabled = await call(registry, "PUT", "/api/queen/queen_finance/soul", {
    body: { sections: { "identity.mission": [{ text: "x", date: "" }] } },
  });
  assert.equal(disabled.status, 409);
  assert.match(disabled.body.error, /soul is disabled/);

  // The real server hands an IncomingMessage (async iterable), not req.body.
  const streamed = await callStream(
    registry,
    "PUT",
    "/api/queen/queen_tech/soul",
    JSON.stringify({
      sections: {
        "identity.mission": [{ text: "Streamed mission.", date: "" }],
        "identity.voice": [],
        "identity.principles": [],
      },
    }),
  );
  assert.equal(streamed.status, 200);
  assert.equal(streamed.body.version, 5);
  assert.equal(streamed.body.sections[0].items[0].text, "Streamed mission.");
});

test("soul decide applies or dismisses real proposal records", async () => {
  seedWorld();
  const registry = makeRegistry();

  const badIndex = await call(
    registry,
    "POST",
    "/api/queen/queen_tech/soul/proposals/soul_p1/decide",
    { body: { accept: [4] } },
  );
  assert.equal(badIndex.status, 400);
  assert.equal(badIndex.body.type, "invalid_request");
  assert.match(badIndex.body.error, /out of range/);

  const apply = await call(
    registry,
    "POST",
    "/api/queen/queen_tech/soul/proposals/soul_p1/decide",
    { body: { accept: null } },
  );
  assert.equal(apply.status, 200);
  assert.equal(apply.body.version, 4);
  assert.ok(
    apply.body.sections[1].items.map((item) => item.text).includes("Cite the source before scaling"),
  );
  assert.equal(apply.body.proposal.id, "soul_p2", "the next pending proposal is now exposed");

  const lines = proposalFileLines();
  assert.equal(lines.find((line) => line.id === "soul_p1").status, "applied");
  assert.equal(lines.find((line) => line.id === "soul_p2").status, "pending");

  const again = await call(
    registry,
    "POST",
    "/api/queen/queen_tech/soul/proposals/soul_p1/decide",
    { body: { accept: null } },
  );
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already applied/);

  const dismiss = await call(
    registry,
    "POST",
    "/api/queen/queen_tech/soul/proposals/soul_p2/decide",
    { body: { accept: [] } },
  );
  assert.equal(dismiss.status, 200);
  assert.equal(dismiss.body.proposal, null);
  assert.equal(dismiss.body.version, 4, "a dismissal is not a soul version");
  assert.equal(proposalFileLines().find((line) => line.id === "soul_p2").status, "dismissed");

  const unknown = await call(
    registry,
    "POST",
    "/api/queen/queen_tech/soul/proposals/soul_nope/decide",
    { body: { accept: null } },
  );
  assert.equal(unknown.status, 404);

  // The pre-apply version was snapshotted, so rollback really undoes the edit.
  const rolled = await call(registry, "POST", "/api/queen/queen_tech/soul/rollback", {
    body: { version: 3 },
  });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.body.version, 5);
  assert.ok(
    !rolled.body.sections[1].items.map((item) => item.text).includes("Cite the source before scaling"),
  );
});

test("soul rollback restores a snapshotted version as a new version", async () => {
  seedWorld();
  const registry = makeRegistry();

  // Create version 4 through the compat API so version 3 is snapshotted.
  const put = await call(registry, "PUT", "/api/queen/queen_tech/soul", {
    body: {
      sections: {
        "identity.mission": [{ text: "Temporary mission.", date: "" }],
        "identity.voice": [{ text: "Direct", date: "" }],
        "identity.principles": [{ text: "Verify before claiming", date: "" }],
      },
    },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.version, 4);

  const rolled = await call(registry, "POST", "/api/queen/queen_tech/soul/rollback", {
    body: { version: 3 },
  });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.body.version, 5);
  assert.equal(rolled.body.sections[0].items[0].text, "Ship evidence-backed work.");
  assert.deepEqual(
    rolled.body.sections[1].items.map((item) => item.text),
    ["Direct", "No hand-waving"],
  );

  const onDisk = readJson(path.join(colonyDir("tech-one"), "soul.json"));
  assert.equal(onDisk.version, 5);
  assert.equal(onDisk.identity.mission, "Ship evidence-backed work.");
  assert.equal(onDisk.history.at(-1).note, "rolled back to version 3");

  const unknown = await call(registry, "POST", "/api/queen/queen_tech/soul/rollback", {
    body: { version: 99 },
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /No soul version 99/);

  const bad = await call(registry, "POST", "/api/queen/queen_tech/soul/rollback", {
    body: { version: "3" },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.type, "invalid_request");
});

test("soul probe and reflect are explicit unsupported answers with real preconditions", async () => {
  const home = seedWorld();
  const registry = makeRegistry();

  const probe = await call(
    registry,
    "POST",
    "/api/queen/queen_tech/soul/proposals/soul_p1/probe",
  );
  assert.equal(probe.status, 400);
  assert.equal(probe.body.type, "unsupported");
  assert.match(probe.body.error, /no probe-question store/);

  const probeMissing = await call(
    registry,
    "POST",
    "/api/queen/queen_tech/soul/proposals/soul_nope/probe",
  );
  assert.equal(probeMissing.status, 404);

  const reflectBlocked = await call(registry, "POST", "/api/queen/queen_tech/soul/reflect");
  assert.equal(reflectBlocked.status, 409);
  assert.match(reflectBlocked.body.error, /Decide on the waiting proposal first/);

  // Remove the pending proposals; reflection is then an unsupported capability,
  // not a fake "started" answer.
  fs.writeFileSync(path.join(colonyDir("tech-one"), "soul_proposals.jsonl"), "");
  const reflect = await call(registry, "POST", "/api/queen/queen_tech/soul/reflect");
  assert.equal(reflect.status, 400);
  assert.equal(reflect.body.type, "unsupported");
  assert.match(reflect.body.error, /soul\/review/);
  assert.ok(home);

  const badAccept = await call(registry, "PUT", "/api/queen/queen_tech/soul", {
    body: { sections: { "identity.voice": "not-a-list" } },
  });
  assert.equal(badAccept.status, 400);
  assert.match(badAccept.body.error, /must be a list/);
});

// ---------------------------------------------------------------------------
// Claude Code queens
// ---------------------------------------------------------------------------

test("Claude Code queens are a valid empty list and transcripts an explicit 404", async () => {
  seedWorld();
  const registry = makeRegistry();

  const list = await call(registry, "GET", "/api/claude-code-queens");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, { queens: [] });

  const transcript = await call(
    registry,
    "GET",
    "/api/claude-code-queens/claude_reviewer/conversations/sess_123",
  );
  assert.equal(transcript.status, 404);
  assert.equal(transcript.body.type, "unsupported");
  assert.match(transcript.body.error, /no Claude Code queen integration/);
  assert.equal(transcript.body.conversation_id, "sess_123");
});
