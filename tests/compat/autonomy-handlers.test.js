/**
 * Route-level tests for the official frontend's autonomy/system handlers:
 * MCP settings, Sentinel notifications, runtime logs, browser status, tasks,
 * and worker inspection/control.
 *
 * Every test uses a fresh RouteRegistry and a fresh PI_HIVE_HOME, so route
 * matching and on-disk state are exercised the same way the server does it.
 * No model, no socket, no network: handlers must return `{status, body}` and
 * leave `res` untouched.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RouteRegistry, ROUTE_STATUS } from "../../src/compat/router.js";
import {
  appendRuntimeLog,
  registerAutonomyRoutes,
  resetRuntimeLogs,
  runtimeLogsSnapshot,
} from "../../src/compat/handlers/autonomy.js";
import { colonyPaths, createColony, loadMetadata } from "../../src/domain/colony.js";
import { createTask } from "../../src/domain/plan.js";
import { writeSkill } from "../../src/domain/skills.js";
import { WorkerManager } from "../../src/runtime/worker.js";

const ENV_KEYS = [
  "PI_HIVE_HOME",
  "PI_HIVE_LOG_FILE",
  "PI_HIVE_TELEGRAM_TOKEN",
  "PI_HIVE_TELEGRAM_BOT_TOKEN",
  "PI_HIVE_SLACK_BOT_TOKEN",
  "PI_HIVE_SLACK_TOKEN",
  "PI_HIVE_SLACK_APP_TOKEN",
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-autonomy-"));
let homeCounter = 0;

after(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function useHome() {
  const home = path.join(TMP_ROOT, `home-${(homeCounter += 1)}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.PI_HIVE_HOME = home;
  return home;
}

function makeRegistry(ctx = {}) {
  const registry = new RouteRegistry();
  registerAutonomyRoutes(registry, ctx);
  return registry;
}

/**
 * Invoke a registered handler with fake req/res and assert it returned a
 * descriptor instead of writing to the socket.
 */
async function call(registry, method, pathname, { ctx, body } = {}) {
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
  assert.equal(typeof result?.status, "number", `${method} ${pathname} returned no status`);
  return result;
}

function readPlan(colony) {
  return JSON.parse(fs.readFileSync(colonyPaths(colony).plan, "utf8"));
}

