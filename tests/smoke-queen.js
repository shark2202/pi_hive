import { createColony, loadMetadata } from "../src/domain/colony.js";
import { openTracker } from "../src/domain/tracker.js";
import { createModelRuntime } from "../src/kernel/model.js";
import { QueenRuntime } from "../src/runtime/queen.js";
import { PlaybookRunner } from "../src/runtime/playbook.js";

const colony = process.env.PI_HIVE_SMOKE_COLONY || "smoke-queen";
try { createColony({ name: colony, queenId: "queen_tech", goal: "Smoke test the Queen -> Worker -> Tracker loop" }); } catch {}
const meta = loadMetadata(colony);
const queen = new QueenRuntime({ colony, queenId: meta.queen_id, modelRuntime: createModelRuntime() });
queen.playbookRunner = new PlaybookRunner({ workerManager: queen.workerManager });

const waitFor = (event, ms = 120000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  queen.once(event, (value) => { clearTimeout(timer); resolve(value); });
});

const first = await queen.chat(
  "Create a tracker table `leads` with columns id TEXT PRIMARY KEY, name TEXT, status TEXT if it does not exist. " +
  "Then spawn exactly one worker to insert one row: id=smoke-1, name=Smoke Lead, status=new, using tracker_upsert, and report success. " +
  "Do not do the insert yourself. After spawning, tell me the worker id and stop.",
);
console.log("QUEEN_FIRST:", first.text);

const report = await waitFor("worker_report");
console.log("WORKER_REPORT:", JSON.stringify(report));

if (queen.running || queen.queue.length) await waitFor("idle");
const tracker = openTracker(colony);
const rows = tracker.query("SELECT * FROM leads WHERE id='smoke-1'");
tracker.close();
console.log("TRACKER_ROWS:", JSON.stringify(rows));
queen.stop();
if (!rows.length) process.exitCode = 2;
