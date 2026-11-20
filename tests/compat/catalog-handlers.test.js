/**
 * Handler tests for the official catalogue surface (skills, prompts,
 * memories, agents).
 *
 * Every test uses a fresh `RouteRegistry` and a fresh `PI_HIVE_HOME`, seeds
 * real colony/skill/memory files, and calls the registered handler with a
 * fake req/res. The handler must return a descriptor and never touch `res`.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RouteRegistry } from "../../src/compat/router.js";
import { coloniesDir, colonyDir, hiveHome } from "../../src/config.js";
import { colonyPaths, createColony, loadMetadata } from "../../src/domain/colony.js";
import { writeSkill } from "../../src/domain/skills.js";
import {
  CATALOG_ROUTE_SPECS,
  catalogCounts,
  registerCatalogRoutes,
} from "../../src/compat/handlers/catalog.js";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-catalog-"));
let homeCounter = 0;

after(() => {
  delete process.env.PI_HIVE_HOME;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Fresh PI_HIVE_HOME per test; src/config.js reads the env at call time. */
function useHome() {
  const home = path.join(TMP_ROOT, `home-${(homeCounter += 1)}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.PI_HIVE_HOME = home;
  return home;
}

function makeRegistry(ctx = {}) {
  const registry = new RouteRegistry();
  registerCatalogRoutes(registry, ctx);
  return registry;
}

function fakeResponse() {
  const state = { wrote: false, headersSent: false };
  const res = {
    get headersSent() {
      return state.headersSent;
    },
    writeHead() {
      state.wrote = true;
      state.headersSent = true;
    },
    end() {
      state.wrote = true;
    },
  };
  return { res, state };
}

/**
 * Invoke a route handler. `options.body` is injected as `req.body` so the
 * test exercises the handler, not node:http. `options.req` overrides the fake
 * request entirely (used for the stream-body test).
 */
async function call(registry, method, target, options = {}) {
  const pathname = target.split("?")[0];
  const match = registry.match(method, pathname);
  assert.ok(match, `no route for ${method} ${target}`);

  const req = options.req ?? {
    method,
    url: target,
    headers: {},
    ...(Object.prototype.hasOwnProperty.call(options, "body") ? { body: options.body } : {}),
  };
  const { res, state } = fakeResponse();
  const args = { req, res, params: match.params };
  if (options.ctx !== undefined) args.ctx = options.ctx;
  if (options.query !== undefined) args.query = options.query;

  const result = await match.route.handler(args);
  assert.equal(state.wrote, false, `${method} ${target} wrote to res instead of returning a descriptor`);
  assert.equal(res.headersSent, false);
  assert.equal(typeof result?.status, "number", `${method} ${target} needs a numeric status`);
  assert.equal(typeof result?.body, "object", `${method} ${target} needs an object body`);
  return result;
}

function expectStatus(result, status, label = "") {
  assert.equal(
    result.status,
    status,
    `${label} expected ${status}, got ${result.status}: ${JSON.stringify(result.body)}`,
  );
}

function seedColony(name, queenId) {
  return createColony({ name, queenId, goal: `${name} goal` });
}

function seedSkill(colony, name, { description = `${name} description`, body = `${name} body` } = {}) {
  return writeSkill(colony, { name, description, body });
}

function skillPath(colony, name) {
  return path.join(colonyPaths(colony).skills, name, "SKILL.md");
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function memoryUrl(rel) {
  return `/api/memories/file?path=${encodeURIComponent(rel)}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("registers all 22 enumerated catalogue routes with honest metadata", () => {
  const registry = new RouteRegistry();
  const returned = registerCatalogRoutes(registry, {});
  assert.equal(returned, registry);

  const expected = [
    "GET /api/skills/scopes",
    "GET /api/skills/:skill",
    "POST /api/skills/upload",
    "GET /api/queen/:queen/skills",
    "POST /api/queen/:queen/skills",
    "PATCH /api/queen/:queen/skills/:skill",
    "GET /api/queen/:queen/skills/:skill/body",
    "PUT /api/queen/:queen/skills/:skill/body",
    "POST /api/queen/:queen/skills/:skill/rename",
    "DELETE /api/queen/:queen/skills/:skill",
    "POST /api/queen/:queen/skills/reload",
    "GET /api/sessions/:session/skill-installs",
    "POST /api/sessions/:session/skill-installs/:install",
    "GET /api/prompts",
    "POST /api/prompts",
    "DELETE /api/prompts/:prompt",
    "GET /api/memories",
    "GET /api/memories/file",
    "PUT /api/memories/file",
    "DELETE /api/memories/file",
    "DELETE /api/agents",
    "PATCH /api/agents/metadata",
  ];

  assert.equal(CATALOG_ROUTE_SPECS.length, expected.length);
  assert.equal(registry.list().length, expected.length);
  assert.deepEqual(
    registry.list().map((route) => `${route.method} ${route.path}`).sort(),
    [...expected].sort(),
  );

  for (const key of expected) {
    const [method, routePath] = key.split(" ");
    const match = registry.match(method, routePath);
    assert.ok(match, `missing ${key}`);
    assert.equal(match.route.handler?.constructor?.name, "AsyncFunction", `${key} handler`);
    assert.equal(match.route.status, "implemented", `${key} must be dispatchable`);
    assert.equal(match.route.meta.official, true, `${key} must be official`);
    assert.ok(["full", "limited"].includes(match.route.meta.compatibility), `${key} compatibility`);
  }

  assert.deepEqual(catalogCounts(), { total: 22, full: 19, limited: 3 });

  // Static routes must win over the dynamic detail/body routes.
  assert.equal(registry.match("GET", "/api/skills/scopes").route.path, "/api/skills/scopes");
  assert.equal(registry.match("GET", "/api/skills/anything").route.path, "/api/skills/:skill");
  assert.equal(
    registry.match("POST", "/api/queen/queen_tech/skills/reload").route.path,
    "/api/queen/:queen/skills/reload",
  );
  assert.equal(
    registry.match("GET", "/api/queen/queen_tech/skills/alpha/body").route.path,
    "/api/queen/:queen/skills/:skill/body",
  );

  assert.ok(registry.match("HEAD", "/api/skills/scopes"), "HEAD falls back to GET");
  assert.throws(() => registerCatalogRoutes(null), /RouteRegistry/);
  assert.throws(() => registerCatalogRoutes({}, {}), /RouteRegistry/);
});

// ---------------------------------------------------------------------------
// Skills library
// ---------------------------------------------------------------------------

test("GET /api/skills/scopes lists built-in queens and real colonies", async () => {
  useHome();
  const registry = makeRegistry();

  const empty = await call(registry, "GET", "/api/skills/scopes");
  expectStatus(empty, 200);
  assert.deepEqual(empty.body.colonies, []);
  assert.deepEqual(
    empty.body.queens.map((queen) => queen.id),
    ["queen_finance", "queen_growth", "queen_ops", "queen_tech"],
  );

  seedColony("acme", "queen_tech");
  seedColony("beta", "queen_finance");
  seedColony("gamma", "queen_custom");
  fs.mkdirSync(path.join(coloniesDir(), "Bad Name"), { recursive: true });
  fs.writeFileSync(path.join(coloniesDir(), "notes.txt"), "ignore");

  const body = await call(registry, "GET", "/api/skills/scopes");
  expectStatus(body, 200);
  assert.deepEqual(body.body.colonies, [
    { name: "acme", queen_id: "queen_tech" },
    { name: "beta", queen_id: "queen_finance" },
    { name: "gamma", queen_id: "queen_custom" },
  ]);
  assert.deepEqual(
    body.body.queens.map((queen) => queen.id),
    ["queen_custom", "queen_finance", "queen_growth", "queen_ops", "queen_tech"],
  );
  for (const queen of body.body.queens) assert.equal(queen.name, queen.id);
});

test("GET /api/skills/:skill returns the first real colony copy, or 404", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  seedColony("beta", "queen_finance");
  seedSkill("acme", "alpha", { description: "acme alpha", body: "acme body" });
  seedSkill("beta", "alpha", { description: "beta alpha", body: "beta body" });

  const registry = makeRegistry();
  const detail = await call(registry, "GET", "/api/skills/alpha");
  expectStatus(detail, 200);

  const location = skillPath("acme", "alpha");
  assert.deepEqual(detail.body, {
    name: "alpha",
    description: "acme alpha",
    source_scope: "colony_ui",
    location,
    base_dir: path.dirname(location),
    body: readText(location),
    visibility: null,
  });
  assert.match(detail.body.body, /^---\n/);
  assert.match(detail.body.body, /acme body/);

  expectStatus(await call(registry, "GET", "/api/skills/missing"), 404);
  expectStatus(await call(registry, "GET", "/api/skills/Bad%20Name"), 400);

  // A skill that only exists in a deleted/odd colony is still real disk data.
  seedSkill("beta", "beta-only", { body: "beta only body" });
  const betaOnly = await call(registry, "GET", "/api/skills/beta-only");
  expectStatus(betaOnly, 200);
  assert.equal(betaOnly.body.location, skillPath("beta", "beta-only"));
});

test("queen skill lists aggregate, dedupe, and expose override state", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  seedColony("beta", "queen_tech");
  seedColony("gamma", "queen_finance");
  seedSkill("acme", "alpha", { description: "acme alpha" });
  seedSkill("beta", "alpha", { description: "beta alpha" });
  seedSkill("beta", "beta-skill");
  seedSkill("gamma", "gamma-skill");

  const registry = makeRegistry();
  const result = await call(registry, "GET", "/api/queen/queen_tech/skills");
  expectStatus(result, 200);

  assert.equal(result.body.queen_id, "queen_tech");
  assert.equal(result.body.all_defaults_disabled, false);
  assert.deepEqual(result.body.skills.map((row) => row.name), ["alpha", "beta-skill"]);

  const alpha = result.body.skills.find((row) => row.name === "alpha");
  assert.equal(alpha.description, "acme alpha", "first sorted colony owns a duplicate name");
  assert.equal(alpha.source_scope, "colony_ui");
  assert.equal(alpha.provenance, "queen_created");
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.editable, true);
  assert.equal(alpha.deletable, true);
  assert.equal(alpha.visibility, null);
  assert.equal(alpha.trust, null);
  assert.equal(alpha.created_at, null);
  assert.equal(alpha.created_by, null);
  assert.equal(alpha.notes, null);
  assert.deepEqual(alpha.param_overrides, {});
  assert.deepEqual(alpha.owner, { type: "colony", id: "acme", name: "acme" });
  assert.deepEqual(alpha.visible_to, { queens: ["queen_tech"], colonies: ["acme"] });
  assert.equal(alpha.enabled_by_default, true);
  assert.equal(alpha.location, skillPath("acme", "alpha"));

  const empty = await call(registry, "GET", "/api/queen/queen_ops/skills");
  expectStatus(empty, 200);
  assert.deepEqual(empty.body, {
    queen_id: "queen_ops",
    all_defaults_disabled: false,
    skills: [],
  });

  expectStatus(await call(registry, "GET", "/api/queen/queen_missing/skills"), 404);
});

