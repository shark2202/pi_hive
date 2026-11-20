/**
 * Route-level tests for the remaining official config / models / credentials
 * compatibility handlers.
 *
 * A fresh RouteRegistry and fake `req`/`res` are used per call, with a temp
 * PI_HIVE_HOME. No model is called, no port is opened, and every assertion is
 * against the descriptor `{ status, body }` the server's dispatcher serializes.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { RouteRegistry, ROUTE_STATUS } from "../../src/compat/router.js";
import { registerConfigRoutes } from "../../src/compat/handlers/config.js";
import {
  CONFIG_EXTRA_ROUTES,
  CONFIG_EXTRA_ROUTE_PATHS,
  LLM_ROLE_SLOTS,
  MODEL_ROLE_SLOTS,
  buildEndpointModels,
  buildLlmSections,
  checkKey,
  registerConfigExtraRoutes,
} from "../../src/compat/handlers/config-extra.js";

const TOUCHED_ENV = [
  "PI_HIVE_HOME",
  "PI_HIVE_MODEL",
  "PI_HIVE_BASE_URL",
  "PI_HIVE_API_KEY",
  "BROADTOKEN_API_KEY",
  "ADEN_API_KEY",
];

const ORIGINAL_ENV = Object.fromEntries(TOUCHED_ENV.map((key) => [key, process.env[key]]));
const tempHomes = [];

function temporaryHome(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pi-hive-${label}-`)));
  tempHomes.push(dir);
  return dir;
}

const HOME = temporaryHome("config-extra-handlers");
process.env.PI_HIVE_HOME = HOME;
process.env.PI_HIVE_MODEL = "extra-test-model";
process.env.PI_HIVE_BASE_URL = "http://127.0.0.1:1/v1";
process.env.PI_HIVE_API_KEY = "extra-test-key";
delete process.env.BROADTOKEN_API_KEY;
delete process.env.ADEN_API_KEY;

after(() => {
  for (const key of TOUCHED_ENV) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
  for (const dir of tempHomes) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRegistry(ctx) {
  const registry = new RouteRegistry();
  // Each registry gets its own home so one test's writes cannot leak into another.
  process.env.PI_HIVE_HOME = temporaryHome("cfg-reg");
  registerConfigExtraRoutes(registry, ctx);
  return registry;
}

function makeCombinedRegistry() {
  const registry = new RouteRegistry();
  process.env.PI_HIVE_HOME = temporaryHome("cfg-combined");
  registerConfigRoutes(registry);
  registerConfigExtraRoutes(registry);
  return registry;
}

/**
 * Invoke a registered route exactly like `PiHiveServer.dispatchRegistered`.
 * `options.req` may carry a Node-style stream; otherwise `options.body` is the
 * parsed body a test wants the handler to see.
 */
async function call(registry, method, pathname, options = {}) {
  const match = registry.match(method, pathname);
  assert.ok(match, `expected a registered route for ${method} ${pathname}`);
  const result = await match.route.handler({
    req: options.req || { method, body: options.body },
    res: { headersSent: false },
    route: match.route,
    params: match.params,
    pathname: options.pathname || match.pathname,
    ctx: options.ctx,
  });
  assert.equal(typeof result, "object", `${method} ${pathname} must return a descriptor`);
  assert.equal(typeof result.status, "number", `${method} ${pathname} must return a status`);
  assert.ok(result.body !== undefined, `${method} ${pathname} must return a body`);
  return result;
}