function readInbox(colony) {
  const file = path.join(colonyPaths(colony).dir, "inbox.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * A WorkerManager with a fake live worker. `spawn()` would call a model, so
 * the manager's documented in-memory maps are populated directly; this is
 * exactly what the HTTP handler reads.
 */
function fakeWorkerManager({ agentMessages = null } = {}) {
  const manager = new WorkerManager({
    colony: "acme",
    queenId: "queen_growth",
    modelRuntime: {},
    options: { maxConcurrentWorkers: 4 },
  });
  const handle = {
    id: "worker_live1",
    task: "Research the market",
    goal: "Market scan",
    profile: "default",
    status: "running",
    startedAt: Date.now() - 30_000,
    report: null,
  };
  manager.active.set(handle.id, handle);
  manager.handles.set(handle.id, handle);
  const aborted = { value: false };
  if (agentMessages !== null) {
    manager.agents.set(handle.id, {
      state: { messages: agentMessages },
      abort() {
        aborted.value = true;
      },
    });
  } else {
    manager.agents.set(handle.id, {
      abort() {
        aborted.value = true;
      },
    });
  }
  return { manager, handle, aborted };
}

function seedHistoricalWorker(colony, { task = "Archived run", summary = "did the work", status = "success" } = {}) {
  const dir = colonyPaths(colony).workers;
  fs.mkdirSync(dir, { recursive: true });
  const base = `${Date.now().toString(36)}_test`;
  fs.writeFileSync(
    path.join(dir, `${base}.json`),
    JSON.stringify(
      {
        queen_id: "queen_growth",
        task,
        data: {},
        profile: "default",
        report: { status, summary, data: {}, at: new Date().toISOString() },
      },
      null,
      2,
    ),
  );
  return `run_${base}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("registers all 26 autonomy routes with honest statuses", () => {
  const registry = makeRegistry({});

  const expected = new Map([
    ["GET /api/mcp/servers", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/mcp/servers", ROUTE_STATUS.IMPLEMENTED],
    ["DELETE /api/mcp/servers/:server", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/mcp/servers/:server/enable", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/mcp/servers/:server/disable", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/mcp/servers/:server/mode", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/mcp/servers/:server/health", ROUTE_STATUS.IMPLEMENTED],
    ["GET /api/colony/:colony/notifications", ROUTE_STATUS.IMPLEMENTED],
    ["PUT /api/colony/:colony/notifications", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/colony/:colony/notifications/test", ROUTE_STATUS.IMPLEMENTED],
    ["GET /api/sentinel/credentials", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/sentinel/telegram/validate", ROUTE_STATUS.PARTIAL],
    ["POST /api/sentinel/telegram/detect-chat", ROUTE_STATUS.PARTIAL],
    ["POST /api/sentinel/slack/validate", ROUTE_STATUS.PARTIAL],
    ["GET /api/runtime-logs", ROUTE_STATUS.IMPLEMENTED],
    ["GET /api/browser/status", ROUTE_STATUS.IMPLEMENTED],
    ["GET /api/sessions/:session/tasks", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/sessions/:session/tasks/unarchive", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/sessions/:session/tasks/clear-completed", ROUTE_STATUS.IMPLEMENTED],
    ["GET /api/sessions/:session/workers", ROUTE_STATUS.IMPLEMENTED],
    ["GET /api/sessions/:session/workers/:worker", ROUTE_STATUS.IMPLEMENTED],
    ["GET /api/sessions/:session/workers/:worker/conversation", ROUTE_STATUS.IMPLEMENTED],
    ["GET /api/sessions/:session/colony/skills", ROUTE_STATUS.IMPLEMENTED],
    ["GET /api/sessions/:session/colony/tools", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/sessions/:session/workers/:worker/stop", ROUTE_STATUS.IMPLEMENTED],
    ["POST /api/sessions/:session/workers/stop-all", ROUTE_STATUS.IMPLEMENTED],
  ]);

  assert.equal(registry.routes.length, 26);
  for (const [key, status] of expected) {
    const [method, routePath] = key.split(" ");
    const found = registry.routes.find((route) => route.method === method && route.path === routePath);
    assert.ok(found, `missing ${key}`);
    assert.equal(found.status, status, `${key} status`);
    assert.equal(found.meta.official, true, `${key} must be official`);
    assert.equal(typeof found.handler, "function", `${key} handler`);
  }

  assert.deepEqual(registry.counts(), {
    implemented: 23,
    partial: 3,
    missing: 0,
    total: 26,
  });
});

test("registerAutonomyRoutes validates its registry", () => {
  assert.throws(() => registerAutonomyRoutes(null, {}), /RouteRegistry/);
  assert.throws(() => registerAutonomyRoutes({}, {}), /RouteRegistry/);
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test("MCP server settings persist, and health really probes reachability", async () => {
  useHome();
  const registry = makeRegistry();

  let result = await call(registry, "GET", "/api/mcp/servers");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { servers: [] });

  // Validation.
  result = await call(registry, "POST", "/api/mcp/servers", { body: {} });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /name is required/);

  result = await call(registry, "POST", "/api/mcp/servers", {
    body: { name: "bad name", transport: "stdio", command: "node" },
  });
  assert.equal(result.status, 400);

  result = await call(registry, "POST", "/api/mcp/servers", {
    body: { name: "ok", transport: "carrier-pigeon" },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /transport must be one of/);

  result = await call(registry, "POST", "/api/mcp/servers", {
    body: { name: "ok", transport: "stdio" },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /command is required/);

  result = await call(registry, "POST", "/api/mcp/servers", {
    body: { name: "ok", transport: "http" },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /url is required/);

  result = await call(registry, "POST", "/api/mcp/servers", {
    body: { name: "ok", transport: "unix" },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /socket_path is required/);

  result = await call(registry, "POST", "/api/mcp/servers", {
    body: { name: "ok", transport: "stdio", command: "node", mode: "telepathy" },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /mode must be one of/);

  // Add.
  result = await call(registry, "POST", "/api/mcp/servers", {
    body: {
      name: "files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server-files"],
      env: { TOKEN: "secret-value" },
      description: "Local files",
    },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.server.name, "files");
  assert.equal(result.body.server.source, "local");
  assert.equal(result.body.server.transport, "stdio");
  assert.equal(result.body.server.mode, "tools");
  assert.equal(result.body.server.enabled, true);
  assert.equal(result.body.server.tool_count, null);
  assert.match(result.body.hint, /does not load MCP servers/);

  // Secrets stay out of the API response.
  result = await call(registry, "GET", "/api/mcp/servers");
  assert.equal(result.body.servers.length, 1);
  assert.equal(result.body.servers[0].name, "files");
  assert.equal("config" in result.body.servers[0], false);
  assert.equal("env" in result.body.servers[0], false);
  assert.equal(JSON.stringify(result.body).includes("secret-value"), false);

  // Stored on disk under PI_HIVE_HOME.
  const store = JSON.parse(fs.readFileSync(path.join(process.env.PI_HIVE_HOME, "mcp_servers.json"), "utf8"));
  assert.equal(store.servers[0].config.command, "npx");
  assert.equal(store.servers[0].config.env.TOKEN, "secret-value");

  // Duplicate.
  result = await call(registry, "POST", "/api/mcp/servers", {
    body: { name: "files", transport: "stdio", command: "node" },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "already_exists");

  // Enable / disable / mode.
  result = await call(registry, "POST", "/api/mcp/servers/files/disable");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { name: "files", enabled: false });

  result = await call(registry, "POST", "/api/mcp/servers/files/enable");
  assert.deepEqual(result.body, { name: "files", enabled: true });

  result = await call(registry, "POST", "/api/mcp/servers/files/mode", { body: { mode: "cli" } });
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "cli");
  assert.match(result.body.hint, /does not load MCP servers/);

  result = await call(registry, "POST", "/api/mcp/servers/files/mode", { body: { mode: "nope" } });
  assert.equal(result.status, 400);

  // Health is a real probe of what it can actually check (reachability).
  result = await call(registry, "POST", "/api/mcp/servers/files/health");
  assert.equal(result.status, 200);
  assert.equal(result.body.name, "files");
  assert.equal(result.body.status, "healthy");
  assert.equal(result.body.tools, 0);
  assert.equal(result.body.error, null);
  assert.match(result.body.detail, /command resolves to/);
  assert.match(result.body.note, /loads no MCP tools/);
  assert.ok(result.body.checked_at);

  result = await call(registry, "GET", "/api/mcp/servers");
  const probed = result.body.servers.find((server) => server.name === "files");
  assert.equal(probed.last_health_status, "healthy");
  assert.equal(probed.last_health_check_at, result.body.servers.find((s) => s.name === "files").last_health_check_at);
  assert.ok(probed.last_health_check_at, "the probe result must be persisted");

  // Unknown server.
  for (const [method, routePath] of [
    ["POST", "/api/mcp/servers/ghost/enable"],
    ["POST", "/api/mcp/servers/ghost/disable"],
    ["POST", "/api/mcp/servers/ghost/mode"],
    ["POST", "/api/mcp/servers/ghost/health"],
    ["DELETE", "/api/mcp/servers/ghost"],
  ]) {
    result = await call(registry, method, routePath, {
      body: method === "POST" && routePath.endsWith("/mode") ? { mode: "cli" } : undefined,
    });
    assert.equal(result.status, 404, `${method} ${routePath}`);
  }

  // Remove.
  result = await call(registry, "DELETE", "/api/mcp/servers/files");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { removed: "files" });
  result = await call(registry, "GET", "/api/mcp/servers");
  assert.deepEqual(result.body, { servers: [] });
});

test("built-in MCP entries cannot be removed or toggled", async () => {
  const home = useHome();
  fs.writeFileSync(
    path.join(home, "mcp_servers.json"),
    JSON.stringify({
      version: 1,
      servers: [{ name: "hive_core", source: "built-in", transport: "harness", enabled: true }],
    }),
  );
  const registry = makeRegistry();

  let result = await call(registry, "DELETE", "/api/mcp/servers/hive_core");
  assert.equal(result.status, 400);
  assert.match(result.body.error, /built-in/);

  result = await call(registry, "POST", "/api/mcp/servers/hive_core/disable");
  assert.equal(result.status, 400);

  result = await call(registry, "POST", "/api/mcp/servers/hive_core/mode", { body: { mode: "cli" } });
  assert.equal(result.status, 400);

  result = await call(registry, "GET", "/api/mcp/servers");
  assert.equal(result.status, 200);
  assert.equal(result.body.servers[0].removable, false);
  assert.equal(result.body.servers[0].mode, "tools");
});

test("the MCP health probe reports unhealthy for an unreachable endpoint or a missing command", async () => {
  const home = useHome();
  // Port 1 on loopback is not listening; the probe must say so instead of guessing.
  const closedPort = 1;
  fs.writeFileSync(
    path.join(home, "mcp_servers.json"),
    JSON.stringify({
      version: 1,
      servers: [
        { name: "dead", source: "local", transport: "http", enabled: true, config: { url: `http://127.0.0.1:${closedPort}/mcp` } },
        { name: "ghostbin", source: "local", transport: "stdio", enabled: true, config: { command: "pihive-no-such-binary" } },
      ],
    }),
  );
  const registry = makeRegistry();

  let result = await call(registry, "POST", "/api/mcp/servers/dead/health");
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "unhealthy");
  assert.equal(result.body.tools, 0);
  assert.match(result.body.error, /ECONNREFUSED|no answer within|EADDRNOTAVAIL|EHOSTUNREACH/);

  result = await call(registry, "POST", "/api/mcp/servers/ghostbin/health");
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "unhealthy");
  assert.match(result.body.error, /command not found on PATH/);

  result = await call(registry, "GET", "/api/mcp/servers");
  const stored = result.body.servers.find((server) => server.name === "dead");
  assert.equal(stored.last_health_status, "unhealthy");
  assert.ok(stored.last_error);
  assert.equal(stored.last_health_check_at !== null, true);
});

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

