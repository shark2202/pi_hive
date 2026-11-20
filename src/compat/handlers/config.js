/**
 * Boot-critical config / catalogue handlers for the official Hive frontend.
 *
 * The official frontend (core/frontend) boots against a large `/api` surface.
 * These ten GET routes are what its model/catalogue/skill/settings layer reads
 * on first paint; before this module they answered the compat shell's
 * structured 501.
 *
 * Every handler returns a descriptor `{ status, body }` instead of writing to a
 * socket, so the registry stays usable in unit tests. Bodies mirror the
 * official TypeScript envelopes in core/frontend/src/api/{config,models,
 * credentials,skills,prompts,agents}.ts, but only ever carry real pi_hive
 * data:
 *
 *   - the single env-configured model in src/config.js (`modelConfig()`),
 *   - colony metadata and colony-scope skills on disk (`~/.pi-hive` or
 *     `PI_HIVE_HOME`),
 *   - empty collections where pi_hive genuinely has no store (prompt library,
 *     credential store, model endpoints, subscriptions, per-queen model slots).
 *
 * Nothing here calls a model or opens a network port.
 */
import { hasAvatar, readFeatures, readProfile } from "../../domain/config-store.js";
import { listPrompts as listStoredPrompts } from "../../domain/prompt-store.js";

import fs from "node:fs";
import path from "node:path";

import { ROUTE_STATUS } from "../router.js";
import { coloniesDir, colonyDir, modelConfig } from "../../config.js";
import { colonyPaths, loadMetadata } from "../../domain/colony.js";
import { getPlan } from "../../domain/plan.js";
import { listSkills } from "../../domain/skills.js";

/** pi_hive's provider id in src/kernel/model.js (createProvider({ id: "pihive" })). */
const MODEL_PROVIDER_ID = "pihive";

/**
 * The model limits src/kernel/model.js binds for the single pi_hive model
 * (`maxTokens: 8192`, `contextWindow: 128000`). Kept here because that module
 * does not export its model definition; update both if it changes.
 */
const MODEL_MAX_TOKENS = 8192;
const MODEL_MAX_CONTEXT_TOKENS = 128000;

/** Official scope label for a skill discovered in a colony's skills/ dir. */
const COLONY_SKILL_SCOPE = "colony_ui";

/** Official discovery category for user-created agents (framework/agents/discovery.py). */
const AGENT_CATEGORY = "Your Agents";

const IMPLEMENTED = Object.freeze({ status: ROUTE_STATUS.IMPLEMENTED, official: true });

/** The env var the current key actually came from, mirroring src/config.js. */
function apiKeyEnvVar() {
  if (process.env.PI_HIVE_API_KEY) return "PI_HIVE_API_KEY";
  if (process.env.BROADTOKEN_API_KEY) return "BROADTOKEN_API_KEY";
  return "PI_HIVE_API_KEY";
}

/** The one model pi_hive is configured with, read fresh per request. */
function currentModel() {
  const cfg = modelConfig();
  return {
    provider: MODEL_PROVIDER_ID,
    model: cfg.modelId,
    apiBase: cfg.baseUrl,
    hasApiKey: Boolean(cfg.apiKey),
    apiKeyEnvVar: apiKeyEnvVar(),
  };
}

// ---------------------------------------------------------------------------
// Builders (pure: each reads pi_hive state at call time)
// ---------------------------------------------------------------------------

/** Official `LLMConfig` (core/frontend/src/api/config.ts). */
export function buildLLMConfig() {
  const model = currentModel();
  return {
    provider: model.provider,
    model: model.model,
    has_api_key: model.hasApiKey,
    max_tokens: MODEL_MAX_TOKENS,
    max_context_tokens: MODEL_MAX_CONTEXT_TOKENS,
    connected_providers: model.hasApiKey ? [model.provider] : [],
    // pi_hive has no subscription presets and no per-provider key store.
    active_subscription: null,
    detected_subscriptions: [],
    subscriptions: [],
    // The OpenAI-compatible endpoint src/config.js actually points at.
    api_base: model.apiBase,
    api_key_env_var: model.apiKeyEnvVar,
  };
}

