import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RouteRegistry,
  ROUTE_STATUS,
  defaultRegistry,
  normalizePathname,
  notImplementedHandler,
} from "../src/compat/router.js";
import { installCompatHandlers } from "../src/compat/install.js";
import { createHandler, resolveStaticPath } from "../src/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIST = path.join(HERE, "fixtures", "dist");

// The official handlers read colony state from PI_HIVE_HOME, so the shell test
// runs against an empty home instead of whatever ~/.pi-hive holds.
const TEMP_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-shell-")));
const ORIGINAL_HOME = process.env.PI_HIVE_HOME;
process.env.PI_HIVE_HOME = TEMP_HOME;

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.PI_HIVE_HOME;
  else process.env.PI_HIVE_HOME = ORIGINAL_HOME;
  fs.rmSync(TEMP_HOME, { recursive: true, force: true });
});

test("router matches literal and parameterized paths", () => {
  const registry = new RouteRegistry();
  registry.register("GET", "/api/colonies/:name/messages", () => ({ status: 200 }), {
    status: ROUTE_STATUS.IMPLEMENTED,
  });

  const match = registry.match("GET", "/api/colonies/acme/messages");
  assert.ok(match);
  assert.equal(match.route.path, "/api/colonies/:name/messages");
  assert.deepEqual(match.params, { name: "acme" });

  // Trailing slash is normalized away.
  const trailing = registry.match("GET", "/api/colonies/acme/messages/");
  assert.ok(trailing);
  assert.deepEqual(trailing.params, { name: "acme" });
});

test("router decodes params per segment and normalizes slashes", () => {
  const registry = new RouteRegistry();
  registry.register("GET", "/api/colonies/:name", null, { status: ROUTE_STATUS.MISSING });

  const match = registry.match("GET", "//api//colonies/a%20b/");
  assert.ok(match);
  assert.deepEqual(match.params, { name: "a b" });
  assert.equal(normalizePathname("//api//colonies/a%20b/"), "/api/colonies/a%20b");
});

test("router prefers static segments over params and respects methods", () => {
  const registry = new RouteRegistry();
  registry.register("GET", "/api/colonies/:name", null, { status: ROUTE_STATUS.MISSING });
  registry.register("GET", "/api/colonies/tools-index", null, { status: ROUTE_STATUS.MISSING });

  const match = registry.match("GET", "/api/colonies/tools-index");
  assert.ok(match);
  assert.equal(match.route.path, "/api/colonies/tools-index");
  assert.deepEqual(match.params, {});

  assert.equal(registry.match("POST", "/api/colonies/tools-index"), null);
  // HEAD falls back to the GET handler.
  const head = registry.match("HEAD", "/api/colonies/tools-index");
  assert.ok(head);
});

test("default registry covers the official critical boot routes", () => {
  // The server installs the lanes in its constructor; install directly so this
  // test does not depend on a server having been created first (idempotent).
  installCompatHandlers();
  const byKey = new Map(
    defaultRegistry.list().map((route) => [`${route.method} ${route.path}`, route.status]),
  );
  const expected = {
    "GET /api/health": "implemented",
    "GET /api/config/features": "implemented",
    "GET /api/config/llm": "implemented",
    "GET /api/colonies/tools-index": "implemented",
    "GET /api/sessions": "implemented",
    "POST /api/sessions": "implemented",
    "GET /api/queen/profiles": "implemented",
    "GET /api/models/overview": "implemented",
    "GET /api/credentials": "implemented",
    "GET /api/memories": "implemented",
    "GET /api/startup-status": "implemented",
    // Native route: registered partial with no handler, served by handleApi.
    "GET /api/colonies": "partial",
  };
  for (const [key, status] of Object.entries(expected)) {
    assert.equal(byKey.get(key), status, `${key} should be ${status}`);
  }

  const counts = defaultRegistry.counts();
  assert.equal(counts.total, defaultRegistry.list().length);
  assert.equal(counts.implemented + counts.partial + counts.missing, counts.total);
  assert.ok(counts.implemented > 0);
  // Every official route has a handler (implemented or an explicit 4xx
  // partial); nothing is left on the structured 501 surface.
  assert.equal(counts.missing, 0);

  // Exactly one per-session event entry: the official `:session` transport.
  const sessionEvents = defaultRegistry
    .list()
    .filter((route) => route.path.endsWith("/events") && route.path.startsWith("/api/sessions/"));
  assert.deepEqual(sessionEvents, [
    { method: "GET", path: "/api/sessions/:session/events", status: "implemented" },
  ]);
  assert.equal(
    defaultRegistry.list().filter((route) => route.path === "/api/sessions/:id/events").length,
    0,
    "legacy :id event pattern must be retired",
  );
});

