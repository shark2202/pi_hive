import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-reminders-"));
process.env.PI_HIVE_HOME = home;

const { createColony } = await import("../src/domain/colony.js");
const { openTracker } = await import("../src/domain/tracker.js");
const { ReminderHub, TrackerSnapshotSource, ColonyParallelSource } = await import("../src/runtime/reminders.js");

test("reminder hub renders tracker snapshots and the parallel nudge", async () => {
  createColony({ name: "rem-colony" });
  const tracker = openTracker("rem-colony");
  tracker.exec("CREATE TABLE leads (id TEXT PRIMARY KEY, status TEXT)");
  for (const id of ["a", "b", "c"]) tracker.upsert("leads", { id, status: "done" });
  tracker.close();

  const queen = { workerManager: { list: () => [] }, running: false, queue: [], lastActivity: Date.now() };
  const hub = new ReminderHub({
    queen,
    sources: [new TrackerSnapshotSource({ colony: "rem-colony" }), new ColonyParallelSource({ colony: "rem-colony", queen })],
  });
  const items = await hub.collect("before_prompt");
  assert.equal(items.length, 2);
  assert.match(items[0].body, /leads: 3 rows/);
  assert.match(items[1].body, /write a skill/i);
});
