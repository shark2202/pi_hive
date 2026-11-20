/**
 * Official frontend compatibility handlers for the organization surface:
 * queens, colonies, sessions, and discovery.
 *
 * Handlers return `{status, body}` descriptors and never write to `res`; the
 * server (or a test harness) serializes the body. Routes are registered with
 * `official: true` because their payloads follow the official frontend's
 * TypeScript contracts in `core/frontend/src/api`.
 *
 * `ctx` is the integration seam. pi_hive has no session manager, so
 * `/api/sessions` and `/api/sessions/history` are honestly empty unless the
 * caller supplies a provider:
 *   ctx.listLiveSessions(ctx)     -> array | {sessions: array}
 *   ctx.listHistorySessions(ctx)  -> array | {sessions: array}
 *   ctx.liveSessions / ctx.historySessions arrays also work.
 * Discover marks a colony loaded from ctx.loadedColonies,
 * ctx.runtimes / ctx.server.runtimes (Map, Set, array, or object keys), or
 * ctx.isColonyLoaded(name).
 */
import fs from "node:fs";
import path from "node:path";

import { colonyDir, coloniesDir } from "../../config.js";
import { loadMetadata } from "../../domain/colony.js";
import { ROUTE_STATUS } from "../router.js";

/** Category name the official discovery UI groups local colonies under. */
export const DISCOVER_CATEGORY = "Your Agents";

/**
 * pi_hive's four built-in queen identities. Their ids are the values stored
 * in colony metadata (`queen_id`), so the official UI and pi_hive agree on
 * identity. Display names are role-derived; pi_hive does not ship human
 * personas for them.
 */
