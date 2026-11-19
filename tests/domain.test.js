import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-test-"));
process.env.PI_HIVE_HOME = home;

const { createColony, listColonies } = await import("../src/domain/colony.js");
const { openTracker } = await import("../src/domain/tracker.js");
const { createTask, listTasks, updateTask } = await import("../src/domain/plan.js");
const { writeSkill, listSkills } = await import("../src/domain/skills.js");

test("colony creates a self-contained directory", () => {
  const meta = createColony({ name: "test-colony", queenId: "queen_tech", goal: "ship it" });
  assert.equal(meta.id, "test-colony");
  const dir = path.join(home, "colonies", "test-colony");
  for (const sub of ["tracker", "skills", "playbooks", "sessions", "workers", "memory"]) {
    assert.ok(fs.existsSync(path.join(dir, sub)), `${sub} missing`);
  }
  assert.equal(listColonies().length, 1);
});

test("tracker upsert/query and read-only guard", () => {
  createColony({ name: "tracker-colony" });
  const tracker = openTracker("tracker-colony");
  tracker.exec("CREATE TABLE leads (id TEXT PRIMARY KEY, name TEXT, done INTEGER DEFAULT 0)");
  tracker.upsert("leads", { id: "l1", name: "Ada", done: 0 });
  tracker.upsert("leads", { id: "l1", name: "Ada Lovelace", done: 1 });
  const rows = tracker.query("SELECT * FROM leads");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Ada Lovelace");
  assert.throws(() => tracker.query("DELETE FROM leads"), /only accepts SELECT/);
  tracker.close();
});

test("plan and skills persist", () => {
  createColony({ name: "plan-colony" });
  const task = createTask("plan-colony", { subject: "do the thing" });
  assert.equal(listTasks("plan-colony").length, 1);
  updateTask("plan-colony", task.id, { status: "completed" });
  assert.equal(listTasks("plan-colony", "completed").length, 1);
  writeSkill("plan-colony", { name: "method", description: "how", body: "step 1" });
  assert.equal(listSkills("plan-colony")[0].name, "method");
});
