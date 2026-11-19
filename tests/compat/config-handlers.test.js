/**
 * Route-level tests for the official frontend's boot-critical config/catalogue
 * compatibility handlers.
 *
 * A fresh RouteRegistry is used per test so method/path matching is exercised
 * the same way the server does it. Every assertion is against a returned
 * `{ status, body }` descriptor — no sockets, no model, no network.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RouteRegistry, ROUTE_STATUS } from "../../src/compat/router.js";
import {
  CONFIG_ROUTE_PATHS,
  buildCredentialSpecs,
  buildLLMConfig,
  registerConfigRoutes,
} from "../../src/compat/handlers/config.js";
import { colonyPaths, createColony } from "../../src/domain/colony.js";
import { createTask } from "../../src/domain/plan.js";
import { writeSkill } from "../../src/domain/skills.js";

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

function useHome(dir) {
  process.env.PI_HIVE_HOME = dir;
}

function makeRegistry(ctx) {
  const registry = new RouteRegistry();
  registerConfigRoutes(registry, ctx);
  return registry;
}

async function call(registry, method, pathname, ctx) {
  const match = registry.match(method, pathname);
  assert.ok(match, `expected a registered route for ${method} ${pathname}`);
  const result = await match.route.handler({
    req: { method },
    res: { headersSent: false },
    params: match.params,
    pathname: match.pathname,
    ctx,
  });
  assert.equal(typeof result, "object", `${method} ${pathname} must return a descriptor`);
  assert.equal(typeof result.status, "number", `${method} ${pathname} must return a status`);
  assert.ok(result.body !== undefined, `${method} ${pathname} must return a body`);
  return result;
}

// --- Fixture: two colonies, one with two real SKILL.md files -----------------

const HOME = temporaryHome("config-handlers");
useHome(HOME);
process.env.PI_HIVE_MODEL = "compat-test-model";
process.env.PI_HIVE_BASE_URL = "http://127.0.0.1:1/v1";
process.env.PI_HIVE_API_KEY = "test-key-not-real";
delete process.env.BROADTOKEN_API_KEY;
delete process.env.ADEN_API_KEY;

createColony({ name: "acme", queenId: "queen_growth", goal: "Prove the config boot routes" });
createColony({ name: "beta", queenId: "queen_tech", goal: "Second colony with no skills" });
createTask("acme", { subject: "first task" });
createTask("acme", { subject: "second task" });
writeSkill("acme", {
  name: "alpha-skill",
  description: "First test skill",
  body: "Use this skill for alpha work.",
});
writeSkill("acme", {
  name: "beta-skill",
  description: "Second test skill",
  body: "Use this skill for beta work.",
});

after(() => {
  for (const key of TOUCHED_ENV) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
  for (const dir of tempHomes) fs.rmSync(dir, { recursive: true, force: true });
});

// --- Registration and matching ----------------------------------------------

test("registers the ten boot-critical official GET routes as implemented", () => {
  const registry = makeRegistry();
  const counts = registry.counts();

  assert.equal(counts.total, CONFIG_ROUTE_PATHS.length);
  assert.equal(counts.implemented, CONFIG_ROUTE_PATHS.length);
  assert.equal(counts.partial, 0);
  assert.equal(counts.missing, 0);

  for (const routePath of CONFIG_ROUTE_PATHS) {
    const match = registry.match("GET", routePath);
    assert.ok(match, `GET ${routePath} must match`);
    assert.equal(match.route.method, "GET");
    assert.equal(match.route.path, routePath);
    assert.equal(match.route.status, ROUTE_STATUS.IMPLEMENTED, `GET ${routePath} status`);
    assert.equal(match.route.meta.official, true, `GET ${routePath} official flag`);
    assert.equal(typeof match.route.meta.description, "string");
    assert.ok(match.route.meta.description.length > 0, `GET ${routePath} description`);
    assert.equal(typeof match.route.handler, "function", `GET ${routePath} handler`);

    // Only GET is registered; POST must not match.
    assert.equal(registry.match("POST", routePath), null, `POST ${routePath} must not match`);

    // The router serves HEAD from the GET handler for read-only routes.
    const head = registry.match("HEAD", routePath);
    assert.ok(head, `HEAD ${routePath} must resolve to the GET handler`);
    assert.equal(head.route.path, routePath);
  }

  assert.equal(registry.match("GET", "/api/nope"), null);
  assert.equal(registry.match("GET", "/api/config/llm/extra"), null);
});

test("re-registering replaces the shell's 501 entry instead of duplicating it", () => {
  const registry = new RouteRegistry();
  registry.register("GET", "/api/config/llm", null, { status: ROUTE_STATUS.MISSING });
  assert.equal(registry.counts().missing, 1);

  registerConfigRoutes(registry);
  assert.equal(registry.counts().total, CONFIG_ROUTE_PATHS.length);
  assert.equal(registry.counts().missing, 0);
  assert.equal(registry.match("GET", "/api/config/llm").route.status, ROUTE_STATUS.IMPLEMENTED);
});

// --- Config / models --------------------------------------------------------

test("GET /api/config/llm returns the official LLMConfig for the pi_hive model", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/config/llm");

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), [
    "active_subscription",
    "api_base",
    "api_key_env_var",
    "connected_providers",
    "detected_subscriptions",
    "has_api_key",
    "max_context_tokens",
    "max_tokens",
    "model",
    "provider",
    "subscriptions",
  ]);
  assert.equal(body.provider, "pihive");
  assert.equal(body.model, "compat-test-model");
  assert.equal(body.has_api_key, true);
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.max_context_tokens, 128000);
  assert.deepEqual(body.connected_providers, ["pihive"]);
  assert.equal(body.active_subscription, null);
  assert.deepEqual(body.detected_subscriptions, []);
  assert.deepEqual(body.subscriptions, []);
  assert.equal(body.api_base, "http://127.0.0.1:1/v1");
  assert.equal(body.api_key_env_var, "PI_HIVE_API_KEY");
});

test("LLMConfig reports no connected provider when the key is absent", () => {
  delete process.env.PI_HIVE_API_KEY;
  try {
    const body = buildLLMConfig();
    assert.equal(body.has_api_key, false);
    assert.deepEqual(body.connected_providers, []);
    // The env var name is still the documented one, so the UI can ask for it.
    assert.equal(body.api_key_env_var, "PI_HIVE_API_KEY");
  } finally {
    process.env.PI_HIVE_API_KEY = "test-key-not-real";
  }
});

test("GET /api/config/models returns the official ModelsCatalogue", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/config/models");

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ["models"]);
  assert.deepEqual(Object.keys(body.models), ["pihive"]);
  assert.equal(body.models.pihive.length, 1);

  const option = body.models.pihive[0];
  assert.deepEqual(Object.keys(option).sort(), [
    "id",
    "label",
    "max_context_tokens",
    "max_tokens",
    "recommended",
  ]);
  assert.equal(option.id, "compat-test-model");
  assert.equal(option.label, "compat-test-model");
  assert.equal(option.recommended, true);
  assert.equal(option.max_tokens, 8192);
  assert.equal(option.max_context_tokens, 128000);
});

test("GET /api/models/overview returns the official ModelsOverview", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/models/overview");

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), [
    "endpoints",
    "judge",
    "providers",
    "queens",
    "slots",
    "subscriptions",
  ]);
  assert.deepEqual(Object.keys(body.slots).sort(), ["llm", "vision_fallback", "worker_llm"]);
  assert.deepEqual(body.slots.llm, {
    source: "catalog",
    provider: "pihive",
    model: "compat-test-model",
    endpoint: null,
    subscription: null,
    api_base: "http://127.0.0.1:1/v1",
    max_context_tokens: 128000,
    has_extra_body: false,
  });
  assert.equal(body.slots.worker_llm, null);
  assert.equal(body.slots.vision_fallback, null);
  assert.deepEqual(body.judge, { configured: false, model: null, api_base: null });
  assert.deepEqual(body.queens, []);
  assert.deepEqual(body.endpoints, []);
  assert.deepEqual(body.subscriptions, []);

  assert.equal(body.providers.length, 1);
  assert.equal(body.providers[0].id, "pihive");
  assert.equal(body.providers[0].connected, true);
  assert.deepEqual(body.providers[0].models, [
    {
      id: "compat-test-model",
      label: "compat-test-model",
      recommended: true,
      max_context_tokens: 128000,
      supports_vision: false,
    },
  ]);
});

// --- Profile / features -----------------------------------------------------

test("GET /api/config/profile returns the official (empty) profile object", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/config/profile");

  assert.equal(status, 200);
  assert.deepEqual(body, {
    displayName: "",
    about: "",
    theme: "",
    has_avatar: false,
    prompt_library_sort: null,
  });
});

test("GET /api/config/features returns the official FeaturesConfig object", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/config/features");

  assert.equal(status, 200);
  assert.deepEqual(body, {
    features: {
      adaptive_tool_budget: false,
      email_senders: false,
      stall_check: false,
    },
  });
  for (const value of Object.values(body.features)) {
    assert.equal(typeof value, "boolean");
  }
});

// --- Credentials ------------------------------------------------------------

test("GET /api/credentials returns an empty official credential list", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/credentials");

  assert.equal(status, 200);
  assert.deepEqual(body, { credentials: [], unreadable_credentials: [] });
});

test("GET /api/credentials/specs returns empty specs and the Aden flag", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/credentials/specs");

  assert.equal(status, 200);
  assert.deepEqual(body, {
    specs: [],
    has_aden_key: false,
    accounts_by_provider: {},
  });

  process.env.ADEN_API_KEY = "aden-test-key";
  try {
    assert.equal(buildCredentialSpecs().has_aden_key, true);
  } finally {
    delete process.env.ADEN_API_KEY;
  }
});

// --- Skills / prompts -------------------------------------------------------

test("GET /api/skills aggregates real colony skills in the official envelope", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/skills");

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["colonies", "queens", "skills"]);

  assert.deepEqual(body.colonies, [
    { name: "acme", queen_id: "queen_growth" },
    { name: "beta", queen_id: "queen_tech" },
  ]);
  assert.deepEqual(body.queens, [
    { id: "queen_growth", name: "queen_growth" },
    { id: "queen_tech", name: "queen_tech" },
  ]);

  assert.equal(body.skills.length, 2, "only acme has SKILL.md files");
  const row = body.skills.find((skill) => skill.name === "alpha-skill");
  assert.ok(row, "alpha-skill must be listed");

  assert.deepEqual(Object.keys(row).sort(), [
    "base_dir",
    "created_at",
    "created_by",
    "deletable",
    "description",
    "editable",
    "enabled",
    "enabled_by_default",
    "location",
    "name",
    "notes",
    "owner",
    "provenance",
    "source_scope",
    "trust",
    "visibility",
    "visible_to",
  ]);
  assert.equal(row.description, "First test skill");
  assert.equal(row.source_scope, "colony_ui");
  assert.equal(row.provenance, "other");
  assert.equal(row.enabled, true);
  assert.equal(row.editable, false);
  assert.equal(row.deletable, false);
  assert.equal(row.enabled_by_default, true);
  assert.equal(row.location, path.join(colonyPaths("acme").skills, "alpha-skill", "SKILL.md"));
  assert.equal(fs.existsSync(row.location), true);
  assert.equal(row.base_dir, path.join(colonyPaths("acme").skills, "alpha-skill"));
  assert.deepEqual(row.owner, { type: "colony", id: "acme", name: "acme" });
  assert.deepEqual(row.visible_to, { queens: ["queen_growth"], colonies: ["acme"] });
  assert.equal(row.visibility, null);
  assert.equal(row.trust, null);
  assert.equal(row.created_at, null);
  assert.equal(row.created_by, null);
  assert.equal(row.notes, null);
});

test("GET /api/prompts returns an empty official prompt list", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/prompts");

  assert.equal(status, 200);
  assert.deepEqual(body, { prompts: [] });
});

// --- Discovery --------------------------------------------------------------

test("GET /api/discover maps real colonies to DiscoverResult", async () => {
  const registry = makeRegistry();
  const { status, body } = await call(registry, "GET", "/api/discover");

  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ["Your Agents"]);

  const entries = body["Your Agents"];
  assert.equal(entries.length, 2);

  const acme = entries.find((entry) => entry.name === "acme");
  assert.ok(acme, "acme must be discovered");
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
  assert.equal(acme.path, colonyPaths("acme").dir);
  assert.equal(acme.category, "Your Agents");
  assert.equal(acme.description, "Prove the config boot routes");
  assert.equal(acme.node_count, 2, "two plan tasks were created");
  assert.equal(acme.session_count, 0);
  assert.equal(acme.run_count, 0);
  assert.equal(acme.tool_count, 0);
  assert.deepEqual(acme.tags, []);
  assert.equal(acme.icon, null);
  assert.deepEqual(acme.workers, []);
  assert.equal(acme.is_loaded, false);
  assert.equal(typeof acme.last_active, "string");
  assert.equal(Number.isNaN(Date.parse(acme.last_active)), false);

  const beta = entries.find((entry) => entry.name === "beta");
  assert.ok(beta, "beta must be discovered");
  assert.equal(beta.node_count, 0);
});

test("discover reads loaded colonies from registration ctx or per-call ctx", async () => {
  const registry = makeRegistry({ runtimes: new Map([["acme", { fake: true }]]) });
  const fromRegistration = await call(registry, "GET", "/api/discover");
  const entries = fromRegistration.body["Your Agents"];
  assert.equal(entries.find((entry) => entry.name === "acme").is_loaded, true);
  assert.equal(entries.find((entry) => entry.name === "beta").is_loaded, false);

  // A per-call ctx wins over the registration-time one.
  const perCall = await call(registry, "GET", "/api/discover", { runtimes: new Set(["beta"]) });
  const perCallEntries = perCall.body["Your Agents"];
  assert.equal(perCallEntries.find((entry) => entry.name === "acme").is_loaded, false);
  assert.equal(perCallEntries.find((entry) => entry.name === "beta").is_loaded, true);
});

test("every route tolerates a missing ctx (the server passes none today)", async () => {
  const registry = makeRegistry();
  for (const routePath of CONFIG_ROUTE_PATHS) {
    const match = registry.match("GET", routePath);
    const result = await match.route.handler({
      req: { method: "GET" },
      res: { headersSent: false },
      params: {},
      pathname: routePath,
    });
    assert.equal(result.status, 200, `GET ${routePath} without ctx`);
    assert.ok(result.body !== undefined, `GET ${routePath} without ctx must return a body`);
  }
});

// --- Genuinely empty domains ------------------------------------------------

test("empty PI_HIVE_HOME yields empty collections, never fabricated rows", async () => {
  const emptyHome = temporaryHome("config-handlers-empty");
  useHome(emptyHome);
  try {
    const registry = makeRegistry();

    const skills = await call(registry, "GET", "/api/skills");
    assert.deepEqual(skills.body, { skills: [], queens: [], colonies: [] });

    const prompts = await call(registry, "GET", "/api/prompts");
    assert.deepEqual(prompts.body, { prompts: [] });

    const credentials = await call(registry, "GET", "/api/credentials");
    assert.deepEqual(credentials.body, { credentials: [], unreadable_credentials: [] });

    const specs = await call(registry, "GET", "/api/credentials/specs");
    assert.deepEqual(specs.body, { specs: [], has_aden_key: false, accounts_by_provider: {} });

    const discover = await call(registry, "GET", "/api/discover");
    assert.deepEqual(discover.body, {}, "no colonies => no discover categories");

    const overview = await call(registry, "GET", "/api/models/overview");
    assert.deepEqual(overview.body.queens, []);
    assert.deepEqual(overview.body.endpoints, []);
    assert.deepEqual(overview.body.subscriptions, []);
    // The model itself is config, not a store: it is still reported.
    assert.equal(overview.body.slots.llm.model, "compat-test-model");
  } finally {
    useHome(HOME);
  }
});

test("a stray colonies/ directory cannot fail a boot route", async () => {
  const strayHome = temporaryHome("config-handlers-stray");
  useHome(strayHome);
  try {
    fs.mkdirSync(path.join(strayHome, "colonies", "Not_A_Colony"), { recursive: true });
    fs.writeFileSync(path.join(strayHome, "colonies", "README.txt"), "not a colony\n");

    const registry = makeRegistry();
    const skills = await call(registry, "GET", "/api/skills");
    assert.deepEqual(skills.body, { skills: [], queens: [], colonies: [] });

    const discover = await call(registry, "GET", "/api/discover");
    assert.deepEqual(discover.body, {});
  } finally {
    useHome(HOME);
  }
});
