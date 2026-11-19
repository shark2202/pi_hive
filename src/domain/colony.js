import fs from "node:fs";
import path from "node:path";
import { colonyDir, coloniesDir, ensureDir } from "../config.js";

export function colonyMetadataPath(name) {
  return path.join(colonyDir(name), "metadata.json");
}

export function loadMetadata(name) {
  const p = colonyMetadataPath(name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function saveMetadata(name, metadata) {
  const p = colonyMetadataPath(name);
  ensureDir(path.dirname(p));
  const next = { ...metadata, updated_at: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

export function createColony({ name, queenId = "queen_growth", goal = "", workerProfiles = [], workspace = "", sentinelEnabled = false }) {
  const dir = colonyDir(name);
  if (fs.existsSync(dir)) throw new Error(`colony '${name}' already exists`);
  ensureDir(dir);
  for (const sub of ["tracker", "skills", "playbooks", "sessions", "workers", "triggers", "memory"]) {
    ensureDir(path.join(dir, sub));
  }
  const metadata = {
    id: name,
    queen_id: queenId,
    goal,
    workspace,
    sentinel_enabled: Boolean(sentinelEnabled),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    max_concurrent_workers: 4,
    worker_profiles: workerProfiles,
  };
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata, null, 2));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ goal, tasks: [] }, null, 2));
  fs.writeFileSync(path.join(dir, "triggers.json"), JSON.stringify({ triggers: [] }, null, 2));
  return metadata;
}

export function listColonies() {
  if (!fs.existsSync(coloniesDir())) return [];
  return fs.readdirSync(coloniesDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => loadMetadata(e.name))
    .filter(Boolean)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function colonyPaths(name) {
  const dir = colonyDir(name);
  return {
    dir,
    tracker: path.join(dir, "tracker", "tracker.db"),
    plan: path.join(dir, "plan.json"),
    triggers: path.join(dir, "triggers.json"),
    metadata: path.join(dir, "metadata.json"),
    skills: path.join(dir, "skills"),
    playbooks: path.join(dir, "playbooks"),
    sessions: path.join(dir, "sessions"),
    workers: path.join(dir, "workers"),
    memory: path.join(dir, "memory"),
  };
}
