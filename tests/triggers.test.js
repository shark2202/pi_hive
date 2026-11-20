import { test } from "node:test";
import assert from "node:assert/strict";
import { cronMatches, parseCron } from "../src/runtime/triggers.js";

test("cron parser supports stars, ranges, steps, lists", () => {
  const c = parseCron("*/15 9-17 * * 1-5");
  assert.ok(c.minute.has(0));
  assert.ok(c.minute.has(45));
  assert.ok(!c.minute.has(7));
  assert.ok(c.hour.has(9));
  assert.ok(c.hour.has(17));
  assert.ok(c.weekday.has(1));
  assert.ok(!c.weekday.has(0));
});

test("cronMatches uses UTC and weekday", () => {
  const d = new Date(Date.UTC(2026, 10, 19, 9, 30)); // Thursday 2026-11-19
  assert.ok(cronMatches("30 9 * * 4", d));
  assert.ok(!cronMatches("30 9 * * 0", d));
  assert.ok(!cronMatches("31 9 * * 4", d));
});

// --- missed fires ----------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createColony, colonyPaths } from "../src/domain/colony.js";
import { TriggerManager } from "../src/runtime/triggers.js";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-trig-")));
process.env.PI_HIVE_HOME = HOME;

function freshColony(name, triggers) {
  fs.rmSync(path.join(HOME, "colonies", name), { recursive: true, force: true });
  createColony({ name, goal: "fire on time" });
  fs.writeFileSync(colonyPaths(name).triggers, JSON.stringify({ triggers }, null, 2));
  return name;
}

function manager(colony, fired = []) {
  return new TriggerManager({ colony, onFire: (name, payload) => fired.push({ name, ...payload }), tickMs: 60000 });
}

test("a trigger armed for the first time is not treated as infinitely overdue", () => {
  freshColony("trig-arm", [
    { name: "user-nightly", type: "interval", interval_minutes: 60, prompt: "check", enabled: true, last_fired_at: null },
  ]);
  const fired = [];
  const triggers = manager("trig-arm", fired);
  const missed = triggers.reconcileMissed(new Date("2026-11-20T10:00:00Z"));
  assert.deepEqual(missed, [], "nothing is missed before the first fire");
  assert.equal(triggers.list()[0].last_fired_at, "2026-11-20T10:00:00.000Z");
  assert.deepEqual(fired, []);
});

test("a stop shorter than one interval misses nothing", () => {
  freshColony("trig-short", [
    {
      name: "user-hourly",
      type: "interval",
      interval_minutes: 60,
      prompt: "check",
      enabled: true,
      last_fired_at: "2026-11-20T09:30:00.000Z",
    },
  ]);
  const triggers = manager("trig-short");
  assert.deepEqual(triggers.reconcileMissed(new Date("2026-11-20T10:00:00Z")), []);
});

test("a long stop fires once per trigger and reports how many slots were missed", () => {
  freshColony("trig-miss", [
    {
      name: "user-hourly",
      type: "interval",
      interval_minutes: 60,
      prompt: "check the tracker",
      enabled: true,
      last_fired_at: "2026-11-20T06:00:00.000Z",
    },
    {
      name: "user-old",
      type: "interval",
      interval_minutes: 30,
      prompt: "older one",
      enabled: true,
      last_fired_at: "2026-11-20T05:00:00.000Z",
    },
    {
      name: "user-off",
      type: "interval",
      interval_minutes: 30,
      prompt: "disabled",
      enabled: false,
      last_fired_at: "2026-11-20T05:00:00.000Z",
    },
  ]);
  const fired = [];
  const triggers = manager("trig-miss", fired);
  const missed = triggers.reconcileMissed(new Date("2026-11-20T10:00:00Z"));
  assert.deepEqual(
    missed.map((entry) => [entry.name, entry.missed_intervals]),
    [
      ["user-hourly", 4],
      ["user-old", 10],
    ],
    "a disabled trigger is never reconciled",
  );

  // start() replays the reconciled list exactly once each, marked as missed.
  triggers.start(new Date("2026-11-20T10:00:00Z"));
  triggers.stop();
  assert.deepEqual(
    fired.map((entry) => [entry.name, entry.missed, entry.missed_intervals]),
    [
      ["user-hourly", true, 4],
      ["user-old", true, 10],
    ],
  );
  assert.equal(triggers.missedFires.length, 2);

  // A second start within the same interval is quiet.
  const again = manager("trig-miss", fired);
  const second = again.reconcileMissed(new Date("2026-11-20T10:00:05Z"));
  assert.deepEqual(second, []);
});

test("a cron trigger missed a slot when its last fire is older than the grace window", () => {
  freshColony("trig-cron", [
    { name: "user-cron", type: "cron", cron: "0 9 * * *", prompt: "daily", enabled: true, last_fired_at: "2026-11-20T09:00:00.000Z" },
  ]);
  const triggers = manager("trig-cron");
  assert.deepEqual(triggers.reconcileMissed(new Date("2026-11-20T09:01:00Z")), []);
  const missed = triggers.reconcileMissed(new Date("2026-11-20T09:30:00Z"));
  assert.deepEqual(missed.map((entry) => entry.missed_intervals), [1]);
});
