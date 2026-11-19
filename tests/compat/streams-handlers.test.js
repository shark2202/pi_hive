/**
 * Tests for the official-frontend SSE compatibility handlers.
 *
 * These use a fake req/res (an EventEmitter plus captured writes), so no
 * port is bound, no model is called, and no real socket is opened. Every
 * stream is closed before the test ends; the handler's heartbeat is also
 * unref'd, so node:test sees no open handles even if a test fails midway.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { RouteRegistry, ROUTE_STATUS } from "../../src/compat/router.js";
import {
  DEFAULT_HEARTBEAT_MS,
  HEARTBEAT_COMMENT,
  STREAM_ROUTES,
  openSseChannel,
  registerStreamRoutes,
  sseFrame,
} from "../../src/compat/handlers/streams.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeRequest extends EventEmitter {
  constructor(url = "/api/sessions/live") {
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

  writeHead(status, headers) {
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

function makeRegistry(ctx = {}) {
  const registry = new RouteRegistry();
  registerStreamRoutes(registry, ctx);
  return registry;
}

async function invoke(registry, pathname, ctx) {
  const match = registry.match("GET", pathname);
  assert.ok(match, `no route matched GET ${pathname}`);
  const req = new FakeRequest(pathname);
  const res = new FakeResponse();
  const result = await match.route.handler({ req, res, params: match.params, ctx });
  return { match, req, res, result };
}

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

test("registers the three official SSE routes as implemented transports", () => {
  const registry = makeRegistry();
  const routes = registry.routes;
  assert.equal(routes.length, 3);

  const byPath = new Map(routes.map((route) => [route.path, route]));
  assert.deepEqual(
    [...byPath.keys()].sort(),
    [
      "/api/events/global",
      "/api/sessions/:session/events",
      "/api/sessions/live",
    ],
  );

  for (const route of routes) {
    assert.equal(route.method, "GET");
    assert.equal(route.meta.status, ROUTE_STATUS.IMPLEMENTED);
    assert.equal(route.meta.official, true);
    assert.equal(route.meta.transport, "sse");
    assert.equal(typeof route.meta.notes, "string");
    assert.ok(route.meta.notes.length > 20);
    assert.equal(typeof route.handler, "function");
  }

  // Real data feeds (session store) where a bridge exists; the global stream
  // still has no backing event bus and stays honestly empty.
  assert.equal(byPath.get(STREAM_ROUTES.liveSessions).meta.dataSource, "session_store");
  assert.equal(byPath.get(STREAM_ROUTES.globalEvents).meta.dataSource, "empty");
  assert.equal(byPath.get(STREAM_ROUTES.sessionEvents).meta.dataSource, "session_store");

  assert.deepEqual(byPath.get(STREAM_ROUTES.liveSessions).meta.sseEvents, ["snapshot"]);
  assert.deepEqual(byPath.get(STREAM_ROUTES.globalEvents).meta.sseEvents, ["message"]);
  assert.deepEqual(byPath.get(STREAM_ROUTES.sessionEvents).meta.sseEvents, ["message"]);
  assert.match(byPath.get(STREAM_ROUTES.sessionEvents).meta.notes, /replays?/i);
  assert.match(byPath.get(STREAM_ROUTES.sessionEvents).meta.notes, /404/);

  assert.deepEqual(registry.counts(), {
    implemented: 3,
    partial: 0,
    missing: 0,
    total: 3,
  });
});

test("GET /api/sessions/live sends the snapshot frame, heartbeats, and closes cleanly", async () => {
  const registry = makeRegistry({ heartbeatMs: 20 });
  const { res, req, result } = await invoke(registry, "/api/sessions/live");

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-cache, no-transform");
  assert.equal(res.headers.connection, "keep-alive");
  assert.equal(res.headers["x-accel-buffering"], "no");
  assert.equal(result.status, 200);
  assert.equal(result.sse, true);

  // The first (and so far only) event frame must be the named snapshot.
  assert.ok(
    res.body.startsWith('event: snapshot\ndata: {"sessions":[]}\n\n'),
    `unexpected first frame: ${JSON.stringify(res.body.slice(0, 80))}`,
  );
  const frames = dataFrames(res.body);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, "snapshot");
  assert.deepEqual(JSON.parse(frames[0].data), { sessions: [] });

  // Heartbeat timer is scheduled and does not keep the process alive.
  const heartbeat = result.stream.heartbeat;
  assert.ok(heartbeat, "heartbeat timer was not scheduled");
  assert.equal(typeof heartbeat.hasRef, "function");
  assert.equal(heartbeat.hasRef(), false, "heartbeat timer must be unref'd");
  assert.equal(result.stream.heartbeatMs, 20);

  await sleep(55);
  const beats = res.body.split(HEARTBEAT_COMMENT).length - 1;
  assert.ok(beats >= 1, `expected at least one heartbeat, got ${beats}`);

  // Closing the request clears the timer and ends the response.
  req.emit("close");
  assert.equal(result.stream.closed, true);
  assert.equal(result.stream.closeReason, "request_close");
  assert.equal(res.ended, true);
  const writesAtClose = res.chunks.length;
  await sleep(45);
  assert.equal(res.chunks.length, writesAtClose, "writes continued after close");

  // Idempotent close.
  result.stream.close();
  assert.equal(result.stream.closed, true);
});

test("GET /api/events/global stays live without fabricating events", async () => {
  const registry = makeRegistry({ heartbeatMs: 20 });
  const { res, req, result } = await invoke(registry, "/api/events/global");

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.ok(res.body.startsWith(": connected\n\n"));
  assert.equal(res.body.includes("data:"), false, "empty global stream must not fake events");
  assert.equal(res.body.includes("event:"), false);

  assert.equal(result.stream.heartbeat.hasRef(), false);
  await sleep(55);
  assert.ok(res.body.includes(HEARTBEAT_COMMENT));

  // Cleanup can arrive via the response side too.
  res.emit("close");
  assert.equal(result.stream.closed, true);
  assert.equal(res.ended, true);
});

test("GET /api/sessions/:session/events is a 404 unknown_session for an unknown id", async () => {
  const registry = makeRegistry({ heartbeatMs: 20 });
  const store = { get: () => null, eventsFile: (id) => `/nonexistent/${id}` };
  const { match, res, result } = await invoke(registry, "/api/sessions/sess_abc123/events", {
    sessionStore: store,
  });

  assert.deepEqual(match.params, { session: "sess_abc123" });
  assert.equal(result.status, 404);
  assert.equal(result.body.type, "unknown_session");
  assert.equal(result.body.session, "sess_abc123");
  // No stream was opened: headers are not sent and the socket is untouched.
  assert.equal(res.headersSent, false);
  assert.equal(res.chunks.length, 0);
});

test("live sessions use ctx data and forward an optional network snapshot", async () => {
  const rows = [
    {
      session_id: "sess_1",
      colony_id: null,
      queen_id: "queen_growth",
      queen_name: "Growth",
      phase: "idle",
      is_executing: false,
      awaiting_input: false,
      interrupted: false,
      interrupt_cause: null,
      queen_busy_reason: null,
      park_reason: null,
      current_tool_name: null,
      current_tool_count: 0,
      last_event_at: null,
      snapshot_seq: 1,
    },
  ];
  const network = {
    degraded: false,
    reason: null,
    since_epoch: null,
    last_event_epoch: null,
  };

  // Registration-time ctx as a plain array.
  const registry = makeRegistry({ sessions: rows, network, heartbeatMs: 50 });
  const first = await invoke(registry, "/api/sessions/live");
  const firstData = JSON.parse(dataFrames(first.res.body)[0].data);
  assert.deepEqual(firstData, { sessions: rows, network });
  first.req.emit("close");

  // Async ctx supplied at invocation time wins over the registration ctx.
  const asyncRows = [{ ...rows[0], session_id: "sess_2" }];
  const second = await invoke(registry, "/api/sessions/live", {
    listSessions: async () => asyncRows,
    heartbeatMs: 50,
  });
  const secondData = JSON.parse(dataFrames(second.res.body)[0].data);
  assert.deepEqual(secondData.sessions, asyncRows);
  assert.equal(secondData.network, undefined, "no network unless ctx provides one");
  second.req.emit("close");

  // A provider returning `{sessions}` is accepted too.
  const third = await invoke(registry, "/api/sessions/live", {
    sessions: () => ({ sessions: [] }),
    heartbeatMs: 50,
  });
  assert.deepEqual(JSON.parse(dataFrames(third.res.body)[0].data), { sessions: [] });
  third.req.emit("close");
});

test("static /api/sessions/live wins over a /api/sessions/:id registration", async () => {
  const registry = makeRegistry({ heartbeatMs: 100 });
  // Register the parameterized route last: specificity must still win.
  registry.register("GET", "/api/sessions/:id", () => ({ status: 200 }), {
    status: ROUTE_STATUS.IMPLEMENTED,
  });

  const match = registry.match("GET", "/api/sessions/live");
  assert.ok(match);
  assert.equal(match.route.path, "/api/sessions/live");

  const { req, res } = await invoke(registry, "/api/sessions/live");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.startsWith("event: snapshot"));
  req.emit("close");
});

test("openSseChannel defaults to the documented heartbeat and cleans up on write failure", () => {
  assert.equal(DEFAULT_HEARTBEAT_MS, 15_000);
  assert.equal(sseFrame("snapshot", { sessions: [] }), 'event: snapshot\ndata: {"sessions":[]}\n\n');
  assert.equal(sseFrame(null, { a: 1 }), 'data: {"a":1}\n\n');
  assert.equal(
    sseFrame("message", "line1\nline2"),
    "event: message\ndata: line1\ndata: line2\n\n",
  );

  const req = new FakeRequest();
  const res = new FakeResponse();
  const handle = openSseChannel(req, res, { initialComment: "hello" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, ": hello\n\n");
  assert.equal(handle.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  assert.equal(handle.heartbeat.hasRef(), false);
  handle.close("test");
  assert.equal(res.ended, true);
  assert.equal(handle.closed, true);
  assert.equal(handle.closeReason, "test");

  // Comment text is sanitized so a newline in a session id cannot inject
  // a `data:`/`event:` line into the stream.
  const injectReq = new FakeRequest();
  const injectRes = new FakeResponse();
  const injectHandle = openSseChannel(injectReq, injectRes, {
    initialComment: "a\nb\r\nc",
  });
  assert.equal(injectRes.body, ": a b  c\n\n");
  assert.equal(injectRes.body.includes("data:"), false);
  injectHandle.close();

  // A throwing socket closes the channel instead of escaping.
  const badRes = new FakeResponse();
  badRes.write = () => {
    throw new Error("socket gone");
  };
  const badReq = new FakeRequest();
  const bad = openSseChannel(badReq, badRes, { initialComment: "x" });
  assert.equal(bad.closed, true);
  assert.equal(bad.write("data: x\n\n"), false);
});