test("POST /api/queen/:queen/skills writes real skill files and honors the target", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  const registry = makeRegistry();

  const created = await call(registry, "POST", "/api/queen/queen_tech/skills", {
    body: {
      name: "new-skill",
      description: "does real work",
      body: "Step one\nStep two",
      enabled: false,
      notes: "created by test",
      files: [{ path: "scripts/run.sh", content: "#!/bin/sh\necho hi\n" }],
    },
  });
  expectStatus(created, 201);

  assert.equal(created.body.name, "new-skill");
  assert.equal(created.body.enabled, false);
  assert.equal(created.body.replaced, false);
  assert.equal(created.body.provenance, "queen_created");
  assert.equal(created.body.owner.id, "acme");
  assert.equal(created.body.installed_path, skillPath("acme", "new-skill"));
  assert.ok(fs.existsSync(created.body.installed_path));
  assert.ok(fs.existsSync(path.join(colonyPaths("acme").skills, "new-skill", "scripts", "run.sh")));
  const text = readText(created.body.installed_path);
  assert.match(text, /^---\nname: new-skill\ndescription: does real work\n---\n/);
  assert.match(text, /Step one\nStep two/);

  const listed = await call(registry, "GET", "/api/queen/queen_tech/skills");
  const row = listed.body.skills.find((skill) => skill.name === "new-skill");
  assert.equal(row.enabled, false);
  assert.equal(row.notes, "created by test");

  const body = await call(registry, "GET", "/api/queen/queen_tech/skills/new-skill/body");
  expectStatus(body, 200);
  assert.equal(body.body.body, "Step one\nStep two");

  // Duplicate / replace.
  expectStatus(
    await call(registry, "POST", "/api/queen/queen_tech/skills", {
      body: { name: "new-skill", description: "dup", body: "dup body" },
    }),
    409,
  );
  const replaced = await call(registry, "POST", "/api/queen/queen_tech/skills", {
    body: {
      name: "new-skill",
      description: "replacement",
      body: "fresh body",
      replace_existing: true,
    },
  });
  expectStatus(replaced, 201);
  assert.equal(replaced.body.replaced, true);
  assert.match(readText(replaced.body.installed_path), /fresh body/);
  assert.equal(
    fs.existsSync(path.join(colonyPaths("acme").skills, "new-skill", "scripts", "run.sh")),
    false,
    "replace removes stale extra files",
  );

  // Validation and ambiguity.
  expectStatus(
    await call(registry, "POST", "/api/queen/queen_tech/skills", {
      body: { name: "Bad Name", description: "d", body: "b" },
    }),
    400,
  );
  expectStatus(
    await call(registry, "POST", "/api/queen/queen_tech/skills", {
      body: { name: "no-description", body: "b" },
    }),
    400,
  );
  expectStatus(
    await call(registry, "POST", "/api/queen/queen_tech/skills", {
      body: { name: "no-body", description: "d", body: "   " },
    }),
    400,
  );
  expectStatus(
    await call(registry, "POST", "/api/queen/queen_tech/skills", {
      body: {
        name: "bad-file",
        description: "d",
        body: "b",
        files: [{ path: "../escape.sh", content: "x" }],
      },
    }),
    400,
  );

  seedColony("beta", "queen_tech");
  const ambiguous = await call(registry, "POST", "/api/queen/queen_tech/skills", {
    body: { name: "multi", description: "d", body: "b" },
  });
  expectStatus(ambiguous, 400);
  assert.match(ambiguous.body.error, /owns 2 colonies/);

  const targeted = await call(registry, "POST", "/api/queen/queen_tech/skills", {
    body: { name: "multi", description: "d", body: "b", colony: "beta" },
  });
  expectStatus(targeted, 201);
  assert.equal(targeted.body.owner.id, "beta");
  assert.ok(fs.existsSync(skillPath("beta", "multi")));

  const foreign = await call(registry, "POST", "/api/queen/queen_tech/skills", {
    body: { name: "foreign", description: "d", body: "b", colony: "gamma" },
  });
  expectStatus(foreign, 400);

  expectStatus(
    await call(registry, "POST", "/api/queen/queen_missing/skills", {
      body: { name: "x", description: "d", body: "b" },
    }),
    404,
  );

  // The registration ctx can pick the target for multi-colony queens.
  const bound = makeRegistry({ resolveColonyForQueen: () => "acme" });
  const viaCtx = await call(bound, "POST", "/api/queen/queen_tech/skills", {
    body: { name: "via-ctx", description: "d", body: "b" },
  });
  expectStatus(viaCtx, 201);
  assert.equal(viaCtx.body.owner.id, "acme");
});