function streamRequest(payload) {
  const req = Readable.from([Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);
  req.method = "POST";
  return req;
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- Registration and matching ----------------------------------------------

const EXPECTED_ROUTES = [
  "GET /api/startup-status",
  "GET /api/config/llm-sections",
  "PUT /api/config/llm-sections",
  "GET /api/config/provider-library",
  "PUT /api/config/provider-library",
  "POST /api/config/provider-library/apply",
  "GET /api/config/external-skills",
  "PUT /api/config/external-skills",
  "PUT /api/config/features",
  "PUT /api/config/llm",
  "PUT /api/config/profile",
  "GET /api/config/rate-limits",
  "PUT /api/config/rate-limits",
  "POST /api/config/profile/avatar",
  "GET /api/config/profile/avatar",
  "PUT /api/models/slots/:slot",
  "DELETE /api/models/slots/:slot",
  "GET /api/models/endpoints/:endpoint/models",
  "PUT /api/models/endpoints/:endpoint",
  "DELETE /api/models/endpoints/:endpoint",
  "GET /api/credentials/:credential",
  "POST /api/credentials",
  "DELETE /api/credentials/:credential",
  "POST /api/credentials/local",
  "DELETE /api/credentials/local/:credential/:alias",
  "POST /api/credentials/check-agent",
  "POST /api/credentials/resync",
  "GET /api/credentials/oauth-status",
  "POST /api/credentials/validate-key",
  "POST /api/sessions/:session/credential-form",
].sort();

test("registers the 30 remaining routes as implemented and official", () => {
  const registry = makeRegistry();
  const counts = registry.counts();

  assert.equal(CONFIG_EXTRA_ROUTES.length, 30);
  assert.equal(CONFIG_EXTRA_ROUTE_PATHS.length, 30);
  assert.equal(counts.total, 30);
  assert.equal(counts.implemented, 30);
  assert.equal(counts.partial, 0);
  assert.equal(counts.missing, 0);

  assert.deepEqual(
    CONFIG_EXTRA_ROUTES.map(({ method, path: routePath }) => `${method} ${routePath}`).sort(),
    EXPECTED_ROUTES,
  );
  // Every path appears exactly once per method; the lane pins 30 unique pairs.
  assert.equal(
    new Set(CONFIG_EXTRA_ROUTES.map(({ method, path: routePath }) => `${method} ${routePath}`)).size,
    30,
  );

  for (const { method, path: routePath } of CONFIG_EXTRA_ROUTES) {
    const match = registry.match(method, routePath);
    assert.ok(match, `${method} ${routePath} must match`);
    assert.equal(match.route.method, method);
    assert.equal(match.route.status, ROUTE_STATUS.IMPLEMENTED, `${method} ${routePath} status`);
    assert.equal(match.route.meta.official, true, `${method} ${routePath} official flag`);
    assert.equal(typeof match.route.meta.description, "string");
    assert.ok(match.route.meta.description.length > 0, `${method} ${routePath} description`);
    assert.equal(typeof match.route.handler, "function", `${method} ${routePath} handler`);
  }

  // A method the lane does not own must not resolve (HEAD is served from GET).
  assert.equal(registry.match("DELETE", "/api/startup-status"), null);
  assert.equal(registry.match("GET", "/api/config/llm"), null, "GET /config/llm belongs to config.js");
  assert.ok(registry.match("HEAD", "/api/startup-status"), "HEAD must resolve to the GET handler");
  assert.equal(registry.match("GET", "/api/nope"), null);
});

test("re-registering replaces the shell's 501 entries instead of duplicating them", () => {
  const registry = new RouteRegistry();
  for (const { method, path: routePath } of CONFIG_EXTRA_ROUTES) {
    registry.register(method, routePath, null, { status: ROUTE_STATUS.MISSING });
  }
  assert.equal(registry.counts().missing, 30);

  registerConfigExtraRoutes(registry);
  assert.equal(registry.counts().total, 30);
  assert.equal(registry.counts().missing, 0);
  assert.equal(registry.counts().implemented, 30);
  assert.equal(registry.match("PUT", "/api/config/llm").route.status, ROUTE_STATUS.IMPLEMENTED);
});

test("adds to config.js without shadowing its existing routes", async () => {
  const registry = makeCombinedRegistry();
  const counts = registry.counts();
  assert.equal(counts.total, 40);
  assert.equal(counts.implemented, 40);
  assert.equal(counts.partial, 0);
  assert.equal(counts.missing, 0);

  // Literal /credentials/specs wins over this lane's /credentials/:credential.
  const specs = await call(registry, "GET", "/api/credentials/specs");
  assert.equal(specs.status, 200);
  assert.deepEqual(specs.body, { specs: [], has_aden_key: false, accounts_by_provider: {} });

  // The wildcard still serves ids the store has no row for.
  const missing = await call(registry, "GET", "/api/credentials/notion");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "Credential 'notion' not found");

  // Existing GET config/llm and the new PUT config/llm stay separate handlers.
  const llm = await call(registry, "GET", "/api/config/llm");
  assert.equal(llm.status, 200);
  assert.equal(llm.body.provider, "pihive");
  const switched = await call(registry, "PUT", "/api/config/llm", { body: { model: "combined-model" } });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.model, "combined-model");
  const foreign = await call(registry, "PUT", "/api/config/llm", { body: { provider: "openai", model: "x" } });
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.error, /one endpoint/);
});

// --- Config reads ------------------------------------------------------------

test("GET /api/startup-status reports a ready server with no bootstrap daemon", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/startup-status");

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["detail", "history", "ready", "stage", "updated_at"]);
  assert.equal(body.ready, true);
  assert.equal(body.stage, "ready");
  assert.match(body.detail, /no bootstrap daemon/i);
  assert.deepEqual(body.history, []);
  assert.equal(typeof body.updated_at, "number");
  assert.ok(Math.abs(Date.now() - body.updated_at) < 5000);
});

