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
 *     `PI_HIVE_API_KEY`; a saved `/api/config/llm` write overrides those
 *     environment values for every runtime built afterwards;
 *   - provider slots, the provider library, external skill roots, feature
 *     flags, the user profile, rate limits and the profile avatar are durable
 *     under `hiveHome()/config/` (`src/domain/config-store.js`). No secret is
 *     ever stored: a section carrying `api_key` is refused.
 *   - no model-endpoint registry, credential vault, local credential registry,
 *     Aden sync, or parked-session credential forms, so those mutations keep
 *     answering **400** with `{ error, type: "unsupported_capability", route,
 *     capability }` — an explicit refusal, never the shell's 501. The only
 *     network-free key check is `POST /api/credentials/validate-key`, which
 *     compares a submitted key with the configured pi_hive key in memory.
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
import { coloniesDir, modelConfig } from "../../config.js";
import {
  FEATURE_KEYS,
  MAX_AVATAR_BYTES,
  readAvatar,
  readEndpoints,
  readLibrary,
  readLlmOverride,
  readRateLimits,
  readSections,
  readSkillPaths,
  readSlots,
  saveAvatar,
  sectionError,
  setLibraryEntry,
  writeEndpoint,
  writeFeatures,
  writeLlmOverride,
  writeProfile,
  writeRateLimits,
  writeSection,
  writeSkillPaths,
  writeSlot,
} from "../../domain/config-store.js";
import { readLlm as readQueenLlm, writeLlm as writeQueenLlm } from "../../domain/queen-state.js";
import {
  accountsByProvider,
  adenConfig,
  deleteCredential as vaultDeleteCredential,
  deleteLocal as vaultDeleteLocal,
  isSafeCredentialId,
  listCredentials,
  listLocal,
  mergeAdenAccounts,
  normalizeKeys,
  saveCredential,
  saveLocal,
} from "../../domain/credential-vault.js";
import { SessionStore } from "../sessions.js";
import { parseMultipart } from "./sessions.js";
import { buildCredentialSpecs, buildFeatures, buildLLMConfig, buildModelsCatalogue } from "./config.js";

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
  const stored = readSections();
  const slot = {
    provider: llm.provider,
    model: llm.model,
    api_base: llm.api_base,
    api_key_env_var: llm.api_key_env_var,
    max_tokens: llm.max_tokens,
    max_context_tokens: llm.max_context_tokens,
  };
  // A saved llm slot may carry extra keys; the runtime-relevant ones already
  // went through modelConfig(), so they agree with what is displayed here.
  for (const [key, value] of Object.entries(stored.llm ?? {})) {
    if (key !== "api_key" && value !== undefined) slot[key] = value;
  }
  return {
    llm: slot,
    // pi_hive records these slots; it runs no worker, vision, or judge model.
    worker_llm: stored.worker_llm ?? null,
    vision_fallback: stored.vision_fallback ?? null,
    judge: stored.judge ?? null,
  };
}

/** Official `{ library }`: named vendor configs, saved under the config dir. */
export function buildProviderLibrary() {
  return { library: readLibrary() };
}

/** Expand `~` and resolve a configured skill root into its on-disk status. */
function resolveSkillPath(raw) {
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  const abs = path.resolve(expanded);
  try {
    if (!fs.statSync(abs).isDirectory()) {
      return { path: raw, resolved: abs, exists: false, skills: 0, error: "not a directory" };
    }
    const skills = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(abs, entry.name, "SKILL.md")))
      .length;
    return { path: raw, resolved: fs.realpathSync(abs), exists: true, skills };
  } catch (error) {
    const code = error?.code;
    return {
      path: raw,
      resolved: abs,
      exists: false,
      skills: 0,
      error: code === "ENOENT" ? "not found" : String(error?.message || error),
    };
  }
}

/**
 * Official `{ paths, resolved, suggestions }`. Paths are the saved external
 * skill roots; colony-local skills (`<colony>/skills/`) are not listed here.
 */
export function buildExternalSkills() {
  const paths = readSkillPaths();
  return { paths, resolved: paths.map(resolveSkillPath), suggestions: [] };
}