test("PATCH persists enabled/notes/param state and validates each field", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  seedSkill("acme", "alpha");
  seedSkill("acme", "beta-skill");
  const registry = makeRegistry();

  const patched = await call(registry, "PATCH", "/api/queen/queen_tech/skills/alpha", {
    body: { enabled: false, notes: "off for now", param_overrides: { temperature: 0.2 } },
  });
  expectStatus(patched, 200);
  assert.deepEqual(patched.body, { name: "alpha", enabled: false, ok: true });

  const sidecar = path.join(colonyDir("acme"), ".skill-overrides.json");
  assert.ok(fs.existsSync(sidecar), "PATCH must persist a real sidecar");
  const stored = JSON.parse(readText(sidecar));
  assert.equal(stored.skills.alpha.enabled, false);
  assert.equal(stored.skills.alpha.notes, "off for now");
  assert.deepEqual(stored.skills.alpha.param_overrides, { temperature: 0.2 });

  const listed = await call(registry, "GET", "/api/queen/queen_tech/skills");
  const alpha = listed.body.skills.find((row) => row.name === "alpha");
  assert.equal(alpha.enabled, false);
  assert.equal(alpha.notes, "off for now");
  assert.deepEqual(alpha.param_overrides, { temperature: 0.2 });

  expectStatus(
    await call(registry, "PATCH", "/api/queen/queen_tech/skills/alpha", {
      body: { enabled: "yes" },
    }),
    400,
  );
  expectStatus(
    await call(registry, "PATCH", "/api/queen/queen_tech/skills/alpha", {
      body: { param_overrides: [] },
    }),
    400,
  );
  expectStatus(
    await call(registry, "PATCH", "/api/queen/queen_tech/skills/alpha", {
      body: { all_defaults_disabled: "yes" },
    }),
    400,
  );
  expectStatus(
    await call(registry, "PATCH", "/api/queen/queen_tech/skills/alpha", { body: {} }),
    400,
  );
  expectStatus(
    await call(registry, "PATCH", "/api/queen/queen_tech/skills/not-there", {
      body: { enabled: true },
    }),
    404,
  );

  const allDefaults = await call(registry, "PATCH", "/api/queen/queen_tech/skills/beta-skill", {
    body: { all_defaults_disabled: true },
  });
  expectStatus(allDefaults, 200);
  const afterDefaults = await call(registry, "GET", "/api/queen/queen_tech/skills");
  assert.equal(afterDefaults.body.all_defaults_disabled, true);

  const cleared = await call(registry, "PATCH", "/api/queen/queen_tech/skills/alpha", {
    body: { notes: null },
  });
  expectStatus(cleared, 200);
  assert.equal(cleared.body.enabled, false, "notes-only PATCH keeps the enabled state");
  const afterClear = await call(registry, "GET", "/api/queen/queen_tech/skills");
  assert.equal(afterClear.body.skills.find((row) => row.name === "alpha").notes, null);
});