/** Official `ModelsCatalogue` ({ models: Record<provider, ModelOption[]> }). */
export function buildModelsCatalogue() {
  const model = currentModel();
  return {
    models: {
      [model.provider]: [
        {
          id: model.model,
          label: model.model,
          recommended: true,
          max_tokens: MODEL_MAX_TOKENS,
          max_context_tokens: MODEL_MAX_CONTEXT_TOKENS,
        },
      ],
    },
  };
}

/** Official `SlotSummary` for the main slot; never carries the key. */
function slotSummary(model) {
  return {
    source: "catalog",
    provider: model.provider,
    model: model.model,
    endpoint: null,
    subscription: null,
    api_base: model.apiBase,
    max_context_tokens: MODEL_MAX_CONTEXT_TOKENS,
    has_extra_body: false,
  };
}

/** Official `ModelsOverview` (core/frontend/src/api/models.ts). */
export function buildModelsOverview() {
  const model = currentModel();
  return {
    slots: {
      llm: slotSummary(model),
      // pi_hive runs one model; there is no worker/vision slot or judge.
      worker_llm: null,
      vision_fallback: null,
    },
    judge: { configured: false, model: null, api_base: null },
    // No per-queen model configuration exists in pi_hive.
    queens: [],
    providers: [
      {
        id: model.provider,
        connected: model.hasApiKey,
        models: [
          {
            id: model.model,
            label: model.model,
            recommended: true,
            max_context_tokens: MODEL_MAX_CONTEXT_TOKENS,
            // src/kernel/model.js declares input: ["text"].
            supports_vision: false,
          },
        ],
      },
    ],
    // No named endpoint registry (the api_base above is the configured endpoint).
    endpoints: [],
    subscriptions: [],
  };
}

/**
 * Official profile object. pi_hive has no profile config file, so these are
 * the documented "not set" values the Python runtime returns for a fresh
 * install; `has_avatar` is false because pi_hive has no avatar store.
 */
export function buildProfile() {
  const stored = readProfile();
  return {
    displayName: stored.displayName ?? "",
    about: stored.about ?? "",
    theme: stored.theme ?? "",
    has_avatar: hasAvatar(),
    prompt_library_sort: stored.prompt_library_sort ?? null,
  };
}

/**
 * Official `{ features }`. pi_hive implements none of these Hive-only switches
 * (no adaptive tool budget, email sender pool, or judge-driven stall check).
 */
export function buildFeatures() {
  const stored = readFeatures();
  return {
    features: {
      adaptive_tool_budget: stored.adaptive_tool_budget ?? false,
      email_senders: stored.email_senders ?? false,
      stall_check: stored.stall_check ?? false,
    },
  };
}

/** Official `{ credentials }`. pi_hive reads keys from the environment only. */
export function buildCredentials() {
  return {
    credentials: [],
    unreadable_credentials: [],
  };
}

/** Official `{ specs, has_aden_key, accounts_by_provider }`. */
export function buildCredentialSpecs() {
  return {
    specs: [],
    has_aden_key: Boolean(process.env.ADEN_API_KEY),
    accounts_by_provider: {},
  };
}

/**
 * Colonies on disk whose name passes pi_hive's own colony validator.
 * `listColonies()` throws on a stray directory name, which must not take a
 * boot route down, so enumeration is guarded per directory.
 */