test("Sentinel config round-trips through notifications.json and metadata", async () => {
  useHome();
  createColony({ name: "acme", goal: "ship it" });
  const registry = makeRegistry();

  let result = await call(registry, "GET", "/api/colony/acme/notifications");
  assert.equal(result.status, 200);
  assert.equal(result.body.colony_id, "acme");
  assert.equal(result.body.sentinel_enabled, false);
  assert.equal(result.body.channel, null);
  assert.deepEqual(result.body.target, {});
  assert.deepEqual(result.body.allowlist, []);
  assert.deepEqual(result.body.thread, {});
  assert.equal(result.body.classify_after_seconds, null);
  assert.deepEqual(result.body.credentials, {
    telegram: { configured: false },
    slack: { bot: false, app: false },
  });

  // Validation.
  result = await call(registry, "PUT", "/api/colony/acme/notifications", {
    body: { sentinel_enabled: true, channel: "carrier-pigeon" },
  });
  assert.equal(result.status, 400);

  result = await call(registry, "PUT", "/api/colony/acme/notifications", {
    body: { sentinel_enabled: true, channel: null },
  });
  assert.equal(result.status, 400);

  result = await call(registry, "PUT", "/api/colony/acme/notifications", {
    body: { sentinel_enabled: true, channel: "hive", allowlist: "nope" },
  });
  assert.equal(result.status, 400);

  result = await call(registry, "PUT", "/api/colony/acme/notifications", {
    body: { sentinel_enabled: true, channel: "hive", classify_after_seconds: 0 },
  });
  assert.equal(result.status, 400);

  result = await call(registry, "PUT", "/api/colony/acme/notifications", {
    body: { sentinel_enabled: true, channel: "hive", classify_after_seconds: "soon" },
  });
  assert.equal(result.status, 400);

  // Save.
  result = await call(registry, "PUT", "/api/colony/acme/notifications", {
    body: {
      sentinel_enabled: true,
      channel: "hive",
      target: { label: "ops" },
      allowlist: ["user_1", "user_2"],
      classify_after_seconds: 45,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.sentinel_enabled, true);
  assert.equal(result.body.channel, "hive");
  assert.deepEqual(result.body.target, { label: "ops" });
  assert.deepEqual(result.body.allowlist, ["user_1", "user_2"]);
  assert.equal(result.body.classify_after_seconds, 45);

  const stored = JSON.parse(
    fs.readFileSync(path.join(colonyPaths("acme").dir, "notifications.json"), "utf8"),
  );
  assert.equal(stored.sentinel_enabled, true);
  assert.equal(stored.channel, "hive");
  assert.equal(stored.classify_after_seconds, 45);

  // The real Sentinel reads metadata.sentinel_enabled at startup.
  assert.equal(loadMetadata("acme").sentinel_enabled, true);

  result = await call(registry, "GET", "/api/colony/acme/notifications");
  assert.equal(result.body.sentinel_enabled, true);
  assert.equal(result.body.channel, "hive");

  // Missing colony.
  result = await call(registry, "GET", "/api/colony/ghost/notifications");
  assert.equal(result.status, 404);
});

test("Sentinel test sends to the local inbox and rejects unimplemented channels", async () => {
  useHome();
  createColony({ name: "acme" });
  const registry = makeRegistry();

  // Not configured at all.
  let result = await call(registry, "POST", "/api/colony/acme/notifications/test", { body: {} });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /channel and target required/);

  // Telegram is honestly unavailable, not a fake ok.
  result = await call(registry, "POST", "/api/colony/acme/notifications/test", {
    body: { channel: "telegram", target: { chat_id: "123" } },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "integration_unavailable");
  assert.match(result.body.error, /no Telegram transport/);
  assert.equal("ok" in result.body, false);

  // Local hive channel writes a real inbox record.
  result = await call(registry, "POST", "/api/colony/acme/notifications/test", {
    body: { channel: "hive", target: {} },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(typeof result.body.message_id, "string");
  assert.equal(result.body.error, null);

  const inbox = readInbox("acme");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].kind, "test");
  assert.equal(inbox[0].channel, "hive");
  assert.equal(inbox[0].colony, "acme");
  assert.equal(inbox[0].message_id, result.body.message_id);

  // Configured channel is used when the body omits one.
  result = await call(registry, "PUT", "/api/colony/acme/notifications", {
    body: { sentinel_enabled: true, channel: "hive" },
  });
  assert.equal(result.status, 200);
  result = await call(registry, "POST", "/api/colony/acme/notifications/test", { body: {} });
  assert.equal(result.status, 200);
  assert.equal(readInbox("acme").length, 2);

  // Slack is equally explicit.
  result = await call(registry, "POST", "/api/colony/acme/notifications/test", {
    body: { channel: "slack", target: { channel: "C1" } },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /no Slack transport/);
});

test("Sentinel credentials report token presence without exposing values", async () => {
  useHome();
  const registry = makeRegistry();

  delete process.env.PI_HIVE_TELEGRAM_TOKEN;
  delete process.env.PI_HIVE_TELEGRAM_BOT_TOKEN;
  delete process.env.PI_HIVE_SLACK_BOT_TOKEN;
  delete process.env.PI_HIVE_SLACK_TOKEN;
  delete process.env.PI_HIVE_SLACK_APP_TOKEN;

  let result = await call(registry, "GET", "/api/sentinel/credentials");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    telegram: { configured: false },
    slack: { bot: false, app: false },
  });

  process.env.PI_HIVE_TELEGRAM_TOKEN = "tg-secret";
  process.env.PI_HIVE_SLACK_BOT_TOKEN = "slack-secret";
  process.env.PI_HIVE_SLACK_APP_TOKEN = "app-secret";

  result = await call(registry, "GET", "/api/sentinel/credentials");
  assert.deepEqual(result.body, {
    telegram: { configured: true },
    slack: { bot: true, app: true },
  });
  assert.equal(JSON.stringify(result.body).includes("secret"), false);

  // A provider can report a different store (e.g. encrypted credentials).
  result = await call(registry, "GET", "/api/sentinel/credentials", {
    ctx: { credentialsStatus: { telegram: { configured: true }, slack: { bot: false, app: true } } },
  });
  assert.deepEqual(result.body, {
    telegram: { configured: true },
    slack: { bot: false, app: true },
  });
});

test("Telegram/Slack validation returns explicit 4xx unless a provider is wired", async () => {
  useHome();
  const registry = makeRegistry();

  delete process.env.PI_HIVE_TELEGRAM_TOKEN;
  delete process.env.PI_HIVE_TELEGRAM_BOT_TOKEN;
  delete process.env.PI_HIVE_SLACK_BOT_TOKEN;
  delete process.env.PI_HIVE_SLACK_TOKEN;

  let result = await call(registry, "POST", "/api/sentinel/telegram/validate", { body: {} });
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.match(result.body.error, /no token provided or saved/);

  result = await call(registry, "POST", "/api/sentinel/telegram/validate", {
    body: { token: "123:abc" },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "integration_unavailable");
  assert.match(result.body.error, /no Telegram transport/);

  result = await call(registry, "POST", "/api/sentinel/telegram/detect-chat", { body: {} });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /save the bot token first/);

  result = await call(registry, "POST", "/api/sentinel/telegram/detect-chat", {
    body: { token: "123:abc" },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "integration_unavailable");

  result = await call(registry, "POST", "/api/sentinel/slack/validate", { body: {} });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /no token provided or saved/);

  result = await call(registry, "POST", "/api/sentinel/slack/validate", { body: { token: "xoxb" } });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, "integration_unavailable");
  assert.match(result.body.error, /no Slack transport/);

  // Real integrations plug in through ctx; their result passes through.
  result = await call(registry, "POST", "/api/sentinel/telegram/validate", {
    body: { token: "123:abc" },
    ctx: { validateTelegram: async (token) => ({ ok: true, bot_username: `bot_${token.length}` }) },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, bot_username: "bot_7" });

  result = await call(registry, "POST", "/api/sentinel/slack/validate", {
    body: { token: "xoxb" },
    ctx: { validateSlack: async () => ({ ok: true, team: "hive", bot_user: "hivebot" }) },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.team, "hive");

  result = await call(registry, "POST", "/api/sentinel/telegram/detect-chat", {
    body: { token: "123:abc" },
    ctx: { detectTelegramChat: async () => ({ ok: true, chat_id: "42", chat_title: "ops" }) },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.chat_id, "42");
});

// ---------------------------------------------------------------------------
// System: runtime logs + browser status
// ---------------------------------------------------------------------------

test("runtime logs honor the boot/after cursor from a ctx provider", async () => {
  useHome();
  const entries = [
    { seq: 1, stream: "stdout", text: "boot" },
    { seq: 2, stream: "stderr", text: "warning" },
    { seq: 3, stream: "stdout", text: "ready" },
  ];
  const registry = makeRegistry({
    getRuntimeLogs: async ({ after, boot }) => ({
      boot: boot === "boot-a" ? "boot-a" : "boot-b",
      entries: boot === "boot-a" ? entries.filter((entry) => entry.seq > after) : entries,
    }),
  });

  let result = await call(registry, "GET", "/api/runtime-logs?after=0&boot=boot-a");
  assert.equal(result.status, 200);
  assert.equal(result.body.boot, "boot-a");
  assert.deepEqual(result.body.entries.map((entry) => entry.seq), [1, 2, 3]);

  result = await call(registry, "GET", "/api/runtime-logs?after=2&boot=boot-a");
  assert.deepEqual(result.body.entries.map((entry) => entry.seq), [3]);

  // A new boot re-sends the whole buffer even when after is set.
  result = await call(registry, "GET", "/api/runtime-logs?after=2&boot=old-boot");
  assert.equal(result.body.boot, "boot-b");
  assert.deepEqual(result.body.entries.map((entry) => entry.seq), [1, 2, 3]);
});

test("runtime logs fall back to the in-memory buffer", async () => {
  useHome();
  delete process.env.PI_HIVE_LOG_FILE;
  const boot = resetRuntimeLogs();
  appendRuntimeLog("stdout", "first line");
  appendRuntimeLog("stderr", "second line\nthird line");
  const registry = makeRegistry();

  let result = await call(registry, "GET", "/api/runtime-logs");
  assert.equal(result.status, 200);
  assert.equal(result.body.boot, boot);
  assert.deepEqual(
    result.body.entries.map((entry) => [entry.seq, entry.stream, entry.text]),
    [
      [1, "stdout", "first line"],
      [2, "stderr", "second line"],
      [3, "stderr", "third line"],
    ],
  );

  result = await call(registry, "GET", "/api/runtime-logs?after=2&boot=" + encodeURIComponent(boot));
  assert.deepEqual(result.body.entries.map((entry) => entry.text), ["third line"]);

  // Wrong boot -> full buffer.
  result = await call(registry, "GET", "/api/runtime-logs?after=2&boot=stale");
  assert.equal(result.body.entries.length, 3);
});

test("runtime logs can read PI_HIVE_LOG_FILE and detect stderr lines", async () => {
  const home = useHome();
  const file = path.join(home, "runtime.log");
  fs.writeFileSync(file, "alpha\n[stderr] beta\ngamma\n");
  process.env.PI_HIVE_LOG_FILE = file;
  const registry = makeRegistry();

  let result = await call(registry, "GET", "/api/runtime-logs?after=0");
  assert.equal(result.status, 200);
  assert.match(result.body.boot, /^file_/);
  assert.deepEqual(
    result.body.entries.map((entry) => [entry.seq, entry.stream, entry.text]),
    [
      [1, "stdout", "alpha"],
      [2, "stderr", "beta"],
      [3, "stdout", "gamma"],
    ],
  );

  result = await call(registry, "GET", `/api/runtime-logs?after=2&boot=${encodeURIComponent(result.body.boot)}`);
  assert.deepEqual(result.body.entries.map((entry) => entry.text), ["gamma"]);

  // A stale boot re-sends the whole file, like a new process would.
  result = await call(registry, "GET", "/api/runtime-logs?after=2&boot=stale");
  assert.deepEqual(result.body.entries.map((entry) => entry.text), ["alpha", "beta", "gamma"]);
});

test("browser status reports the honest offline bridge shape", async () => {
  useHome();
  const registry = makeRegistry();

  let result = await call(registry, "GET", "/api/browser/status");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    bridge: false,
    connected: false,
    health: "offline",
    last_pong_age_ms: null,
    extension_version: null,
    active_tab: null,
  });

  // A real bridge can be wired through ctx; unknown fields are normalized.
  result = await call(registry, "GET", "/api/browser/status?session_id=s1", {
    ctx: {
      browserStatus: async (sessionId) => ({
        bridge: true,
        connected: true,
        health: "healthy",
        last_pong_age_ms: 1200,
        extension_version: "1.2.3",
        active_tab: { id: 7, title: "Docs", url: "https://example.com/docs" },
        echoed: sessionId,
      }),
    },
  });
  assert.equal(result.body.bridge, true);
  assert.equal(result.body.connected, true);
  assert.equal(result.body.health, "healthy");
  assert.equal(result.body.last_pong_age_ms, 1200);
  assert.equal(result.body.extension_version, "1.2.3");
  assert.deepEqual(result.body.active_tab, { id: 7, title: "Docs", url: "https://example.com/docs" });
  assert.equal("echoed" in result.body, false);
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

test("task list maps plan.json onto the official TaskListSnapshot", async () => {
  useHome();
  createColony({ name: "acme", goal: "ship a slice" });
  const pending = createTask("acme", { subject: "Plan", description: "write the plan" });
  const running = createTask("acme", { subject: "Build", status: "in_progress" });
  const done = createTask("acme", { subject: "Ship", status: "completed" });
  const registry = makeRegistry();

  let result = await call(registry, "GET", "/api/sessions/acme/tasks");
  assert.equal(result.status, 200);
  assert.equal(result.body.session_id, "acme");
  assert.equal(result.body.role, "session");
  assert.deepEqual(result.body.meta, {
    role: "session",
    creator_agent_id: null,
    goal: "ship a slice",
    created_at: result.body.meta.created_at,
    schema_version: 1,
  });
  assert.equal(typeof result.body.meta.created_at, "number");
  assert.equal(result.body.tasks.length, 3);

  const bySubject = Object.fromEntries(result.body.tasks.map((task) => [task.subject, task]));
  assert.equal(bySubject.Plan.status, "pending");
  assert.equal(bySubject.Build.status, "in_progress");
  assert.equal(bySubject.Ship.status, "completed");
  const rawIds = { Plan: pending.id, Build: running.id, Ship: done.id };
  for (const task of result.body.tasks) {
    assert.ok(Number.isInteger(task.id) && task.id > 0, "task id must be a positive integer");
    assert.equal(typeof task.created_at, "number");
    assert.equal(typeof task.updated_at, "number");
    assert.ok(task.created_at > 1_600_000_000);
    assert.equal(task.metadata.pi_hive_id, rawIds[task.subject]);
  }

  // Ids are stable across reads.
  const again = await call(registry, "GET", "/api/sessions/acme/tasks");
  assert.deepEqual(again.body.tasks.map((task) => task.id), result.body.tasks.map((task) => task.id));

  // `<colony>:<session>` also resolves; the bare id is echoed back.
  result = await call(registry, "GET", "/api/sessions/acme:session-42/tasks");
  assert.equal(result.status, 200);
  assert.equal(result.body.session_id, "acme:session-42");

  // A provider can map an opaque session id onto a colony.
  result = await call(registry, "GET", "/api/sessions/uuid-1234/tasks", {
    ctx: { resolveSession: async () => ({ colony: "acme" }) },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.tasks.length, 3);

  // Unknown session.
  result = await call(registry, "GET", "/api/sessions/nope/tasks");
  assert.equal(result.status, 404);
  assert.equal(result.body.type, "unknown_session");
});

test("task list returns 404 when the plan file does not exist", async () => {
  useHome();
  createColony({ name: "acme" });
  fs.rmSync(colonyPaths("acme").plan);
  const registry = makeRegistry();

  const result = await call(registry, "GET", "/api/sessions/acme/tasks");
  assert.equal(result.status, 404);
  assert.equal(result.body.session_id, "acme");
  assert.deepEqual(result.body.tasks, []);
  assert.match(result.body.error, /not found/);
});

test("clear-completed archives completed tasks non-destructively and unarchive restores them", async () => {
  useHome();
  createColony({ name: "acme" });
  createTask("acme", { subject: "Pending" });
  createTask("acme", { subject: "Done", status: "completed" });
  createTask("acme", { subject: "Done too", status: "completed" });
  const registry = makeRegistry();

  let snapshot = await call(registry, "GET", "/api/sessions/acme/tasks");
  const doneIds = snapshot.body.tasks
    .filter((task) => task.status === "completed")
    .map((task) => task.id);

  let result = await call(registry, "POST", "/api/sessions/acme/tasks/clear-completed", { body: {} });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { session_id: "acme", archived: doneIds });

  let plan = readPlan("acme");
  assert.deepEqual(
    plan.tasks.map((task) => [task.subject, task.status, task.archived_from]),
    [
      ["Pending", "pending", undefined],
      ["Done", "archived", "completed"],
      ["Done too", "archived", "completed"],
    ],
  );

  snapshot = await call(registry, "GET", "/api/sessions/acme/tasks");
  assert.deepEqual(
    snapshot.body.tasks.map((task) => task.status),
    ["pending", "archived", "archived"],
  );

  // Unarchive validates its body strictly.
  result = await call(registry, "POST", "/api/sessions/acme/tasks/unarchive", {
    body: { task_ids: ["1"] },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.session_id, "acme");

  result = await call(registry, "POST", "/api/sessions/acme/tasks/unarchive", { body: {} });
  assert.equal(result.status, 400);

  // Restoring a non-archived id is a no-op, like the official route.
  const pendingId = snapshot.body.tasks.find((task) => task.status === "pending").id;
  result = await call(registry, "POST", "/api/sessions/acme/tasks/unarchive", {
    body: { task_ids: [pendingId, 999_999] },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.restored, []);

  // Restore the archived tasks.
  result = await call(registry, "POST", "/api/sessions/acme/tasks/unarchive", {
    body: { task_ids: doneIds },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { session_id: "acme", restored: doneIds });

  plan = readPlan("acme");
  assert.deepEqual(
    plan.tasks.map((task) => [task.subject, task.status, "archived_from" in task]),
    [
      ["Pending", "pending", false],
      ["Done", "completed", false],
      ["Done too", "completed", false],
    ],
  );

  // Nothing completed -> empty archive.
  result = await call(registry, "POST", "/api/sessions/acme/tasks/clear-completed", { body: {} });
  assert.deepEqual(result.body.archived, doneIds);

  result = await call(registry, "POST", "/api/sessions/acme/tasks/clear-completed", { body: {} });
  assert.deepEqual(result.body.archived, []);
});

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

test("worker list merges live WorkerManager state with on-disk runs", async () => {
  useHome();
  createColony({ name: "acme" });
  const runId = seedHistoricalWorker("acme");
  const { manager } = fakeWorkerManager();
  const registry = makeRegistry({ getRuntime: () => ({ workerManager: manager }) });

  const result = await call(registry, "GET", "/api/sessions/acme/workers");
  assert.equal(result.status, 200);
  assert.equal(result.body.workers.length, 2);

  const live = result.body.workers.find((row) => row.worker_id === "worker_live1");
  assert.ok(live);
  assert.equal(live.task, "Research the market");
  assert.equal(live.goal, "Market scan");
  assert.equal(live.status, "running");
  assert.equal(live.is_active, true);
  assert.ok(live.started_at > 1_600_000_000);
  assert.ok(live.duration_seconds >= 29);
  assert.equal(live.result, null);
  assert.equal(live.result_status, null);

  const historical = result.body.workers.find((row) => row.worker_id === runId);
  assert.ok(historical);
  assert.equal(historical.status, "historical");
  assert.equal(historical.is_active, false);
  assert.equal(historical.task, "Archived run");
  assert.deepEqual(historical.result, {
    status: "success",
    summary: "did the work",
    error: null,
    tokens_used: 0,
    duration_seconds: 0,
  });
  assert.equal(historical.result_status, "success");
  assert.equal(historical.result_summary, "did the work");
});

test("worker detail reads live state and run files; unknown ids 404", async () => {
  useHome();
  createColony({ name: "acme" });
  const runId = seedHistoricalWorker("acme", { task: "Old job", summary: "finished" });
  const { manager } = fakeWorkerManager();
  const registry = makeRegistry({ getRuntime: () => ({ workerManager: manager }) });

  let result = await call(registry, "GET", "/api/sessions/acme/workers/worker_live1");
  assert.equal(result.status, 200);
  assert.equal(result.body.worker.worker_id, "worker_live1");
  assert.equal(result.body.worker.profile_name, "default");
  assert.deepEqual(result.body.worker.batch, {
    batch_id: "",
    batch_index: 0,
    batch_size: 0,
    worker_seq: 0,
  });
  assert.deepEqual(result.body.worker.tasks, []);

  result = await call(registry, "GET", `/api/sessions/acme/workers/${runId}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.worker.worker_id, runId);
  assert.equal(result.body.worker.task, "Old job");
  assert.equal(result.body.worker.profile_name, "default");
  assert.equal(result.body.worker.result.summary, "finished");

  result = await call(registry, "GET", "/api/sessions/acme/workers/worker_missing");
  assert.equal(result.status, 404);
  assert.match(result.body.error, /unknown worker/);

  result = await call(registry, "GET", "/api/sessions/acme/workers/..%2Fescape");
  assert.equal(result.status, 404);
});

test("worker conversation serves live agent messages and persisted parts", async () => {
  useHome();
  createColony({ name: "acme" });
  const messages = [
    { role: "user", content: "do the thing" },
    {
      role: "assistant",
      content: [{ type: "text", text: "on it" }],
      toolCalls: [{ name: "tracker_query", arguments: "{\"sql\":\"select 1\"}" }],
    },
    { role: "tool", content: "ok", tool_use_id: "call_1" },
  ];
  const { manager } = fakeWorkerManager({ agentMessages: messages });
  const registry = makeRegistry({ getRuntime: () => ({ workerManager: manager }) });

  let result = await call(registry, "GET", "/api/sessions/acme/workers/worker_live1/conversation");
  assert.equal(result.status, 200);
  assert.equal(result.body.worker_id, "worker_live1");
  assert.equal(result.body.total, 3);
  assert.equal(result.body.truncated, false);
  assert.deepEqual(result.body.messages[0], { seq: 1, role: "user", content: "do the thing" });
  assert.equal(result.body.messages[1].content, "on it");
  assert.deepEqual(result.body.messages[1].tool_calls, [
    { name: "tracker_query", arguments: "{\"sql\":\"select 1\"}" },
  ]);
  assert.equal(result.body.messages[2].tool_use_id, "call_1");

  // Persisted conversation parts are read for a worker directory.
  const partsDir = path.join(colonyPaths("acme").workers, "worker_disk", "conversations", "parts");
  fs.mkdirSync(partsDir, { recursive: true });
  fs.writeFileSync(
    path.join(partsDir, "0001.json"),
    JSON.stringify({ seq: 1, role: "assistant", content: "hello from disk" }),
  );
  fs.writeFileSync(
    path.join(partsDir, "0002.json"),
    JSON.stringify({ seq: 2, role: "tool", content: "result", tool_use_id: "t1" }),
  );
  result = await call(registry, "GET", "/api/sessions/acme/workers/worker_disk/conversation");
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 2);
  assert.deepEqual(result.body.messages.map((message) => message.seq), [1, 2]);
  assert.equal(result.body.messages[0].content, "hello from disk");

  // A flat run file has no transcript; the empty answer is explicit.
  const runId = seedHistoricalWorker("acme");
  result = await call(registry, "GET", `/api/sessions/acme/workers/${runId}/conversation`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { worker_id: runId, messages: [], total: 0, truncated: false });

  result = await call(registry, "GET", "/api/sessions/acme/workers/nope/conversation");
  assert.equal(result.status, 404);
});

test("colony skills and tools expose real pi_hive state", async () => {
  useHome();
  createColony({ name: "acme", queenId: "queen_tech" });
  writeSkill("acme", { name: "research", description: "Do disciplined research", body: "# Steps" });
  const registry = makeRegistry();

  let result = await call(registry, "GET", "/api/sessions/acme/colony/skills");
  assert.equal(result.status, 200);
  assert.equal(result.body.skills.length, 1);
  assert.equal(result.body.skills[0].name, "research");
  assert.equal(result.body.skills[0].description, "Do disciplined research");
  assert.equal(result.body.skills[0].base_dir, colonyPaths("acme").skills);
  assert.equal(result.body.skills[0].source_scope, "colony_ui");
  assert.equal(result.body.skills[0].location, path.join(colonyPaths("acme").skills, "research", "SKILL.md"));

  // Static fallback: the real tool factories, no runtime needed.
  result = await call(registry, "GET", "/api/sessions/acme/colony/tools");
  assert.equal(result.status, 200);
  const names = result.body.tools.map((tool) => tool.name);
  for (const expected of ["tracker_query", "task_create", "memory_read", "file_read", "soul_read"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.ok(result.body.tools.every((tool) => tool.provider === null));
  assert.equal(new Set(names).size, names.length, "tool names must be unique");

  // A live runtime wins when present.
  result = await call(registry, "GET", "/api/sessions/acme/colony/tools", {
    ctx: {
      getRuntime: () => ({
        tools: () => [
          { name: "only_tool", description: "Runtime tool" },
          { name: "only_tool", description: "duplicate" },
        ],
      }),
    },
  });
  assert.deepEqual(result.body.tools, [
    { name: "only_tool", description: "Runtime tool", provider: null },
  ]);
});

test("stop aborts one live worker and stop-all clears the queue", async () => {
  useHome();
  createColony({ name: "acme" });
  const { manager, aborted } = fakeWorkerManager();
  const registry = makeRegistry({ getRuntime: () => ({ workerManager: manager }) });

  let result = await call(registry, "POST", "/api/sessions/acme/workers/worker_live1/stop", { body: {} });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { stopped: true, worker_id: "worker_live1", status: "stopped" });
  assert.equal(aborted.value, true);

  // The list reflects the terminal state immediately (the run may still be settling).
  const listed = await call(registry, "GET", "/api/sessions/acme/workers");
  const stoppedRow = listed.body.workers.find((row) => row.worker_id === "worker_live1");
  assert.equal(stoppedRow.status, "stopped");
  assert.equal(stoppedRow.is_active, false);

  // An unknown id is a 404, not a fake stop.
  result = await call(registry, "POST", "/api/sessions/acme/workers/ghost/stop", { body: {} });
  assert.equal(result.status, 404);
  assert.equal(result.body.stopped, false);

  // Stop-all: one active + one queued worker.
  const second = fakeWorkerManager();
  const queued = {
    id: "worker_queued1",
    task: "Queued work",
    status: "queued",
    startedAt: 0,
    reject() {},
  };
  second.manager.queue.push(queued);
  second.manager.handles.set(queued.id, queued);
  const registry2 = makeRegistry({ getRuntime: () => ({ workerManager: second.manager }) });

  result = await call(registry2, "POST", "/api/sessions/acme/workers/stop-all", { body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.stopped_count, 2);
  assert.deepEqual(result.body.stopped.sort(), ["worker_live1", "worker_queued1"]);
  assert.equal(second.aborted.value, true);
  assert.equal(second.manager.queue.length, 0);
});

test("stop falls back to the registered agent when a manager has no stop()", async () => {
  useHome();
  createColony({ name: "acme" });
  const aborted = { value: false };
  const handle = {
    id: "worker_legacy",
    task: "Legacy worker",
    status: "running",
    startedAt: Date.now() - 1000,
    report: null,
  };
  const manager = {
    active: new Map([[handle.id, handle]]),
    handles: new Map([[handle.id, handle]]),
    agents: new Map([[handle.id, { abort: () => (aborted.value = true) }]]),
    queue: [],
  };
  const registry = makeRegistry({ getRuntime: () => ({ workerManager: manager }) });

  const result = await call(registry, "POST", "/api/sessions/acme/workers/worker_legacy/stop", {
    body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.stopped, true);
  assert.equal(aborted.value, true);
});

test("stop-all is an honest empty result when no runtime is loaded", async () => {
  useHome();
  createColony({ name: "acme" });
  const registry = makeRegistry();

  const result = await call(registry, "POST", "/api/sessions/acme/workers/stop-all", { body: {} });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { stopped: [], stopped_count: 0, errors: null });
});

test("WorkerManager.stop() handles queued, active, and finished handles", async () => {
  const manager = new WorkerManager({
    colony: "acme",
    queenId: "queen_growth",
    modelRuntime: {},
    options: { maxConcurrentWorkers: 1 },
  });

  // Queued: removed before start and rejected.
  const queued = {
    id: "worker_q",
    task: "queued",
    status: "queued",
    startedAt: 0,
    report: null,
    promise: null,
    resolve() {},
    reject(error) {
      queued.rejected = error.message;
    },
  };
  manager.handles.set(queued.id, queued);
  manager.queue.push(queued);
  let result = manager.stop("worker_q");
  assert.equal(result.stopped, true);
  assert.equal(manager.queue.length, 0);
  assert.match(queued.rejected, /stopped before start/);

  // Active: abort is called.
  const aborted = { value: false };
  const active = {
    id: "worker_a",
    task: "active",
    status: "running",
    startedAt: Date.now() - 5000,
    report: null,
  };
  manager.handles.set(active.id, active);
  manager.active.set(active.id, active);
  manager.agents.set(active.id, { abort: () => (aborted.value = true) });
  result = manager.stop("worker_a");
  assert.equal(result.stopped, true);
  assert.equal(aborted.value, true);

  // Finished: reports the terminal state instead of claiming a stop.
  manager.active.delete("worker_a");
  manager.agents.delete("worker_a");
  result = manager.stop("worker_a");
  assert.equal(result.stopped, false);
  assert.equal(result.reason, "already_terminated");

  // Unknown.
  result = manager.stop("worker_missing");
  assert.equal(result.stopped, false);
  assert.equal(result.reason, "not_found");

  // stopAll only walks queued + active.
  assert.deepEqual(manager.stopAll(), { stopped: [], stopped_count: 0, errors: null });
});

test("session-scoped routes reject unknown sessions consistently", async () => {
  useHome();
  const registry = makeRegistry();

  for (const [method, routePath] of [
    ["GET", "/api/sessions/ghost/tasks"],
    ["POST", "/api/sessions/ghost/tasks/unarchive"],
    ["POST", "/api/sessions/ghost/tasks/clear-completed"],
    ["GET", "/api/sessions/ghost/workers"],
    ["GET", "/api/sessions/ghost/workers/w1"],
    ["GET", "/api/sessions/ghost/workers/w1/conversation"],
    ["GET", "/api/sessions/ghost/colony/skills"],
    ["GET", "/api/sessions/ghost/colony/tools"],
    ["POST", "/api/sessions/ghost/workers/w1/stop"],
    ["POST", "/api/sessions/ghost/workers/stop-all"],
  ]) {
    const result = await call(registry, method, routePath, { body: method === "POST" ? {} : undefined });
    assert.equal(result.status, 404, `${method} ${routePath}`);
    assert.equal(result.body.type, "unknown_session");
  }
});

test("runtimeLogsSnapshot is exported for server integration", () => {
  const boot = resetRuntimeLogs();
  appendRuntimeLog("stdout", "one");
  const snapshot = runtimeLogsSnapshot(0, boot);
  assert.equal(snapshot.boot, boot);
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(runtimeLogsSnapshot(1, boot).entries, []);
  assert.equal(runtimeLogsSnapshot(1, "other-boot").entries.length, 1);
});