export const BUILT_IN_QUEENS = Object.freeze(
  [
    { id: "queen_growth", name: "Growth Queen", title: "Head of Growth" },
    { id: "queen_tech", name: "Technology Queen", title: "Head of Technology" },
    { id: "queen_finance", name: "Finance Queen", title: "Head of Finance" },
    { id: "queen_ops", name: "Operations Queen", title: "Head of Operations" },
    { id: "queen_product", name: "Product Queen", title: "Head of Product" },
    { id: "queen_marketing", name: "Marketing Queen", title: "Head of Marketing" },
    { id: "queen_sales", name: "Sales Queen", title: "Head of Sales" },
    { id: "queen_legal", name: "Legal Queen", title: "Head of Legal" },
    { id: "queen_people", name: "People Queen", title: "Head of People" },
    { id: "queen_support", name: "Support Queen", title: "Head of Support" },
    { id: "queen_data", name: "Data Queen", title: "Head of Data" },
    { id: "queen_design", name: "Design Queen", title: "Head of Design" },
    { id: "queen_research", name: "Research Queen", title: "Head of Research" },
  ].map((queen) => Object.freeze({ ...queen, has_avatar: false, custom: false })),
);

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Colony directory names, sorted; invalid names are filtered later. */
function listColonyNames() {
  const root = coloniesDir();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** metadata.json or null when missing/malformed; never throws for a bad colony. */
function readMetadata(name) {
  try {
    const meta = loadMetadata(name);
    return isPlainObject(meta) ? meta : null;
  } catch {
    return null;
  }
}

/**
 * The colony's MCP allowlist, mirroring the official runtime:
 * `tools.json.enabled_mcp_tools` is authoritative; a legacy
 * `metadata.json.enabled_mcp_tools` is read only when the sidecar is absent.
 * `null` means "no allowlist / allow everything"; `[]` is an explicit empty
 * allowlist and therefore counts as present.
 */
export function readColonyAllowlist(name, meta = null) {
  let dir;
  try {
    dir = colonyDir(name);
  } catch {
    return null;
  }

  const sidecar = path.join(dir, "tools.json");
  if (fs.existsSync(sidecar)) {
    try {
      const data = JSON.parse(fs.readFileSync(sidecar, "utf8"));
      const raw = isPlainObject(data) ? data.enabled_mcp_tools : null;
      return isStringArray(raw) ? raw : null;
    } catch {
      // Malformed sidecar is treated as default-allow, like the official host.
      return null;
    }
  }

  const legacy = isPlainObject(meta) ? meta.enabled_mcp_tools : null;
  return isStringArray(legacy) ? legacy : null;
}

/** Official ColonySummary list, built from real colony metadata on disk. */
export function listColonySummaries() {
  const summaries = [];
  for (const name of listColonyNames()) {
    const meta = readMetadata(name);
    if (!meta) continue;

    const allowlist = readColonyAllowlist(name, meta);
    const queenName =
      (typeof meta.queen_name === "string" && meta.queen_name) ||
      (typeof meta.queen_id === "string" && meta.queen_id) ||
      null;

    summaries.push({
      name,
      queen_name: queenName,
      created_at: typeof meta.created_at === "string" && meta.created_at ? meta.created_at : null,
      has_allowlist: allowlist !== null,
      enabled_count: allowlist === null ? null : allowlist.length,
    });
  }
  return summaries;
}

/** "my_colony" -> "My Colony"; discovery only needs a display label. */
function humanize(name) {
  return name
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function countSessionFiles(dir) {
  try {
    return fs
      .readdirSync(path.join(dir, "sessions"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function countPlanTasks(dir) {
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
    return Array.isArray(plan.tasks) ? plan.tasks.length : 0;
  } catch {
    return 0;
  }
}

function addLoadedNames(target, source) {
  if (!source) return;
  if (source instanceof Map) {
    for (const key of source.keys()) if (typeof key === "string") target.add(key);
    return;
  }
  if (source instanceof Set) {
    for (const value of source) if (typeof value === "string") target.add(value);
    return;
  }
  if (Array.isArray(source)) {
    for (const entry of source) {
      const name = typeof entry === "string" ? entry : entry?.colony ?? entry?.colony_id ?? entry?.name;
      if (typeof name === "string") target.add(name);
    }
    return;
  }
  if (typeof source === "object") {
    for (const key of Object.keys(source)) target.add(key);
  }
}

function loadedColonyNames(ctx) {
  const names = new Set();
  addLoadedNames(names, ctx?.loadedColonies);
  addLoadedNames(names, ctx?.runtimes);
  addLoadedNames(names, ctx?.server?.runtimes);
  return names;
}

/**
 * Official DiscoverResult envelope: `{ [category]: DiscoverEntry[] }`.
 * Empty object when the user has no colonies, matching the official host.
 * `run_count` and `tool_count` stay 0 because pi_hive has no worker run/tool
 * registry; they are structural fields, not invented data.
 */
export function buildDiscoverResult(ctx = {}) {
  const loaded = loadedColonyNames(ctx);
  const isLoaded = (name) =>
    typeof ctx?.isColonyLoaded === "function" ? Boolean(ctx.isColonyLoaded(name)) : loaded.has(name);

  const entries = [];
  for (const name of listColonyNames()) {
    const meta = readMetadata(name);
    if (!meta || meta.deleted === true) continue;

    let dir;
    try {
      dir = colonyDir(name);
    } catch {
      continue;
    }

    entries.push({
      path: path.resolve(dir),
      name: humanize(name),
      description:
        (typeof meta.description === "string" && meta.description) ||
        (typeof meta.goal === "string" && meta.goal) ||
        "",
      category: DISCOVER_CATEGORY,
      created_at: typeof meta.created_at === "string" && meta.created_at ? meta.created_at : null,
      session_count: countSessionFiles(dir),
      run_count: 0,
      node_count: countPlanTasks(dir),
      tool_count: 0,
      tags: isStringArray(meta.tags) ? meta.tags : [],
      last_active: typeof meta.updated_at === "string" && meta.updated_at ? meta.updated_at : null,
      is_loaded: isLoaded(name),
      icon: typeof meta.icon === "string" && meta.icon ? meta.icon : null,
      workers: [],
    });
  }

  return entries.length ? { [DISCOVER_CATEGORY]: entries } : {};
}

function sessionRows(value, label) {
  const rows = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.sessions)
      ? value.sessions
      : null;
  if (!rows) throw new TypeError(`${label} must return an array or {sessions: [...]}`);
  // No fabricated rows: a provider row without a real session_id is dropped.
  return rows.filter(
    (row) => isPlainObject(row) && typeof row.session_id === "string" && row.session_id.length > 0,
  );
}

async function collectSessions(ctx, kind) {
  const functionKeys =
    kind === "history" ? ["listHistorySessions"] : ["listLiveSessions", "listSessions"];
  for (const key of functionKeys) {
    const fn = ctx?.[key];
    if (typeof fn === "function") return sessionRows(await fn(ctx), key);
  }

  const arrayKeys = kind === "history" ? ["historySessions"] : ["liveSessions"];
  for (const key of arrayKeys) {
    if (Array.isArray(ctx?.[key])) return sessionRows(ctx[key], key);
  }
  return [];
}

/**
 * Register the organization/session compatibility routes.
 *
 * `GET /api/colonies` is registered PARTIAL on purpose: pi_hive's native
 * server already answers that path with raw colony metadata for the `/ui/`
 * dashboard, and the compat dispatcher only takes over MISSING routes. The
 * handler below returns the official ColonySummary envelope if a caller or a
 * future dispatcher hands the route over.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] integration context (session/loaded-colony providers)
 */
export function registerOrganizationRoutes(registry, ctx = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registerOrganizationRoutes requires a RouteRegistry");
  }
  const meta = { official: true };

  registry.register(
    "GET",
    "/api/queen/profiles",
    async () => ({ status: 200, body: { queens: BUILT_IN_QUEENS } }),
    {
      ...meta,
      status: ROUTE_STATUS.IMPLEMENTED,
      description: "official queen catalog for pi_hive's four built-in queens",
    },
  );

  registry.register(
    "GET",
    "/api/colonies/tools-index",
    async () => ({ status: 200, body: { colonies: listColonySummaries() } }),
    {
      ...meta,
      status: ROUTE_STATUS.IMPLEMENTED,
      description: "official ColonySummary list from real colony metadata and tools.json",
    },
  );

  registry.register(
    "GET",
    "/api/colonies",
    async () => ({ status: 200, body: { colonies: listColonySummaries() } }),
    {
      ...meta,
      status: ROUTE_STATUS.PARTIAL,
      native: true,
      description:
        "official ColonySummary list; the native raw-metadata /api/colonies answers first, so the live route stays partial",
    },
  );

  const sessionsHandler = async ({ ctx: callCtx } = {}) => ({
    status: 200,
    body: { sessions: await collectSessions(callCtx ?? ctx, "live") },
  });

  registry.register("GET", "/api/sessions", sessionsHandler, {
    ...meta,
    status: ROUTE_STATUS.IMPLEMENTED,
    description: "live sessions; empty without a session provider",
  });

  const historyHandler = async ({ ctx: callCtx } = {}) => ({
    status: 200,
    body: { sessions: await collectSessions(callCtx ?? ctx, "history") },
  });

  registry.register("GET", "/api/sessions/history", historyHandler, {
    ...meta,
    status: ROUTE_STATUS.IMPLEMENTED,
    description: "queen session history; empty without a history provider",
  });

  const discoverHandler = async ({ ctx: callCtx } = {}) => ({
    status: 200,
    body: buildDiscoverResult(callCtx ?? ctx),
  });

  registry.register("GET", "/api/discover", discoverHandler, {
    ...meta,
    status: ROUTE_STATUS.IMPLEMENTED,
    description: "official DiscoverResult envelope from real colonies",
  });

  return registry;
}

export default registerOrganizationRoutes;
