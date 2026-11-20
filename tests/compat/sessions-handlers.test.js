/**
 * Tests for the official-frontend session compatibility handlers.
 *
 * Each test gets a fresh PI_HIVE_HOME with real colony directories. The
 * integration seam (`ctx`) is a fake map of QueenRuntime objects, so no model,
 * network, or socket is touched. Attachment tests use a fake res because that
 * route intentionally streams binary bytes.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { RouteRegistry, ROUTE_STATUS } from "../../src/compat/router.js";
import { colonyDir } from "../../src/config.js";
import { createColony } from "../../src/domain/colony.js";
import { createTask } from "../../src/domain/plan.js";
import {
  LEGACY_SESSION_ROUTES,
  SESSION_ROUTE_DEFINITIONS,
  clearSessionStoreCache,
  registerSessionRoutes,
  sessionColonyFromStore,
} from "../../src/compat/handlers/sessions.js";
import { registerAutonomyRoutes } from "../../src/compat/handlers/autonomy.js";
import { SessionStore } from "../../src/compat/sessions.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-sessions-"));
let homeCounter = 0;

after(() => {
  delete process.env.PI_HIVE_HOME;
  clearSessionStoreCache();
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function useHome() {
  const home = path.join(TMP_ROOT, `home-${(homeCounter += 1)}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.PI_HIVE_HOME = home;
  clearSessionStoreCache();
  return home;
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
    this.chunks = [];
    this.ended = false;
    this.headersSent = false;
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = { ...headers };
    this.headersSent = true;
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
    this.headersSent = true;
  }

  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function makeRegistry(ctx = {}) {
  const registry = new RouteRegistry();
  registerSessionRoutes(registry, ctx);
  return registry;
}

/** Install both lanes on one registry, the way installCompatHandlers does. */
function makeCombinedRegistry(ctx = {}) {
  const registry = new RouteRegistry();
  registerSessionRoutes(registry, ctx);
  registerAutonomyRoutes(registry, ctx);
  return registry;
}

async function call(registry, method, pathname, options = {}) {
  const match = registry.match(method, pathname);
  assert.ok(match, `no route for ${method} ${pathname}`);

  const req = new EventEmitter();
  req.method = method;
  req.url = pathname;
  req.headers = { ...(options.headers || {}) };
  if (options.body !== undefined) req.body = options.body;
  if (options.rawBody !== undefined) req.rawBody = options.rawBody;

  const res = new FakeResponse();
  const result = await match.route.handler({
    req,
    res,
    params: match.params,
    pathname,
    ctx: options.ctx,
  });
  return { result, res, match };
}

async function callJson(registry, method, pathname, options = {}) {
  const { result, res } = await call(registry, method, pathname, options);
  assert.ok(result, `${method} ${pathname} returned no descriptor`);
  assert.equal(res.headersSent, false, `${method} ${pathname} wrote to res`);
  return result;
}

function seedColony(name = "acme", queenId = "queen_tech", goal = "ship a slice") {
  return createColony({ name, queenId, goal });
}

function makeQueen(colony, { reply = "queen reply", fail = false } = {}) {
  const calls = [];
  const fired = [];
  const queen = {
    colony,
    queenId: "queen_tech",
    running: false,
    queue: [],
    calls,
    fired,
    agent: {
      aborted: false,
      abort() {
        this.aborted = true;
      },
    },
    async chat(text) {
      calls.push(text);
      if (fail) throw new Error("model down");
      return { ok: true, text: reply };
    },
    injectTrigger(name, payload) {
      fired.push({ name, payload });
    },
    tools() {
      return [
        { name: "tracker_query", label: "Tracker", description: "Query the tracker" },
        { name: "spawn_worker", label: "Spawn", description: "Spawn a worker" },
      ];
    },
    workerManager: { list: () => [{ id: "w1" }] },
  };
  return queen;
}

