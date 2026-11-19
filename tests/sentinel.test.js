import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-sentinel-"));
process.env.PI_HIVE_HOME = home;

const { createColony } = await import("../src/domain/colony.js");
const { Sentinel } = await import("../src/runtime/sentinel.js");

test("sentinel writes escalations to the local inbox", async () => {
  createColony({ name: "sentinel-colony", goal: "test" });
  const events = [];
  const queen = {
    running: false,
    queue: [],
    lastActivity: Date.now() - 600000,
    agent: { state: { messages: [{ role: "assistant", content: [{ type: "text", text: "parked" }] }] } },
    workerManager: { list: () => [] },
    emit: (name, record) => events.push({ name, record }),
  };
  const sentinel = new Sentinel({ queen, colony: "sentinel-colony", modelRuntime: null, budgetSeconds: 300 });
  const record = await sentinel.escalate("blocker", "needs a decision");
  assert.equal(record.kind, "blocker");
  assert.equal(events[0].name, "sentinel_escalation");
  const inbox = sentinel.inbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].reason, "needs a decision");
});
