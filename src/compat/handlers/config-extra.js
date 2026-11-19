/**
 * Remaining official config / models / credentials routes.
 *
 * The boot-critical config handlers in `./config.js` cover the ten GET routes
 * the official frontend reads on first paint. This module adds the other
 * thirty routes in the same families: provider slots, the provider library,
 * external skill roots, feature/profile/rate-limit writes, model slots and
 * endpoints, and credential CRUD.
 *
 * pi_hive's reality defines the answers:
 *
 *   - one model, configured by `PI_HIVE_MODEL` / `PI_HIVE_BASE_URL` /
 *     `PI_HIVE_API_KEY` in `src/config.js`; there is no writable configuration
 *     file and no session hot-swap;
 *   - no provider library, external-skill store, feature flags, user profile,
 *     social rate limiter, avatar store, model-endpoint registry, credential
 *     vault, local credential registry, Aden sync, or parked-session credential
 *     forms.
 *
 * Reads therefore return the real model/limit values from `modelConfig()` or a
 * documented empty collection. Every mutation whose capability does not exist
 * answers **400** with `{ error, type: "unsupported_capability", route,
 * capability }` — an explicit refusal, never the shell's 501 and never a fake
 * `{saved: ...}` success. The only network-free key check is
 * `POST /api/credentials/validate-key`, which compares a submitted key with
 * the configured pi_hive key in memory.
 *
 * Handlers return `{ status, body }` descriptors (matching the compat router
 * and `./config.js`); none writes to `res`, opens a port, or calls a model.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROUTE_STATUS } from "../router.js";
import { modelConfig } from "../../config.js";
import { buildCredentialSpecs, buildLLMConfig, buildModelsCatalogue } from "./config.js";

/** Official provider-slot names (core/frontend/src/api/config.ts `LlmRole`). */
const ROLE_SLOTS = Object.freeze(["llm", "worker_llm", "vision_fallback", "judge"]);

/** Slot names the Models page can address (`RoleSlot`); queens are `queen:<id>`. */
const MODEL_SLOTS = new Set(["llm", "worker_llm", "vision_fallback"]);

/** Refuse more than this much JSON; the native server caps request bodies too. */
const MAX_JSON_BODY_BYTES = 1024 * 1024;

const IMPLEMENTED = Object.freeze({ status: ROUTE_STATUS.IMPLEMENTED, official: true });

// ---------------------------------------------------------------------------
// Builders (pure: each reads pi_hive state at call time)
// ---------------------------------------------------------------------------

/**
 * Official `StartupStatus` (core/frontend/src/api/config.ts).
 *
 * pi_hive has no bootstrap daemon and no staged startup: answering this route
 * is itself proof that the compat server is up, so `ready` is true and the
 * history stays empty instead of inventing stages.
 */
export function buildStartupStatus() {
  return {
    ready: true,
    stage: "ready",
    detail: "pi_hive serves requests directly; it has no bootstrap daemon",
    updated_at: Date.now(),
    history: [],
  };
}

/**
 * Official `Record<LlmRole, LlmSection | null>`.
 *
 * Only the main slot exists; its values are the real env-configured model.
 * The API key itself is never exposed — only the env var name.
 */
export function buildLlmSections() {
  const llm = buildLLMConfig();
  return {
    llm: {
      provider: llm.provider,
      model: llm.model,
      api_base: llm.api_base,
      api_key_env_var: llm.api_key_env_var,
      max_tokens: llm.max_tokens,
      max_context_tokens: llm.max_context_tokens,
    },
    // pi_hive has no worker, vision, or judge slot.
    worker_llm: null,
    vision_fallback: null,
    judge: null,
  };
}

/** Official `{ library }`. pi_hive stores no named vendor configs. */
export function buildProviderLibrary() {
  return { library: {} };
}

/**
 * Official `{ paths, resolved, suggestions }`. Skills are per-colony
 * (`<colony>/skills/<name>/SKILL.md`); there are no external skill roots and
 * no config file in which to record one.
 */
export function buildExternalSkills() {
  return { paths: [], resolved: [], suggestions: [] };
}

/** Official `{ limits }`. pi_hive has no social-action rate limiter. */
export function buildRateLimits() {
  return { limits: [] };
}

/**
 * Official `{ models: EndpointModel[] }` for a named endpoint.
 *
 * pi_hive has no endpoint registry, but the one endpoint it does use is real:
 * it is addressed by the provider id from the model config. Any other name is
 * unknown. Returns null for an unknown endpoint so the caller can answer 404.
 */