function multipart(filename, content, contentType = "text/plain") {
  const boundary = "----pi-hive-session-test";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    rawBody: Buffer.concat([head, Buffer.from(content), tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createSession(registry, body, ctx = undefined) {
  const result = await callJson(registry, "POST", "/api/sessions", { body, ctx });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

// ---------------------------------------------------------------------------

test("registers all 31 official session routes with honest statuses", () => {
  const registry = makeRegistry();
  assert.equal(SESSION_ROUTE_DEFINITIONS.length, 31);
  assert.equal(registry.list().length, 31);

  for (const definition of SESSION_ROUTE_DEFINITIONS) {
    const match = registry.match(definition.method, definition.path.replace(":session", "sid").replace(":colony", "acme").replace(":trigger", "tid").replace(":attachment", "a.txt"));
    assert.ok(match, `missing ${definition.method} ${definition.path}`);
    assert.equal(match.route.status, definition.status, definition.path);
    assert.equal(match.route.meta.official, true);
    assert.equal(typeof match.route.handler, "function");
  }

  const counts = registry.counts();
  assert.equal(counts.implemented, 31);
  assert.equal(counts.partial, 0);
  assert.equal(counts.missing, 0);

  for (const route of registry.list()) {
    if (route.status !== ROUTE_STATUS.PARTIAL) continue;
    assert.match(
      registry.match(route.method, route.path.replace(":session", "sid")).route.meta.reason,
      /./,
      `${route.path} needs an explicit partial reason`,
    );
  }

  assert.throws(() => registerSessionRoutes(null), /RouteRegistry/);
  assert.throws(() => registerSessionRoutes({}, {}), /RouteRegistry/);
});

test("registration retires legacy :id/:name patterns that would shadow it", async () => {
  useHome();
  const registry = new RouteRegistry();
  for (const legacy of LEGACY_SESSION_ROUTES) {
    registry.register(legacy.method, legacy.path, null, { status: ROUTE_STATUS.MISSING });
  }
  registerSessionRoutes(registry, {});

  const probes = [
    ["GET", "/api/sessions/s1"],
    ["POST", "/api/sessions/s1/chat"],
    ["GET", "/api/sessions/s1/events/history"],
    ["GET", "/api/colonies/acme/sessions"],
    ["GET", "/api/colonies/acme/active-session"],
  ];
  for (const [method, pathname] of probes) {
    const match = registry.match(method, pathname);
    assert.ok(match, `missing ${method} ${pathname}`);
    assert.equal(match.route.status, ROUTE_STATUS.IMPLEMENTED, `${method} ${pathname} shadowed`);
    assert.notEqual(match.route.handler.name, "notImplementedHandler");
  }
});

test("POST /sessions creates a real colony session envelope", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const body = await createSession(registry, { colony_id: "acme" });

  assert.match(body.session_id, /^sess-/);
  assert.equal(body.colony_id, "acme");
  assert.equal(body.has_worker, true);
  assert.equal(body.agent_path, colonyDir("acme"));
  assert.equal(body.goal, "ship a slice");
  assert.equal(body.queen_id, "queen_tech");
  assert.equal(body.queen_name, "queen_tech");
  assert.equal(body.queen_phase, "colony");
  assert.equal(body.colony_spawned, false);
  assert.equal(body.spawned_colony_id, null);
  assert.equal(typeof body.loaded_at, "number");
  assert.equal(typeof body.uptime_seconds, "number");
  assert.ok(body.uptime_seconds >= 0);

  const file = path.join(process.env.PI_HIVE_HOME, "sessions", body.session_id, "session.json");
  assert.ok(fs.existsSync(file));
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(record.session_id, body.session_id);
  assert.equal(record.colony_id, "acme");

  const list = await callJson(registry, "GET", "/api/sessions");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.sessions.map((row) => row.session_id), [body.session_id]);
});

test("POST /sessions supports an independent queen session and initial prompt", async () => {
  useHome();
  const registry = makeRegistry();

  const solo = await createSession(registry, {});
  assert.equal(solo.colony_id, null);
  assert.equal(solo.has_worker, false);
  assert.equal(solo.agent_path, "");
  assert.equal(solo.queen_phase, "independent");

  seedColony("acme");
  const queen = makeQueen("acme", { reply: "hello from the queen" });
  const prompted = await createSession(
    registry,
    { colony_id: "acme", initial_prompt: "Start the launch plan" },
    { runtimes: new Map([["acme", queen]]) },
  );
  assert.deepEqual(queen.calls, ["Start the launch plan"]);
  assert.equal(prompted.initial_prompt, undefined);

  const stats = await callJson(registry, "GET", `/api/sessions/${prompted.session_id}/stats`);
  assert.equal(stats.body.messages, 2);
  assert.equal(stats.body.events, 2);
});

test("POST /sessions accepts queen ids and display names", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();

  const byId = await createSession(registry, { colony_id: "acme", queen_name: "queen_ops" });
  assert.equal(byId.queen_id, "queen_ops");
  assert.equal(byId.queen_name, "Operations Queen");

  const byDisplay = await createSession(registry, {
    colony_id: "acme",
    queen_name: "Technology Queen",
  });
  assert.equal(byDisplay.queen_id, "queen_tech");
  assert.equal(byDisplay.queen_name, "Technology Queen");

  const legacyPhase = await createSession(registry, {
    colony_id: "acme",
    initial_phase: "working",
  });
  assert.equal(legacyPhase.queen_phase, "colony");
});

test("POST /sessions validates ids, bodies, queens, and phases", async () => {
  useHome();
  seedColony("acme");
  seedColony("beta", "queen_ops");
  const registry = makeRegistry();

  const cases = [
    [{ colony_id: "nope" }, 404, /Colony 'nope' not found/],
    [{ queen_name: "queen_nope" }, 404, /Queen 'queen_nope' not found/],
    [{ initial_phase: "sideways" }, 400, /Invalid initial_phase/],
    [{ colony_id: 42 }, 400, /colony_id/],
    [{ queen_name: 42 }, 400, /queen_name/],
    [{ initial_prompt: 42 }, 400, /initial_prompt/],
    [{ source_session_id: "sess-nope" }, 404, /not found/],
  ];

  for (const [body, status, pattern] of cases) {
    const result = await callJson(registry, "POST", "/api/sessions", { body });
    assert.equal(result.status, status, JSON.stringify(body));
    assert.match(result.body.error, pattern);
  }

  const badJson = await callJson(registry, "POST", "/api/sessions", { body: "{bad json" });
  assert.equal(badJson.status, 400);
  assert.match(badJson.body.error, /Invalid JSON/);

  const notObject = await callJson(registry, "POST", "/api/sessions", { body: [1, 2] });
  assert.equal(notObject.status, 400);
  assert.match(notObject.body.error, /JSON object/);

  const source = await createSession(registry, { colony_id: "acme" });
  const withSource = await createSession(registry, {
    colony_id: "beta",
    source_session_id: source.session_id,
  });
  assert.equal(withSource.colony_id, "beta");

  const duplicate = await callJson(registry, "POST", "/api/sessions", {
    body: { colony_id: "acme", session_id: source.session_id },
  });
  assert.equal(duplicate.status, 409);

  const invalidId = await callJson(registry, "POST", "/api/sessions", {
    body: { session_id: "../escape" },
  });
  assert.equal(invalidId.status, 400);
});

test("GET /sessions lists live rows newest first and filters by colony", async () => {
  useHome();
  seedColony("acme");
  seedColony("beta", "queen_ops");
  const registry = makeRegistry();

  const first = await createSession(registry, { colony_id: "acme" });
  await sleep(3);
  const second = await createSession(registry, { colony_id: "beta" });

  const all = await callJson(registry, "GET", "/api/sessions");
  assert.deepEqual(all.body.sessions.map((row) => row.session_id), [second.session_id, first.session_id]);

  const acme = await callJson(registry, "GET", "/api/sessions?colony_id=acme");
  assert.deepEqual(acme.body.sessions.map((row) => row.session_id), [first.session_id]);

  const missing = await callJson(registry, "GET", "/api/sessions/sess-nope");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /not found/);
});

