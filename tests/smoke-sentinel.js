import { createColony, loadMetadata } from "../src/domain/colony.js";
import { createModelRuntime } from "../src/kernel/model.js";
import { QueenRuntime } from "../src/runtime/queen.js";
import { Sentinel } from "../src/runtime/sentinel.js";

const colony = "smoke-sentinel";
try { createColony({ name: colony, queenId: "queen_ops", goal: "verify sentinel wiring" }); } catch {}
const meta = loadMetadata(colony);
const modelRuntime = createModelRuntime();
const queen = new QueenRuntime({ colony, queenId: meta.queen_id, modelRuntime });
const sentinel = new Sentinel({ queen, colony, modelRuntime, budgetSeconds: 1, tickMs: 100000 });

queen.lastActivity = Date.now() - 10000;
const verdict = await sentinel.check();
console.log("SENTINEL_VERDICT:", verdict);
if (queen.running || queen.queue.length) {
  await new Promise((resolve) => queen.once("idle", resolve));
}
console.log("INBOX:", JSON.stringify(sentinel.inbox()));
queen.stop();
process.exit(0);