/** Official `{ limits }`: saved per-platform social pacing, empty by default. */
export function buildRateLimits() {
  return { limits: readRateLimits() };
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
  if (endpointName !== provider) {
    // A stored endpoint is asked directly; the caller turns a null into 404.
    return readEndpoints()[endpointName] ? ENDPOINT_MODELS_UNPROBED : null;
  }
  const catalogue = buildModelsCatalogue();
  const models = (catalogue.models?.[provider] || []).map((model) => ({
    id: model.id,
    label: model.label,
    max_context_tokens: model.max_context_tokens,
  }));
  return { models };
}

/** Marker: the route handler still has to ask the endpoint over HTTP. */
const ENDPOINT_MODELS_UNPROBED = Object.freeze({ unprobed: true });

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

/** 400 for a mutation whose payload is wrong; the route is the handler's own path. */
function invalid(message) {
  return { status: 400, body: { error: message, type: "invalid_request" } };
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
/** Official GET avatar: the saved profile picture, or 404 when never uploaded. */
async function getProfileAvatar() {
  const avatar = readAvatar();
  if (!avatar) return notFound("No avatar found");
  return { status: 200, body: avatar.bytes, content_type: avatar.content_type };
}

async function getEndpointModels(args = {}) {
  const name = typeof args.params?.endpoint === "string" ? args.params.endpoint : "";
  const body = buildEndpointModels(name);
  if (!body) return notFound(`There's no endpoint '${name}'`);
  if (body.unprobed) return probeEndpointModels(name);
  return ok(body);
}

/**
 * `GET {api_base}/models` for a stored endpoint. OpenAI-compatible servers all
 * answer this, so it is the honest way to list what an endpoint serves; a
 * failure is reported with the endpoint's own error instead of an empty list.
 */
async function probeEndpointModels(name) {
  const entry = readEndpoints()[name];
  const url = `${entry.api_base.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENDPOINT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: entry.api_key ? { authorization: `Bearer ${entry.api_key}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: 502, body: { error: `${name} answered ${response.status} for ${url}`, endpoint: name } };
    }
    const payload = await response.json().catch(() => null);
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    return {
      status: 200,
      body: {
        models: list
          .filter((model) => model && typeof model.id === "string")
          .map((model) => ({
            id: model.id,
            label: typeof model.name === "string" ? model.name : null,
            max_context_tokens:
              Number(model.context_length ?? model.max_context_tokens ?? model.max_model_len) || null,
          })),
      },
    };
  } catch (err) {
    const reason = err?.name === "AbortError" ? `no answer within ${ENDPOINT_PROBE_TIMEOUT_MS} ms` : err?.message || String(err);
    return { status: 502, body: { error: `could not reach ${name}: ${reason}`, endpoint: name } };
  } finally {
    clearTimeout(timer);
  }
}

/** The credential vault is empty, so every id is missing (never a secret echo). */
/**
 * `GET /api/credentials/:credential` — the stored credential plus its named
 * accounts. Field names are listed; no value is ever returned.
 */