test("GET /api/config/llm-sections exposes the real env-configured llm slot", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/config/llm-sections");

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["judge", "llm", "vision_fallback", "worker_llm"]);
  assert.deepEqual(body.llm, {
    provider: "pihive",
    model: "extra-test-model",
    api_base: "http://127.0.0.1:1/v1",
    api_key_env_var: "PI_HIVE_API_KEY",
    max_tokens: 8192,
    max_context_tokens: 128000,
  });
  assert.equal("api_key" in body.llm, false, "the section must never carry the key");
  assert.equal(body.worker_llm, null);
  assert.equal(body.vision_fallback, null);
  assert.equal(body.judge, null);

  // Read fresh per request: changing the env changes the section.
  await withEnv({ PI_HIVE_MODEL: "second-model" }, async () => {
    const next = await call(registry, "GET", "/api/config/llm-sections");
    assert.equal(next.body.llm.model, "second-model");
    assert.equal(buildLlmSections().llm.model, "second-model");
  });
  assert.equal(buildLlmSections().llm.model, "extra-test-model");
  assert.deepEqual(LLM_ROLE_SLOTS, ["llm", "worker_llm", "vision_fallback", "judge"]);
  assert.deepEqual(MODEL_ROLE_SLOTS, ["llm", "worker_llm", "vision_fallback"]);
});

test("empty config collections are documented empties, not invented rows", async () => {
  const registry = makeRegistry();

  const library = await call(registry, "GET", "/api/config/provider-library");
  assert.equal(library.status, 200);
  assert.deepEqual(library.body, { library: {} });

  const external = await call(registry, "GET", "/api/config/external-skills");
  assert.equal(external.status, 200);
  assert.deepEqual(external.body, { paths: [], resolved: [], suggestions: [] });

  const limits = await call(registry, "GET", "/api/config/rate-limits");
  assert.equal(limits.status, 200);
  assert.deepEqual(limits.body, { limits: [] });
});

test("GET /api/config/profile/avatar is the official 404 (no avatar store)", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/config/profile/avatar");
  assert.equal(status, 404);
  assert.deepEqual(body, { error: "No avatar found" });
});

// --- Models ------------------------------------------------------------------

test("GET /api/models/endpoints/:endpoint/models serves the configured endpoint only", async () => {
  const registry = makeRegistry();

  const configured = await call(registry, "GET", "/api/models/endpoints/pihive/models");
  assert.equal(configured.status, 200);
  assert.deepEqual(configured.body, {
    models: [
      {
        id: "extra-test-model",
        label: "extra-test-model",
        max_context_tokens: 128000,
      },
    ],
  });
  assert.deepEqual(buildEndpointModels("pihive"), configured.body);
  assert.equal(buildEndpointModels("elsewhere"), null);

  const unknown = await call(registry, "GET", "/api/models/endpoints/elsewhere/models");
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: "There's no endpoint 'elsewhere'" });
});

// --- Credentials reads -------------------------------------------------------

test("GET /api/credentials/:credential is 404 without leaking a store", async () => {
  const registry = makeRegistry();

  const knownShape = await call(registry, "GET", "/api/credentials/notion");
  assert.equal(knownShape.status, 404);
  assert.deepEqual(knownShape.body, { error: "Credential 'notion' not found" });

  // Router params are decoded, so an encoded id is reported as the user sees it.
  const encoded = await call(registry, "GET", "/api/credentials/notion%20token");
  assert.equal(encoded.status, 404);
  assert.equal(encoded.body.error, "Credential 'notion token' not found");
});

test("GET /api/credentials/oauth-status is empty with a real Aden-key bit", async () => {
  const registry = makeRegistry();
  const first = await call(registry, "GET", "/api/credentials/oauth-status");

  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), [
    "accounts_by_provider",
    "fetched_at",
    "has_aden_key",
  ]);
  assert.deepEqual(first.body.accounts_by_provider, {});
  assert.equal(first.body.has_aden_key, false);
  assert.equal(typeof first.body.fetched_at, "number");
  assert.ok(Math.abs(Date.now() - first.body.fetched_at) < 5000);

  await withEnv({ ADEN_API_KEY: "aden-test-key" }, async () => {
    const aden = await call(registry, "GET", "/api/credentials/oauth-status");
    assert.equal(aden.body.has_aden_key, true);
  });
});

// --- Credential checks -------------------------------------------------------

