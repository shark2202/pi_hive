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
