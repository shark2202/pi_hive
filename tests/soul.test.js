import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-soul-"));
process.env.PI_HIVE_HOME = home;

const { createColony } = await import("../src/domain/colony.js");
const { loadSoul, appendProposal, applyProposal, listProposals } = await import("../src/domain/soul.js");

test("soul proposals apply evidence-backed edits", () => {
  createColony({ name: "soul-colony", goal: "test" });
  const before = loadSoul("soul-colony");
  assert.equal(before.mode, "review");
  assert.equal(before.identity.mission, "");

  const proposal = appendProposal("soul-colony", {
    section: "identity.mission",
    change: "Prove demand before building.",
    evidence: ["user: stop guessing", "tracker: three failed experiments"],
    confidence: 0.8,
  });
  const soul = applyProposal("soul-colony", proposal.id);
  assert.equal(soul.identity.mission, "Prove demand before building.");
  assert.equal(soul.history.length, 1);
  assert.equal(soul.history[0].proposal_id, proposal.id);
  assert.equal(listProposals("soul-colony")[0].status, "applied");
});

test("soul voice entries are deduplicated", () => {
  createColony({ name: "soul-voice" });
  const p1 = appendProposal("soul-voice", { section: "identity.voice", change: "Direct.", evidence: ["a"] });
  appendProposal("soul-voice", { section: "identity.voice", change: "Direct.", evidence: ["b"] });
  applyProposal("soul-voice", p1.id);
  const proposals = listProposals("soul-voice");
  applyProposal("soul-voice", proposals[1].id);
  const soul = loadSoul("soul-voice");
  assert.deepEqual(soul.identity.voice, ["Direct."]);
});