test("GET/PUT body round-trips frontmatter-stripped text and extra files", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  seedSkill("acme", "alpha", { description: "old desc", body: "First body" });
  const registry = makeRegistry();

  const read = await call(registry, "GET", "/api/queen/queen_tech/skills/alpha/body");
  expectStatus(read, 200);
  assert.equal(read.body.name, "alpha");
  assert.equal(read.body.description, "old desc");
  assert.equal(read.body.source_scope, "colony_ui");
  assert.equal(read.body.body, "First body");
  assert.equal(read.body.editable, true);
  assert.equal(read.body.visibility, null);
  assert.equal(read.body.location, skillPath("acme", "alpha"));

  const put = await call(registry, "PUT", "/api/queen/queen_tech/skills/alpha/body", {
    body: { body: "Second body" },
  });
  expectStatus(put, 200);
  assert.deepEqual(put.body, { name: "alpha", installed_path: skillPath("acme", "alpha") });
  let text = readText(skillPath("acme", "alpha"));
  assert.match(text, /description: old desc/);
  assert.match(text, /Second body/);

  const reread = await call(registry, "GET", "/api/queen/queen_tech/skills/alpha/body");
  assert.equal(reread.body.body, "Second body");

  const described = await call(registry, "PUT", "/api/queen/queen_tech/skills/alpha/body", {
    body: {
      body: "Third body",
      description: "new desc",
      files: [{ path: "docs/notes.md", content: "notes\n" }],
    },
  });
  expectStatus(described, 200);
  text = readText(skillPath("acme", "alpha"));
  assert.match(text, /description: new desc/);
  assert.match(text, /Third body/);
  assert.equal(
    readText(path.join(colonyPaths("acme").skills, "alpha", "docs", "notes.md")),
    "notes\n",
  );

  expectStatus(
    await call(registry, "PUT", "/api/queen/queen_tech/skills/alpha/body", {
      body: { body: "   " },
    }),
    400,
  );
  expectStatus(
    await call(registry, "PUT", "/api/queen/queen_tech/skills/missing/body", {
      body: { body: "x" },
    }),
    404,
  );
  expectStatus(
    await call(registry, "PUT", "/api/queen/queen_missing/skills/alpha/body", {
      body: { body: "x" },
    }),
    404,
  );
  expectStatus(
    await call(registry, "PUT", "/api/queen/queen_tech/skills/Bad%20Name/body", {
      body: { body: "x" },
    }),
    400,
  );
});