test("GET /sessions/:id returns LiveSessionDetail with trigger entry points", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const created = await createSession(registry, { colony_id: "acme" });

  const result = await callJson(registry, "GET", `/api/sessions/${created.session_id}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.session_id, created.session_id);
  assert.equal(result.body.cold, false);
  assert.deepEqual(result.body.colonies, ["acme"]);
  assert.deepEqual(result.body.entry_points, []);
  assert.equal(result.body.title, null);
  assert.equal(result.body.message_count, 0);
});

test("PATCH title sets and clears a title with validation", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const created = await createSession(registry, { colony_id: "acme" });

  const set = await callJson(registry, "PATCH", `/api/sessions/${created.session_id}/title`, {
    body: { title: "Launch prep" },
  });
  assert.deepEqual(set.body, { session_id: created.session_id, title: "Launch prep" });

  const detail = await callJson(registry, "GET", `/api/sessions/${created.session_id}`);
  assert.equal(detail.body.title, "Launch prep");

  const clear = await callJson(registry, "PATCH", `/api/sessions/${created.session_id}/title`, {
    body: { title: "   " },
  });
  assert.deepEqual(clear.body, { session_id: created.session_id, title: null });

  const bad = await callJson(registry, "PATCH", `/api/sessions/${created.session_id}/title`, {
    body: { title: 42 },
  });
  assert.equal(bad.status, 400);

  const missing = await callJson(registry, "PATCH", "/api/sessions/sess-nope/title", {
    body: { title: "x" },
  });
  assert.equal(missing.status, 404);
});

test("POST chat forwards to QueenRuntime.chat and logs both sides", async () => {
  useHome();
  seedColony("acme");
  const queen = makeQueen("acme", { reply: "deploying now" });
  const registry = makeRegistry({ runtimes: new Map([["acme", queen]]) });
  const created = await createSession(registry, { colony_id: "acme" });

  const result = await callJson(registry, "POST", `/api/sessions/${created.session_id}/chat`, {
    body: { message: "ship it", display_message: "Ship it!" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "queen");
  assert.equal(result.body.delivered, true);
  assert.equal(result.body.reply, "deploying now");
  assert.deepEqual(queen.calls, ["ship it"]);

  const page = await callJson(registry, "GET", `/api/sessions/${created.session_id}/events/history`);
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.events.map((event) => event.type), [
    "client_input_received",
    "llm_text_delta",
  ]);
  assert.equal(page.body.events[0].data.content, "Ship it!");
  assert.equal(page.body.events[1].data.content, "deploying now");
  assert.equal(page.body.total, 2);
  assert.equal(page.body.returned, 2);
  assert.equal(page.body.start_index, 1);
  assert.equal(page.body.has_more_older, false);

  const stats = await callJson(registry, "GET", `/api/sessions/${created.session_id}/stats`);
  assert.equal(stats.body.messages, 2);
  assert.equal(stats.body.events, 2);
  assert.equal(stats.body.workers, 1);
});

test("chat returns documented errors for bad bodies, locks, and runtime failures", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const created = await createSession(registry, { colony_id: "acme" });
  const chatPath = `/api/sessions/${created.session_id}/chat`;

  const missingMessage = await callJson(registry, "POST", chatPath, { body: {} });
  assert.equal(missingMessage.status, 400);
  assert.match(missingMessage.body.error, /message/);

  const empty = await callJson(registry, "POST", chatPath, { body: { message: "   " } });
  assert.equal(empty.status, 400);

  const noRuntime = await callJson(registry, "POST", chatPath, { body: { message: "hi" } });
  assert.equal(noRuntime.status, 409);
  assert.equal(noRuntime.body.error, "queen_unavailable");

  const failing = makeQueen("acme", { fail: true });
  const failingRegistry = makeRegistry({ runtimes: new Map([["acme", failing]]) });
  const failed = await callJson(failingRegistry, "POST", chatPath, { body: { message: "hi" } });
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /model down/);

  const page = await callJson(registry, "GET", `/api/sessions/${created.session_id}/events/history`);
  assert.deepEqual(page.body.events.map((event) => event.type), [
    "client_input_received",
    "execution_failed",
  ]);

  const unknown = await callJson(registry, "POST", "/api/sessions/sess-nope/chat", {
    body: { message: "hi" },
  });
  assert.equal(unknown.status, 404);
});

test("mark-colony-spawned locks the session and chat returns 409", async () => {
  useHome();
  seedColony("acme");
  seedColony("beta", "queen_ops");
  const registry = makeRegistry({ runtimes: new Map([["acme", makeQueen("acme")]]) });
  const created = await createSession(registry, { colony_id: "acme" });

  const bad = await callJson(registry, "POST", `/api/sessions/${created.session_id}/mark-colony-spawned`, {
    body: {},
  });
  assert.equal(bad.status, 400);

  const marked = await callJson(registry, "POST", `/api/sessions/${created.session_id}/mark-colony-spawned`, {
    body: { colony_id: "beta" },
  });
  assert.deepEqual(marked.body, {
    session_id: created.session_id,
    colony_spawned: true,
    spawned_colony_id: "beta",
  });

  const detail = await callJson(registry, "GET", `/api/sessions/${created.session_id}`);
  assert.equal(detail.body.colony_spawned, true);
  assert.equal(detail.body.spawned_colony_id, "beta");

  const locked = await callJson(registry, "POST", `/api/sessions/${created.session_id}/chat`, {
    body: { message: "continue" },
  });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error, "session_locked");
  assert.equal(locked.body.reason, "colony_spawned");
});

test("events history pages backward with real offsets and counts", async () => {
  useHome();
  seedColony("acme");
  const queen = makeQueen("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", queen]]) });
  const created = await createSession(registry, { colony_id: "acme" });
  const base = `/api/sessions/${created.session_id}/events/history`;

  const empty = await callJson(registry, "GET", base);
  assert.deepEqual(empty.body, {
    events: [],
    session_id: created.session_id,
    total: 0,
    returned: 0,
    truncated: false,
    limit: 500,
    start_index: 0,
    start_offset: 0,
    has_more_older: false,
  });

  await callJson(registry, "POST", `/api/sessions/${created.session_id}/chat`, {
    body: { message: "one" },
  });

  const tail = await callJson(registry, "GET", `${base}?limit=1`);
  assert.equal(tail.body.limit, 1);
  assert.equal(tail.body.returned, 1);
  assert.equal(tail.body.events[0].type, "llm_text_delta");
  assert.equal(tail.body.start_index, 2);
  assert.equal(tail.body.has_more_older, true);

  const older = await callJson(
    registry,
    "GET",
    `${base}?limit=1&before_offset=${tail.body.start_offset}&before_index=${tail.body.start_index}`,
  );
  assert.equal(older.body.events[0].type, "client_input_received");
  assert.equal(older.body.total, -1);
  assert.equal(older.body.has_more_older, false);
  assert.equal(older.body.start_index, 1);
});

test("snapshot reflects the live runtime and event log", async () => {
  useHome();
  seedColony("acme");
  const queen = makeQueen("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", queen]]) });
  const created = await createSession(registry, { colony_id: "acme" });

  const idle = await callJson(registry, "GET", `/api/sessions/${created.session_id}/snapshot`);
  assert.equal(idle.status, 200);
  assert.equal(idle.body.is_executing, false);
  assert.equal(idle.body.queen_busy_reason, null);
  assert.equal(idle.body.awaiting_input, false);
  assert.equal(idle.body.snapshot_seq, 0);

  queen.running = true;
  await callJson(registry, "POST", `/api/sessions/${created.session_id}/chat`, {
    body: { message: "work" },
  });
  const busy = await callJson(registry, "GET", `/api/sessions/${created.session_id}/snapshot`);
  assert.equal(busy.body.is_executing, true);
  assert.equal(busy.body.queen_busy_reason, "llm");
  assert.equal(busy.body.snapshot_seq, 2);
  assert.equal(typeof busy.body.last_event_at, "string");

  const unknown = await callJson(registry, "GET", "/api/sessions/sess-nope/snapshot");
  assert.equal(unknown.status, 404);
});

test("live_tools exposes the queen runtime tool list", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", makeQueen("acme")]]) });
  const created = await createSession(registry, { colony_id: "acme" });

  const result = await callJson(registry, "GET", `/api/sessions/${created.session_id}/live_tools`);
  assert.equal(result.status, 200);
  assert.equal(result.body.session_id, created.session_id);
  assert.equal(result.body.phase_state_ready, true);
  assert.deepEqual(result.body.tools.map((tool) => tool.name), ["tracker_query", "spawn_worker"]);
  assert.deepEqual(result.body.actual_tools, result.body.tools);
  assert.equal(result.body.expected_tools.every((tool) => tool.status === "callable"), true);

  const unknown = await callJson(registry, "GET", "/api/sessions/sess-nope/live_tools");
  assert.equal(unknown.status, 404);
});

test("stats reports message, event, task, and worker counts", async () => {
  useHome();
  seedColony("acme");
  createTask("acme", { subject: "first" });
  createTask("acme", { subject: "second" });
  const registry = makeRegistry({ runtimes: new Map([["acme", makeQueen("acme")]]) });
  const created = await createSession(registry, { colony_id: "acme" });
  await callJson(registry, "POST", `/api/sessions/${created.session_id}/chat`, {
    body: { message: "hello" },
  });

  const stats = await callJson(registry, "GET", `/api/sessions/${created.session_id}/stats`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.session_id, created.session_id);
  assert.equal(stats.body.colony_id, "acme");
  assert.equal(stats.body.messages, 2);
  assert.equal(stats.body.events, 2);
  assert.deepEqual(stats.body.tasks, { total: 2, open: 2 });
  assert.equal(stats.body.workers, 1);
  assert.equal(stats.body.status, "live");

  const unknown = await callJson(registry, "GET", "/api/sessions/sess-nope/stats");
  assert.equal(unknown.status, 404);
});

test("colony session history and active-session use only stored rows", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", makeQueen("acme")]]) });

  const emptyActive = await callJson(registry, "GET", "/api/colonies/acme/active-session");
  assert.deepEqual(emptyActive.body, { session: null });

  const created = await createSession(registry, { colony_id: "acme" });

  const history = await callJson(registry, "GET", "/api/colonies/acme/sessions");
  assert.equal(history.status, 200);
  assert.equal(history.body.sessions.length, 1);
  assert.equal(history.body.sessions[0].session_id, created.session_id);
  assert.equal(history.body.sessions[0].cold, false);
  assert.equal(history.body.sessions[0].live, true);
  assert.equal(history.body.sessions[0].has_messages, false);

  const stillEmpty = await callJson(registry, "GET", "/api/colonies/acme/active-session");
  assert.deepEqual(stillEmpty.body, { session: null });

  await callJson(registry, "POST", `/api/sessions/${created.session_id}/record-message`, {
    body: { message: "remember this" },
  });

  const active = await callJson(registry, "GET", "/api/colonies/acme/active-session");
  assert.equal(active.body.session.session_id, created.session_id);
  assert.equal(active.body.session.has_messages, true);

  const missing = await callJson(registry, "GET", "/api/colonies/nope/sessions");
  assert.equal(missing.status, 404);

  const invalid = await callJson(registry, "GET", "/api/colonies/BAD_NAME/sessions");
  assert.equal(invalid.status, 400);
});

test("trigger routes create, list, patch, activate, deactivate, and run", async () => {
  useHome();
  seedColony("acme");
  const queen = makeQueen("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", queen]]) });
  const created = await createSession(registry, { colony_id: "acme" });
  const base = `/api/sessions/${created.session_id}/triggers`;

  const createdTrigger = await callJson(registry, "POST", base, {
    body: {
      name: "Nightly ops check",
      task: "Review the tracker and report anomalies",
      trigger_config: { interval_minutes: 30 },
    },
  });
  assert.equal(createdTrigger.status, 200);
  assert.equal(createdTrigger.body.trigger_id, "user-nightly-ops-check");
  assert.equal(createdTrigger.body.trigger_type, "timer");
  assert.deepEqual(createdTrigger.body.trigger_config, { interval_minutes: 30 });

  const stored = JSON.parse(fs.readFileSync(path.join(colonyDir("acme"), "triggers.json"), "utf8"));
  assert.equal(stored.triggers.length, 1);
  assert.equal(stored.triggers[0].name, "user-nightly-ops-check");
  assert.equal(stored.triggers[0].enabled, true);

  const list = await callJson(registry, "GET", base);
  assert.equal(list.body.triggers.length, 1);
  assert.equal(list.body.triggers[0].task, "Review the tracker and report anomalies");
  assert.equal(list.body.triggers[0].enabled, true);

  const updated = await callJson(registry, "PATCH", `/api/sessions/${created.session_id}/triggers/${createdTrigger.body.trigger_id}`, {
    body: { task: "Check twice", trigger_config: { cron: "0 9 * * *" } },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.task, "Check twice");
  assert.deepEqual(updated.body.trigger_config, { cron: "0 9 * * *" });

  const deactivated = await callJson(
    registry,
    "POST",
    `/api/sessions/${created.session_id}/triggers/${createdTrigger.body.trigger_id}/deactivate`,
  );
  assert.deepEqual(deactivated.body, {
    status: "deactivated",
    trigger_id: createdTrigger.body.trigger_id,
  });

  const activated = await callJson(
    registry,
    "POST",
    `/api/sessions/${created.session_id}/triggers/${createdTrigger.body.trigger_id}/activate`,
  );
  assert.deepEqual(activated.body, {
    status: "activated",
    trigger_id: createdTrigger.body.trigger_id,
  });

  const run = await callJson(registry, "POST", `/api/sessions/${created.session_id}/triggers/${createdTrigger.body.trigger_id}/run`);
  assert.deepEqual(run.body, { status: "triggered", trigger_id: createdTrigger.body.trigger_id });
  assert.equal(queen.fired.length, 1);
  assert.equal(queen.fired[0].name, createdTrigger.body.trigger_id);
});

test("trigger routes reject invalid bodies and unknown triggers", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", makeQueen("acme")]]) });
  const created = await createSession(registry, { colony_id: "acme" });
  const base = `/api/sessions/${created.session_id}/triggers`;

  const noName = await callJson(registry, "POST", base, {
    body: { task: "x", trigger_config: { interval_minutes: 5 } },
  });
  assert.equal(noName.status, 400);

  const noTask = await callJson(registry, "POST", base, {
    body: { name: "x", trigger_config: { interval_minutes: 5 } },
  });
  assert.equal(noTask.status, 400);

  const noConfig = await callJson(registry, "POST", base, {
    body: { name: "x", task: "x" },
  });
  assert.equal(noConfig.status, 400);

  const badType = await callJson(registry, "POST", base, {
    body: { name: "x", task: "x", trigger_type: "webhook", trigger_config: { interval_minutes: 5 } },
  });
  assert.equal(badType.status, 400);

  const badInterval = await callJson(registry, "POST", base, {
    body: { name: "x", task: "x", trigger_config: { interval_minutes: -1 } },
  });
  assert.equal(badInterval.status, 400);

  const badCron = await callJson(registry, "POST", base, {
    body: { name: "x", task: "x", trigger_config: { cron: "not a cron" } },
  });
  assert.equal(badCron.status, 400);

  const unknownTrigger = await callJson(registry, "PATCH", `${base}/user-nope`, {
    body: { task: "x" },
  });
  assert.equal(unknownTrigger.status, 404);

  const unknownRun = await callJson(registry, "POST", `${base}/user-nope/run`);
  assert.equal(unknownRun.status, 404);

  const unknownSession = await callJson(registry, "GET", "/api/sessions/sess-nope/triggers");
  assert.equal(unknownSession.status, 404);

  const noUpdates = await callJson(registry, "POST", base, {
    body: { name: "x", task: "x", trigger_config: { interval_minutes: 5 } },
  });
  assert.equal(noUpdates.status, 200);
  const triggerId = noUpdates.body.trigger_id;
  const emptyPatch = await callJson(registry, "PATCH", `${base}/${triggerId}`, { body: {} });
  assert.equal(emptyPatch.status, 400);
});

test("attachment upload stores the file and GET streams it back", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const created = await createSession(registry, { colony_id: "acme" });
  const payload = multipart("notes.txt", "hello attachment", "text/plain");

  const upload = await callJson(registry, "POST", `/api/sessions/${created.session_id}/upload-attachment`, {
    rawBody: payload.rawBody,
    headers: payload.headers,
  });
  assert.equal(upload.status, 200);
  assert.equal(upload.body.session_id, created.session_id);
  assert.equal(upload.body.original_name, "notes.txt");
  assert.equal(upload.body.content_type, "text/plain");
  assert.match(upload.body.filename, /notes\.txt$/);
  assert.ok(fs.existsSync(upload.body.path));
  assert.equal(fs.readFileSync(upload.body.path, "utf8"), "hello attachment");

  const download = await call(
    registry,
    "GET",
    `/api/sessions/${created.session_id}/attachment/${encodeURIComponent(upload.body.filename)}`,
  );
  assert.equal(download.res.statusCode, 200);
  assert.equal(download.res.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(download.res.text(), "hello attachment");
  assert.equal(download.res.ended, true);

  const noFile = await callJson(registry, "POST", `/api/sessions/${created.session_id}/upload-attachment`, {
    rawBody: Buffer.alloc(0),
    headers: payload.headers,
  });
  assert.equal(noFile.status, 400);

  const traversal = await callJson(
    registry,
    "GET",
    `/api/sessions/${created.session_id}/attachment/${encodeURIComponent("../session.json")}`,
  );
  assert.equal(traversal.status, 400);

  const missing = await callJson(registry, "GET", `/api/sessions/${created.session_id}/attachment/nope.txt`);
  assert.equal(missing.status, 404);
});

test("record-message persists without running the queen", async () => {
  useHome();
  seedColony("acme");
  const queen = makeQueen("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", queen]]) });
  const created = await createSession(registry, { colony_id: "acme" });
  const pathName = `/api/sessions/${created.session_id}/record-message`;

  const first = await callJson(registry, "POST", pathName, { body: { message: "I choose option B" } });
  assert.deepEqual(first.body, { status: "recorded", seq: 0 });
  const second = await callJson(registry, "POST", pathName, { body: { message: "and C" } });
  assert.deepEqual(second.body, { status: "recorded", seq: 1 });
  assert.equal(queen.calls.length, 0, "record-message must not call the model");

  const page = await callJson(registry, "GET", `/api/sessions/${created.session_id}/events/history`);
  assert.deepEqual(page.body.events.map((event) => event.type), [
    "client_input_received",
    "client_input_received",
  ]);

  const bad = await callJson(registry, "POST", pathName, { body: { message: "" } });
  assert.equal(bad.status, 400);
});

test("queen-context queues to the live runtime or persists for cold sessions", async () => {
  useHome();
  seedColony("acme");
  const queen = makeQueen("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", queen]]) });
  const created = await createSession(registry, { colony_id: "acme" });

  const live = await callJson(registry, "POST", `/api/sessions/${created.session_id}/queen-context`, {
    body: { message: "the customer prefers email" },
  });
  assert.deepEqual(live.body, { status: "queued", delivered: true });
  assert.equal(queen.queue.length, 1);
  assert.match(queen.queue[0].text, /\[External event\]: the customer prefers email/);

  const coldRegistry = makeRegistry();
  const cold = await callJson(coldRegistry, "POST", `/api/sessions/${created.session_id}/queen-context`, {
    body: { message: "remember this later" },
  });
  assert.deepEqual(cold.body, { status: "queued_persisted", delivered: false });

  const store = new SessionStore({ home: process.env.PI_HIVE_HOME });
  const record = store.get(created.session_id);
  assert.equal(record.pending_context.length, 1);
  assert.equal(record.pending_context[0].message, "remember this later");

  const bad = await callJson(registry, "POST", `/api/sessions/${created.session_id}/queen-context`, {
    body: {},
  });
  assert.equal(bad.status, 400);
});

test("cancel-queen and presence report runtime state honestly", async () => {
  useHome();
  seedColony("acme");
  const queen = makeQueen("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", queen]]) });
  const created = await createSession(registry, { colony_id: "acme" });

  const cancelled = await callJson(registry, "POST", `/api/sessions/${created.session_id}/cancel-queen`);
  assert.deepEqual(cancelled.body, { cancelled: true });
  assert.equal(queen.agent.aborted, true);

  const cold = await callJson(makeRegistry(), "POST", `/api/sessions/${created.session_id}/cancel-queen`);
  assert.deepEqual(cold.body, { cancelled: false, error: "Queen not active" });

  const presence = await callJson(registry, "POST", `/api/sessions/${created.session_id}/presence`);
  assert.deepEqual(presence.body, { ok: true, resumed: false });

  const unknown = await callJson(registry, "POST", "/api/sessions/sess-nope/presence");
  assert.equal(unknown.status, 404);
});

test("fork copies the transcript and can cut before a timestamp", async () => {
  useHome();
  seedColony("acme");
  const queen = makeQueen("acme", { reply: "answer one" });
  const registry = makeRegistry({ runtimes: new Map([["acme", queen]]) });
  const created = await createSession(registry, { colony_id: "acme" });
  await callJson(registry, "POST", `/api/sessions/${created.session_id}/chat`, {
    body: { message: "question one" },
  });

  const forked = await callJson(registry, "POST", `/api/sessions/${created.session_id}/fork`, {
    body: {},
  });
  assert.equal(forked.status, 200);
  assert.notEqual(forked.body.session_id, created.session_id);
  assert.equal(forked.body.copied_events, 2);

  const detail = await callJson(registry, "GET", `/api/sessions/${forked.body.session_id}`);
  assert.equal(detail.body.forked_from, created.session_id);

  const cut = await callJson(registry, "POST", `/api/sessions/${created.session_id}/fork`, {
    body: { before_input_at: new Date(0).toISOString() },
  });
  assert.equal(cut.body.copied_events, 0);

  const bad = await callJson(registry, "POST", `/api/sessions/${created.session_id}/fork`, {
    body: { before_input_at: 42 },
  });
  assert.equal(bad.status, 400);
});

test("compact-and-fork links a new session and reports which compaction ran", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry({ runtimes: new Map([["acme", makeQueen("acme")]]) });
  const created = await createSession(registry, { colony_id: "acme" });
  await callJson(registry, "POST", `/api/sessions/${created.session_id}/record-message`, {
    body: { message: "first decision" },
  });
  await callJson(registry, "POST", `/api/sessions/${created.session_id}/record-message`, {
    body: { message: "second decision" },
  });

  const result = await callJson(
    registry,
    "POST",
    `/api/sessions/${created.session_id}/compact-and-fork`,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.compacted_from, created.session_id);
  assert.equal(result.body.messages_compacted, 2);
  assert.equal(typeof result.body.summary_chars, "number");
  assert.ok(result.body.summary_chars > 0);
  assert.equal(result.body.compaction, "extract", "no runtime is reachable in this harness");
  assert.match(result.body.note, /verbatim extract/);

  const store = new SessionStore({ home: process.env.PI_HIVE_HOME });
  const forked = store.get(result.body.new_session_id);
  assert.equal(forked.forked_from, created.session_id);
  assert.match(forked.compaction_summary, /first decision/);

  assert.ok(store.get(created.session_id), "the source session stays on disk");
  assert.equal(
    (await callJson(registry, "POST", "/api/sessions/sess-nope/compact-and-fork")).status,
    404,
  );
});

test("DELETE stops a session but keeps it in colony history as cold", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const created = await createSession(registry, { colony_id: "acme" });

  const stopped = await callJson(registry, "DELETE", `/api/sessions/${created.session_id}`);
  assert.deepEqual(stopped.body, { session_id: created.session_id, stopped: true });

  const live = await callJson(registry, "GET", "/api/sessions");
  assert.deepEqual(live.body.sessions, []);

  const detail = await callJson(registry, "GET", `/api/sessions/${created.session_id}`);
  assert.equal(detail.body.cold, true);

  const history = await callJson(registry, "GET", "/api/colonies/acme/sessions");
  assert.equal(history.body.sessions.length, 1);
  assert.equal(history.body.sessions[0].cold, true);
  assert.equal(history.body.sessions[0].live, false);

  const unknown = await callJson(registry, "DELETE", "/api/sessions/sess-nope");
  assert.equal(unknown.status, 404);
});

test("DELETE /sessions/history/:session purges only stopped records", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const created = await createSession(registry, { colony_id: "acme" });

  const live = await callJson(
    registry,
    "DELETE",
    `/api/sessions/history/${created.session_id}`,
  );
  assert.equal(live.status, 409);
  assert.equal(live.body.deleted, false);

  assert.equal(
    (await callJson(registry, "DELETE", `/api/sessions/${created.session_id}`)).status,
    200,
  );

  const purged = await callJson(
    registry,
    "DELETE",
    `/api/sessions/history/${created.session_id}`,
  );
  assert.deepEqual(purged.body, { deleted: true, session_id: created.session_id });
  assert.equal(
    fs.existsSync(path.join(process.env.PI_HIVE_HOME, "sessions", created.session_id)),
    false,
  );
  assert.equal(
    (await callJson(registry, "DELETE", `/api/sessions/history/${created.session_id}`)).status,
    404,
  );
});

test("dismiss-colony-pivot and reveal return real paths", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const created = await createSession(registry, { colony_id: "acme" });

  const dismissed = await callJson(
    registry,
    "POST",
    `/api/sessions/${created.session_id}/dismiss-colony-pivot`,
  );
  assert.deepEqual(dismissed.body, { dismissed: false, reason: "no_pending_pivot" });

  const revealed = await callJson(registry, "POST", `/api/sessions/${created.session_id}/reveal`);
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.revealed, false);
  assert.equal(
    revealed.body.path,
    path.join(process.env.PI_HIVE_HOME, "sessions", created.session_id),
  );
  assert.ok(fs.existsSync(revealed.body.path));

  assert.equal(
    (await callJson(registry, "POST", "/api/sessions/sess-nope/reveal")).status,
    404,
  );
});

test("report-bundle writes a real tar.gz with size and sha256", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const created = await createSession(registry, { colony_id: "acme" });
  await callJson(registry, "POST", `/api/sessions/${created.session_id}/record-message`, {
    body: { message: "evidence" },
  });

  const report = await callJson(registry, "POST", `/api/sessions/${created.session_id}/report-bundle`, {
    body: { description: "it broke", severity: "high" },
  });
  assert.equal(report.status, 200);
  assert.equal(report.body.ok, true);
  assert.equal(report.body.content_type, "application/gzip");
  assert.match(report.body.filename, /\.tar\.gz$/);
  assert.match(report.body.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.body.size, fs.statSync(report.body.bundle_path).size);

  // A real gzipped tar: unpack it and read the members back.
  const archive = zlib.gunzipSync(fs.readFileSync(report.body.bundle_path));
  const names = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim(), 8);
    names.push(name);
    const body = archive.subarray(offset + 512, offset + 512 + size).toString("utf8");
    if (name === "report.json") {
      assert.equal(JSON.parse(body).description, "it broke");
      assert.equal(JSON.parse(body).severity, "high");
    }
    if (name === "session.json") assert.equal(JSON.parse(body).session_id, created.session_id);
    if (name === "events.jsonl") assert.match(body, /"evidence"/);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(names, ["report.json", "session.json", "events.jsonl", "transcript.txt", "README.txt"]);
  assert.equal(report.body.stats.binary_files, 0);

  assert.equal(
    (await callJson(registry, "POST", "/api/sessions/sess-nope/report-bundle", { body: {} })).status,
    404,
  );
});

test("records survive a fresh SessionStore instance (restart simulation)", async () => {
  useHome();
  seedColony("acme");
  const registry = makeRegistry();
  const created = await createSession(registry, { colony_id: "acme" });
  await callJson(registry, "POST", `/api/sessions/${created.session_id}/record-message`, {
    body: { message: "persisted across restart" },
  });

  const reopened = new SessionStore({ home: process.env.PI_HIVE_HOME });
  const record = reopened.get(created.session_id);
  assert.equal(record.session_id, created.session_id);
  assert.equal(record.message_count, 1);

  const page = await callJson(registry, "GET", `/api/sessions/${created.session_id}/events/history`);
  assert.equal(page.body.events.length, 1);

  // A restarted process has no in-memory live set: the durable record becomes
  // cold history, still visible to the colony page and by id.
  clearSessionStoreCache();
  const restarted = makeRegistry();
  const list = await callJson(restarted, "GET", "/api/sessions");
  assert.deepEqual(list.body.sessions, []);

  const history = await callJson(restarted, "GET", "/api/colonies/acme/sessions");
  assert.equal(history.body.sessions.length, 1);
  assert.equal(history.body.sessions[0].cold, true);
  assert.equal(history.body.sessions[0].has_messages, true);

  const detail = await callJson(restarted, "GET", `/api/sessions/${created.session_id}`);
  assert.equal(detail.body.session_id, created.session_id);
  assert.equal(detail.body.cold, true);

  // Chat revives the cold record into the live feed.
  const revived = makeRegistry({ runtimes: new Map([["acme", makeQueen("acme")]]) });
  const chatted = await callJson(revived, "POST", `/api/sessions/${created.session_id}/chat`, {
    body: { message: "wake up" },
  });
  assert.equal(chatted.status, 200);
  const liveAgain = await callJson(revived, "GET", "/api/sessions");
  assert.deepEqual(liveAgain.body.sessions.map((row) => row.session_id), [created.session_id]);
});

// ---------------------------------------------------------------------------
// Cross-lane resolution: sessions lane -> autonomy session subroutes
// ---------------------------------------------------------------------------

test("a session created through POST /api/sessions resolves on the autonomy worker route", async () => {
  useHome();
  seedColony("acme", "queen_tech", "ship a slice");

  const ctx = { runtimes: new Map() };
  const registry = makeCombinedRegistry(ctx);
  const created = await createSession(registry, { colony_id: "acme" });

  // The sessions lane publishes the durable store on the shared context.
  assert.equal(typeof ctx.resolveSession, "function");
  assert.equal(typeof ctx.sessionStore?.get, "function");
  assert.equal(ctx.resolveSession(created.session_id), "acme");

  const workers = await callJson(registry, "GET", `/api/sessions/${created.session_id}/workers`);
  assert.equal(workers.status, 200, JSON.stringify(workers.body));
  assert.deepEqual(workers.body.workers, []);

  // Every autonomy session subroute must see the same session, not only workers.
  const tasks = await callJson(registry, "GET", `/api/sessions/${created.session_id}/tasks`);
  assert.notEqual(tasks.body.type, "unknown_session", JSON.stringify(tasks.body));
  assert.equal(tasks.body.session_id, created.session_id);
});

test("a per-call ctx that is a different object still resolves through the durable store", async () => {
  useHome();
  seedColony("acme");

  const boundCtx = { runtimes: new Map() };
  const registry = makeCombinedRegistry(boundCtx);
  const created = await createSession(registry, { colony_id: "acme" });

  // A host may hand each call a fresh object without the registration-time
  // resolver or store; resolution must fall back to the store directly.
  const perCallCtx = { runtimes: new Map() };
  const workers = await callJson(registry, "GET", `/api/sessions/${created.session_id}/workers`, {
    ctx: perCallCtx,
  });
  assert.equal(workers.status, 200, JSON.stringify(workers.body));
  assert.equal(perCallCtx.resolveSession, undefined);

  assert.equal(sessionColonyFromStore(perCallCtx, created.session_id), "acme");
  assert.equal(sessionColonyFromStore(perCallCtx, "sess-unknown"), null);
});

test("a frozen ctx is not mutated and still resolves through the store fallback", async () => {
  useHome();
  seedColony("acme");

  const frozenCtx = Object.freeze({ runtimes: new Map() });
  const registry = makeCombinedRegistry(frozenCtx);
  const created = await createSession(registry, { colony_id: "acme" });

  assert.equal(frozenCtx.resolveSession, undefined);
  assert.equal(frozenCtx.sessionStore, undefined);

  const workers = await callJson(registry, "GET", `/api/sessions/${created.session_id}/workers`);
  assert.equal(workers.status, 200, JSON.stringify(workers.body));
});

test("a session parks at an event cursor and resumes from it", async () => {
  useHome();
  createColony({ name: "acme", goal: "park and resume" });
  const store = new SessionStore();
  const session = store.create({ colonyId: "acme", queenId: "queen_tech" });

  // Nothing to resume from yet: an empty log parks at cursor 0.
  const emptyPark = store.park(session.session_id, { reason: "nothing yet" });
  assert.equal(emptyPark.parked, true);
  assert.equal(emptyPark.resume_cursor, 0);
  assert.equal(store.resume(session.session_id).cursor, 0);

  store.appendEvent(session.session_id, { type: "client_input_received", data: { content: "first" } });
  store.appendEvent(session.session_id, { type: "assistant_message", data: { content: "second" } });

  const parked = store.park(session.session_id, { reason: "waiting on a key" });
  assert.equal(parked.parked, true);
  assert.equal(parked.park_reason, "waiting on a key");
  assert.ok(parked.parked_at);
  assert.ok(parked.resume_cursor > 0, "the cursor points past the last event");

  // Parking does not stop the session, and it is durable on disk.
  assert.equal(store.get(session.session_id).stopped_at, null);
  const reread = new SessionStore().get(session.session_id);
  assert.equal(reread.parked, true);
  assert.equal(reread.resume_cursor, parked.resume_cursor);

  // Events appended while parked move the log past the stored cursor.
  store.appendEvent(session.session_id, { type: "assistant_message", data: { content: "third" } });
  assert.ok(store.lastEventCursor(session.session_id) > parked.resume_cursor);

  const resumed = store.resume(session.session_id);
  assert.deepEqual(resumed, { session_id: session.session_id, resumed: true, cursor: parked.resume_cursor });
  const cleared = store.get(session.session_id);
  assert.equal(cleared.parked, false);
  assert.equal(cleared.park_reason, null);
  assert.equal(cleared.resume_cursor, null);

  // Resuming an unparked session says so and reports the live cursor.
  const again = store.resume(session.session_id);
  assert.equal(again.resumed, false);
  assert.equal(again.cursor, store.lastEventCursor(session.session_id));

  assert.equal(store.park("sess-nope"), null);
  assert.equal(store.resume("sess-nope"), null);
});