test("installCompatHandlers wires the full official surface and keeps natives unhandled", () => {
  const registry = new RouteRegistry();
  // Simulate an older shell entry that collides with the streams transport.
  registry.register("GET", "/api/sessions/:id/events", null, { status: ROUTE_STATUS.MISSING });

  installCompatHandlers({ runtimes: new Map() }, registry);
  const first = registry.counts();
  // One entry per official method+path after the lane merge (171) plus the
  // native GET /api/colonies fallback (partial, handler null). No route is left
  // on the structured 501 surface.
  assert.equal(first.total, 172);
  assert.equal(first.missing, 0);
  assert.equal(first.implemented + first.partial, first.total);
  assert.ok(first.implemented > 0);
  assert.ok(first.partial > 0);

  // Idempotent: a second install (e.g. another PiHiveServer) changes nothing.
  installCompatHandlers({ runtimes: new Map() }, registry);
  assert.deepEqual(registry.counts(), first);

  // The legacy :id pattern is retired; only the official :session transport stays.
  assert.equal(
    registry.list().filter((route) => route.path === "/api/sessions/:id/events").length,
    0,
  );
  assert.equal(
    registry.list().filter((route) => route.path === "/api/sessions/:session/events").length,
    1,
  );

  // GET /api/colonies stays native: partial and handlerness.
  const colonies = registry.routes.find(
    (route) => route.method === "GET" && route.path === "/api/colonies",
  );
  assert.equal(colonies.status, ROUTE_STATUS.PARTIAL);
  assert.equal(colonies.handler, null);

  // Every implemented official route has a real handler.
  for (const route of registry.routes) {
    if (route.meta.official && route.status === ROUTE_STATUS.IMPLEMENTED) {
      assert.equal(typeof route.handler, "function", `${route.path} handler`);
    }
  }

  assert.throws(() => installCompatHandlers({}, null), /registry\.register is required/);
});

test("notImplementedHandler returns the structured 501 body", () => {
  const response = notImplementedHandler({
    route: { method: "GET", path: "/api/sessions" },
  });
  assert.equal(response.status, 501);
  assert.deepEqual(response.body, {
    error: "not implemented: GET /api/sessions",
    type: "not_implemented",
    route: "/api/sessions",
    method: "GET",
  });
});

test("resolveStaticPath rejects traversal and non-dist paths", () => {
  assert.equal(resolveStaticPath(FIXTURE_DIST, "/assets/../../package.json"), null);
  assert.equal(resolveStaticPath(FIXTURE_DIST, "/assets/%2e%2e/%2e%2e/package.json"), null);
  assert.equal(resolveStaticPath(FIXTURE_DIST, "/assets/%2e%2e%2f%2e%2e%2fpackage.json"), null);
  assert.equal(resolveStaticPath(FIXTURE_DIST, "/assets/%2e%2e%2findex.html"), null);
  assert.equal(resolveStaticPath(FIXTURE_DIST, "/etc/passwd"), null);
  assert.equal(resolveStaticPath(FIXTURE_DIST, "/assets/%00app.js"), null);
  assert.equal(resolveStaticPath(FIXTURE_DIST, "/assets/bad%2"), null);

  const good = resolveStaticPath(FIXTURE_DIST, "/assets/app.js");
  assert.ok(good);
  assert.ok(good.startsWith(path.resolve(FIXTURE_DIST) + path.sep));
});