test("POST /api/credentials/validate-key compares locally with the configured key", async () => {
  const registry = makeRegistry();

  const match = await call(registry, "POST", "/api/credentials/validate-key", {
    body: { provider_id: "pihive", api_key: "extra-test-key" },
  });
  assert.equal(match.status, 200);
  assert.equal(match.body.valid, true);
  assert.equal(typeof match.body.message, "string");

  const mismatch = await call(registry, "POST", "/api/credentials/validate-key", {
    body: { provider_id: "pihive", api_key: "not-the-key" },
  });
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.body.valid, false);

  const other = await call(registry, "POST", "/api/credentials/validate-key", {
    body: { provider_id: "openai", api_key: "sk-something" },
  });
  assert.equal(other.status, 200);
  assert.equal(other.body.valid, null);
  assert.match(other.body.message, /openai/);

  const missing = await call(registry, "POST", "/api/credentials/validate-key", { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.type, "invalid_request");
  assert.match(missing.body.error, /provider_id and api_key/);

  const malformed = await call(registry, "POST", "/api/credentials/validate-key", {
    body: "{not-json",
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, "Invalid JSON body");

  // No configured key: the check cannot claim a pass.
  await withEnv({ PI_HIVE_API_KEY: undefined, BROADTOKEN_API_KEY: undefined }, async () => {
    const unconfigured = await call(registry, "POST", "/api/credentials/validate-key", {
      body: { provider_id: "pihive", api_key: "anything" },
    });
    assert.equal(unconfigured.status, 200);
    assert.equal(unconfigured.body.valid, null);
    assert.match(unconfigured.body.message, /not configured/);
  });

  // Exported helper agrees with the route.
  assert.equal(checkKey("pihive", "extra-test-key").valid, true);
});

test("POST /api/credentials/check-agent returns no per-agent requirements", async () => {
  const registry = makeRegistry();
  const agentDir = temporaryHome("config-extra-agent");
  const agentFile = path.join(agentDir, "not-a-dir.txt");
  fs.writeFileSync(agentFile, "x");

  const missing = await call(registry, "POST", "/api/credentials/check-agent", { body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "agent_path is required");

  const notDir = await call(registry, "POST", "/api/credentials/check-agent", {
    body: { agent_path: agentFile },
  });
  assert.equal(notDir.status, 400);
  assert.match(notDir.body.error, /not a directory/);

  const absent = await call(registry, "POST", "/api/credentials/check-agent", {
    body: { agent_path: path.join(agentDir, "nope") },
  });
  assert.equal(absent.status, 400);

  const checked = await call(registry, "POST", "/api/credentials/check-agent", {
    body: { agent_path: agentDir },
  });
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.body, { required: [], has_aden_key: false });

  await withEnv({ ADEN_API_KEY: "aden-test-key" }, async () => {
    const aden = await call(registry, "POST", "/api/credentials/check-agent", {
      body: { agent_path: agentDir },
    });
    assert.equal(aden.body.has_aden_key, true);
  });

  const malformed = await call(registry, "POST", "/api/credentials/check-agent", {
    body: "[not an object",
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error, "Invalid JSON body");
});

test("request bodies are read from a Node request stream, like the server passes them", async () => {
  const registry = makeRegistry();

  const valid = await call(registry, "POST", "/api/credentials/validate-key", {
    req: streamRequest('{"provider_id":"pihive","api_key":"extra-test-key"}'),
  });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.valid, true);

  const inline = await call(registry, "POST", "/api/credentials/validate-key", {
    req: Readable.from(['{"provider_id":"pihive","api_key":"wrong"}']),
  });
  assert.equal(inline.status, 200);
  assert.equal(inline.body.valid, false);

  const invalid = await call(registry, "POST", "/api/credentials/validate-key", {
    req: streamRequest("{not-json"),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "Invalid JSON body");
});

// --- Mutations: explicit 4xx, never 501 or fake success ----------------------

const UNSUPPORTED_MUTATIONS = [
  ["POST", "/api/credentials"],
  ["DELETE", "/api/credentials/notion"],
  ["POST", "/api/credentials/local"],
  ["DELETE", "/api/credentials/local/notion/acct"],
  ["POST", "/api/credentials/resync"],
  ["POST", "/api/sessions/session-1/credential-form"],
];

test("every unsupported mutation answers 400 with an explicit reason", async () => {
  const registry = makeRegistry();

  for (const [method, pathname] of UNSUPPORTED_MUTATIONS) {
    const { status, body } = await call(registry, method, pathname, { body: {} });
    assert.equal(status, 400, `${method} ${pathname} must be an explicit 400`);
    assert.equal(body.type, "unsupported_capability", `${method} ${pathname} type`);
    assert.equal(typeof body.error, "string", `${method} ${pathname} error`);
    assert.ok(body.error.length > 20, `${method} ${pathname} must explain why`);
    assert.match(body.error, /pi_hive|cannot|no /i, `${method} ${pathname} reason`);
    assert.equal(body.route, pathname, `${method} ${pathname} route`);
    assert.equal(typeof body.capability, "string", `${method} ${pathname} capability`);
    assert.ok(body.capability.length > 0);

    // Refusals must not look like the official success envelopes.
    assert.equal("saved" in body, false, `${method} ${pathname} must not claim saved`);
    assert.equal("deleted" in body, false, `${method} ${pathname} must not claim deleted`);
    assert.equal("avatar_url" in body, false, `${method} ${pathname} must not claim an avatar`);
    assert.equal("library" in body, false, `${method} ${pathname} must not claim a library`);
  }
});


// --- Config writes: durable round-trips --------------------------------------

test("PUT /api/config/llm-sections stores a slot that GET reads back", async () => {
  const registry = makeCombinedRegistry();
  const written = await call(registry, "PUT", "/api/config/llm-sections", {
    body: {
      role: "judge",
      section: { provider: "openai", model: "judge-model", api_base: "https://judge.test/v1", api_key_env_var: "JUDGE_KEY" },
    },
  });
  assert.equal(written.status, 200);
  assert.equal(written.body.role, "judge");
  assert.equal(written.body.section.model, "judge-model");
  assert.equal(written.body.sessions_swapped, 0); // no server in this context
  const read = await call(registry, "GET", "/api/config/llm-sections");
  assert.equal(read.body.judge.model, "judge-model");
  assert.equal(read.body.llm.model, (await call(registry, "GET", "/api/config/llm")).body.model, "a judge write does not move the llm slot");

  const cleared = await call(registry, "PUT", "/api/config/llm-sections", { body: { role: "judge", section: null } });
  assert.equal(cleared.body.section, null);
  assert.equal((await call(registry, "GET", "/api/config/llm-sections")).body.judge, null);
});

test("a config write refuses a secret and never echoes it back", async () => {
  const registry = makeRegistry();
  const withKey = await call(registry, "PUT", "/api/config/llm-sections", {
    body: { role: "judge", section: { provider: "openai", model: "m", api_key: "submitted-secret-value" } },
  });
  assert.equal(withKey.status, 400);
  assert.match(withKey.body.error, /api_key/);
  assert.equal(JSON.stringify(withKey.body).includes("submitted-secret-value"), false);
  assert.equal(JSON.stringify(await call(registry, "GET", "/api/config/llm-sections")).includes("submitted-secret-value"), false);

  const unknownRole = await call(registry, "PUT", "/api/config/llm-sections", { body: { role: "nope", section: null } });
  assert.equal(unknownRole.status, 400);
});

test("PUT /api/config/llm switches the model and the saved value outranks the environment", async () => {
  const registry = makeCombinedRegistry();
  const res = await call(registry, "PUT", "/api/config/llm", { body: { model: "swapped-model" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.model, "swapped-model");
  assert.equal(res.body.provider, "pihive");
  assert.equal(res.body.has_api_key, true);
  assert.equal(res.body.sessions_swapped, 0);
  assert.equal(res.body.active_subscription, null);
  assert.equal((await call(registry, "GET", "/api/config/llm")).body.model, "swapped-model");

  const foreignProvider = await call(registry, "PUT", "/api/config/llm", { body: { provider: "openai", model: "x" } });
  assert.equal(foreignProvider.status, 400);
  assert.match(foreignProvider.body.error, /one endpoint/);
  const subscription = await call(registry, "PUT", "/api/config/llm", { body: { subscription: "claude", model: "x" } });
  assert.equal(subscription.status, 400);
  assert.equal((await call(registry, "GET", "/api/config/llm")).body.model, "swapped-model", "refusals change nothing");
});

test("the provider library saves entries and applies one into a slot", async () => {
  const registry = makeCombinedRegistry();
  const saved = await call(registry, "PUT", "/api/config/provider-library", {
    body: { name: "local-llama", section: { provider: "openai", model: "llama-3", api_base: "http://127.0.0.1:8080/v1" } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.name, "local-llama");
  assert.deepEqual(Object.keys((await call(registry, "GET", "/api/config/provider-library")).body.library), ["local-llama"]);

  const applied = await call(registry, "POST", "/api/config/provider-library/apply", { body: { name: "local-llama" } });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.role, "llm");
  assert.equal(applied.body.section.model, "llama-3");
  assert.equal((await call(registry, "GET", "/api/config/llm")).body.model, "llama-3", "applying re-points the runtime slot");

  assert.equal((await call(registry, "POST", "/api/config/provider-library/apply", { body: { name: "ghost" } })).status, 404);
  assert.equal((await call(registry, "PUT", "/api/config/provider-library", { body: { name: "", section: null } })).status, 400);
  const deleted = await call(registry, "PUT", "/api/config/provider-library", { body: { name: "local-llama", section: null } });
  assert.equal(deleted.body.section, null);
  assert.deepEqual((await call(registry, "GET", "/api/config/provider-library")).body, { library: {} });
});

test("PUT /api/config/external-skills records roots and reports how each resolves", async () => {
  const registry = makeRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihive-skills-"));
  fs.mkdirSync(path.join(root, "demo-skill"), { recursive: true });
  fs.writeFileSync(path.join(root, "demo-skill", "SKILL.md"), "# demo\n");
  const res = await call(registry, "PUT", "/api/config/external-skills", { body: { paths: [root, "/nope/missing"] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.paths, [root, "/nope/missing"]);
  assert.equal(res.body.resolved[0].exists, true);
  assert.equal(res.body.resolved[0].skills, 1);
  assert.equal(res.body.resolved[1].exists, false);
  assert.deepEqual((await call(registry, "GET", "/api/config/external-skills")).body.paths, [root, "/nope/missing"]);
  assert.equal((await call(registry, "PUT", "/api/config/external-skills", { body: { paths: "x" } })).status, 400);
});

test("PUT /api/config/features persists the switches", async () => {
  const registry = makeCombinedRegistry();
  const res = await call(registry, "PUT", "/api/config/features", { body: { features: { stall_check: true } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.features.stall_check, true);
  assert.equal(res.body.features.adaptive_tool_budget, false, "unwritten flags keep their default");
  assert.equal(typeof res.body.colonies_applied, "number");
  assert.equal((await call(registry, "GET", "/api/config/features")).body.features.stall_check, true);
  assert.equal((await call(registry, "PUT", "/api/config/features", { body: { features: { nope: true } } })).status, 400);
  assert.equal((await call(registry, "PUT", "/api/config/features", { body: { features: { stall_check: "yes" } } })).status, 400);
});

test("PUT /api/config/profile saves the profile; has_avatar follows the avatar store", async () => {
  const registry = makeCombinedRegistry();
  assert.equal((await call(registry, "GET", "/api/config/profile")).body.has_avatar, false);
  const res = await call(registry, "PUT", "/api/config/profile", {
    body: { displayName: "Cap", about: "runs the colony", theme: "dusk", prompt_library_sort: { my: "updated_at" } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.displayName, "Cap");
  const after = await call(registry, "GET", "/api/config/profile");
  assert.equal(after.body.about, "runs the colony");
  assert.equal(after.body.theme, "dusk");
  assert.deepEqual(after.body.prompt_library_sort, { my: "updated_at" });
  assert.equal((await call(registry, "PUT", "/api/config/profile", { body: {} })).status, 400);
  assert.equal((await call(registry, "PUT", "/api/config/profile", { body: { prompt_library_sort: 5 } })).status, 400);
});

test("the profile avatar round-trips as bytes", async () => {
  const registry = makeCombinedRegistry();
  assert.equal((await call(registry, "GET", "/api/config/profile/avatar")).status, 404);

  const boundary = "pihive-config-avatar";
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const raw = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const uploaded = await call(registry, "POST", "/api/config/profile/avatar", {
    req: Object.assign(Readable.from([raw]), { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` } }),
  });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.avatar_url, "/api/config/profile/avatar");

  const served = await call(registry, "GET", "/api/config/profile/avatar");
  assert.equal(served.status, 200);
  assert.equal(served.content_type, "image/png");
  assert.equal(Buffer.compare(served.body, bytes), 0);
  assert.equal((await call(registry, "GET", "/api/config/profile")).body.has_avatar, true);

  const notAnImage = await call(registry, "POST", "/api/config/profile/avatar", {
    req: Object.assign(Readable.from([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${boundary}--\r\n`)]), {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    }),
  });
  assert.equal(notAnImage.status, 400);
});

test("PUT /api/config/rate-limits replaces the table and warns on unusable keys", async () => {
  const registry = makeRegistry();
  const res = await call(registry, "PUT", "/api/config/rate-limits", {
    body: { limits: { "twitter:like": 30, "reddit:comment": 120, broken: 5, "x:y": -1 } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.limits, [
    { platform: "twitter", action_type: "like", min_delay_s: 30 },
    { platform: "reddit", action_type: "comment", min_delay_s: 120 },
  ]);
  assert.equal(res.body.warnings.length, 2);
  assert.deepEqual((await call(registry, "GET", "/api/config/rate-limits")).body.limits, res.body.limits);
});
test("slot and endpoint ids are validated before anything is written", async () => {
  const registry = makeRegistry();

  const unknownSlot = await call(registry, "PUT", "/api/models/slots/not_a_slot", { body: {} });
  assert.equal(unknownSlot.status, 400);
  assert.equal(unknownSlot.body.type, "invalid_request");
  assert.match(unknownSlot.body.error, /no slot 'not_a_slot'/);

  const noChoice = await call(registry, "PUT", "/api/models/slots/worker_llm", { body: {} });
  assert.equal(noChoice.status, 400);
  assert.match(noChoice.body.error, /source must be 'catalog' or 'endpoint'/);

  const noModel = await call(registry, "PUT", "/api/models/slots/worker_llm", {
    body: { source: "catalog", provider: "pihive" },
  });
  assert.equal(noModel.status, 400);
  assert.match(noModel.body.error, /model is required/);

  const unknownEndpointChoice = await call(registry, "PUT", "/api/models/slots/worker_llm", {
    body: { source: "endpoint", endpoint: "gone", model: "m" },
  });
  assert.equal(unknownEndpointChoice.status, 404);

  const missingEndpoint = await call(registry, "DELETE", "/api/models/endpoints/gone");
  assert.equal(missingEndpoint.status, 404);

  const badBase = await call(registry, "PUT", "/api/models/endpoints/local", { body: { api_base: "not-a-url" } });
  assert.equal(badBase.status, 400);
  assert.match(badBase.body.error, /absolute URL/);

  const noBase = await call(registry, "PUT", "/api/models/endpoints/local", { body: { api_key: "k" } });
  assert.equal(noBase.status, 400);
  assert.match(noBase.body.error, /api_base is required/);

  // Nothing above may have created a file.
  assert.equal(fs.existsSync(path.join(process.env.PI_HIVE_HOME, "config", "endpoints.json")), false);
  assert.equal(fs.existsSync(path.join(process.env.PI_HIVE_HOME, "config", "slots.json")), false);
});

test("a named endpoint round-trips without ever echoing its key", async () => {
  const registry = makeCombinedRegistry();
  const saved = await call(registry, "PUT", "/api/models/endpoints/ollama", {
    body: { api_base: "http://127.0.0.1:11434/v1/", api_key: "endpoint-secret-value" },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, {
    name: "ollama",
    api_base: "http://127.0.0.1:11434/v1",
    builtin: false,
    has_key: true,
    running: false,
  });
  assert.equal(JSON.stringify(saved.body).includes("endpoint-secret-value"), false);

  // The key is on disk with 0600, outside the repo.
  const file = path.join(process.env.PI_HIVE_HOME, "config", "endpoints.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.ollama.api_key, "endpoint-secret-value");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }

  const edited = await call(registry, "PUT", "/api/models/endpoints/ollama", { body: { api_base: "http://127.0.0.1:8080/v1" } });
  assert.equal(edited.body.api_base, "http://127.0.0.1:8080/v1");
  assert.equal(edited.body.has_key, true, "an api_base edit keeps the stored key");

  const cleared = await call(registry, "PUT", "/api/models/endpoints/ollama", { body: { api_key: null } });
  assert.equal(cleared.body.has_key, false);

  const listed = await call(registry, "GET", "/api/models/overview");
  assert.deepEqual(
    listed.body.endpoints.map((endpoint) => endpoint.name),
    ["ollama"],
    "the overview lists stored endpoints",
  );

  const deleted = await call(registry, "DELETE", "/api/models/endpoints/ollama");
  assert.deepEqual(deleted.body, { deleted: "ollama" });
  const after = await call(registry, "GET", "/api/models/overview");
  assert.deepEqual(after.body.endpoints, []);
});

test("model slots persist and the overview reports them", async () => {
  const registry = makeCombinedRegistry();

  const worker = await call(registry, "PUT", "/api/models/slots/worker_llm", {
    body: { source: "catalog", provider: "pihive", model: "worker-model" },
  });
  assert.equal(worker.status, 200);
  assert.equal(worker.body.slot, "worker_llm");
  assert.equal(worker.body.summary.model, "worker-model");
  assert.equal(worker.body.summary.source, "catalog");

  const vision = await call(registry, "PUT", "/api/models/slots/vision_fallback", {
    body: { source: "catalog", provider: "pihive", model: "vision-model" },
  });
  assert.equal(vision.status, 200);

  let overview = await call(registry, "GET", "/api/models/overview");
  assert.equal(overview.body.slots.worker_llm.model, "worker-model");
  assert.equal(overview.body.slots.vision_fallback.model, "vision-model");

  // The worker runtime really reads this slot.
  const { workerModelConfig } = await import("../../src/config.js");
  assert.equal(workerModelConfig().modelId, "worker-model");

  const cleared = await call(registry, "DELETE", "/api/models/slots/worker_llm");
  assert.deepEqual(cleared.body, { slot: "worker_llm", summary: null });
  overview = await call(registry, "GET", "/api/models/overview");
  assert.equal(overview.body.slots.worker_llm, null);
  assert.notEqual(workerModelConfig().modelId, "worker-model");

  // A queen slot is her own llm section, and it shows up in the overview.
  const queen = await call(registry, "PUT", "/api/models/slots/queen:growth", {
    body: { source: "catalog", provider: "pihive", model: "queen-model" },
  });
  assert.equal(queen.status, 200);
  overview = await call(registry, "GET", "/api/models/overview");
  const growth = overview.body.queens.find((entry) => entry.id === "growth");
  assert.ok(growth, "a queen with her own model appears in the overview");
  assert.equal(growth.model, "queen-model");

  await call(registry, "DELETE", "/api/models/slots/queen:growth");
  overview = await call(registry, "GET", "/api/models/overview");
  assert.deepEqual(overview.body.queens, []);

  // The main slot writes the override the runtime is built from.
  const main = await call(registry, "PUT", "/api/models/slots/llm", {
    body: { source: "catalog", provider: "pihive", model: "main-model" },
  });
  assert.equal(main.status, 200);
  assert.equal(main.body.summary.model, "main-model");
  assert.equal(typeof main.body.sessions_switched, "number");
  const llm = await call(registry, "GET", "/api/config/llm");
  assert.equal(llm.body.model, "main-model");

  const clearedMain = await call(registry, "DELETE", "/api/models/slots/llm");
  assert.equal(clearedMain.body.summary, null);
  const back = await call(registry, "GET", "/api/config/llm");
  assert.notEqual(back.body.model, "main-model");
});

// --- Hardening ---------------------------------------------------------------

test("no response echoes the configured or submitted API key", async () => {
  const registry = makeRegistry();
  const configuredKey = process.env.PI_HIVE_API_KEY; // "extra-test-key"
  const submittedKey = "submitted-secret-value";

  const sections = await call(registry, "GET", "/api/config/llm-sections");
  assert.equal(JSON.stringify(sections.body).includes(configuredKey), false);

  const validated = await call(registry, "POST", "/api/credentials/validate-key", {
    body: { provider_id: "pihive", api_key: submittedKey },
  });
  assert.equal(validated.body.valid, false);
  assert.equal(JSON.stringify(validated.body).includes(submittedKey), false);

  const oauth = await call(registry, "GET", "/api/credentials/oauth-status");
  assert.equal(JSON.stringify(oauth.body).includes(configuredKey), false);
});

test("every route tolerates a missing ctx and an empty request", async () => {
  const registry = makeRegistry();

  for (const { method, path: routePath } of CONFIG_EXTRA_ROUTES) {
    const match = registry.match(method, routePath);
    assert.ok(match);
    const result = await match.route.handler({
      req: { method },
      res: { headersSent: false },
      params: {},
      pathname: routePath,
    });
    assert.ok(result.status >= 200 && result.status < 500, `${method} ${routePath} status`);
    assert.ok(result.body && typeof result.body === "object", `${method} ${routePath} body`);
    assert.doesNotThrow(() => JSON.stringify(result.body), `${method} ${routePath} serializable`);
  }
});

test("an empty PI_HIVE_HOME does not change any of these answers", async () => {
  const emptyHome = temporaryHome("config-extra-empty");
  const registry = makeRegistry();

  await withEnv({ PI_HIVE_HOME: emptyHome }, async () => {
    const startup = await call(registry, "GET", "/api/startup-status");
    assert.equal(startup.status, 200);

    const sections = await call(registry, "GET", "/api/config/llm-sections");
    assert.equal(sections.body.llm.model, "extra-test-model");

    const endpoint = await call(registry, "GET", "/api/models/endpoints/pihive/models");
    assert.equal(endpoint.body.models.length, 1);

    const library = await call(registry, "GET", "/api/config/provider-library");
    assert.deepEqual(library.body, { library: {} });
  });
});