test("POST rename moves the folder, frontmatter, and override entry", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  seedSkill("acme", "alpha", { body: "rename me" });
  const registry = makeRegistry();

  await call(registry, "PATCH", "/api/queen/queen_tech/skills/alpha", {
    body: { enabled: false },
  });

  const renamed = await call(registry, "POST", "/api/queen/queen_tech/skills/alpha/rename", {
    body: { new_name: "beta" },
  });
  expectStatus(renamed, 200);
  assert.deepEqual(renamed.body, { old_name: "alpha", new_name: "beta", ok: true });

  assert.equal(fs.existsSync(path.join(colonyPaths("acme").skills, "alpha")), false);
  assert.ok(fs.existsSync(skillPath("acme", "beta")));
  assert.match(readText(skillPath("acme", "beta")), /^name: beta$/m);
  assert.match(readText(skillPath("acme", "beta")), /rename me/);

  const listed = await call(registry, "GET", "/api/queen/queen_tech/skills");
  const beta = listed.body.skills.find((row) => row.name === "beta");
  assert.equal(beta.enabled, false, "override entry follows the rename");
  const sidecar = JSON.parse(readText(path.join(colonyDir("acme"), ".skill-overrides.json")));
  assert.equal(sidecar.skills.alpha, undefined);
  assert.equal(sidecar.skills.beta.enabled, false);

  expectStatus(
    await call(registry, "POST", "/api/queen/queen_tech/skills/missing/rename", {
      body: { new_name: "gamma" },
    }),
    404,
  );
  seedSkill("acme", "gamma");
  expectStatus(
    await call(registry, "POST", "/api/queen/queen_tech/skills/beta/rename", {
      body: { new_name: "gamma" },
    }),
    409,
  );
  expectStatus(
    await call(registry, "POST", "/api/queen/queen_tech/skills/beta/rename", {
      body: { new_name: "beta" },
    }),
    400,
  );
  expectStatus(
    await call(registry, "POST", "/api/queen/queen_tech/skills/beta/rename", {
      body: { new_name: "Bad Name" },
    }),
    400,
  );
  expectStatus(
    await call(registry, "POST", "/api/queen/queen_missing/skills/beta/rename", {
      body: { new_name: "other" },
    }),
    404,
  );
});

test("DELETE removes the real skill folder and its override entry", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  seedSkill("acme", "alpha");
  const registry = makeRegistry();

  await call(registry, "PATCH", "/api/queen/queen_tech/skills/alpha", {
    body: { enabled: false },
  });

  const removed = await call(registry, "DELETE", "/api/queen/queen_tech/skills/alpha");
  expectStatus(removed, 200);
  assert.deepEqual(removed.body, { name: "alpha", removed: true });
  assert.equal(fs.existsSync(path.join(colonyPaths("acme").skills, "alpha")), false);

  const sidecar = JSON.parse(readText(path.join(colonyDir("acme"), ".skill-overrides.json")));
  assert.equal(sidecar.skills.alpha, undefined);

  expectStatus(await call(registry, "DELETE", "/api/queen/queen_tech/skills/alpha"), 404);
  expectStatus(await call(registry, "DELETE", "/api/queen/queen_tech/skills/Bad%20Name"), 400);
  expectStatus(await call(registry, "DELETE", "/api/queen/queen_missing/skills/alpha"), 404);
});