function listColonyMetadata() {
  let entries;
  try {
    entries = fs.readdirSync(coloniesDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      colonyDir(entry.name); // throws for names pi_hive would refuse
    } catch {
      continue;
    }
    try {
      const metadata = loadMetadata(entry.name);
      if (metadata && typeof metadata === "object") out.push({ name: entry.name, metadata });
    } catch {
      // Unreadable metadata is skipped, not fatal.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function countJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function countPlanTasks(colonyName) {
  try {
    const tasks = getPlan(colonyName).tasks;
    return Array.isArray(tasks) ? tasks.length : 0;
  } catch {
    return 0;
  }
}

/** Real worker run records (runtime/worker.js writes one JSON per run). */
function readWorkers(colonyName, metadata) {
  const dir = colonyPaths(colonyName).workers;
  let files;
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const workers = [];
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const record = JSON.parse(fs.readFileSync(full, "utf8"));
      const stat = fs.statSync(full);
      workers.push({
        // pi_hive stores runs, not worker configs: no config path or tool count.
        name: String(record?.profile?.name || file.replace(/\.json$/, "")),
        config_path: "",
        description: String(record?.report?.summary || "").slice(0, 500),
        tool_count: 0,
        task: String(record?.task || ""),
        spawned_at: record?.report?.at || stat.mtime.toISOString(),
        queen_name: String(record?.queen_id || metadata.queen_id || ""),
        colony_id: colonyName,
      });
    } catch {
      // A half-written record is skipped.
    }
  }
  return workers;
}

/**
 * Official `AggregatedSkillsResponse`. pi_hive only has colony-scope skills
 * (skills/<name>/SKILL.md), which are real rows here; the shared user library
 * and queen profiles do not exist, so `queens` is derived from the queen ids
 * colonies actually reference.
 */
export function buildSkills() {
  const colonies = listColonyMetadata();
  const queens = new Map();
  const rows = [];

  for (const { name: colonyName, metadata } of colonies) {
    const queenId =
      typeof metadata.queen_id === "string" && metadata.queen_id ? metadata.queen_id : null;
    if (queenId && !queens.has(queenId)) {
      queens.set(queenId, { id: queenId, name: String(metadata.queen_name || queenId) });
    }

    let skills = [];
    try {
      skills = listSkills(colonyName);
    } catch {
      skills = [];
    }
    for (const skill of skills) {
      rows.push({
        name: skill.name,
        description: skill.description || "",
        source_scope: COLONY_SKILL_SCOPE,
        // pi_hive records no author for a SKILL.md dropped into a colony.
        provenance: "other",
        enabled: true,
        // No HTTP edit/delete path for colony skills in this module.
        editable: false,
        deletable: false,
        location: skill.path,
        base_dir: path.dirname(skill.path),
        visibility: null,
        trust: null,
        created_at: null,
        created_by: null,
        notes: null,
        owner: { type: "colony", id: colonyName, name: colonyName },
        visible_to: {
          queens: queenId ? [queenId] : [],
          colonies: [colonyName],
        },
        enabled_by_default: true,
      });
    }
  }

  rows.sort(
    (a, b) => a.name.localeCompare(b.name) || a.owner.id.localeCompare(b.owner.id),
  );

  return {
    skills: rows,
    queens: [...queens.values()].sort((a, b) => a.id.localeCompare(b.id)),
    colonies: colonies.map(({ name, metadata }) => ({
      name,
      queen_id: typeof metadata.queen_id === "string" ? metadata.queen_id : null,
    })),
  };
}

/** Official `{ prompts }` from the custom prompt store, newest first. */
export function buildPrompts() {
  return { prompts: listStoredPrompts() };
}

/** Colony ids whose runtime is live, when the caller can tell us. */
function loadedColonyIds(ctx) {
  const sources = [ctx?.runtimes, ctx?.server?.runtimes, ctx?.colonies];
  for (const source of sources) {
    if (source instanceof Set) return new Set([...source]);
    if (source && typeof source.keys === "function") return new Set([...source.keys()]);
  }
  return new Set();
}

