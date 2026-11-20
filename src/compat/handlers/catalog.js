/**
 * Official-frontend catalogue handlers: skills, prompts, memories, agents.
 *
 * The official Hive frontend calls the routes in
 * `core/frontend/src/api/{skills,prompts,memories,agents}.ts`. pi_hive has a
 * real skill store (colony `skills/<name>/SKILL.md` directories) and a real
 * memory store (`<PI_HIVE_HOME>/memory/{global,queens/<id>}` and
 * `colonies/<colony>/memory`), so those routes read and write actual files.
 * It has no prompt library and no separate agents store, so the unsupported
 * mutations answer 400 with an explicit reason instead of a fake success or
 * the compat shell's 501.
 *
 * Queen scoping maps to pi_hive's existing ownership model: a queen's skills
 * are the skills of the colonies whose `metadata.json.queen_id` is that
 * queen. No second skill store is invented. When a queen owns more than one
 * colony, a create request may pass `colony` (a pi_hive extension) to choose
 * the target; without it the request is rejected as ambiguous.
 *
 * The skill enable/notes state the official PATCH route carries has no
 * pi_hive runtime equivalent. It is persisted in a per-colony
 * `.skill-overrides.json` sidecar so the UI round-trips honestly; the pi_hive
 * queen prompts still read every SKILL.md. That limitation is reported as a
 * gap rather than hidden.
 *
 * Every handler returns a `{status, body}` descriptor and never writes to
 * `res`. `registerCatalogRoutes(registry, ctx)` binds all routes; a per-call
 * `ctx` wins over the registration-time one.
 */

import fs from "node:fs";
import path from "node:path";

import { coloniesDir, colonyDir, hiveHome } from "../../config.js";
import { colonyPaths, loadMetadata, saveMetadata } from "../../domain/colony.js";
import { listSkills } from "../../domain/skills.js";
import { createPrompt as storeCreatePrompt, deletePrompt as storeDeletePrompt, listPrompts as storeListPrompts } from "../../domain/prompt-store.js";
import {
  decideRequest as decideInstallRequest,
  installSkill as installLibrarySkill,
  listLibrarySkills,
  normalizeSkillName,
  parseSkillMarkdown,
  queueRequest as queueInstallRequest,
  readRequests as readInstallRequests,
  validSkillName,
} from "../../domain/skill-library.js";
import { parseMultipart, readRawBody } from "./sessions.js";
import { ROUTE_STATUS } from "../router.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches src/config.js `colonyDir()`; invalid directories are not colonies. */
const COLONY_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Queen ids used by pi_hive's built-in identities. */
const BUILT_IN_QUEEN_IDS = Object.freeze([
  "queen_growth",
  "queen_tech",
  "queen_finance",
  "queen_ops",
]);
/** Official skill-name shape (core/framework/skills/skill_writer.py). */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Official source-scope label for a skill found in a colony's skills/ dir. */
const COLONY_SKILL_SCOPE = "colony_ui";
/** Official `queen_created` provenance is what colony-authored skills are. */
const COLONY_SKILL_PROVENANCE = "queen_created";
/** `queen_memory_v2.MAX_FILE_SIZE_BYTES`. */
const MAX_MEMORY_BYTES = 4096;
/** Same cap the official upload endpoint enforces. */
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** Per-colony sidecar for the official PATCH enable/notes state. */
const SKILL_OVERRIDES_FILE = ".skill-overrides.json";

const FULL = "full";
const LIMITED = "limited";

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ok(body, status = 200) {
  return { status, body };
}

function fail(status, error) {
  return { status, body: { error } };
}

function failUnsupported(error) {
  return { status: 400, body: { error, type: "unsupported" } };
}

/** Translate thrown errors into descriptors; unexpected errors stay visible. */
function guarded(fn) {
  return async (args = {}) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      return fail(500, err?.message || "internal error");
    }
  };
}

function requestUrl(args) {
  const raw = args?.req?.url;
  return new URL(typeof raw === "string" && raw ? raw : "/", "http://localhost");
}

/**
 * Read a query parameter from `args.query` (test harness) or the request URL
 * (the real server passes only `req`). Returns null when absent.
 */
function queryParam(args, name) {
  const injected = args?.query;
  if (injected && typeof injected.get === "function") return injected.get(name);
  if (isPlainObject(injected) && Object.prototype.hasOwnProperty.call(injected, name)) {
    const value = injected[name];
    return value === undefined || value === null ? null : String(value);
  }
  return requestUrl(args).searchParams.get(name);
}