test("POST reload is an honest no-op because pi_hive reads disk per GET", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  const registry = makeRegistry();

  const result = await call(registry, "POST", "/api/queen/queen_tech/skills/reload");
  expectStatus(result, 200);
  assert.deepEqual(result.body, { ok: true, target: "queen_tech", kind: "queen" });
  expectStatus(await call(registry, "POST", "/api/queen/queen_missing/skills/reload"), 404);
});

// ---------------------------------------------------------------------------
// Explicitly unsupported surfaces
// ---------------------------------------------------------------------------

test("upload stays a 400; prompts and agent mutations are real", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  const registry = makeRegistry();

  const upload = await call(registry, "POST", "/api/skills/upload", {
    body: "not actually multipart",
  });
  expectStatus(upload, 400);
  assert.equal(upload.body.type, "unsupported");
  assert.match(upload.body.error, /no user or queen skill library/);
  assert.equal(fs.existsSync(path.join(colonyPaths("acme").skills, "alpha")), false);

  const prompts = await call(registry, "GET", "/api/prompts");
  expectStatus(prompts, 200);
  assert.deepEqual(prompts.body, { prompts: [] });

  const createdPrompt = await call(registry, "POST", "/api/prompts", {
    body: { title: "T", category: "custom", content: "C", skills: ["Review", "review", " "], tags: ["Ops"] },
  });
  expectStatus(createdPrompt, 200);
  assert.match(createdPrompt.body.id, /^prm-[0-9a-f]{12}$/);
  assert.equal(createdPrompt.body.title, "T");
  assert.equal(createdPrompt.body.category, "custom");
  assert.equal(createdPrompt.body.content, "C");
  assert.deepEqual(createdPrompt.body.skills, ["review"], "skills are lowercased and deduped");
  assert.deepEqual(createdPrompt.body.tags, ["ops"]);
  assert.equal(createdPrompt.body.custom, true);

  expectStatus(
    await call(registry, "POST", "/api/prompts", { body: { title: "T" } }),
    400,
    "missing content",
  );
  const badPromptJson = await call(registry, "POST", "/api/prompts", { body: "{not json" });
  expectStatus(badPromptJson, 400);
  assert.match(badPromptJson.body.error, /invalid JSON/);

  const second = await call(registry, "POST", "/api/prompts", {
    body: { title: "Second", category: "", content: "D" },
  });
  expectStatus(second, 200);
  assert.equal(second.body.category, "General", "a blank category falls back to General");

  const listed = await call(registry, "GET", "/api/prompts");
  expectStatus(listed, 200);
  assert.deepEqual(listed.body.prompts.map((entry) => entry.title), ["Second", "T"], "newest first");

  // The store is on disk, so a second registry sees the same prompts.
  const reread = await call(makeRegistry(), "GET", "/api/prompts");
  assert.equal(reread.body.prompts.length, 2);

  const deletedPrompt = await call(registry, "DELETE", `/api/prompts/${createdPrompt.body.id}`);
  expectStatus(deletedPrompt, 200);
  assert.deepEqual(deletedPrompt.body, { deleted: createdPrompt.body.id });

  const gone = await call(registry, "DELETE", `/api/prompts/${createdPrompt.body.id}`);
  expectStatus(gone, 404);

  const afterDelete = await call(registry, "GET", "/api/prompts");
  assert.deepEqual(afterDelete.body.prompts.map((entry) => entry.title), ["Second"]);

  // Agents are colony directories: soft delete, an icon patch, then purge.
  const agentPath = colonyPaths("acme").dir;
  const deletedAgent = await call(registry, "DELETE", "/api/agents", {
    body: { agent_path: "/tmp/not-a-colony", purge: false },
  });
  expectStatus(deletedAgent, 404);

  expectStatus(
    await call(registry, "PATCH", "/api/agents/metadata", { body: { agent_path: agentPath, icon: "rocket" } }),
    200,
  );
  assert.equal(loadMetadata("acme").icon, "rocket");

  const soft = await call(registry, "DELETE", "/api/agents", { body: { agent_path: agentPath } });
  expectStatus(soft, 200);
  assert.deepEqual(soft.body, { deleted: "acme", purged: false });
  assert.equal(loadMetadata("acme").deleted, true);
  assert.equal(fs.existsSync(agentPath), true, "a soft delete keeps the data");

  const purge = await call(registry, "DELETE", "/api/agents", {
    body: { agent_path: agentPath, purge: true },
  });
  expectStatus(purge, 200);
  assert.deepEqual(purge.body, { deleted: "acme", purged: true });
  assert.equal(fs.existsSync(agentPath), false, "a purge removes the colony directory");

  expectStatus(
    await call(registry, "PATCH", "/api/agents/metadata", { body: { agent_path: agentPath, icon: "x" } }),
    404,
  );
  expectStatus(
    await call(registry, "PATCH", "/api/agents/metadata", { body: { agent_path: "/tmp/not-a-colony" } }),
    404,
  );

  const missingPath = await call(registry, "DELETE", "/api/agents", { body: {} });
  expectStatus(missingPath, 400);
  assert.match(missingPath.body.error, /agent_path is required/);
  expectStatus(await call(registry, "DELETE", "/api/agents", { body: "{bad" }), 400);

  expectStatus(await call(registry, "PATCH", "/api/agents/metadata", { body: {} }), 400);
  expectStatus(await call(registry, "PATCH", "/api/agents/metadata", { body: "{bad" }), 400);

  // Only icon is writable here; anything else is refused rather than half-applied.
  createColony({ name: "beta", goal: "second" });
  const betaPath = colonyPaths("beta").dir;
  const unsupportedField = await call(registry, "PATCH", "/api/agents/metadata", {
    body: { agent_path: betaPath, goal: "rewritten" },
  });
  expectStatus(unsupportedField, 400);
  assert.match(unsupportedField.body.error, /unsupported metadata field 'goal'/);
});