function discoverEntry(colonyName, metadata, loaded) {
  const paths = colonyPaths(colonyName);
  return {
    path: paths.dir,
    name: String(metadata.name || metadata.id || colonyName),
    description: String(metadata.goal || metadata.description || ""),
    category: AGENT_CATEGORY,
    created_at: typeof metadata.created_at === "string" ? metadata.created_at : null,
    session_count: countJsonFiles(paths.sessions),
    // The tracker schema is agent-defined; pi_hive keeps no run counter.
    run_count: 0,
    node_count: countPlanTasks(colonyName),
    // Worker configs do not exist; runs are reported under workers[].
    tool_count: 0,
    tags: Array.isArray(metadata.tags)
      ? metadata.tags.filter((tag) => typeof tag === "string")
      : [],
    last_active: typeof metadata.updated_at === "string" ? metadata.updated_at : null,
    is_loaded: loaded.has(colonyName),
    icon: typeof metadata.icon === "string" ? metadata.icon : null,
    workers: readWorkers(colonyName, metadata),
  };
}

/**
 * Official `DiscoverResult` (Record<category, DiscoverEntry[]>). Empty when
 * there are no colonies, matching the Python runtime's "no empty categories".
 */
export function buildDiscover(ctx = {}) {
  const loaded = loadedColonyIds(ctx);
  const entries = listColonyMetadata().map(({ name, metadata }) =>
    discoverEntry(name, metadata, loaded),
  );
  return entries.length ? { [AGENT_CATEGORY]: entries } : {};
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function descriptor(build) {
  return async () => ({ status: 200, body: build() });
}

const getLlmConfig = descriptor(buildLLMConfig);
const getModelsCatalogue = descriptor(buildModelsCatalogue);
const getModelsOverview = descriptor(buildModelsOverview);
const getProfile = descriptor(buildProfile);
const getFeatures = descriptor(buildFeatures);
const getCredentials = descriptor(buildCredentials);
const getCredentialSpecs = descriptor(buildCredentialSpecs);
const getSkills = descriptor(buildSkills);
const getPrompts = descriptor(buildPrompts);

/** Discover accepts runtime state through the per-call ctx when one is passed. */
async function getDiscover({ ctx } = {}) {
  return { status: 200, body: buildDiscover(ctx || {}) };
}

/**
 * Register this lane's official routes on `registry`.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] optional integration context (e.g. `{ runtimes }`);
 *                       per-call ctx from the server takes precedence.
 * @returns {object} the registry, for chaining
 */
export function registerConfigRoutes(registry, ctx = {}) {
  const registeredCtx = ctx && typeof ctx === "object" ? ctx : {};
  // Discover is the only route that can use runtime state (live colony ids);
  // a per-call ctx wins over the one captured at registration.
  const discover = (args = {}) =>
    getDiscover({ ...args, ctx: args.ctx || registeredCtx });

  const routes = [
    ["/api/config/llm", getLlmConfig, "official LLMConfig from the pi_hive model env"],
    ["/api/config/models", getModelsCatalogue, "official ModelsCatalogue for the pi_hive model"],
    ["/api/models/overview", getModelsOverview, "official ModelsOverview for the single pi_hive model"],
    ["/api/config/profile", getProfile, "official profile object; pi_hive has no profile store"],
    ["/api/config/features", getFeatures, "official feature flags; pi_hive implements none"],
    ["/api/credentials", getCredentials, "official credential list; pi_hive is env-only"],
    ["/api/credentials/specs", getCredentialSpecs, "official credential specs; none registered"],
    ["/api/skills", getSkills, "official aggregated skills from colony skills/ dirs"],
    ["/api/prompts", getPrompts, "the stored custom prompts, newest first"],
    ["/api/discover", discover, "official agent discovery over pi_hive colonies"],
  ];

  for (const [routePath, handler, description] of routes) {
    registry.register("GET", routePath, handler, { ...IMPLEMENTED, description });
  }

  return registry;
}

export const CONFIG_ROUTE_PATHS = Object.freeze([
  "/api/config/llm",
  "/api/config/models",
  "/api/models/overview",
  "/api/config/profile",
  "/api/config/features",
  "/api/credentials",
  "/api/credentials/specs",
  "/api/skills",
  "/api/prompts",
  "/api/discover",
]);

export default registerConfigRoutes;