function parseJsonText(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/**
 * The compat server does not pre-parse request bodies, so handlers read them
 * here. Tests inject `req.body`; a real node:http IncomingMessage is consumed
 * as an async iterable. A body over the official 2 MB cap is a 413.
 */
async function readJsonBody(req) {
  if (!req) throw new HttpError(400, "invalid JSON body");

  if (Object.prototype.hasOwnProperty.call(req, "body")) {
    const injected = req.body;
    if (injected === undefined || injected === null) return {};
    if (Buffer.isBuffer(injected)) return parseJsonText(injected.toString("utf8"));
    if (typeof injected === "string") return parseJsonText(injected);
    if (typeof injected === "object") return injected;
    throw new HttpError(400, "invalid JSON body");
  }

  if (typeof req[Symbol.asyncIterator] !== "function") return {};

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, `request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return parseJsonText(Buffer.concat(chunks).toString("utf8"));
}

async function readObjectBody(req) {
  const body = await readJsonBody(req);
  if (!isPlainObject(body)) throw new HttpError(400, "JSON body must be an object");
  return body;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function readJsonFile(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return isPlainObject(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Parse the simple `key: value` frontmatter pi_hive writes. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ""));
  if (!match) return { meta: {}, body: String(text ?? "") };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: match[2] };
}

function listColonyNames() {
  let entries;
  try {
    entries = fs.readdirSync(coloniesDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && COLONY_NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function readColonyMeta(colony) {
  try {
    const meta = loadMetadata(colony);
    return isPlainObject(meta) ? meta : null;
  } catch {
    return null;
  }
}

function listColonySkills(colony) {
  try {
    return listSkills(colony)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function allSkillEntries() {
  const out = [];
  for (const colony of listColonyNames()) {
    for (const skill of listColonySkills(colony)) out.push({ colony, skill });
  }
  return out;
}

function findSkillAnywhere(name) {
  for (const entry of allSkillEntries()) if (entry.skill.name === name) return entry;
  return null;
}

// ---------------------------------------------------------------------------
// Skill names
// ---------------------------------------------------------------------------

/** Validate a skill name before it is used as a directory component. */
function validateSkillName(raw) {
  if (typeof raw !== "string") return { error: "skill name is required" };
  const name = raw.trim();
  if (!name) return { error: "skill name is required" };
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return { error: `skill name '${name}' must not contain path separators` };
  }
  if (!SKILL_NAME_RE.test(name)) {
    return { error: `skill name '${name}' must match [a-z0-9][a-z0-9._-] and be <=64 chars` };
  }
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return { error: `skill name '${name}' has leading/trailing/consecutive hyphens` };
  }
  return { name };
}

function validateSkillDescription(raw, { required = true } = {}) {
  if (raw === undefined || raw === null) {
    return required ? { error: "description is required" } : { description: null };
  }
  if (typeof raw !== "string") return { error: "description must be a string" };
  const description = raw.trim();
  if (!description) return { error: "description is required" };
  if (description.length > 1024) return { error: "description must be <=1024 chars" };
  if (/[\r\n]/.test(description)) return { error: "description must be a single line" };
  return { description };
}

function validateSkillBody(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "body is required" };
  return { body: raw };
}

function normalizeSkillFiles(raw) {
  if (raw === undefined || raw === null) return { files: [] };
  if (!Array.isArray(raw)) return { error: "files must be an array" };
  if (raw.length > 50) return { error: "files must contain at most 50 entries" };
  const files = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return { error: "each files entry must be an object" };
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      return { error: "each files entry needs a non-empty path" };
    }
    if (typeof entry.content !== "string") {
      return { error: `file '${entry.path}' needs string content` };
    }
    let rel = entry.path.trim().replace(/\\/g, "/");
    if (rel.startsWith("./")) rel = rel.slice(2);
    if (rel.startsWith("/") || rel.includes("\0")) {
      return { error: `file path '${entry.path}' must be relative` };
    }
    const parts = rel.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      return { error: `file path '${entry.path}' must stay inside the skill folder` };
    }
    if (rel === "SKILL.md") {
      return { error: "files must not contain SKILL.md; pass body instead" };
    }
    files.push({ path: rel, content: entry.content });
  }
  return { files };
}

function skillMarkdown({ name, description, body }) {
  const trimmed = String(body).replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${trimmed}\n`;
}

function writeSkillDocument(skillDir, { name, description, body }) {
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(file, skillMarkdown({ name, description, body }));
  return file;
}

function writeExtraFiles(skillDir, files) {
  for (const file of files) {
    const target = path.join(skillDir, ...file.path.split("/"));
    const root = path.resolve(skillDir);
    if (!path.resolve(target).startsWith(`${root}${path.sep}`)) {
      throw new HttpError(400, `file path '${file.path}' escapes the skill folder`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
}

// ---------------------------------------------------------------------------
// Queen scoping + overrides
// ---------------------------------------------------------------------------

function queensFromColonies() {
  const ids = new Set(BUILT_IN_QUEEN_IDS);
  for (const colony of listColonyNames()) {
    const meta = readColonyMeta(colony);
    if (meta && typeof meta.queen_id === "string" && meta.queen_id.trim()) {
      ids.add(meta.queen_id.trim());
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function ownedColonies(queenId) {
  return listColonyNames().filter((colony) => {
    const meta = readColonyMeta(colony);
    return Boolean(meta && meta.queen_id === queenId);
  });
}

function isKnownQueen(queenId) {
  return queensFromColonies().includes(queenId);
}

function skillOverridesPath(colony) {
  return path.join(colonyPaths(colony).dir, SKILL_OVERRIDES_FILE);
}

function loadSkillOverrides(colony) {
  const data = readJsonFile(skillOverridesPath(colony), {});
  const skills = isPlainObject(data.skills) ? data.skills : {};
  return {
    all_defaults_disabled: data.all_defaults_disabled === true,
    skills,
  };
}

function saveSkillOverrides(colony, store) {
  writeJsonFile(skillOverridesPath(colony), {
    all_defaults_disabled: store.all_defaults_disabled === true,
    skills: isPlainObject(store.skills) ? store.skills : {},
  });
}

function overrideFor(store, name) {
  const entry = store?.skills?.[name];
  return isPlainObject(entry) ? entry : null;
}

function skillRowFor(colony, skill, queenId, store) {
  const entry = overrideFor(store, skill.name);
  const enabled = typeof entry?.enabled === "boolean" ? entry.enabled : true;
  const notes = typeof entry?.notes === "string" ? entry.notes : null;
  const paramOverrides = isPlainObject(entry?.param_overrides) ? { ...entry.param_overrides } : {};
  const baseDir = path.dirname(skill.path);
  return {
    name: skill.name,
    description: skill.description || "",
    source_scope: COLONY_SKILL_SCOPE,
    provenance: COLONY_SKILL_PROVENANCE,
    enabled,
    editable: true,
    deletable: true,
    location: skill.path,
    base_dir: baseDir,
    visibility: null,
    trust: null,
    created_at: null,
    created_by: null,
    notes,
    param_overrides: paramOverrides,
    owner: { type: "colony", id: colony, name: colony },
    visible_to: { queens: [queenId], colonies: [colony] },
    enabled_by_default: true,
  };
}

function buildQueenSkills(queenId) {
  const owned = ownedColonies(queenId);
  const stores = new Map(owned.map((colony) => [colony, loadSkillOverrides(colony)]));
  const rows = [];
  const seen = new Set();

  for (const colony of owned) {
    for (const skill of listColonySkills(colony)) {
      // The official manager exposes one row per skill name per scope; a
      // duplicate colony copy is not a second row. The first colony wins.
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      rows.push(skillRowFor(colony, skill, queenId, stores.get(colony)));
    }
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const allDefaultsDisabled =
    owned.length > 0 && owned.every((colony) => stores.get(colony).all_defaults_disabled === true);

  return {
    queen_id: queenId,
    all_defaults_disabled: allDefaultsDisabled,
    skills: rows,
  };
}

function findQueenSkill(queenId, name, colonyFilter = null) {
  // Only colonies this queen actually owns are searchable; an explicit
  // `colony` must not let one queen mutate another queen's skill.
  const owned = ownedColonies(queenId);
  const colonies = colonyFilter ? owned.filter((colony) => colony === colonyFilter) : owned;
  for (const colony of colonies) {
    const skill = listColonySkills(colony).find((entry) => entry.name === name);
    if (skill) return { colony, skill };
  }
  return null;
}

/** Resolve the colony a queen-scoped create should write into. */
function resolveCreateColony(queenId, payload, ctx) {
  const owned = ownedColonies(queenId);
  const explicit = payload?.colony ?? payload?.colony_id ?? payload?.target_colony;

  if (explicit !== undefined && explicit !== null && explicit !== "") {
    if (typeof explicit !== "string") return { error: "colony must be a string", status: 400 };
    if (!owned.includes(explicit)) {
      return {
        error: `colony '${explicit}' is not owned by queen '${queenId}'`,
        status: 400,
      };
    }
    return { colony: explicit };
  }

  const resolver = ctx?.resolveColonyForQueen ?? ctx?.colonyForQueen;
  if (typeof resolver === "function") {
    let picked;
    try {
      picked = resolver(queenId, ctx);
    } catch {
      picked = null;
    }
    if (typeof picked === "string" && owned.includes(picked)) return { colony: picked };
  }

  if (owned.length === 1) return { colony: owned[0] };
  if (owned.length === 0) {
    return {
      error: `queen '${queenId}' owns no colonies; create a colony before adding a skill`,
      status: 400,
    };
  }
  return {
    error: `queen '${queenId}' owns ${owned.length} colonies; pass 'colony' to choose one`,
    status: 400,
  };
}

// ---------------------------------------------------------------------------
// Skill route handlers
// ---------------------------------------------------------------------------

async function getSkillScopes() {
  const colonies = listColonyNames().map((name) => {
    const meta = readColonyMeta(name);
    return {
      name,
      queen_id: meta && typeof meta.queen_id === "string" ? meta.queen_id : null,
    };
  });
  return ok({
    queens: queensFromColonies().map((id) => ({ id, name: id })),
    colonies,
  });
}

async function getSkillDetail(args) {
  const result = validateSkillName(args.params?.skill);
  if (result.error) return fail(400, result.error);

  const match = findSkillAnywhere(result.name);
  if (!match) return fail(404, `skill '${result.name}' not found`);

  // The official scope-less detail endpoint returns the SKILL.md text as-is,
  // frontmatter included.
  let raw;
  try {
    raw = fs.readFileSync(match.skill.path, "utf8");
  } catch (err) {
    return fail(500, `failed to read ${match.skill.path}: ${err.message}`);
  }

  return ok({
    name: match.skill.name,
    description: match.skill.description || "",
    source_scope: COLONY_SKILL_SCOPE,
    location: match.skill.path,
    base_dir: path.dirname(match.skill.path),
    body: raw,
    visibility: null,
  });
}

/**
 * `POST /api/skills/upload` — multipart SKILL.md into the shared library
 * (`hiveHome()/skills/<name>`). A `session_id` field queues an install request
 * for that session instead of installing, which is how a queen's proposal
 * reaches the user. `.zip` bundles are refused: this host stores text files.
 */
async function uploadSkill(args) {
  let parts;
  try {
    parts = parseMultipart(await readRawBody(args.req), args.req?.headers?.["content-type"]);
  } catch (err) {
    return fail(400, err?.message || "expected multipart/form-data with a file");
  }
  const filePart = parts.find((part) => (part.name === "file" || part.name === "files") && part.data?.length);
  if (!filePart) return fail(400, "multipart field 'file' is required");
  const fileName = String(filePart.filename || "");
  if (/\.zip$/i.test(fileName)) {
    return fail(400, "zip bundles are not supported: upload a SKILL.md (optionally with extra text files)");
  }
  const parsed = parseSkillMarkdown(filePart.data.toString("utf8"));
  const name = normalizeSkillName(parsed.name || fileName.replace(/\.md$/i, ""));
  if (!name) return fail(400, "could not read a skill name from the upload");
  if (!validSkillName(name)) {
    return fail(400, `skill name must be 1-64 characters of letters, digits, dash or underscore: '${name}'`);
  }
  const description = parsed.description || name;
  const sessionId = parts.find((part) => part.name === "session_id")?.data?.toString("utf8").trim();
  const extra = parts
    .filter((part) => part !== filePart && part.filename && part.data?.length)
    .map((part) => ({ path: String(part.filename).replace(/^\.\//, ""), content: part.data.toString("utf8") }));

  if (sessionId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return fail(400, `invalid session id '${sessionId}'`);
    const request = queueInstallRequest(sessionId, { name, description, body: parsed.body, files: extra });
    return ok({
      name,
      installed_path: "",
      replaced: request.replaces,
      scope: "session",
      target_id: sessionId,
      enabled: false,
    });
  }

  try {
    const installed = installLibrarySkill({ name, description, body: parsed.body, files: extra });
    return ok({
      name,
      installed_path: installed.installed_path,
      replaced: installed.replaced,
      scope: "global",
      target_id: null,
      enabled: true,
    });
  } catch (err) {
    return fail(400, err.message);
  }
}

async function getQueenSkills(args) {
  const queenId = args.params?.queen;
  if (typeof queenId !== "string" || !queenId.trim()) return fail(400, "queen is required");
  if (!isKnownQueen(queenId)) return fail(404, `queen '${queenId}' not found`);
  return ok(buildQueenSkills(queenId));
}

async function createQueenSkill(args, ctx) {
  const queenId = args.params?.queen;
  if (!isKnownQueen(queenId)) return fail(404, `queen '${queenId}' not found`);

  const payload = await readObjectBody(args.req);

  const nameResult = validateSkillName(payload.name);
  if (nameResult.error) return fail(400, nameResult.error);
  const descriptionResult = validateSkillDescription(payload.description);
  if (descriptionResult.error) return fail(400, descriptionResult.error);
  const bodyResult = validateSkillBody(payload.body);
  if (bodyResult.error) return fail(400, bodyResult.error);
  const filesResult = normalizeSkillFiles(payload.files);
  if (filesResult.error) return fail(400, filesResult.error);

  let enabled = true;
  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== "boolean") return fail(400, "'enabled' must be a boolean");
    enabled = payload.enabled;
  }

  const target = resolveCreateColony(queenId, payload, ctx);
  if (target.error) return fail(target.status, target.error);

  const name = nameResult.name;
  const skillsRoot = colonyPaths(target.colony).skills;
  const skillDir = path.join(skillsRoot, name);
  const existed = fs.existsSync(skillDir);
  const replace = payload.replace_existing === true;

  if (existed && !replace) return fail(409, `skill '${name}' already exists`);

  if (existed) fs.rmSync(skillDir, { recursive: true, force: true });
  const installedPath = writeSkillDocument(skillDir, {
    name,
    description: descriptionResult.description,
    body: bodyResult.body,
  });
  writeExtraFiles(skillDir, filesResult.files);

  const store = loadSkillOverrides(target.colony);
  store.skills[name] = {
    enabled,
    param_overrides: {},
    notes: typeof payload.notes === "string" ? payload.notes : null,
  };
  saveSkillOverrides(target.colony, store);

  const written = listColonySkills(target.colony).find((skill) => skill.name === name);
  const row = written
    ? skillRowFor(target.colony, written, queenId, store)
    : {
        ...skillRowFor(
          target.colony,
          { name, description: descriptionResult.description, path: installedPath, body: bodyResult.body },
          queenId,
          store,
        ),
      };

  return ok(
    {
      ...row,
      installed_path: installedPath,
      replaced: existed,
      enabled,
      provenance: COLONY_SKILL_PROVENANCE,
    },
    201,
  );
}

async function patchQueenSkill(args) {
  const queenId = args.params?.queen;
  if (!isKnownQueen(queenId)) return fail(404, `queen '${queenId}' not found`);

  const nameResult = validateSkillName(args.params?.skill);
  if (nameResult.error) return fail(400, nameResult.error);

  const payload = await readObjectBody(args.req);
  const hasEnabled = Object.prototype.hasOwnProperty.call(payload, "enabled");
  const hasParamOverrides = Object.prototype.hasOwnProperty.call(payload, "param_overrides");
  const hasNotes = Object.prototype.hasOwnProperty.call(payload, "notes");
  const hasAllDefaults = Object.prototype.hasOwnProperty.call(payload, "all_defaults_disabled");

  if (!hasEnabled && !hasParamOverrides && !hasNotes && !hasAllDefaults) {
    return fail(400, "no editable fields provided");
  }
  if (hasEnabled && typeof payload.enabled !== "boolean") {
    return fail(400, "'enabled' must be a boolean");
  }
  if (hasParamOverrides && !isPlainObject(payload.param_overrides)) {
    return fail(400, "'param_overrides' must be an object");
  }
  if (hasAllDefaults && typeof payload.all_defaults_disabled !== "boolean") {
    return fail(400, "'all_defaults_disabled' must be a boolean");
  }

  const colonyParam =
    typeof payload.colony === "string" && payload.colony
      ? payload.colony
      : queryParam(args, "colony");
  const entry = findQueenSkill(queenId, nameResult.name, colonyParam || null);
  if (!entry) return fail(404, `skill '${nameResult.name}' not found`);

  // `all_defaults_disabled` is a queen-level switch in the official store;
  // persist it on every colony this queen owns.
  if (hasAllDefaults) {
    for (const colony of ownedColonies(queenId)) {
      const store = loadSkillOverrides(colony);
      store.all_defaults_disabled = payload.all_defaults_disabled;
      saveSkillOverrides(colony, store);
    }
  }

  const store = loadSkillOverrides(entry.colony);
  const updated = overrideFor(store, nameResult.name) || {
    enabled: null,
    param_overrides: {},
    notes: null,
  };
  if (hasEnabled) updated.enabled = payload.enabled;
  if (hasParamOverrides) updated.param_overrides = { ...payload.param_overrides };
  if (hasNotes && (typeof payload.notes === "string" || payload.notes === null)) {
    updated.notes = payload.notes;
  }
  store.skills[nameResult.name] = updated;
  saveSkillOverrides(entry.colony, store);

  return ok({
    name: nameResult.name,
    enabled: typeof updated.enabled === "boolean" ? updated.enabled : null,
    ok: true,
  });
}

async function getQueenSkillBody(args) {
  const queenId = args.params?.queen;
  if (!isKnownQueen(queenId)) return fail(404, `queen '${queenId}' not found`);

  const nameResult = validateSkillName(args.params?.skill);
  if (nameResult.error) return fail(400, nameResult.error);

  const colonyParam = queryParam(args, "colony");
  const entry = findQueenSkill(queenId, nameResult.name, colonyParam || null);
  if (!entry) return fail(404, `skill '${nameResult.name}' not found`);

  // Round-trips through PUT .../body, which re-adds frontmatter. The
  // official parser strips the body, so trailing whitespace is not surfaced.
  const body = String(entry.skill.body || "").trim();
  return ok({
    name: entry.skill.name,
    description: entry.skill.description || "",
    source_scope: COLONY_SKILL_SCOPE,
    location: entry.skill.path,
    base_dir: path.dirname(entry.skill.path),
    body,
    visibility: null,
    editable: true,
  });
}

async function putQueenSkillBody(args) {
  const queenId = args.params?.queen;
  if (!isKnownQueen(queenId)) return fail(404, `queen '${queenId}' not found`);

  const nameResult = validateSkillName(args.params?.skill);
  if (nameResult.error) return fail(400, nameResult.error);

  const payload = await readObjectBody(args.req);
  const bodyResult = validateSkillBody(payload.body);
  if (bodyResult.error) return fail(400, bodyResult.error);
  const filesResult = normalizeSkillFiles(payload.files);
  if (filesResult.error) return fail(400, filesResult.error);

  const colonyParam = queryParam(args, "colony");
  const entry = findQueenSkill(queenId, nameResult.name, colonyParam || null);
  if (!entry) return fail(404, `skill '${nameResult.name}' not found`);

  let description;
  if (payload.description !== undefined) {
    const descResult = validateSkillDescription(payload.description);
    if (descResult.error) return fail(400, descResult.error);
    description = descResult.description;
  } else {
    let current = "";
    try {
      current = fs.readFileSync(entry.skill.path, "utf8");
    } catch {
      current = "";
    }
    description = parseFrontmatter(current).meta.description || entry.skill.description || "";
  }
  if (!description) return fail(400, "description is required");

  const skillDir = path.dirname(entry.skill.path);
  const installedPath = writeSkillDocument(skillDir, {
    name: entry.skill.name,
    description,
    body: bodyResult.body,
  });
  writeExtraFiles(skillDir, filesResult.files);

  return ok({ name: entry.skill.name, installed_path: installedPath });
}

async function renameQueenSkill(args) {
  const queenId = args.params?.queen;
  if (!isKnownQueen(queenId)) return fail(404, `queen '${queenId}' not found`);

  const oldResult = validateSkillName(args.params?.skill);
  if (oldResult.error) return fail(400, oldResult.error);

  const payload = await readObjectBody(args.req);
  const newResult = validateSkillName(payload.new_name);
  if (newResult.error) return fail(400, newResult.error);
  if (newResult.name === oldResult.name) {
    return fail(400, "new_name matches the current name");
  }

  const colonyParam =
    typeof payload.colony === "string" && payload.colony
      ? payload.colony
      : queryParam(args, "colony");
  const entry = findQueenSkill(queenId, oldResult.name, colonyParam || null);
  if (!entry) return fail(404, `skill '${oldResult.name}' not found`);

  const oldDir = path.dirname(entry.skill.path);
  const skillsRoot = path.dirname(oldDir);
  const newDir = path.join(skillsRoot, newResult.name);

  if (!fs.existsSync(oldDir)) {
    return fail(404, `skill '${oldResult.name}' has no directory`);
  }
  if (fs.existsSync(newDir)) return fail(409, `skill '${newResult.name}' already exists`);

  try {
    fs.renameSync(oldDir, newDir);
  } catch (err) {
    return fail(500, `failed to rename skill folder: ${err.message}`);
  }

  const skillMd = path.join(newDir, "SKILL.md");
  try {
    const text = fs.readFileSync(skillMd, "utf8");
    const patched = text.replace(/^name:\s*.*$/m, `name: ${newResult.name}`);
    if (patched !== text) fs.writeFileSync(skillMd, patched);
  } catch (err) {
    // Roll the directory back rather than leave a dir/frontmatter mismatch.
    try {
      fs.renameSync(newDir, oldDir);
    } catch {
      // Best effort only.
    }
    return fail(500, `failed to update SKILL.md: ${err.message}`);
  }

  const store = loadSkillOverrides(entry.colony);
  if (isPlainObject(store.skills[oldResult.name])) {
    store.skills[newResult.name] = store.skills[oldResult.name];
    delete store.skills[oldResult.name];
    saveSkillOverrides(entry.colony, store);
  }

  return ok({ old_name: oldResult.name, new_name: newResult.name, ok: true });
}

async function deleteQueenSkill(args) {
  const queenId = args.params?.queen;
  if (!isKnownQueen(queenId)) return fail(404, `queen '${queenId}' not found`);

  const nameResult = validateSkillName(args.params?.skill);
  if (nameResult.error) return fail(400, nameResult.error);

  const colonyParam = queryParam(args, "colony");
  const entry = findQueenSkill(queenId, nameResult.name, colonyParam || null);
  if (!entry) return fail(404, `skill '${nameResult.name}' not found`);

  const skillDir = path.dirname(entry.skill.path);
  try {
    fs.rmSync(skillDir, { recursive: true, force: true });
  } catch (err) {
    return fail(500, `failed to remove skill folder: ${err.message}`);
  }

  const store = loadSkillOverrides(entry.colony);
  if (isPlainObject(store.skills[nameResult.name])) {
    delete store.skills[nameResult.name];
    saveSkillOverrides(entry.colony, store);
  }

  return ok({ name: nameResult.name, removed: true });
}

async function reloadQueenSkills(args) {
  const queenId = args.params?.queen;
  if (!isKnownQueen(queenId)) return fail(404, `queen '${queenId}' not found`);
  // pi_hive's skill listing reads disk on each call and keeps no runtime
  // cache, so a reload is already reflected on the next GET.
  return ok({ ok: true, target: queenId, kind: "queen" });
}

// ---------------------------------------------------------------------------
// Skill install requests (no pi_hive queue exists)
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function listSkillInstalls(args) {
  const sessionId = args.params?.session;
  if (!SESSION_ID_RE.test(String(sessionId || ""))) {
    return fail(400, `invalid session id '${sessionId || ""}'`);
  }
  return ok({ requests: readInstallRequests(sessionId) });
}

async function decideSkillInstall(args) {
  const sessionId = args.params?.session;
  const installId = args.params?.install;
  if (!SESSION_ID_RE.test(String(sessionId || ""))) {
    return fail(400, `invalid session id '${sessionId || ""}'`);
  }
  if (!SESSION_ID_RE.test(String(installId || ""))) {
    return fail(400, `invalid install request id '${installId || ""}'`);
  }

  const payload = await readObjectBody(args.req);
  if (payload.decision !== "approve" && payload.decision !== "deny") {
    return fail(400, "decision must be 'approve' or 'deny'");
  }

  let decided;
  try {
    decided = decideInstallRequest(sessionId, installId, payload.decision);
  } catch (err) {
    return fail(400, err.message);
  }
  if (!decided) return fail(404, `install request '${installId}' not found`);
  return ok({
    name: decided.request.name,
    decision: payload.decision,
    // No inbound channel tells a queen about the decision; the queue is the record.
    queen_told: false,
    installed_path: decided.installed?.installed_path ?? null,
  });
}

// ---------------------------------------------------------------------------
// Prompts (real custom_prompts store under hiveHome()/prompts)
// ---------------------------------------------------------------------------

async function listPrompts() {
  return ok({ prompts: storeListPrompts() });
}

async function createPrompt(args) {
  const payload = await readObjectBody(args.req);
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const content = typeof payload.content === "string" ? payload.content : "";
  if (!title || !content.trim()) return fail(400, "Title and content are required");
  if (payload.skills !== undefined && !Array.isArray(payload.skills)) {
    return fail(400, "skills must be a list of skill names");
  }
  if (payload.tags !== undefined && !Array.isArray(payload.tags)) {
    return fail(400, "tags must be a list of strings");
  }
  const entry = storeCreatePrompt({
    title,
    category: payload.category,
    content,
    skills: payload.skills,
    tags: payload.tags,
  });
  return { status: 200, body: entry };
}

async function deletePrompt(args) {
  const id = String(args?.params?.prompt ?? "");
  if (!id) return fail(400, "prompt id is required");
  if (!storeDeletePrompt(id)) return fail(404, `Prompt '${id}' not found`);
  return ok({ deleted: id });
}

// ---------------------------------------------------------------------------
// Memories (real pi_hive files)
// ---------------------------------------------------------------------------

function memoryRoots() {
  return {
    global: path.join(hiveHome(), "memory", "global"),
    queens: path.join(hiveHome(), "memory", "queens"),
  };
}

function memoryScopeFromParts(parts) {
  if (parts.length === 2 && parts[0] === "global") {
    return {
      rel: parts.join("/"),
      root: memoryRoots().global,
      scope: "global",
      scope_name: "",
      filename: parts[1],
    };
  }
  if (parts.length === 4 && parts[0] === "agents" && parts[1] === "queens") {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(parts[2])) return null;
    return {
      rel: parts.join("/"),
      root: path.join(memoryRoots().queens, parts[2]),
      scope: "queen",
      scope_name: parts[2],
      filename: parts[3],
    };
  }
  if (parts.length === 3 && parts[0] === "colonies") {
    if (!COLONY_NAME_RE.test(parts[1])) return null;
    return {
      rel: parts.join("/"),
      root: path.join(colonyDir(parts[1]), "memory"),
      scope: "colony",
      scope_name: parts[1],
      filename: parts[2],
    };
  }
  return null;
}

/** Resolve a memory `path` query to a real file, refusing traversal/symlinks. */
function resolveMemoryPath(rel) {
  if (typeof rel !== "string" || !rel) return null;
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  const filename = parts[parts.length - 1];
  if (!filename.endsWith(".md") || filename.startsWith(".")) return null;

  const scope = memoryScopeFromParts(parts);
  if (!scope) return null;

  const root = path.resolve(scope.root);
  const target = path.resolve(root, filename);
  if (!target.startsWith(`${root}${path.sep}`)) return null;

  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { ...scope, target, exists: false };
  }
  if (!stat.isFile()) return null;
  return { ...scope, target, exists: true, stat };
}

function memoryEntry(resolved, includeContent = false) {
  let text = "";
  let stat = resolved.stat;
  if (!stat) {
    try {
      stat = fs.lstatSync(resolved.target);
    } catch {
      stat = null;
    }
  }
  try {
    text = fs.readFileSync(resolved.target, "utf8");
  } catch {
    return null;
  }
  const { meta } = parseFrontmatter(text);
  const entry = {
    path: resolved.rel,
    filename: resolved.filename,
    name: typeof meta.name === "string" ? meta.name : null,
    type: typeof meta.type === "string" ? meta.type : null,
    description: typeof meta.description === "string" ? meta.description : null,
    scope: resolved.scope,
    scope_name: resolved.scope_name,
    mtime: stat ? Math.floor(stat.mtimeMs / 1000) : 0,
  };
  if (includeContent) entry.content = text;
  return entry;
}

function memoryFilesIn(root, makeRel) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
    const target = path.join(root, entry.name);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let text;
    try {
      text = fs.readFileSync(target, "utf8");
    } catch {
      continue;
    }
    const { meta } = parseFrontmatter(text);
    out.push({
      path: makeRel(entry.name),
      filename: entry.name,
      name: typeof meta.name === "string" ? meta.name : null,
      type: typeof meta.type === "string" ? meta.type : null,
      description: typeof meta.description === "string" ? meta.description : null,
      scope: null,
      scope_name: "",
      mtime: Math.floor(stat.mtimeMs / 1000),
    });
  }
  return out;
}

function listMemoryEntries() {
  const entries = [];

  for (const item of memoryFilesIn(memoryRoots().global, (file) => `global/${file}`)) {
    entries.push({ ...item, scope: "global", scope_name: "" });
  }

  let queenDirs = [];
  try {
    queenDirs = fs
      .readdirSync(memoryRoots().queens, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]{1,64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    queenDirs = [];
  }
  for (const queen of queenDirs) {
    const root = path.join(memoryRoots().queens, queen);
    for (const item of memoryFilesIn(root, (file) => `agents/queens/${queen}/${file}`)) {
      entries.push({ ...item, scope: "queen", scope_name: queen });
    }
  }

  for (const colony of listColonyNames()) {
    const root = path.join(colonyDir(colony), "memory");
    for (const item of memoryFilesIn(root, (file) => `colonies/${colony}/${file}`)) {
      entries.push({ ...item, scope: "colony", scope_name: colony });
    }
  }

  entries.sort(
    (a, b) =>
      String(a.scope).localeCompare(String(b.scope)) ||
      String(a.scope_name).localeCompare(String(b.scope_name)) ||
      b.mtime - a.mtime ||
      a.path.localeCompare(b.path),
  );
  return entries;
}

async function listMemories() {
  return ok({ memories: listMemoryEntries() });
}

async function getMemory(args) {
  const rel = queryParam(args, "path");
  if (!rel) return fail(400, "path query parameter is required");
  const resolved = resolveMemoryPath(rel);
  if (!resolved) return fail(400, "Invalid path");
  if (!resolved.exists) return fail(404, "Memory not found");

  const entry = memoryEntry(resolved, true);
  if (!entry) return fail(500, "Could not read memory");
  return ok(entry);
}

async function updateMemory(args) {
  const rel = queryParam(args, "path");
  if (!rel) return fail(400, "path query parameter is required");
  const resolved = resolveMemoryPath(rel);
  if (!resolved) return fail(400, "Invalid path");
  if (!resolved.exists) return fail(404, "Memory not found");

  const payload = await readObjectBody(args.req);
  if (typeof payload.content !== "string" || !payload.content.trim()) {
    return fail(400, "Content must be a non-empty string");
  }
  if (Buffer.byteLength(payload.content, "utf8") > MAX_MEMORY_BYTES) {
    return fail(400, `Memory exceeds the ${MAX_MEMORY_BYTES}-byte limit`);
  }

  let content = payload.content;
  if (!content.endsWith("\n")) content += "\n";
  try {
    fs.writeFileSync(resolved.target, content);
  } catch (err) {
    return fail(500, `Could not write memory: ${err.message}`);
  }

  const entry = memoryEntry({ ...resolved, stat: null }, true);
  if (!entry) return fail(500, "Could not read memory");
  entry.content = content;
  return ok(entry);
}

async function deleteMemory(args) {
  const rel = queryParam(args, "path");
  if (!rel) return fail(400, "path query parameter is required");
  const resolved = resolveMemoryPath(rel);
  if (!resolved) return fail(400, "Invalid path");
  if (!resolved.exists) return fail(404, "Memory not found");

  try {
    fs.unlinkSync(resolved.target);
  } catch (err) {
    return fail(500, `Could not delete memory: ${err.message}`);
  }
  return ok({ deleted: resolved.rel });
}

// ---------------------------------------------------------------------------
// Agents (a pi_hive agent is a colony directory)
// ---------------------------------------------------------------------------

/**
 * Map an official `agent_path` onto the colony it names. Discovery reports
 * `colonies/<name>`; the desktop may also hand back `agents/<name>` or a path
 * from another machine, so compare basenames against real colony dirs instead
 * of string-equality on the absolute path.
 */
function resolveAgentPath(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "agent_path is required" };
  const cleaned = raw.trim().replace(/[\\/]+$/, "");
  const base = path.basename(cleaned);
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(base)) {
    return { error: `agent_path is not a colony directory: ${raw}` };
  }
  const colonyD = colonyDir(base);
  const agentD = path.join(hiveHome(), "agents", base);
  if (!fs.existsSync(colonyD) && !fs.existsSync(agentD)) {
    return { error: `no agent at ${raw}`, status: 404 };
  }
  return { name: base, colonyDir: colonyD, agentDir: agentD };
}

async function deleteAgent(args) {
  const payload = await readObjectBody(args.req);
  const resolved = resolveAgentPath(payload.agent_path);
  if (resolved.error) return fail(resolved.status ?? 400, resolved.error);
  const purge = payload.purge === true;

  if (purge) {
    for (const dir of [resolved.colonyDir, resolved.agentDir]) {
      if (!fs.existsSync(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        return fail(500, `failed to purge ${dir}: ${err.message}`);
      }
    }
    return ok({ deleted: resolved.name, purged: true });
  }

  // Soft delete: keep the data, hide the colony from discovery.
  if (fs.existsSync(resolved.colonyDir)) {
    let metadata = {};
    try {
      metadata = JSON.parse(fs.readFileSync(path.join(resolved.colonyDir, "metadata.json"), "utf8"));
    } catch {
      metadata = {};
    }
    try {
      saveMetadata(resolved.name, { ...metadata, id: metadata.id || resolved.name, deleted: true });
    } catch (err) {
      return fail(500, `failed to mark ${resolved.name} deleted: ${err.message}`);
    }
  }
  return ok({ deleted: resolved.name, purged: false });
}

/** Fields the desktop may write here. Everything else stays colony-API only. */
const AGENT_METADATA_FIELDS = new Set(["icon"]);

async function updateAgentMetadata(args) {
  const payload = await readObjectBody(args.req);
  const resolved = resolveAgentPath(payload.agent_path);
  if (resolved.error) return fail(resolved.status ?? 400, resolved.error);

  const patch = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "agent_path") continue;
    if (!AGENT_METADATA_FIELDS.has(key)) {
      return fail(400, `unsupported metadata field '${key}'; supported: ${[...AGENT_METADATA_FIELDS].join(", ")}`);
    }
    if (value !== null && typeof value !== "string") {
      return fail(400, `'${key}' must be a string or null`);
    }
    patch[key] = typeof value === "string" ? value.trim() || null : null;
  }
  if (Object.keys(patch).length === 0) return fail(400, "no metadata fields supplied");

  if (!fs.existsSync(resolved.colonyDir)) {
    return fail(404, `colony '${resolved.name}' has no metadata.json to update`);
  }
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(resolved.colonyDir, "metadata.json"), "utf8"));
  } catch (err) {
    return fail(500, `metadata.json is not valid JSON: ${err.message}`);
  }
  try {
    saveMetadata(resolved.name, { ...metadata, ...patch, updated_at: new Date().toISOString() });
  } catch (err) {
    return fail(500, `failed to save metadata: ${err.message}`);
  }
  return ok({ ok: true });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * One entry per official route this lane owns. `compatibility` is the honest
 * contract state: `limited` routes exist and are verified, but answer an
 * explicit 400 or an empty collection because pi_hive has no backing store.
 *
 * All entries register with `status: implemented` because the compat server
 * only dispatches MISSING or official+IMPLEMENTED routes; a PARTIAL route
 * would fall through to the shell's 501, which the unsupported endpoints
 * explicitly must not do.
 */
export const CATALOG_ROUTE_SPECS = Object.freeze(
  [
    {
      method: "GET",
      path: "/api/skills/scopes",
      compatibility: FULL,
      description: "queens and colonies available to the skills library",
      handler: getSkillScopes,
    },
    {
      method: "GET",
      path: "/api/skills/:skill",
      compatibility: FULL,
      description: "scope-less skill detail from the first colony copy",
      handler: getSkillDetail,
    },
    {
      method: "POST",
      path: "/api/skills/upload",
      compatibility: FULL,
      description: "installs a multipart SKILL.md into hiveHome()/skills, or queues it for a session",
      handler: uploadSkill,
    },
    {
      method: "GET",
      path: "/api/queen/:queen/skills",
      compatibility: FULL,
      description: "queen-scoped skills aggregated from the queen's colonies",
      handler: getQueenSkills,
    },
    {
      method: "POST",
      path: "/api/queen/:queen/skills",
      compatibility: FULL,
      description: "create a SKILL.md in a colony owned by the queen",
      handler: createQueenSkill,
    },
    {
      method: "PATCH",
      path: "/api/queen/:queen/skills/:skill",
      compatibility: FULL,
      description: "persist enabled/notes/param overrides in a colony sidecar",
      handler: patchQueenSkill,
    },
    {
      method: "GET",
      path: "/api/queen/:queen/skills/:skill/body",
      compatibility: FULL,
      description: "queen copy with frontmatter stripped, for the body editor",
      handler: getQueenSkillBody,
    },
    {
      method: "PUT",
      path: "/api/queen/:queen/skills/:skill/body",
      compatibility: FULL,
      description: "rewrite the queen copy's SKILL.md body and description",
      handler: putQueenSkillBody,
    },
    {
      method: "POST",
      path: "/api/queen/:queen/skills/:skill/rename",
      compatibility: FULL,
      description: "rename a queen copy's folder and frontmatter name",
      handler: renameQueenSkill,
    },
    {
      method: "DELETE",
      path: "/api/queen/:queen/skills/:skill",
      compatibility: FULL,
      description: "delete a queen copy's skill folder",
      handler: deleteQueenSkill,
    },
    {
      method: "POST",
      path: "/api/queen/:queen/skills/reload",
      compatibility: FULL,
      description: "no-op reload: pi_hive reads skill dirs on every GET",
      handler: reloadQueenSkills,
    },
    {
      method: "GET",
      path: "/api/sessions/:session/skill-installs",
      compatibility: FULL,
      description: "the session's queued skill-install requests",
      handler: listSkillInstalls,
    },
    {
      method: "POST",
      path: "/api/sessions/:session/skill-installs/:install",
      compatibility: FULL,
      description: "approves (installs into the library) or denies a queued request; 404 unknown",
      handler: decideSkillInstall,
    },
    {
      method: "GET",
      path: "/api/prompts",
      compatibility: FULL,
      description: "the stored custom prompts, newest first",
      handler: listPrompts,
    },
    {
      method: "POST",
      path: "/api/prompts",
      compatibility: FULL,
      description: "creates a custom prompt (minted id, skills/tags normalized)",
      handler: createPrompt,
    },
    {
      method: "DELETE",
      path: "/api/prompts/:prompt",
      compatibility: FULL,
      description: "deletes a stored prompt; 404 for an unknown id",
      handler: deletePrompt,
    },
    {
      method: "GET",
      path: "/api/memories",
      compatibility: FULL,
      description: "real memory files from global, queen, and colony scopes",
      handler: listMemories,
    },
    {
      method: "GET",
      path: "/api/memories/file",
      compatibility: FULL,
      description: "read one memory file by relative path",
      handler: getMemory,
    },
    {
      method: "PUT",
      path: "/api/memories/file",
      compatibility: FULL,
      description: "overwrite one memory file's content",
      handler: updateMemory,
    },
    {
      method: "DELETE",
      path: "/api/memories/file",
      compatibility: FULL,
      description: "delete one memory file",
      handler: deleteMemory,
    },
    {
      method: "DELETE",
      path: "/api/agents",
      compatibility: FULL,
      description: "soft-deletes (metadata.deleted) or purges the colony an agent path names",
      handler: deleteAgent,
    },
    {
      method: "PATCH",
      path: "/api/agents/metadata",
      compatibility: FULL,
      description: "writes icon (and only icon) into the colony's metadata.json",
      handler: updateAgentMetadata,
    },
  ].map((spec) => Object.freeze(spec)),
);

/** Honest totals for the lane report and tests. */
export function catalogCounts() {
  return {
    total: CATALOG_ROUTE_SPECS.length,
    full: CATALOG_ROUTE_SPECS.filter((spec) => spec.compatibility === FULL).length,
    limited: CATALOG_ROUTE_SPECS.filter((spec) => spec.compatibility === LIMITED).length,
  };
}

/**
 * Register every catalogue route on `registry`.
 *
 * @param {import("../router.js").RouteRegistry} registry
 * @param {object} [ctx] integration context; may provide
 *   `resolveColonyForQueen(queenId)` for queen-scoped skill creates.
 * @returns {object} the registry, for chaining
 */
export function registerCatalogRoutes(registry, ctx = {}) {
  if (!registry || typeof registry.register !== "function") {
    throw new TypeError("registerCatalogRoutes requires a RouteRegistry");
  }
  const registeredCtx = isPlainObject(ctx) ? ctx : {};

  for (const spec of CATALOG_ROUTE_SPECS) {
    const handler = guarded((args) =>
      spec.handler(args, args.ctx && isPlainObject(args.ctx) ? args.ctx : registeredCtx),
    );
    registry.register(spec.method, spec.path, handler, {
      status: ROUTE_STATUS.IMPLEMENTED,
      official: true,
      compatibility: spec.compatibility,
      limited: spec.compatibility === LIMITED,
      description: spec.description,
    });
  }

  return registry;
}

export default registerCatalogRoutes;
