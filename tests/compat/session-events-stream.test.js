/**
 * Regression tests for the real session-events bridge
 * (GET /api/sessions/:session/events).
 *
 * The stream must replay the durable `events.jsonl` log as `event: message`
 * frames, tail lines appended after the connection opened, 404 an unknown id,
 * survive malformed lines, and stop its poller on every close path. Each test
 * uses a throwaway PI_HIVE_HOME, and every connection is closed before the
 * test ends; the poller is unref'd, so node:test reports no open handles.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RouteRegistry } from "../../src/compat/router.js";
import { clearSessionStoreCache } from "../../src/compat/handlers/sessions.js";
import {
  DEFAULT_EVENT_POLL_MS,
  STREAM_ROUTES,
  createEventTail,
  registerStreamRoutes,
} from "../../src/compat/handlers/streams.js";
import { SessionStore } from "../../src/compat/sessions.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-session-stream-"));
let homeCounter = 0;

after(() => {
  delete process.env.PI_HIVE_HOME;
  clearSessionStoreCache();
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function newStore() {
  const home = path.join(TMP_ROOT, `home-${(homeCounter += 1)}`);
  fs.mkdirSync(home, { recursive: true });
  return new SessionStore({ home });
}

class FakeRequest extends EventEmitter {
  constructor(url) {
    super();
    this.method = "GET";
    this.url = url;
    this.headers = { accept: "text/event-stream" };
  }
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
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.ended = true;
    this.headersSent = true;
  }

  get body() {
    return this.chunks.join("");
  }
}

function makeRegistry() {
  const registry = new RouteRegistry();
  registerStreamRoutes(registry, {});
  return registry;
}

async function connect(registry, sessionId, ctx) {
  const pathname = `/api/sessions/${sessionId}/events`;
  const match = registry.match("GET", pathname);
  assert.ok(match, `no route matched GET ${pathname}`);
  const req = new FakeRequest(pathname);
  const res = new FakeResponse();
  const result = await match.route.handler({ req, res, params: match.params, ctx });
  return { match, req, res, result };
}

async function invoke(registry, pathname, ctx) {
  const match = registry.match("GET", pathname);
  assert.ok(match, `no route matched GET ${pathname}`);
  const req = new FakeRequest(pathname);
  const res = new FakeResponse();
  const result = await match.route.handler({ req, res, params: match.params, ctx });
  return { match, req, res, result };
}

/** Parse data frames only; comment/heartbeat frames are ignored. */
function dataFrames(body) {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame && !frame.startsWith(":"))
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event:"));
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return { event: event ? event.slice(6).trim() : "message", data };
    });
}

