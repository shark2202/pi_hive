import fs from "node:fs";
import path from "node:path";
import { colonyPaths } from "./colony.js";

export const DEFAULT_SOUL = {
  version: 1,
  mode: "review",
  identity: {
    mission: "",
    voice: [],
    principles: [],
  },
  probes: [],
  updated_at: null,
  history: [],
};

export function soulPath(colony) {
  return path.join(colonyPaths(colony).dir, "soul.json");
}

export function proposalsPath(colony) {
  return path.join(colonyPaths(colony).dir, "soul_proposals.jsonl");
}

export function loadSoul(colony) {
  const file = soulPath(colony);
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_SOUL);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...structuredClone(DEFAULT_SOUL),
      ...data,
      identity: { ...DEFAULT_SOUL.identity, ...(data.identity || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_SOUL);
  }
}

export function saveSoul(colony, soul) {
  const next = { ...soul, updated_at: new Date().toISOString() };
  fs.writeFileSync(soulPath(colony), JSON.stringify(next, null, 2));
  return next;
}

export function setSoulMode(colony, mode) {
  if (!["off", "review", "auto"].includes(mode)) throw new Error("soul mode must be off, review, or auto");
  const soul = loadSoul(colony);
  soul.mode = mode;
  return saveSoul(colony, soul);
}

export function appendProposal(colony, proposal) {
  const record = {
    id: `soul_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    status: "pending",
    ...proposal,
  };
  fs.appendFileSync(proposalsPath(colony), JSON.stringify(record) + "\n");
  return record;
}

export function listProposals(colony) {
  const file = proposalsPath(colony);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
}

export function applyProposal(colony, id) {
  const proposals = listProposals(colony);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) throw new Error(`unknown soul proposal '${id}'`);
  if (proposal.status === "applied") return loadSoul(colony);
  const soul = loadSoul(colony);
  const section = proposal.section || "";
  const change = String(proposal.change || "").trim();
  if (!change) throw new Error("proposal has no change");
  if (section === "identity.mission") soul.identity.mission = change;
  else if (section === "identity.voice") {
    if (!soul.identity.voice.includes(change)) soul.identity.voice.push(change);
  } else if (section === "identity.principles") {
    if (!soul.identity.principles.includes(change)) soul.identity.principles.push(change);
  } else if (section === "probes") {
    soul.probes.push({ text: change, added_at: new Date().toISOString() });
  } else {
    throw new Error(`unsupported soul section '${section}'`);
  }
  proposal.status = "applied";
  proposal.applied_at = new Date().toISOString();
  soul.history.push({
    at: proposal.applied_at,
    proposal_id: proposal.id,
    section,
    change,
    evidence: proposal.evidence || [],
  });
  saveSoul(colony, soul);
  fs.writeFileSync(proposalsPath(colony), proposals.map((p) => JSON.stringify(p)).join("\n") + "\n");
  return loadSoul(colony);
}
