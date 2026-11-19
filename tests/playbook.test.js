import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-playbook-"));
process.env.PI_HIVE_HOME = home;

const { createColony } = await import("../src/domain/colony.js");
const { openTracker } = await import("../src/domain/tracker.js");
const { PlaybookRunner } = await import("../src/runtime/playbook.js");
const { colonyPaths } = await import("../src/domain/colony.js");

test("playbook converges rows and dead-letters the rest", async () => {
  createColony({ name: "pb-colony" });
  const tracker = openTracker("pb-colony");
  tracker.exec("CREATE TABLE leads (id TEXT PRIMARY KEY, done INTEGER DEFAULT 0)");
  for (const id of ["a", "b", "c"]) tracker.upsert("leads", { id, done: 0 });
  tracker.close();

  const dir = colonyPaths("pb-colony").playbooks;
  fs.writeFileSync(path.join(dir, "leads.play.js"), `
export const meta = { name: "leads", concurrency: 2 };
export async function run(ctx) {
  const out = await ctx.converge({
    pending: () => ctx.trackerQuery("SELECT id FROM leads WHERE done=0"),
    dispatch: async (row) => {
      const r = await ctx.worker("process " + row.id, { data: { id: row.id } });
      if (r.status === "done") ctx.trackerExec("UPDATE leads SET done=1 WHERE id='" + row.id + "'");
      return r;
    },
    maxRounds: 2,
  });
  return out;
}
`);

  const runner = new PlaybookRunner({
    workerManager: {
      async spawnAndWait({ data }) {
        return { status: "success", data };
      },
    },
  });
  const run = await runner.start({ colony: "pb-colony", name: "leads" });
  const result = await runner.wait(run.run_id);
  assert.equal(result.converged, true);
  assert.equal(result.dead_lettered, 0);
  const status = runner.status(run.run_id);
  assert.equal(status.status, "done");
  assert.equal(status.dispatched, 3);
});

test("inline playbook is saved by meta name", async () => {
  createColony({ name: "pb-inline" });
  const runner = new PlaybookRunner({ workerManager: { async spawnAndWait() { return { status: "success", data: {} }; } } });
  const run = await runner.start({
    colony: "pb-inline",
    script: `export const meta = { name: "inline-demo" };\nexport async function run(ctx) { ctx.log("ok"); return { ok: true }; }`,
  });
  await runner.wait(run.run_id);
  assert.ok(fs.existsSync(path.join(colonyPaths("pb-inline").playbooks, "inline-demo.play.js")));
});

test("worker retries failed dispatches", async () => {
  createColony({ name: "pb-retry" });
  let attempts = 0;
  const runner = new PlaybookRunner({
    workerManager: {
      async spawnAndWait() {
        attempts += 1;
        return attempts === 1 ? { status: "failed", summary: "transient" } : { status: "success", data: { ok: true } };
      },
    },
  });
  const run = await runner.start({
    colony: "pb-retry",
    script: `export const meta = { name: "retry-demo" };
export async function run(ctx) {
  const r = await ctx.worker("retry me", { retries: 1, backoff: "linear" });
  return { status: r.status, attempts: r.attempts };
}`,
  });
  const result = await runner.wait(run.run_id);
  assert.equal(result.status, "done");
  assert.equal(result.attempts, 2);
  assert.equal(runner.status(run.run_id).dispatched, 2);
});

test("lane limits in-flight workers", async () => {
  createColony({ name: "pb-lane" });
  let inflight = 0;
  let maxInflight = 0;
  const runner = new PlaybookRunner({
    workerManager: {
      async spawnAndWait({ data }) {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight -= 1;
        return { status: "success", data };
      },
    },
  });
  const run = await runner.start({
    colony: "pb-lane",
    script: `export const meta = { name: "lane-demo", concurrency: 3 };
export async function run(ctx) {
  ctx.lane("io", { concurrency: 1 });
  const jobs = [1,2,3].map((id) => () => ctx.worker("job " + id, { lane: "io", data: { id } }));
  await Promise.all(jobs.map((job) => job()));
  return { ok: true };
}`,
  });
  await runner.wait(run.run_id);
  assert.equal(maxInflight, 1);
});