test("replays every stored event as an ordered `event: message` frame", async () => {
  const store = newStore();
  const sessionId = "sess_replay_1";
  store.create({ sessionId });
  const first = store.appendEvent(sessionId, {
    type: "client_input_received",
    data: { content: "hello queen", image_count: 0 },
  });
  const second = store.appendEvent(sessionId, {
    type: "llm_text_delta",
    data: { content: "hello back", snapshot: "hello back" },
  });

  const registry = makeRegistry();
  const { res, req, result } = await connect(registry, sessionId, {
    sessionStore: store,
    heartbeatMs: 10_000,
    eventPollMs: 20,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-cache, no-transform");
  assert.equal(res.headers.connection, "keep-alive");
  assert.equal(res.headers["x-accel-buffering"], "no");
  assert.equal(result.status, 200);
  assert.equal(result.sse, true);
  assert.equal(result.session_id, sessionId);
  assert.ok(res.body.startsWith(`: session ${sessionId} connected\n\n`));

  const frames = dataFrames(res.body);
  assert.equal(frames.length, 2, `expected 2 replayed frames, got ${frames.length}`);
  assert.deepEqual(
    frames.map((frame) => frame.event),
    ["message", "message"],
  );
  assert.deepEqual(JSON.parse(frames[0].data), first);
  assert.deepEqual(JSON.parse(frames[1].data), second);
  // The exact stored records, not a projection or a synthesized snapshot.
  assert.equal(JSON.parse(frames[0].data).type, "client_input_received");
  assert.equal(JSON.parse(frames[1].data).data.snapshot, "hello back");

  req.emit("close");
  assert.equal(result.stream.closed, true);
});

test("tails events appended after the stream opened, exactly once", async () => {
  const store = newStore();
  const sessionId = "sess_tail_1";
  store.create({ sessionId });
  store.appendEvent(sessionId, {
    type: "client_input_received",
    data: { content: "first", image_count: 0 },
  });

  const registry = makeRegistry();
  const { res, req, result } = await connect(registry, sessionId, {
    sessionStore: store,
    heartbeatMs: 10_000,
    eventPollMs: 20,
  });
  assert.equal(dataFrames(res.body).length, 1);

  const third = store.appendEvent(sessionId, {
    type: "llm_text_delta",
    data: { content: "streamed reply", snapshot: "streamed reply" },
  });
  const fourth = store.appendEvent(sessionId, {
    type: "execution_failed",
    data: { error: "boom" },
  });

  await sleep(140);

  const frames = dataFrames(res.body);
  assert.equal(frames.length, 3, `expected 3 frames after tail, got ${frames.length}`);
  assert.deepEqual(JSON.parse(frames[1].data), third);
  assert.deepEqual(JSON.parse(frames[2].data), fourth);
  // Byte-offset cursor: replayed lines are never sent a second time.
  const seqs = frames.map((frame) => JSON.parse(frame.data).seq);
  assert.deepEqual(seqs, [0, 1, 2]);
  assert.equal(new Set(seqs).size, 3);
  assert.ok(result.stream.tail.offset > 0);

  req.emit("close");
});

test("buffers a partial trailing line until its newline arrives", async () => {
  const store = newStore();
  const sessionId = "sess_partial_1";
  store.create({ sessionId });
  store.appendEvent(sessionId, { type: "client_input_received", data: { content: "one" } });

  const registry = makeRegistry();
  const { res, req, result } = await connect(registry, sessionId, {
    sessionStore: store,
    heartbeatMs: 10_000,
    eventPollMs: 20,
  });
  assert.equal(dataFrames(res.body).length, 1);

  const file = store.eventsFile(sessionId);
  fs.appendFileSync(file, '{"type":"custom",');
  await sleep(80);
  assert.equal(dataFrames(res.body).length, 1, "a half-written line must not be emitted");

  fs.appendFileSync(file, '"data":{"note":"split"}}\n');
  await sleep(80);

  const frames = dataFrames(res.body);
  assert.equal(frames.length, 2);
  assert.deepEqual(JSON.parse(frames[1].data), {
    type: "custom",
    data: { note: "split" },
  });
  assert.equal(result.stream.tail.partial, "");

  req.emit("close");
});

test("skips malformed stored lines instead of fabricating or crashing", async () => {
  const store = newStore();
  const sessionId = "sess_malformed_1";
  store.create({ sessionId });
  const good = store.appendEvent(sessionId, {
    type: "client_input_received",
    data: { content: "still works" },
  });
  fs.appendFileSync(store.eventsFile(sessionId), "not json at all\n");
  // A JSON scalar is parsed but is not an AgentEvent record.
  fs.appendFileSync(store.eventsFile(sessionId), "42\n");

  const registry = makeRegistry();
  const { res, req, result } = await connect(registry, sessionId, {
    sessionStore: store,
    heartbeatMs: 10_000,
    eventPollMs: 20,
  });

  const frames = dataFrames(res.body);
  assert.equal(frames.length, 1);
  assert.deepEqual(JSON.parse(frames[0].data), good);
  assert.equal(result.stream.tail.malformed, 2);

  req.emit("close");
});

test("unknown session is a 404 unknown_session, not an empty stream", async () => {
  const store = newStore();
  const registry = makeRegistry();
  const { res, result } = await connect(registry, "sess_missing", {
    sessionStore: store,
  });

  assert.equal(result.status, 404);
  assert.equal(result.body.type, "unknown_session");
  assert.equal(result.body.session, "sess_missing");
  assert.equal(res.headersSent, false);
  assert.equal(res.chunks.length, 0);
});

test("closes cleanly: poller cleared, response ended, no further writes", async () => {
  const store = newStore();
  const sessionId = "sess_close_1";
  store.create({ sessionId });
  store.appendEvent(sessionId, { type: "client_input_received", data: { content: "hi" } });

  const registry = makeRegistry();
  const { res, req, result } = await connect(registry, sessionId, {
    sessionStore: store,
    heartbeatMs: 20,
    eventPollMs: 20,
  });

  const tail = result.stream.tail;
  assert.ok(tail, "event tail was not created");
  assert.ok(tail.timer, "event poll timer was not scheduled");
  assert.equal(tail.timer.hasRef(), false, "event poll timer must be unref'd");
  assert.equal(result.stream.heartbeat.hasRef(), false);

  await sleep(60);
  assert.ok(res.body.includes(": heartbeat"), "heartbeat comments must keep flowing");

  req.emit("close");
  assert.equal(result.stream.closed, true);
  assert.equal(result.stream.closeReason, "request_close");
  assert.equal(result.stream.tail.closed, true);
  assert.equal(result.stream.tail.timer, null, "poll timer must be cleared");
  assert.equal(res.ended, true);

  const writesAtClose = res.chunks.length;
  await sleep(80);
  assert.equal(res.chunks.length, writesAtClose, "writes continued after close");

  // A direct stream.close() (server shutdown / write error) also stops it.
  const second = await connect(registry, sessionId, {
    sessionStore: store,
    heartbeatMs: 10_000,
    eventPollMs: 20,
  });
  assert.equal(second.result.stream.tail.closed, false);
  second.result.stream.close("test");
  assert.equal(second.result.stream.tail.closed, true);
  assert.equal(second.result.stream.tail.timer, null);
});

test("resolves the store from ctx.hiveHome when no store instance is provided", async () => {
  const store = newStore();
  const sessionId = "sess_home_1";
  store.create({ sessionId });
  const event = store.appendEvent(sessionId, {
    type: "llm_text_delta",
    data: { content: "from disk", snapshot: "from disk" },
  });

  process.env.PI_HIVE_HOME = store.home;
  clearSessionStoreCache();
  try {
    const registry = makeRegistry();
    const { res, req } = await connect(registry, sessionId, {
      hiveHome: store.home,
      heartbeatMs: 10_000,
      eventPollMs: 20,
    });
    const frames = dataFrames(res.body);
    assert.equal(frames.length, 1);
    assert.deepEqual(JSON.parse(frames[0].data), event);
    req.emit("close");
  } finally {
    delete process.env.PI_HIVE_HOME;
    clearSessionStoreCache();
  }
});

test("GET /api/sessions/live snapshots real live rows from the store", async () => {
  const store = newStore();
  const record = store.create({ sessionId: "sess_live_1" });

  const registry = makeRegistry();
  const { res, req } = await invoke(registry, STREAM_ROUTES.liveSessions, {
    sessionStore: store,
    heartbeatMs: 10_000,
  });
  const frames = dataFrames(res.body);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "snapshot");
  const snapshot = JSON.parse(frames[0].data);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].session_id, record.session_id);
  assert.equal(snapshot.sessions[0].colony_id, null);
  assert.equal(snapshot.network, undefined);
  req.emit("close");

  // With no host provider and no store the snapshot stays honestly empty.
  const bare = makeRegistry();
  const empty = await invoke(bare, STREAM_ROUTES.liveSessions, { heartbeatMs: 10_000 });
  assert.deepEqual(JSON.parse(dataFrames(empty.res.body)[0].data), { sessions: [] });
  empty.req.emit("close");
});

test("createEventTail starts at offset 0, restarts after truncation, and stops", async () => {
  const store = newStore();
  const sessionId = "sess_tail_unit_1";
  store.create({ sessionId });
  const event = store.appendEvent(sessionId, {
    type: "client_input_received",
    data: { content: "one" },
  });
  const file = store.eventsFile(sessionId);

  const received = [];
  const tail = createEventTail({ file, send: (record) => received.push(record), pollMs: 10 });
  assert.equal(DEFAULT_EVENT_POLL_MS, 300);
  assert.equal(tail.pollMs, 10);
  tail.start();
  assert.deepEqual(received, [event]);
  assert.ok(tail.offset > 0);

  // A rewritten (shorter) log is replayed rather than skipped.
  fs.writeFileSync(file, `${JSON.stringify({ type: "custom", data: { replaced: true } })}\n`);
  tail.poll();
  assert.equal(received.length, 2);
  assert.deepEqual(received[1], { type: "custom", data: { replaced: true } });

  tail.stop();
  assert.equal(tail.closed, true);
  assert.equal(tail.timer, null);
  assert.equal(tail.poll(), undefined, "polling after stop is a no-op");
  assert.equal(received.length, 2);
});