export function buildEndpointModels(endpointName) {
  const provider = buildLLMConfig().provider;
  if (endpointName !== provider) return null;
  const catalogue = buildModelsCatalogue();
  const models = (catalogue.models?.[provider] || []).map((model) => ({
    id: model.id,
    label: model.label,
    max_context_tokens: model.max_context_tokens,
  }));
  return { models };
}

/** Official `OAuthStatusResponse`: no OAuth providers, real Aden-key bit. */
export function buildOauthStatus() {
  return {
    accounts_by_provider: {},
    has_aden_key: buildCredentialSpecs().has_aden_key,
    fetched_at: Date.now(),
  };
}

/**
 * Network-free key check for `POST /api/credentials/validate-key`.
 *
 * pi_hive's provider library is one env-configured OpenAI-compatible endpoint,
 * so there is no upstream health check to call. For that provider the only
 * truthful check is a local comparison with the configured key; other provider
 * ids report `valid: null` (unknown) rather than claiming a pass. The submitted
 * key is never echoed in the answer.
 */
export function checkKey(providerId, apiKey) {
  const provider = buildLLMConfig().provider;
  if (providerId !== provider) {
    return {
      valid: null,
      message: `pi_hive has no key health check for '${providerId}'; its only provider is '${provider}'`,
    };
  }
  const configured = modelConfig().apiKey;
  if (!configured) {
    return {
      valid: null,
      message: "PI_HIVE_API_KEY is not configured, so the key cannot be checked",
    };
  }
  const valid = String(apiKey).trim() === configured;
  return {
    valid,
    message: valid
      ? `The key matches the configured ${provider} API key`
      : `The key does not match the configured ${provider} API key`,
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function readStream(req) {
  return (async () => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MAX_JSON_BODY_BYTES) throw new Error("request body too large");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
}

/**
 * Read a JSON object from a compat handler call.
 *
 * Tests pass `req.body`; the native server passes a Node IncomingMessage.
 * Empty bodies are `{}` (matching the server's `readBody`), malformed JSON is
 * reported so the caller can answer 400.
 *
 * @returns {Promise<{ok: true, value: object} | {ok: false, tooLarge?: boolean}>}
 */
async function readJson(req) {
  let raw;
  try {
    if (req && req.body !== undefined) raw = req.body;
    else if (req && typeof req.json === "function") raw = await req.json();
    else if (req && typeof req[Symbol.asyncIterator] === "function") raw = await readStream(req);
    else return { ok: true, value: {} };
  } catch (error) {
    return { ok: false, tooLarge: /too large/i.test(String(error?.message || "")) };
  }

  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
  if (typeof raw === "string") {
    if (!raw.trim()) return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  }
  if (typeof raw === "object") return { ok: true, value: raw };
  return { ok: false };
}

function ok(body) {
  return { status: 200, body };
}

function notFound(message) {
  return { status: 404, body: { error: message } };
}

/** Explicit refusal for a capability pi_hive does not have. */
function unsupported(route, capability, reason) {
  return {
    status: 400,
    body: {
      error: reason,
      type: "unsupported_capability",
      route,
      capability,
    },
  };
}

function invalidRequest(route, message) {
  return { status: 400, body: { error: message, type: "invalid_request", route } };
}

function bodyError(route, parsed) {
  if (parsed.tooLarge) {
    return { status: 413, body: { error: "request body too large", type: "invalid_request", route } };
  }
  return invalidRequest(route, "Invalid JSON body");
}

function routeOf(args, fallback) {
  return typeof args?.pathname === "string" && args.pathname ? args.pathname : fallback;
}

// ---------------------------------------------------------------------------
// Read handlers
// ---------------------------------------------------------------------------

async function getStartupStatus() {
  return ok(buildStartupStatus());
}

async function getLlmSections() {
  return ok(buildLlmSections());
}

async function getProviderLibrary() {
  return ok(buildProviderLibrary());
}

async function getExternalSkills() {
  return ok(buildExternalSkills());
}

async function getRateLimits() {
  return ok(buildRateLimits());
}

/** Official GET avatar: pi_hive has no avatar file, so the documented 404. */
async function getProfileAvatar() {
  return notFound("No avatar found");
}

async function getEndpointModels(args = {}) {
  const name = typeof args.params?.endpoint === "string" ? args.params.endpoint : "";
  const body = buildEndpointModels(name);
  if (!body) return notFound(`There's no endpoint '${name}'`);
  return ok(body);
}

/** The credential vault is empty, so every id is missing (never a secret echo). */
async function getCredential(args = {}) {
  const id = typeof args.params?.credential === "string" ? args.params.credential : "";
  return notFound(`Credential '${id}' not found`);
}

async function getOauthStatus() {
  return ok(buildOauthStatus());
}

// ---------------------------------------------------------------------------
// Credential read/check handlers
// ---------------------------------------------------------------------------

/**
 * Official check-agent shape. pi_hive agents declare no per-node credential
 * requirements: the only model key is process-wide. The path is still checked
 * so a bogus agent_path is a real 400, not a silent pass.
 */
async function postCheckAgent(args = {}) {
  const route = routeOf(args, "/api/credentials/check-agent");
  const parsed = await readJson(args.req);
  if (!parsed.ok) return bodyError(route, parsed);

  const agentPath =
    typeof parsed.value?.agent_path === "string" ? parsed.value.agent_path.trim() : "";
  if (!agentPath) return invalidRequest(route, "agent_path is required");

  const expanded = agentPath.startsWith("~")
    ? path.join(os.homedir(), agentPath.slice(1))
    : agentPath;
  let stat = null;
  try {
    stat = fs.statSync(expanded);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    return invalidRequest(route, `agent_path '${agentPath}' is not a directory`);
  }

  return ok({
    required: [],
    has_aden_key: buildCredentialSpecs().has_aden_key,
  });
}

/** Official `{ valid, message }`; local comparison only, no network. */
async function postValidateKey(args = {}) {
  const route = routeOf(args, "/api/credentials/validate-key");
  const parsed = await readJson(args.req);
  if (!parsed.ok) return bodyError(route, parsed);

  const providerId =
    typeof parsed.value?.provider_id === "string" ? parsed.value.provider_id.trim() : "";
  const apiKey = typeof parsed.value?.api_key === "string" ? parsed.value.api_key : "";
  if (!providerId || !apiKey) {
    return invalidRequest(route, "provider_id and api_key are required");
  }
  return ok(checkKey(providerId, apiKey));
}

// ---------------------------------------------------------------------------
// Mutation handlers (all refusals are capability-explicit)
// ---------------------------------------------------------------------------

function putLlmSections(args = {}) {
  return unsupported(
    routeOf(args, "/api/config/llm-sections"),
    "config.llm-sections",
    "pi_hive reads its model from PI_HIVE_MODEL, PI_HIVE_BASE_URL and PI_HIVE_API_KEY; there is no writable configuration file, so a provider slot cannot be saved or hot-swapped",
  );
}

function putProviderLibrary(args = {}) {
  return unsupported(
    routeOf(args, "/api/config/provider-library"),
    "config.provider-library",
    "pi_hive has no provider library: its single OpenAI-compatible endpoint comes from environment variables, not saved vendor configs",
  );
}

function applyProviderLibrary(args = {}) {
  return unsupported(
    routeOf(args, "/api/config/provider-library/apply"),
    "config.provider-library",
    "pi_hive has no provider library entry to apply: the model endpoint comes from PI_HIVE_BASE_URL",
  );
}

function putExternalSkills(args = {}) {
  return unsupported(
    routeOf(args, "/api/config/external-skills"),
    "config.external-skills",
    "pi_hive has no external skill roots: skills live in each colony's skills/ directory and there is no configuration file to record extra paths",
  );
}

function putFeatures(args = {}) {
  return unsupported(
    routeOf(args, "/api/config/features"),
    "config.features",
    "pi_hive has no feature-flag store: the Hive-only features (adaptive tool budget, email senders, stall check) do not exist here",
  );
}

function putLlmConfig(args = {}) {
  return unsupported(
    routeOf(args, "/api/config/llm"),
    "config.llm",
    "pi_hive serves a single model configured by PI_HIVE_MODEL, PI_HIVE_BASE_URL and PI_HIVE_API_KEY; runtime model switching and session hot-swap are not supported",
  );
}

function putProfile(args = {}) {
  return unsupported(
    routeOf(args, "/api/config/profile"),
    "config.profile",
    "pi_hive has no user profile store, so display name, about, theme and density cannot be saved",
  );
}

function putRateLimits(args = {}) {
  return unsupported(
    routeOf(args, "/api/config/rate-limits"),
    "config.rate-limits",
    "pi_hive has no social rate-limit store: it runs no outbound social actions and keeps no per-platform limits",
  );
}

function postProfileAvatar(args = {}) {
  return unsupported(
    routeOf(args, "/api/config/profile/avatar"),
    "config.profile.avatar",
    "pi_hive has no avatar store or profile asset directory, so a profile picture cannot be uploaded",
  );
}

const SLOT_REASONS = Object.freeze({
  llm: {
    put: "pi_hive runs one model configured by environment variables; the main model cannot be assigned or hot-swapped at runtime",
    delete: "the main model cannot be removed: pi_hive always needs the single model configured by PI_HIVE_MODEL",
  },
  worker_llm:
    "pi_hive has no worker_llm slot: it runs the single configured model for queens and workers alike",
  vision_fallback:
    "pi_hive has no vision_fallback slot: the configured model declares text input only",
  queen:
    "pi_hive has no per-queen model configuration: every colony uses the single configured model",
});

function slotMutation(args = {}, method) {
  const route = routeOf(args, `/api/models/slots/${args.params?.slot ?? ""}`);
  const slot = typeof args.params?.slot === "string" ? args.params.slot : "";

  if (slot === "llm") {
    return unsupported(
      route,
      "models.slots",
      method === "DELETE" ? SLOT_REASONS.llm.delete : SLOT_REASONS.llm.put,
    );
  }
  if (slot === "worker_llm" || slot === "vision_fallback") {
    return unsupported(route, "models.slots", SLOT_REASONS[slot]);
  }
  if (slot.startsWith("queen:")) {
    return unsupported(route, "models.slots", SLOT_REASONS.queen);
  }
  return invalidRequest(
    route,
    `There's no slot '${slot}': pi_hive supports the single env-configured main model only`,
  );
}

function putSlot(args = {}) {
  return slotMutation(args, "PUT");
}

function deleteSlot(args = {}) {
  return slotMutation(args, "DELETE");
}

function putEndpoint(args = {}) {
  const name = typeof args.params?.endpoint === "string" ? args.params.endpoint : "";
  return unsupported(
    routeOf(args, `/api/models/endpoints/${name}`),
    "models.endpoints",
    "pi_hive has no model endpoint registry: the OpenAI-compatible endpoint is fixed by PI_HIVE_BASE_URL and cannot be added or changed at runtime",
  );
}

function deleteEndpoint(args = {}) {
  const name = typeof args.params?.endpoint === "string" ? args.params.endpoint : "";
  const route = routeOf(args, `/api/models/endpoints/${name}`);
  if (name === buildLLMConfig().provider) {
    return unsupported(
      route,
      "models.endpoints",
      "the configured endpoint comes from PI_HIVE_BASE_URL and cannot be removed at runtime",
    );
  }
  return notFound(`There's no endpoint '${name}'`);
}

function postCredential(args = {}) {
  return unsupported(
    routeOf(args, "/api/credentials"),
    "credentials.store",
    "pi_hive has no credential vault: model keys come from the environment (PI_HIVE_API_KEY), never from a stored credential",
  );
}

function deleteCredential(args = {}) {
  const id = typeof args.params?.credential === "string" ? args.params.credential : "";
  return unsupported(
    routeOf(args, `/api/credentials/${id}`),
    "credentials.store",
    "pi_hive has no credential vault, so there is no stored credential to delete; keys come from the environment",
  );
}

function postLocalCredential(args = {}) {
  return unsupported(
    routeOf(args, "/api/credentials/local"),
    "credentials.local",
    "pi_hive has no local credential registry: it cannot store named accounts or aliases",
  );
}

function deleteLocalCredential(args = {}) {
  const id = typeof args.params?.credential === "string" ? args.params.credential : "";
  const alias = typeof args.params?.alias === "string" ? args.params.alias : "";
  return unsupported(
    routeOf(args, `/api/credentials/local/${id}/${alias}`),
    "credentials.local",
    "pi_hive has no local credential registry, so there is no local account to delete",
  );
}

function postCredentialResync(args = {}) {
  return unsupported(
    routeOf(args, "/api/credentials/resync"),
    "credentials.resync",
    "pi_hive has no Aden credential sync or credential store to resynchronise",
  );
}

function postCredentialForm(args = {}) {
  return unsupported(
    routeOf(args, "/api/sessions/:session/credential-form"),
    "sessions.credential-form",
    "pi_hive has no credential vault or parked agent sessions, so a secure credential form cannot be submitted",
  );
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

/**
 * The thirty routes this module owns, in registration order. Values are
 * `[method, path, handler, description]`; `CONFIG_EXTRA_ROUTES` exposes the
 * method/path pins without the handlers.
 */
const ROUTE_TABLE = [
  ["GET", "/api/startup-status", getStartupStatus, "official StartupStatus; ready, with no bootstrap daemon"],
  ["GET", "/api/config/llm-sections", getLlmSections, "official provider slots; the real env-configured llm slot, others null"],
  ["PUT", "/api/config/llm-sections", putLlmSections, "400: pi_hive's model config is env-only and has no writable slots"],
  ["GET", "/api/config/provider-library", getProviderLibrary, "official provider library; empty (no vendor config store)"],
  ["PUT", "/api/config/provider-library", putProviderLibrary, "400: pi_hive has no provider library store"],
  ["POST", "/api/config/provider-library/apply", applyProviderLibrary, "400: pi_hive has no provider library entry to apply"],
  ["GET", "/api/config/external-skills", getExternalSkills, "official external skill roots; empty (skills are colony-local)"],
  ["PUT", "/api/config/external-skills", putExternalSkills, "400: pi_hive has no external-skill configuration file"],
  ["PUT", "/api/config/features", putFeatures, "400: pi_hive implements no Hive-only feature flags"],
  ["PUT", "/api/config/llm", putLlmConfig, "400: the single model is env-configured and cannot be hot-swapped"],
  ["PUT", "/api/config/profile", putProfile, "400: pi_hive has no user profile store"],
  ["GET", "/api/config/rate-limits", getRateLimits, "official rate limits; empty (no social rate limiter)"],
  ["PUT", "/api/config/rate-limits", putRateLimits, "400: pi_hive has no social rate-limit store"],
  ["POST", "/api/config/profile/avatar", postProfileAvatar, "400: pi_hive has no avatar store"],
  ["GET", "/api/config/profile/avatar", getProfileAvatar, "official 404: pi_hive has no avatar file"],
  ["PUT", "/api/models/slots/:slot", putSlot, "400: pi_hive runs one env-configured model and has no other slots"],
  ["DELETE", "/api/models/slots/:slot", deleteSlot, "400: the single model cannot be cleared and other slots do not exist"],
  ["GET", "/api/models/endpoints/:endpoint/models", getEndpointModels, "the configured endpoint's single real model; 404 for unknown names"],
  ["PUT", "/api/models/endpoints/:endpoint", putEndpoint, "400: pi_hive has no writable endpoint registry"],
  ["DELETE", "/api/models/endpoints/:endpoint", deleteEndpoint, "400 for the env-configured endpoint; 404 for unknown names"],
  ["GET", "/api/credentials/:credential", getCredential, "official 404: pi_hive has no credential vault"],
  ["POST", "/api/credentials", postCredential, "400: pi_hive has no credential vault (keys are env-only)"],
  ["DELETE", "/api/credentials/:credential", deleteCredential, "400: pi_hive has no credential vault"],
  ["POST", "/api/credentials/local", postLocalCredential, "400: pi_hive has no local credential registry"],
  ["DELETE", "/api/credentials/local/:credential/:alias", deleteLocalCredential, "400: pi_hive has no local credential registry"],
  ["POST", "/api/credentials/check-agent", postCheckAgent, "empty requirement list; the only model key is process-wide"],
  ["POST", "/api/credentials/resync", postCredentialResync, "400: pi_hive has no Aden credential sync"],
  ["GET", "/api/credentials/oauth-status", getOauthStatus, "official OAuth status; no providers, real Aden-key bit"],
  ["POST", "/api/credentials/validate-key", postValidateKey, "local check against the configured pi_hive key; no network"],
  ["POST", "/api/sessions/:session/credential-form", postCredentialForm, "400: pi_hive has no credential vault or parked sessions"],
];

/** Method + path for every route, for contract checks and tests. */
export const CONFIG_EXTRA_ROUTES = Object.freeze(
  ROUTE_TABLE.map(([method, routePath]) => Object.freeze({ method, path: routePath })),
);

/** Path-only view (the official surface has no duplicate paths in this lane). */
export const CONFIG_EXTRA_ROUTE_PATHS = Object.freeze(
  ROUTE_TABLE.map(([, routePath]) => routePath),
);

/**
 * Register the remaining config/models/credentials routes on `registry`.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] integration context (reserved; these handlers read
 *                       process/env state and need no per-call runtime state)
 * @returns {object} the registry, for chaining
 */
export function registerConfigExtraRoutes(registry, ctx = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registerConfigExtraRoutes requires a RouteRegistry");
  }
  void ctx; // no runtime state is needed; accepted for the lane's uniform signature

  for (const [method, routePath, handler, description] of ROUTE_TABLE) {
    registry.register(method, routePath, handler, { ...IMPLEMENTED, description });
  }
  return registry;
}

/** Official role-slot names, exported for callers that build UIs over this module. */
export const LLM_ROLE_SLOTS = ROLE_SLOTS;
/** Slot names the Models page may PUT/DELETE without a queen prefix. */
export const MODEL_ROLE_SLOTS = Object.freeze([...MODEL_SLOTS]);

export default registerConfigExtraRoutes;