async function getCredential(args = {}) {
  const id = typeof args.params?.credential === "string" ? args.params.credential : "";
  const stored = listCredentials().find((entry) => entry.credential_id === id) || null;
  const accounts = listLocal(id);
  if (!stored && accounts.length === 0) return notFound(`Credential '${id}' not found`);
  return {
    status: 200,
    body: {
      credential_id: id,
      credential_type: accounts.some((entry) => entry.account) ? "local" : "api_key",
      key_names: stored?.has_keys ?? accounts[0]?.has_keys ?? [],
      created_at: stored?.updated_at ?? accounts[0]?.created_at ?? null,
      updated_at: stored?.updated_at ?? accounts[0]?.created_at ?? null,
      accounts: accounts.map((entry) => ({
        provider: id,
        alias: entry.account,
        identity: { account: entry.account },
        source: "local",
        credential_id: id,
        // Presence only: the field names, never their values.
        has_keys: entry.has_keys,
      })),
    },
  };
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

/** Read the whole request as bytes, for a multipart avatar upload. */
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * A saved model takes effect in every runtime built afterwards: the server drops
 * its cached env-derived runtime and every colony runtime, so the next turn of
 * each live session constructs its agent against the saved model. Returns how
 * many colony runtimes were dropped (0 when no server is in the ctx, or when the
 * runtime was injected by tests/CLI and is therefore not ours to swap).
 */
function swapLiveSessions(ctx) {
  // The dispatcher passes the server instance itself as ctx.
  const server = ctx?.server ?? ctx;
  if (!server || typeof server.swapModelRuntime !== "function") return 0;
  return server.swapModelRuntime();
}

function countColonies() {
  try {
    return fs.readdirSync(coloniesDir(), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/** PUT /config/llm-sections — write one provider slot (null clears it). */
const putLlmSections = async ({ req, ctx }) => {
  const parsed = await readJson(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const { role, section } = parsed.value ?? {};
  if (!ROLE_SLOTS.includes(role)) return invalid(`unknown role '${role}'`);
  const value = section === undefined ? null : section;
  const error = sectionError(value);
  if (error) return invalid(error);
  const sections = writeSection(role, value);
  if (role === "llm") writeLlmOverride(value);
  return {
    status: 200,
    body: {
      role,
      section: sections[role] ?? null,
      sessions_swapped: role === "llm" ? swapLiveSessions(ctx) : 0,
    },
  };
};

/** PUT /config/provider-library — save (or delete with null) one vendor entry. */
const putProviderLibrary = async ({ req }) => {
  const parsed = await readJson(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const { name, section } = parsed.value ?? {};
  if (typeof name !== "string" || !name.trim() || name.trim().length > 64) {
    return invalid("name must be a non-empty string of at most 64 characters");
  }
  const value = section === undefined ? null : section;
  const error = sectionError(value);
  if (error) return invalid(error);
  const library = setLibraryEntry(name.trim(), value);
  return { status: 200, body: { name: name.trim(), section: library[name.trim()] ?? null } };
};

/** POST /config/provider-library/apply — copy a saved entry into a slot. */
const applyProviderLibrary = async ({ req, ctx }) => {
  const parsed = await readJson(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const body = parsed.value ?? {};
  const { name } = body;
  const role = body.role === undefined ? "llm" : body.role;
  if (!ROLE_SLOTS.includes(role)) return invalid(`unknown role '${role}'`);
  const entry = typeof name === "string" ? readLibrary()[name] : undefined;
  if (!entry) return notFound(`There's no provider '${name}'`);
  const sections = writeSection(role, entry);
  if (role === "llm") writeLlmOverride(entry);
  return {
    status: 200,
    body: {
      role,
      section: sections[role] ?? null,
      sessions_swapped: role === "llm" ? swapLiveSessions(ctx) : 0,
    },
  };
};

/** PUT /config/external-skills — replace the list of external skill roots. */
const putExternalSkills = async ({ req }) => {
  const parsed = await readJson(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const paths = parsed.value?.paths;
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || !p.trim() || p.includes("\0"))) {
    return invalid("paths must be an array of directory paths");
  }
  const unique = [...new Set(paths.map((p) => p.trim()))];
  writeSkillPaths(unique);
  return { status: 200, body: { paths: unique, resolved: unique.map(resolveSkillPath) } };
};

/** PUT /config/features — persist the Developer-options switches. */
const putFeatures = async ({ req }) => {
  const parsed = await readJson(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const features = parsed.value?.features;
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    return invalid("features must be an object");
  }
  const unknown = Object.keys(features).filter((key) => !FEATURE_KEYS.includes(key));
  if (unknown.length) return invalid(`unknown feature flags: ${unknown.join(", ")}`);
  for (const key of Object.keys(features)) {
    if (typeof features[key] !== "boolean") return invalid(`${key} must be a boolean`);
  }
  writeFeatures(features);
  return { status: 200, body: { features: buildFeatures().features, colonies_applied: countColonies() } };
};

/** PUT /config/llm — switch the model, on the catalogue or on the custom endpoint. */
const putLlmConfig = async ({ req, ctx }) => {
  const parsed = await readJson(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const body = parsed.value ?? {};
  if (body.subscription !== undefined) {
    return invalid(`pi_hive has no subscription presets; '${body.subscription}' is unknown`);
  }
  if (typeof body.model !== "string" || !body.model.trim()) return invalid("model is required");
  const current = buildLLMConfig();
  if (body.provider !== undefined && body.provider !== current.provider) {
    return invalid(`pi_hive serves one endpoint; provider '${body.provider}' is not configured`);
  }
  const override = { ...readLlmOverride(), model: body.model.trim() };
  delete override.api_key;
  writeLlmOverride(override);
  const next = buildLLMConfig();
  return {
    status: 200,
    body: {
      provider: next.provider,
      model: next.model,
      has_api_key: next.has_api_key,
      max_tokens: next.max_tokens,
      max_context_tokens: next.max_context_tokens,
      sessions_swapped: swapLiveSessions(ctx),
      active_subscription: null,
    },
  };
};

/** PUT /config/profile — save display name, about, theme, density, sort order. */
const putProfile = async ({ req }) => {
  const parsed = await readJson(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const body = parsed.value ?? {};
  const patch = {};
  for (const key of ["displayName", "about", "theme", "density"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string" || body[key].length > 2000) {
        return invalid(`${key} must be a string of at most 2000 characters`);
      }
      patch[key] = body[key];
    }
  }
  if (body.prompt_library_sort !== undefined) {
    const sort = body.prompt_library_sort;
    const badSort =
      sort !== null &&
      (typeof sort !== "object" ||
        Array.isArray(sort) ||
        ["my", "community"].some((k) => sort[k] !== undefined && typeof sort[k] !== "string"));
    if (badSort) return invalid("prompt_library_sort must be null or an object of my/community");
    patch.prompt_library_sort = sort;
  }
  if (!Object.keys(patch).length) return invalid("no profile fields supplied");
  const profile = writeProfile(patch);
  return {
    status: 200,
    body: {
      displayName: profile.displayName ?? "",
      about: profile.about ?? "",
      theme: profile.theme ?? "",
      prompt_library_sort: profile.prompt_library_sort ?? null,
    },
  };
};

/** PUT /config/rate-limits — replace the pacing table from `platform:action` map. */
const putRateLimits = async ({ req }) => {
  const parsed = await readJson(req);
  if (!parsed.ok) return invalid("Invalid JSON body");
  const limits = parsed.value?.limits;
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    return invalid("limits must be an object mapping 'platform:action_type' to seconds");
  }
  const entries = [];
  const warnings = [];
  for (const [key, value] of Object.entries(limits)) {
    const parts = key.split(/[:./]/);
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      warnings.push(`ignored '${key}': expected 'platform:action_type'`);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      warnings.push(`ignored '${key}': delay must be a non-negative number`);
      continue;
    }
    entries.push({ platform: parts[0], action_type: parts[1], min_delay_s: value });
  }
  return { status: 200, body: { limits: writeRateLimits(entries), warnings } };
};

const ENDPOINT_PROBE_TIMEOUT_MS = 5000;

const AVATAR_TYPES = /^(image\/(png|jpeg|jpg|webp)|application\/octet-stream)$/;

/** POST /config/profile/avatar — store the uploaded profile picture. */
const postProfileAvatar = async ({ req }) => {
  let parts;
  try {
    parts = parseMultipart(await readRawBody(req), req.headers["content-type"]);
  } catch (error) {
    return invalid(error?.message || "Expected multipart/form-data with an avatar field");
  }
  const field = parts.find((part) => part.name === "avatar" && part.data?.length);
  if (!field) return invalid("multipart field 'avatar' is required");
  const contentType = field.contentType || "application/octet-stream";
  if (!AVATAR_TYPES.test(contentType)) {
    return invalid(`avatar must be a PNG, JPEG or WebP image, not ${contentType}`);
  }
  if (field.data.length > MAX_AVATAR_BYTES) {
    return invalid(`avatar exceeds ${MAX_AVATAR_BYTES} bytes`);
  }
  saveAvatar({ bytes: field.data, contentType });
  return { status: 200, body: { avatar_url: "/api/config/profile/avatar" } };
};

/** A slot summary shaped like the official `SlotSummary` (never a key). */
function slotSummaryOf(source, { provider, model, endpoint }) {
  const cfg = modelConfig();
  const saved = endpoint ? readEndpoints()[endpoint] || null : null;
  return {
    source,
    provider: provider ?? null,
    model,
    endpoint: endpoint ?? null,
    subscription: null,
    api_base:
      source === "endpoint"
        ? saved?.api_base ?? null
        : source === "catalog" && provider === cfg.provider
          ? cfg.baseUrl
          : null,
    max_context_tokens: null,
    has_extra_body: false,
  };
}

/** Validate an official `ModelChoice`: a catalogue model or an endpoint's model. */
function readChoice(parsed) {
  const source = parsed?.source;
  if (source !== "catalog" && source !== "endpoint") {
    return { error: "source must be 'catalog' or 'endpoint'" };
  }
  if (typeof parsed?.model !== "string" || !parsed.model.trim()) {
    return { error: "model is required" };
  }
  if (source === "catalog") {
    if (typeof parsed.provider !== "string" || !parsed.provider.trim()) {
      return { error: "provider is required for a catalogue choice" };
    }
    return { choice: { source, provider: parsed.provider.trim(), model: parsed.model.trim() } };
  }
  if (typeof parsed.endpoint !== "string" || !parsed.endpoint.trim()) {
    return { error: "endpoint is required for an endpoint choice" };
  }
  const name = parsed.endpoint.trim();
  if (!readEndpoints()[name]) return { error: `There's no endpoint '${name}'`, status: 404 };
  return { choice: { source, endpoint: name, model: parsed.model.trim() } };
}

/** Split the official slot id into a role slot or a queen id. */
function parseSlotId(slot) {
  if (slot === "llm" || slot === "worker_llm" || slot === "vision_fallback") return { role: slot };
  if (slot.startsWith("queen:") && slot.length > 6) return { queen: slot.slice(6) };
  return null;
}

/** The llm section a choice resolves to. */
function choiceSection(choice) {
  const section = { model: choice.model };
  if (choice.provider) section.provider = choice.provider;
  if (choice.endpoint) {
    const saved = readEndpoints()[choice.endpoint];
    if (saved?.api_base) section.api_base = saved.api_base;
  }
  return section;
}

/**
 * `PUT /api/models/slots/:slot`. The main model writes the saved LLM override
 * (what `modelConfig()` reads), a `queen:<id>` slot writes that queen's own llm
 * section, and worker/vision slots persist a summary (`hiveHome()/config/slots.json`)
 * that the worker runtime reads. Only the main model can swap live sessions,
 * because only it backs an already-built runtime.
 */
async function putSlot(args = {}) {
  const route = routeOf(args, `/api/models/slots/${args.params?.slot ?? ""}`);
  const slot = typeof args.params?.slot === "string" ? args.params.slot : "";
  const target = parseSlotId(slot);
  if (!target) {
    return invalidRequest(route, `There's no slot '${slot}': slot must be llm, worker_llm, vision_fallback or queen:<id>`);
  }
  const parsed = await readJson(args.req ?? {});
  const choice = readChoice(parsed.ok ? parsed.value : null);
  if (choice.error) {
    return choice.status === 404 ? notFound(choice.error) : invalidRequest(route, choice.error);
  }

  if (target.role === "llm") {
    const section = choiceSection(choice.choice);
    const error = sectionError(section);
    if (error) return invalidRequest(route, error);
    writeLlmOverride(section);
    return {
      status: 200,
      body: { slot, summary: slotSummaryOf(choice.choice.source, choice.choice), sessions_switched: swapLiveSessions(args.ctx) },
    };
  }

  if (target.queen) {
    writeQueenLlm(target.queen, choiceSection(choice.choice));
    return { status: 200, body: { slot, summary: slotSummaryOf(choice.choice.source, choice.choice), sessions_switched: 0 } };
  }

  writeSlot(slot, slotSummaryOf(choice.choice.source, choice.choice));
  return { status: 200, body: { slot, summary: slotSummaryOf(choice.choice.source, choice.choice), sessions_switched: 0 } };
}

/** `DELETE /api/models/slots/:slot` — back to the default (main model, or none). */
async function deleteSlot(args = {}) {
  const route = routeOf(args, `/api/models/slots/${args.params?.slot ?? ""}`);
  const slot = typeof args.params?.slot === "string" ? args.params.slot : "";
  const target = parseSlotId(slot);
  if (!target) {
    return invalidRequest(route, `There's no slot '${slot}': slot must be llm, worker_llm, vision_fallback or queen:<id>`);
  }
  if (target.role === "llm") {
    writeLlmOverride(null);
    return { status: 200, body: { slot, summary: null, sessions_switched: swapLiveSessions(args.ctx) } };
  }
  if (target.queen) {
    writeQueenLlm(target.queen, null);
    return { status: 200, body: { slot, summary: null } };
  }
  writeSlot(slot, null);
  return { status: 200, body: { slot, summary: null } };
}

/** Official `ModelEndpoint` for one stored name — never the key. */
function endpointBody(name, entry) {
  return {
    name,
    api_base: entry?.api_base ?? "",
    builtin: false,
    has_key: Boolean(entry?.api_key),
    running: false,
  };
}

/** `PUT /api/models/endpoints/:endpoint` — add or edit one named endpoint. */
async function putEndpoint(args = {}) {
  const route = routeOf(args, `/api/models/endpoints/${args.params?.endpoint ?? ""}`);
  const name = typeof args.params?.endpoint === "string" ? args.params.endpoint.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    return invalidRequest(route, "endpoint name must be 1-64 characters of letters, digits, dot, dash or underscore");
  }
  const parsed = await readJson(args.req ?? {});
  const body = parsed.ok ? parsed.value : null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidRequest(route, "expected {api_base?, api_key?}");
  }
  const existing = readEndpoints()[name] || null;
  const patch = {};

  if (body.api_base !== undefined) {
    if (typeof body.api_base !== "string") return invalidRequest(route, "api_base must be a string");
    let url;
    try {
      url = new URL(body.api_base.trim());
    } catch {
      return invalidRequest(route, `api_base must be an absolute URL, got '${body.api_base}'`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return invalidRequest(route, "api_base must be http or https");
    }
    patch.api_base = body.api_base.trim().replace(/\/+$/, "");
  }
  if (body.api_key !== undefined) {
    if (body.api_key !== null && typeof body.api_key !== "string") {
      return invalidRequest(route, "api_key must be a string or null");
    }
    patch.api_key = body.api_key === null ? null : body.api_key.trim();
  }
  if (!existing && !patch.api_base) {
    return invalidRequest(route, "api_base is required when adding an endpoint");
  }
  if (Object.keys(patch).length === 0) {
    return invalidRequest(route, "nothing to change: send api_base and/or api_key");
  }

  const stamp = new Date().toISOString();
  const saved = writeEndpoint(name, {
    ...patch,
    created_at: existing?.created_at ?? stamp,
    updated_at: stamp,
  });
  return { status: 200, body: endpointBody(name, saved) };
}

/** `DELETE /api/models/endpoints/:endpoint`. */
function deleteEndpoint(args = {}) {
  const name = typeof args.params?.endpoint === "string" ? args.params.endpoint.trim() : "";
  if (!readEndpoints()[name]) {
    return notFound(`There's no endpoint '${name}'`);
  }
  writeEndpoint(name, null);
  return { status: 200, body: { deleted: name } };
}

/**
 * `POST /api/credentials` — save (merge) the fields of one credential into
 * `hiveHome()/credentials/vault.json` (0600). The response says what exists,
 * never a value.
 */
async function postCredential(args = {}) {
  const route = routeOf(args, "/api/credentials");
  const parsed = await readJson(args.req ?? {});
  const body = parsed.ok ? parsed.value : null;
  const credentialId = typeof body?.credential_id === "string" ? body.credential_id.trim() : "";
  if (!isSafeCredentialId(credentialId)) {
    return invalidRequest(route, "credential_id must be 1-128 characters of letters, digits, dot, dash, colon or underscore");
  }
  const normalized = normalizeKeys(body?.keys);
  if (normalized.error) return invalidRequest(route, normalized.error);
  saveCredential(credentialId, normalized.keys);
  return { status: 200, body: { saved: credentialId } };
}

/** `DELETE /api/credentials/:credential`. */
function deleteCredential(args = {}) {
  const id = typeof args.params?.credential === "string" ? args.params.credential : "";
  if (!isSafeCredentialId(id)) return notFound(`No credential '${id}'`);
  if (!vaultDeleteCredential(id)) return notFound(`No credential '${id}'`);
  return { status: 200, body: { deleted: true } };
}

/** `POST /api/credentials/local` — a named local account (provider + alias). */
async function postLocalCredential(args = {}) {
  const route = routeOf(args, "/api/credentials/local");
  const parsed = await readJson(args.req ?? {});
  const body = parsed.ok ? parsed.value : null;
  const credentialId = typeof body?.credential_id === "string" ? body.credential_id.trim() : "";
  if (!isSafeCredentialId(credentialId)) {
    return invalidRequest(route, "credential_id must be 1-128 characters of letters, digits, dot, dash, colon or underscore");
  }
  const account = typeof body?.account === "string" ? body.account.trim() : "";
  if (account && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(account)) {
    return invalidRequest(route, "account must be 1-128 characters of letters, digits, dot, dash, colon, at or underscore");
  }
  const normalized = normalizeKeys(body?.keys);
  if (normalized.error) return invalidRequest(route, normalized.error);
  const saved = saveLocal({ credentialId, alias: account, account, keys: normalized.keys });
  return {
    status: 200,
    body: {
      saved: saved.saved,
      status: saved.status,
      identity: saved.identity,
      // No upstream health check runs here, so validity is honestly unknown.
      valid: null,
      message: "stored locally; no health check was run",
    },
  };
}

/** `DELETE /api/credentials/local/:credential/:alias`. */
function deleteLocalCredential(args = {}) {
  const id = typeof args.params?.credential === "string" ? args.params.credential : "";
  const alias = typeof args.params?.alias === "string" ? args.params.alias : "";
  if (!vaultDeleteLocal(id, alias)) return notFound(`No local account '${alias}' for '${id}'`);
  return { status: 200, body: { deleted: true } };
}

/**
 * `POST /api/credentials/resync` — pull the Aden account list.
 *
 * Without `PI_HIVE_ADEN_URL` + `PI_HIVE_ADEN_KEY` there is nothing to sync, and
 * the route says so instead of reporting a fake success.
 */
async function postCredentialResync(args = {}) {
  const route = routeOf(args, "/api/credentials/resync");
  const aden = adenConfig();
  if (!aden) {
    return invalidRequest(
      route,
      "Aden sync is not configured: set PI_HIVE_ADEN_URL and PI_HIVE_ADEN_KEY to resynchronise remote accounts",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${aden.base}/v1/credentials/accounts`, {
      headers: { authorization: `Bearer ${aden.key}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: 502,
        body: { error: `Aden answered ${response.status}`, synced: false, accounts_by_provider: accountsByProvider() },
      };
    }
    const payload = await response.json().catch(() => null);
    const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
    const merged = mergeAdenAccounts(accounts);
    return { status: 200, body: { synced: merged.synced, accounts_by_provider: merged.accounts_by_provider } };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "Aden did not answer within 10 s" : err?.message || String(err);
    return {
      status: 502,
      body: { error: `could not reach Aden: ${reason}`, synced: false, accounts_by_provider: accountsByProvider() },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `POST /api/sessions/:session/credential-form` — the secure form a queen pops
 * when an agent needs a key. Saving stores the secret in the vault and clears
 * the session's park flag; cancelling just clears it. Either way the session is
 * unblocked, which is what the client's `resumed` flag reports.
 */
async function postCredentialForm(args = {}) {
  const route = routeOf(args, "/api/sessions/:session/credential-form");
  const sessionId = typeof args.params?.session === "string" ? args.params.session : "";
  const parsed = await readJson(args.req ?? {});
  const body = parsed.ok ? parsed.value : null;
  const status = body?.status === "cancelled" ? "cancelled" : body?.status === "saved" ? "saved" : null;
  if (!status) return invalidRequest(route, "status must be 'saved' or 'cancelled'");

  const store = new SessionStore();
  const record = store.get(sessionId);
  if (!record) return notFound(`Session '${sessionId}' not found`);

  let saved = null;
  if (status === "saved") {
    const credentialId = typeof body?.credential_id === "string" ? body.credential_id.trim() : "";
    if (!isSafeCredentialId(credentialId)) return invalidRequest(route, "credential_id is required when saving");
    const normalized = normalizeKeys(body?.keys);
    if (normalized.error) return invalidRequest(route, normalized.error);
    const account = typeof body?.account === "string" ? body.account.trim() : "";
    if (account) saveLocal({ credentialId, alias: account, account, keys: normalized.keys });
    else saveCredential(credentialId, normalized.keys);
    saved = credentialId;
  }

  // Clear the park so the loop can continue; the correlation id is the record.
  store.update(sessionId, {
    parked: false,
    park_reason: null,
    credential_form: {
      correlation_id: typeof body?.correlation_id === "string" ? body.correlation_id : null,
      credential_id: saved,
      status,
      at: new Date().toISOString(),
    },
  });
  store.appendEvent(sessionId, {
    type: status === "saved" ? "credential_saved" : "credential_cancelled",
    data: { credential_id: saved, correlation_id: body?.correlation_id ?? null },
  });

  return {
    status: 200,
    body: {
      ...(saved ? { saved } : {}),
      resumed: true,
      status,
    },
  };
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
  ["PUT", "/api/config/llm-sections", putLlmSections, "writes one slot durably; the llm slot drives the runtime for runtimes built afterwards"],
  ["GET", "/api/config/provider-library", getProviderLibrary, "the saved vendor configs, empty until one is PUT"],
  ["PUT", "/api/config/provider-library", putProviderLibrary, "saves (or deletes with null) one named vendor config; api_key is refused"],
  ["POST", "/api/config/provider-library/apply", applyProviderLibrary, "copies a saved entry into a provider slot; 404 for an unknown name"],
  ["GET", "/api/config/external-skills", getExternalSkills, "the saved skill roots with each one's on-disk status"],
  ["PUT", "/api/config/external-skills", putExternalSkills, "replaces the saved skill roots and reports how each resolves"],
  ["PUT", "/api/config/features", putFeatures, "persists the three feature switches; unknown flags are 400 (no behaviour is wired to them here)"],
  ["PUT", "/api/config/llm", putLlmConfig, "switches the model; the saved value outranks the environment for later runtimes"],
  ["PUT", "/api/config/profile", putProfile, "saves display name, about, theme, density and prompt sort"],
  ["GET", "/api/config/rate-limits", getRateLimits, "the saved pacing table, empty until one is PUT"],
  ["PUT", "/api/config/rate-limits", putRateLimits, "replaces the pacing table from a platform:action map, warning on unusable keys"],
  ["POST", "/api/config/profile/avatar", postProfileAvatar, "stores the uploaded picture under the config dir; image types only, 5 MiB cap"],
  ["GET", "/api/config/profile/avatar", getProfileAvatar, "serves the stored avatar bytes; 404 until one is uploaded"],
  ["PUT", "/api/models/slots/:slot", putSlot, "assigns llm/worker_llm/vision_fallback/queen:<id>; only llm swaps live sessions"],
  ["DELETE", "/api/models/slots/:slot", deleteSlot, "clears a slot back to the main model"],
  ["GET", "/api/models/endpoints/:endpoint/models", getEndpointModels, "asks a stored endpoint's /models; 404 unknown, 502 unreachable"],
  ["PUT", "/api/models/endpoints/:endpoint", putEndpoint, "adds or edits a named endpoint; the key is stored 0600 and never echoed"],
  ["DELETE", "/api/models/endpoints/:endpoint", deleteEndpoint, "removes a stored endpoint; 404 for unknown names"],
  ["GET", "/api/credentials/:credential", getCredential, "official 404: pi_hive has no credential vault"],
  ["POST", "/api/credentials", postCredential, "merges one credential into hiveHome()/credentials/vault.json (0600); values are never echoed"],
  ["DELETE", "/api/credentials/:credential", deleteCredential, "deletes a stored credential; 404 for an unknown id"],
  ["POST", "/api/credentials/local", postLocalCredential, "stores a named local account; validity stays null (no health check runs)"],
  ["DELETE", "/api/credentials/local/:credential/:alias", deleteLocalCredential, "deletes one named local account; 404 when absent"],
  ["POST", "/api/credentials/check-agent", postCheckAgent, "empty requirement list; the only model key is process-wide"],
  ["POST", "/api/credentials/resync", postCredentialResync, "pulls the Aden account list when PI_HIVE_ADEN_URL/KEY are set; 400 otherwise"],
  ["GET", "/api/credentials/oauth-status", getOauthStatus, "official OAuth status; no providers, real Aden-key bit"],
  ["POST", "/api/credentials/validate-key", postValidateKey, "local check against the configured pi_hive key; no network"],
  ["POST", "/api/sessions/:session/credential-form", postCredentialForm, "saves the secret into the vault and unparks the session (or cancels)"],
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