test("skill-install routes are empty/400 because pi_hive has no queue", async () => {
  useHome();
  const registry = makeRegistry();

  const list = await call(registry, "GET", "/api/sessions/session-1/skill-installs");
  expectStatus(list, 200);
  assert.deepEqual(list.body, { requests: [] });
  expectStatus(
    await call(registry, "GET", "/api/sessions/bad%20id/skill-installs"),
    400,
    "invalid session id",
  );

  const decided = await call(
    registry,
    "POST",
    "/api/sessions/session-1/skill-installs/req-1",
    { body: { decision: "approve" } },
  );
  expectStatus(decided, 400);
  assert.equal(decided.body.type, "unsupported");
  assert.match(decided.body.error, /no shared skill library/);

  expectStatus(
    await call(registry, "POST", "/api/sessions/session-1/skill-installs/req-1", {
      body: { decision: "maybe" },
    }),
    400,
    "invalid decision",
  );
  expectStatus(
    await call(registry, "POST", "/api/sessions/session-1/skill-installs/req-1", {
      body: "{bad",
    }),
    400,
    "invalid JSON",
  );
  expectStatus(
    await call(registry, "POST", "/api/sessions/session-1/skill-installs/bad%20id", {
      body: { decision: "deny" },
    }),
    400,
    "invalid request id",
  );
  expectStatus(
    await call(registry, "POST", "/api/sessions/bad%20id/skill-installs/req-1", {
      body: { decision: "deny" },
    }),
    400,
    "invalid session id",
  );
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

function seedMemories() {
  const home = hiveHome();
  const globalRoot = path.join(home, "memory", "global");
  const queenRoot = path.join(home, "memory", "queens", "queen_tech");
  fs.mkdirSync(globalRoot, { recursive: true });
  fs.mkdirSync(queenRoot, { recursive: true });
  fs.writeFileSync(
    path.join(globalRoot, "profile.md"),
    "---\nname: Profile\ntype: user\ndescription: About me\n---\n\nHello\n",
  );
  fs.writeFileSync(
    path.join(queenRoot, "lesson.md"),
    "---\nname: Lesson\ntype: feedback\n---\n\nLearn\n",
  );
  seedColony("acme", "queen_tech");
  fs.writeFileSync(
    path.join(colonyDir("acme"), "memory", "project.md"),
    "---\nname: Project\ntype: project\ndescription: Ship\n---\n\nWork\n",
  );
  fs.writeFileSync(path.join(globalRoot, "notes.txt"), "ignore");
  fs.writeFileSync(path.join(globalRoot, ".hidden.md"), "ignore");
}

test("GET /api/memories lists real global, queen, and colony files", async () => {
  useHome();
  const registry = makeRegistry();

  const empty = await call(registry, "GET", "/api/memories");
  expectStatus(empty, 200);
  assert.deepEqual(empty.body, { memories: [] });

  seedMemories();
  const result = await call(registry, "GET", "/api/memories");
  expectStatus(result, 200);
  assert.deepEqual(
    result.body.memories.map((memory) => memory.path).sort(),
    ["agents/queens/queen_tech/lesson.md", "colonies/acme/project.md", "global/profile.md"],
  );

  const byPath = new Map(result.body.memories.map((memory) => [memory.path, memory]));
  const global = byPath.get("global/profile.md");
  assert.equal(global.filename, "profile.md");
  assert.equal(global.name, "Profile");
  assert.equal(global.type, "user");
  assert.equal(global.description, "About me");
  assert.equal(global.scope, "global");
  assert.equal(global.scope_name, "");
  assert.equal(typeof global.mtime, "number");
  assert.ok(global.mtime > 0);
  assert.equal("content" in global, false, "list responses stay metadata-only");

  const queen = byPath.get("agents/queens/queen_tech/lesson.md");
  assert.equal(queen.scope, "queen");
  assert.equal(queen.scope_name, "queen_tech");
  assert.equal(queen.name, "Lesson");
  assert.equal(queen.type, "feedback");
  assert.equal(queen.description, null);

  const colony = byPath.get("colonies/acme/project.md");
  assert.equal(colony.scope, "colony");
  assert.equal(colony.scope_name, "acme");
  assert.equal(colony.name, "Project");
  assert.equal(colony.description, "Ship");
});

test("GET/PUT/DELETE /api/memories/file round-trip real files and refuse traversal", async () => {
  useHome();
  seedMemories();
  const registry = makeRegistry();

  for (const [rel, expected] of [
    ["global/profile.md", /Hello/],
    ["agents/queens/queen_tech/lesson.md", /Learn/],
    ["colonies/acme/project.md", /Work/],
  ]) {
    const read = await call(registry, "GET", memoryUrl(rel));
    expectStatus(read, 200, rel);
    assert.equal(read.body.path, rel);
    assert.match(read.body.content, expected);
    assert.equal(typeof read.body.mtime, "number");
  }

  expectStatus(await call(registry, "GET", "/api/memories/file"), 400);
  expectStatus(await call(registry, "GET", memoryUrl("../etc/passwd.md")), 400);
  expectStatus(await call(registry, "GET", memoryUrl("/etc/passwd.md")), 400);
  expectStatus(await call(registry, "GET", memoryUrl("global/notes.txt")), 400);
  expectStatus(await call(registry, "GET", memoryUrl("unknown/foo.md")), 400);
  expectStatus(await call(registry, "GET", memoryUrl("global/missing.md")), 404);

  const updated = await call(registry, "PUT", memoryUrl("global/profile.md"), {
    body: { content: "# Updated" },
  });
  expectStatus(updated, 200);
  assert.equal(updated.body.content, "# Updated\n");
  assert.equal(readText(path.join(hiveHome(), "memory", "global", "profile.md")), "# Updated\n");

  const normalized = await call(registry, "PUT", memoryUrl("global/profile.md"), {
    body: { content: "no trailing newline" },
  });
  expectStatus(normalized, 200);
  assert.equal(normalized.body.content, "no trailing newline\n");

  expectStatus(
    await call(registry, "PUT", memoryUrl("global/profile.md"), { body: { content: "  " } }),
    400,
  );
  expectStatus(
    await call(registry, "PUT", memoryUrl("global/profile.md"), {
      body: { content: "x".repeat(4097) },
    }),
    400,
  );
  expectStatus(
    await call(registry, "PUT", memoryUrl("global/missing.md"), { body: { content: "x" } }),
    404,
  );
  expectStatus(
    await call(registry, "PUT", memoryUrl("../escape.md"), { body: { content: "x" } }),
    400,
  );
  expectStatus(
    await call(registry, "PUT", "/api/memories/file", { body: { content: "x" } }),
    400,
  );

  const deleted = await call(registry, "DELETE", memoryUrl("global/profile.md"));
  expectStatus(deleted, 200);
  assert.deepEqual(deleted.body, { deleted: "global/profile.md" });
  assert.equal(fs.existsSync(path.join(hiveHome(), "memory", "global", "profile.md")), false);
  expectStatus(await call(registry, "DELETE", memoryUrl("global/profile.md")), 404);
  expectStatus(await call(registry, "DELETE", memoryUrl("../escape.md")), 400);
  expectStatus(await call(registry, "DELETE", "/api/memories/file"), 400);
});

// ---------------------------------------------------------------------------
// Body transport
// ---------------------------------------------------------------------------

test("a real async-iterable request body is parsed, not just injected", async () => {
  useHome();
  seedColony("acme", "queen_tech");
  const registry = makeRegistry();

  const match = registry.match("POST", "/api/queen/queen_tech/skills");
  assert.ok(match);
  const req = {
    method: "POST",
    url: "/api/queen/queen_tech/skills",
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(
        JSON.stringify({
          name: "streamed",
          description: "from a stream",
          body: "stream body",
        }),
      );
    },
  };
  const { res, state } = fakeResponse();
  const result = await match.route.handler({ req, res, params: match.params });
  assert.equal(state.wrote, false);
  expectStatus(result, 201);
  assert.equal(result.body.name, "streamed");
  assert.ok(fs.existsSync(skillPath("acme", "streamed")));

  const badMatch = registry.match("POST", "/api/queen/queen_tech/skills");
  const badReq = {
    method: "POST",
    url: "/api/queen/queen_tech/skills",
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("{bad");
    },
  };
  const badResponse = fakeResponse();
  const badResult = await badMatch.route.handler({
    req: badReq,
    res: badResponse.res,
    params: badMatch.params,
  });
  assert.equal(badResponse.state.wrote, false);
  expectStatus(badResult, 400);
  assert.match(badResult.body.error, /invalid JSON/);
});
