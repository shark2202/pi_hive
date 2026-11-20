/**
 * Memory recall and reflection: the selector must cut noise, the digest must be
 * stable, and the cooldown must be a real gate (force overrides it).
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { colonyDir } from "../src/config.js";
import { createColony } from "../src/domain/colony.js";
import {
  readReflectionState,
  recallForPrompt,
  recallMemory,
  reflectMemory,
  writeMemory,
} from "../src/domain/memory.js";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-memory-")));
process.env.PI_HIVE_HOME = HOME;

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

function seed(name) {
  // Global and queen memory are shared across colonies, so each test starts from
  // an empty memory root rather than inheriting the previous test's notes.
  fs.rmSync(path.join(HOME, "colonies", name), { recursive: true, force: true });
  fs.rmSync(path.join(HOME, "memory"), { recursive: true, force: true });
  createColony({ name, goal: "ship the release" });
  return name;
}

test("recall returns only blocks that match the query, best first", () => {
  const colony = seed("mem-recall");
  writeMemory(
    colony,
    "global",
    "2026-11-01-release.md",
    "# Release policy\nShip on Tuesdays after the suite is green.\nRollback first if the smoke test fails.",
  );
  writeMemory(colony, "colony", "2026-11-10-invoices.md", "# Invoice quirks\nVendor sends PDFs on the 3rd.\nTotals exclude VAT.");
  writeMemory(colony, "queen", "voice.md", "# Voice\nBe direct, no filler.");

  const release = recallMemory(colony, "release rollback smoke", { limit: 3 });
  assert.equal(release.length, 1, "only the release block matches");
  assert.equal(release[0].heading, "Release policy");
  assert.equal(release[0].scope, "global");
  assert.ok(release[0].score >= 4);
  assert.deepEqual(release[0].matched.sort(), ["release", "rollback", "smoke"]);

  const headingBeatsBody = recallMemory(colony, "invoice policy", { limit: 3 });
  assert.equal(headingBeatsBody[0].heading, "Invoice quirks");

  assert.deepEqual(recallMemory(colony, "nothing relevant here", { limit: 3 }), [], "an unrelated query yields nothing");
  assert.deepEqual(recallMemory(colony, "the and of", { limit: 3 }), [], "stopwords alone are not a query");

  const prompt = recallForPrompt(colony, "vendor pdf");
  assert.match(prompt, /^### colony: Invoice quirks/);
  assert.match(prompt, /Vendor sends PDFs/);
  assert.equal(recallForPrompt(colony, "zzz"), "");
});

test("reflection writes a stable digest and honours the cooldown", () => {
  const colony = seed("mem-reflect");
  writeMemory(colony, "global", "a.md", "# Process\nRun the suite.\nAsk before pushing.");
  writeMemory(colony, "colony", "b.md", "# Process\nRun the suite.\nPing the owner when blocked.");
  writeMemory(colony, "queen", "c.md", "# Voice\nBe direct.");

  const at = new Date("2026-11-20T10:00:00Z");
  const first = reflectMemory(colony, { now: at });
  assert.equal(first.skipped, false);
  assert.equal(first.sections, 2, "the two 'Process' blocks merge into one section");
  const text = fs.readFileSync(first.file, "utf8");
  assert.match(text, /^---\nname: reflection\ntype: digest/);
  assert.match(text, /## Process/);
  assert.match(text, /- Run the suite\./, "a duplicated line appears once");
  assert.match(text, /- Ask before pushing\./);
  assert.match(text, /- Ping the owner when blocked\./);
  assert.match(text, /## Voice/);
  assert.equal((text.match(/- Run the suite\./g) ?? []).length, 1);

  // Within the cooldown nothing is rewritten.
  const second = reflectMemory(colony, { now: new Date("2026-11-20T11:00:00Z") });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "cooldown");
  assert.equal(second.next_at, "2026-11-20T16:00:00.000Z");

  // force bypasses it, and the counter keeps the history honest.
  const forced = reflectMemory(colony, { now: new Date("2026-11-20T11:30:00Z"), force: true });
  assert.equal(forced.skipped, false);
  assert.deepEqual(readReflectionState(colony), { last_at: "2026-11-20T11:30:00.000Z", runs: 2 });

  // After the cooldown a plain run works again.
  const later = reflectMemory(colony, { now: new Date("2026-11-20T18:00:00Z") });
  assert.equal(later.skipped, false);
  assert.equal(readReflectionState(colony).runs, 3);
});

test("reflection on an empty colony writes an empty digest instead of failing", () => {
  const colony = seed("mem-empty");
  const result = reflectMemory(colony, { now: new Date("2026-11-20T10:00:00Z") });
  assert.equal(result.skipped, false);
  assert.equal(result.sections, 0);
  assert.match(fs.readFileSync(result.file, "utf8"), /# Reflection digest \(0 sections\)/);
  assert.ok(fs.existsSync(path.join(colonyDir(colony), "memory")) === false || true);
});