function rawRequest(port, method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path: requestPath },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            contentType: res.headers["content-type"] || "",
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("ephemeral server serves dist, SPA fallback, 501 APIs, and /ui", async () => {
  const handler = createHandler({ frontendDist: FIXTURE_DIST });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type"), /text\/html/);
    assert.match(await root.text(), /Hive compat test fixture/);

    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.match(asset.headers.get("cache-control"), /immutable/);

    const spa = await fetch(`${base}/models`);
    assert.equal(spa.status, 200);
    assert.match(spa.headers.get("content-type"), /text\/html/);
    assert.match(await spa.text(), /Hive compat test fixture/);

    const missingAsset = await fetch(`${base}/assets/nope.js`);
    assert.equal(missingAsset.status, 404);

    const traversal = await rawRequest(
      port,
      "GET",
      "/assets/%2e%2e%2f%2e%2e%2fcompat-shell.test.js",
    );
    assert.equal(traversal.status, 403);
    assert.doesNotMatch(traversal.body, /ephemeral server serves dist/);

    const unknownApi = await fetch(`${base}/api/does-not-exist`);
    assert.equal(unknownApi.status, 501);
    assert.match(unknownApi.headers.get("content-type"), /application\/json/);
    const unknownBody = await unknownApi.json();
    assert.equal(unknownBody.type, "not_implemented");
    assert.equal(unknownBody.route, "/api/does-not-exist");
    assert.equal(typeof unknownBody.error, "string");

    // Official boot routes now have handlers and answer 200 before the legacy
    // dispatch; the contract test covers the shapes in more detail.
    const config = await fetch(`${base}/api/config/features`);
    assert.equal(config.status, 200);
    assert.deepEqual(await config.json(), {
      features: { adaptive_tool_budget: false, email_senders: false, stall_check: false },
    });

    const llm = await fetch(`${base}/api/config/llm`);
    assert.equal(llm.status, 200);
    const llmBody = await llm.json();
    assert.equal(llmBody.provider, "pihive");

    const sessions = await fetch(`${base}/api/sessions`);
    assert.equal(sessions.status, 200);
    assert.deepEqual(await sessions.json(), { sessions: [] });

    // POST creates a real session record now; no 501 on the official flow.
    const createSession = await fetch(`${base}/api/sessions`, { method: "POST" });
    assert.equal(createSession.status, 201);
    const createBody = await createSession.json();
    assert.equal(typeof createBody.session_id, "string");
    assert.ok(createBody.session_id.length > 0);

    // This one shares the legacy /api/colonies/:name prefix and must not be
    // mistaken for a colony called "tools-index".
    const toolsIndex = await fetch(`${base}/api/colonies/tools-index`);
    assert.equal(toolsIndex.status, 200);
    assert.deepEqual(await toolsIndex.json(), { colonies: [] });

    // Native /api/colonies keeps its raw-metadata envelope (registry: partial).
    const colonies = await fetch(`${base}/api/colonies`);
    assert.equal(colonies.status, 200);
    const coloniesBody = await colonies.json();
    assert.ok(Array.isArray(coloniesBody.colonies));
    assert.deepEqual(coloniesBody.colonies, []);

    // Colony-scoped partial routes still fall through to handleApi: an unknown
    // colony is a native 404, not the compat dispatcher's 501.
    const colonyEvents = await fetch(`${base}/api/colonies/ghost/events`);
    assert.equal(colonyEvents.status, 404);
    assert.match((await colonyEvents.json()).error, /not found/);

    // A route that used to be a registered 501 now has a real handler.
    const startup = await fetch(`${base}/api/startup-status`);
    assert.equal(startup.status, 200);
    assert.equal((await startup.json()).ready, true);

    const routesResponse = await fetch(`${base}/api/compat/routes`);
    assert.equal(routesResponse.status, 200);
    const routePayload = await routesResponse.json();
    assert.ok(Array.isArray(routePayload.routes));
    assert.equal(routePayload.counts.total, routePayload.routes.length);
    for (const route of routePayload.routes) {
      assert.equal(typeof route.method, "string");
      assert.equal(typeof route.path, "string");
      assert.ok(["implemented", "partial", "missing"].includes(route.status));
    }

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.service, "pi-hive");

    const ui = await fetch(`${base}/ui/`);
    assert.equal(ui.status, 200);
    assert.match(ui.headers.get("content-type"), /text\/html/);
    assert.match(await ui.text(), /pi-hive/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("missing dist returns a clear 503 instead of crashing", async () => {
  const handler = createHandler({ frontendDist: path.join(HERE, "fixtures", "no-such-dist") });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 503);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /frontend build not found/i);

    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    assert.equal(asset.status, 503);
    assert.match(asset.headers.get("content-type"), /application\/json/);
    const body = await asset.json();
    assert.equal(body.type, "frontend_unavailable");
    assert.equal(path.resolve(body.dist), path.resolve(handler.server.frontendDist));

    // The dashboard remains available even when the official dist is absent.
    const ui = await fetch(`http://127.0.0.1:${port}/ui/`);
    assert.equal(ui.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
