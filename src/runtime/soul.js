import fs from "node:fs";
import path from "node:path";
import { colonyPaths } from "../domain/colony.js";
import { loadSoul, saveSoul, appendProposal, listProposals, applyProposal } from "../domain/soul.js";
import { readMemory } from "../domain/memory.js";
import { createPiAgent, lastAssistantText, messageText } from "../kernel/agent.js";

const REVIEW_SYSTEM = `You are the Soul reviewer for a Hive colony.
The Soul is the queen's durable identity: mission, voice, principles, probes.
Propose at most 3 changes that are supported by evidence from the transcript or memory.
Never invent facts. Every proposal must quote or cite the evidence it relies on.
Respond ONLY with JSON:
{"proposals":[{"section":"identity.mission"|"identity.voice"|"identity.principles"|"probes","change":"...","evidence":["..."],"confidence":0.0}]}
If there is not enough evidence, return {"proposals":[]}.`;

export class SoulEngine {
  constructor({ queen, colony, modelRuntime, maxEdits = 3 }) {
    this.queen = queen;
    this.colony = colony;
    this.modelRuntime = modelRuntime;
    this.maxEdits = Number(maxEdits) || 3;
    this.lastReviewAt = null;
  }

  status() {
    const soul = loadSoul(this.colony);
    const proposals = listProposals(this.colony);
    return {
      soul,
      proposals: proposals.slice(-20),
      pending: proposals.filter((p) => p.status === "pending").length,
      last_review_at: this.lastReviewAt || proposals.at(-1)?.at || null,
    };
  }

  #context() {
    const messages = (this.queen?.agent?.state?.messages || [])
      .map((m) => `${m.role}: ${messageText(m)}`)
      .filter((line) => line.length > 3)
      .slice(-30)
      .join("\n")
      .slice(-12000);
    const memory = [
      readMemory(this.colony, "colony"),
      readMemory(this.colony, "queen", this.queen?.queenId || "queen"),
    ].filter(Boolean).join("\n\n").slice(-8000);
    const reports = [];
    const dir = colonyPaths(this.colony).workers;
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(-8)) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
          reports.push(`${data.task || "worker"}: ${data.report?.summary || ""}`);
        } catch { /* skip broken report */ }
      }
    }
    return { transcript: messages, memory, reports: reports.join("\n").slice(-4000) };
  }

  async review() {
    const soul = loadSoul(this.colony);
    if (soul.mode === "off") return { proposals: [], skipped: "soul mode is off" };
    const context = this.#context();
    const agent = createPiAgent({
      systemPrompt: REVIEW_SYSTEM,
      tools: [],
      modelRuntime: this.modelRuntime,
      maxTurns: 2,
    });
    await agent.prompt(JSON.stringify({ soul, ...context }, null, 2));
    await agent.waitForIdle();
    const text = lastAssistantText(agent.state.messages);
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return { proposals: [], error: "reviewer returned no JSON" };
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch { return { proposals: [], error: "reviewer returned invalid JSON" }; }
    const proposals = Array.isArray(parsed.proposals) ? parsed.proposals.slice(0, this.maxEdits) : [];
    const saved = [];
    for (const proposal of proposals) {
      if (!proposal.section || !proposal.change) continue;
      if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0) continue;
      saved.push(appendProposal(this.colony, {
        section: proposal.section,
        change: String(proposal.change).slice(0, 2000),
        evidence: proposal.evidence.slice(0, 5).map((e) => String(e).slice(0, 500)),
        confidence: Number(proposal.confidence) || 0,
        mode: soul.mode,
      }));
    }
    this.lastReviewAt = new Date().toISOString();
    if (soul.mode === "auto") {
      for (const proposal of saved) {
        if ((proposal.evidence || []).length >= 2) {
          try {
            applyProposal(this.colony, proposal.id);
            proposal.status = "applied";
          } catch { /* keep it pending */ }
        }
      }
    }
    return { proposals: saved, mode: soul.mode, pending: saved.filter((p) => p.status === "pending").length };
  }

  apply(id) {
    return applyProposal(this.colony, id);
  }
}
