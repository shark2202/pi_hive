/**
 * Core mechanics: the Goal/Outcome judge, token metering and the stall guard.
 *
 * These are the parts of the loop that decide when "done" is true and when a run
 * is going nowhere, so the assertions are about state transitions and recorded
 * evidence, not about return codes.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createColony } from "../src/domain/colony.js";
import { budgetState, getUsage, meteringPath, recordTurnUsage } from "../src/domain/metering.js";
import { clearPark, evaluate, guardPath, guardState, observeTurn, turnSignature } from "../src/domain/loop-guard.js";
import { getGoal, goalPath, goalSummary, judgeGoal, setGoal } from "../src/domain/goal.js";
import { GRACE_PROMPT, normalizeResume, resumePrompt } from "../src/runtime/worker.js";

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-hive-core-")));
process.env.PI_HIVE_HOME = HOME;

after(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

function freshColony(name) {
  fs.rmSync(path.join(HOME, "colonies", name), { recursive: true, force: true });
  createColony({ name, goal: "land the release" });
  return name;
}

const GOAL = {
  objective: "Ship 1.0 with a green suite",
  success_criteria: [
    { statement: "npm test is green", observable: "npm test exits 0" },
    { statement: "the bundle builds", observable: "npm run build writes frontend/dist/index.html" },
  ],
  constraints: ["do not touch /core", { rule: "no new dependencies", hard: true }],
  budget: { max_attempts: 3, max_tokens: 1000 },
};

// --- goal document ---------------------------------------------------------

test("a goal must carry observable success criteria and real constraints", () => {
  const colony = freshColony("goal-valid");
  const goal = setGoal(colony, GOAL);
  assert.equal(goal.status, "open");
  assert.deepEqual(goal.success_criteria.map((c) => c.id), ["crit_1", "crit_2"]);
  assert.equal(goal.success_criteria[0].observable, "npm test exits 0");
  assert.deepEqual(goal.constraints, [
    { id: "cons_1", rule: "do not touch /core", hard: true },
    { id: "cons_2", rule: "no new dependencies", hard: true },
  ]);

  assert.throws(() => setGoal(colony, { ...GOAL, objective: "" }), /objective is required/);
  assert.throws(() => setGoal(colony, { ...GOAL, success_criteria: [] }), /at least one success criterion/);
  assert.throws(
    () => setGoal(colony, { ...GOAL, success_criteria: [{ statement: "it works" }] }),
    /needs 'observable'/,
  );
  assert.throws(() => setGoal(colony, { ...GOAL, budget: { max_attempts: 0 } }), /max_attempts/);

  // A rejected goal leaves the stored one untouched.
  assert.equal(getGoal(colony).objective, GOAL.objective);
});

test("the outcome judge accepts, retries within budget, then escalates", () => {
  const colony = freshColony("goal-judge");
  setGoal(colony, { ...GOAL, budget: { max_attempts: 2 } });

  const accepted = judgeGoal(colony, {
    verdict: "accept",
    reason: "suite green and bundle built",
    evidence: ["npm test: 239 pass", "frontend/dist/index.html"],
    criteria_met: ["crit_1", "crit_2"],
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.attempts.length, 1);
  assert.equal(accepted.attempts[0].evidence.length, 2);
  const summary = goalSummary(colony);
  assert.equal(summary.status, "accepted");
  assert.deepEqual(summary.criteria.map((c) => c.met), [true, true]);
  assert.equal(summary.last_verdict.verdict, "accept");

  // A fresh goal starts a fresh attempt history.
  setGoal(colony, { ...GOAL, budget: { max_attempts: 2 } }, { reset: true });
  assert.equal(getGoal(colony).attempts.length, 0);

  const retry = judgeGoal(colony, { verdict: "retry", reason: "one criterion missing", criteria_met: ["crit_1"] });
  assert.equal(retry.status, "open");
  assert.equal(retry.attempts.length, 1);

  const exhausted = judgeGoal(colony, { verdict: "retry", reason: "still missing" });
  assert.equal(exhausted.status, "escalated", "the budget, not patience, ends the retry loop");
  assert.equal(exhausted.attempts.length, 2);
  assert.equal(exhausted.attempts[1].verdict, "escalate");
  assert.match(exhausted.attempts[1].reason, /retry budget exhausted after 2 attempts/);

  assert.throws(() => judgeGoal(colony, { verdict: "maybe" }), /verdict must be one of/);
  assert.throws(() => judgeGoal(freshColony("goal-none"), { verdict: "accept" }), /no goal is set/);
});

test("a corrupt goal file is reported, not silently treated as absent", () => {
  const colony = freshColony("goal-corrupt");
  setGoal(colony, GOAL);
  fs.writeFileSync(goalPath(colony), "{not json");
  const goal = getGoal(colony);
  assert.equal(goal.status, "invalid");
  assert.match(goal.error, /not valid JSON/);
  assert.throws(() => judgeGoal(colony, { verdict: "accept" }), /not valid JSON/);
});

// --- metering --------------------------------------------------------------

test("usage is summed from assistant messages, per day and in total", () => {
  const colony = freshColony("meter-usage");
  assert.deepEqual(getUsage(colony).total, { turns: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 });

  const turn = [
    { role: "user", content: "go" },
    { role: "assistant", content: "working", usage: { input: 100, output: 40, cost: 0.002 } },
    { role: "assistant", content: "done", usage: { input: 20, output: 10 } },
  ];
  const first = recordTurnUsage(colony, turn, { at: new Date("2026-11-20T10:00:00Z") });
  assert.deepEqual(first.recorded, { turns: 2, tokens_in: 120, tokens_out: 50, cost_usd: 0.002 });
  assert.equal(first.total.tokens_in, 120);
  assert.deepEqual(first.by_day["2026-11-20"], { turns: 2, tokens_in: 120, tokens_out: 50, cost_usd: 0.002 });

  // A second day lands in its own bucket and adds to the total.
  const second = recordTurnUsage(colony, [{ role: "assistant", usage: { input: 30, output: 5 } }], {
    at: new Date("2026-11-21T09:00:00Z"),
  });
  assert.equal(second.total.tokens_in, 150);
  assert.equal(second.by_day["2026-11-21"].tokens_in, 30);
  assert.equal(second.last_turn_at, "2026-11-21T09:00:00.000Z");

  // A turn with no usage is not a turn: nothing is written.
  const none = recordTurnUsage(colony, [{ role: "user", content: "hi" }]);
  assert.equal(none.recorded, null);
  assert.equal(getUsage(colony).total.turns, 3, "the two earlier turns plus this one");

  assert.equal(JSON.parse(fs.readFileSync(meteringPath(colony), "utf8")).total.tokens_out, 55);
});

test("the goal's token budget is measured against recorded usage", () => {
  const colony = freshColony("meter-budget");
  const goal = setGoal(colony, { ...GOAL, budget: { max_tokens: 200 } });
  let state = budgetState(colony, goal);
  assert.deepEqual(state, { limit: 200, used: 0, exhausted: false, remaining: 200 });

  recordTurnUsage(colony, [{ role: "assistant", usage: { input: 150, output: 40 } }]);
  state = budgetState(colony, goal);
  assert.equal(state.used, 190);
  assert.equal(state.exhausted, false);
  assert.equal(state.remaining, 10);

  recordTurnUsage(colony, [{ role: "assistant", usage: { input: 20, output: 0 } }]);
  state = budgetState(colony, goal);
  assert.equal(state.exhausted, true);
  assert.equal(state.remaining, 0);

  // Without a budget the numbers are reported but nothing is "exhausted".
  const unbounded = budgetState(colony, { budget: {} });
  assert.equal(unbounded.limit, null);
  assert.equal(unbounded.exhausted, false);
  assert.equal(unbounded.used, 210);
});

// --- stall / doom loop -----------------------------------------------------

test("the guard parks a loop that repeats the same action", () => {
  const colony = freshColony("guard-doom");
  const signature = "tool:read:src/a.js";
  assert.equal(observeTurn(colony, { signature }).stalled, false);
  assert.equal(observeTurn(colony, { signature }).stalled, false);
  assert.equal(observeTurn(colony, { signature }).stalled, false);
  const fourth = observeTurn(colony, { signature });
  assert.equal(fourth.stalled, true);
  assert.equal(fourth.kind, "doom_loop");
  assert.match(fourth.reason, /repeated 4 times/);
  assert.equal(fourth.parked, true);

  const stored = guardState(colony);
  assert.equal(stored.parked, true);
  assert.match(stored.park_reason, /same action repeated/);

  // A different action breaks the streak, and clearing the park lets work resume.
  clearPark(colony);
  assert.equal(guardState(colony).parked, false);
  assert.equal(observeTurn(colony, { signature: "tool:write:src/a.js" }).stalled, false);
});

test("the guard parks a loop that produces nothing three turns in a row", () => {
  const colony = freshColony("guard-stall");
  assert.equal(observeTurn(colony, { signature: "tool:read:x" }).stalled, false);
  assert.equal(observeTurn(colony, { signature: null }).idle, 1);
  assert.equal(observeTurn(colony, { signature: null }).idle, 2);
  const third = observeTurn(colony, { signature: null });
  assert.equal(third.stalled, true);
  assert.equal(third.kind, "stall");
  assert.match(third.reason, /3 turns in a row produced nothing observable/);

  // Progress resets the idle counter.
  clearPark(colony);
  observeTurn(colony, { signature: null });
  const progressed = observeTurn(colony, { signature: "tool:write:src/b.js" });
  assert.equal(progressed.idle, 0);
  assert.equal(progressed.stalled, false);
  assert.equal(guardState(colony).idle, 0);
});

test("the judgement is pure: a caller can evaluate a window without touching disk", () => {
  const signature = "tool:read:a";
  const state = { window: [1, 2, 3, 4].map(() => ({ signature })), idle: 0 };
  assert.equal(evaluate(state).kind, "doom_loop");
  assert.equal(evaluate({ window: [{ signature: "a" }, { signature: "a" }, { signature: "b" }], idle: 0 }).stalled, false);
  assert.equal(evaluate({ window: [], idle: 3 }).kind, "stall");
  assert.equal(evaluate({ window: [], idle: 0 }).stalled, false);
  assert.equal(fs.existsSync(guardPath("never-created")), false);
});

test("turn signatures are stable and describe the tools a turn called", () => {
  const messages = [
    { role: "assistant", content: [{ type: "tool_use", name: "read", input: { path: "src/a.js" } }] },
    { role: "assistant", content: [{ type: "tool_use", name: "read", input: { path: "src/a.js" } }] },
    { role: "assistant", content: "nothing else" },
  ];
  const first = turnSignature(messages);
  assert.equal(first, turnSignature(messages), "the same turn yields the same signature");
  assert.match(first, /read:\{"path":"src\/a\.js"\}/);
  assert.notEqual(first, turnSignature([{ role: "assistant", content: [{ type: "tool_use", name: "read", input: { path: "src/b.js" } }] }]));

  assert.match(turnSignature([{ role: "assistant", content: "just text" }]), /^text:just text$/);
  assert.equal(turnSignature([{ role: "user", content: "only the user spoke" }]), null);
  assert.equal(turnSignature([]), null);
});

// --- worker resume + grace -------------------------------------------------

test("a resumed worker is told what the earlier report already did", () => {
  assert.equal(normalizeResume(null), null);
  assert.equal(normalizeResume({}), null, "an empty resume carries nothing");
  assert.equal(normalizeResume("text"), null);
  assert.equal(normalizeResume({ summary: "", data: {} }), null);

  const resumed = normalizeResume({
    summary: "read the tracker, found 3 stale rows",
    data: { rows: 3 },
    at: "2026-11-20T09:00:00.000Z",
    report: { at: "2026-11-20T08:00:00.000Z" },
  });
  assert.deepEqual(resumed, {
    summary: "read the tracker, found 3 stale rows",
    data: { rows: 3 },
    at: "2026-11-20T09:00:00.000Z",
  });

  const block = resumePrompt(resumed);
  assert.match(block, /resumes an earlier report/);
  assert.match(block, /"rows": 3/);
  assert.match(block, /found 3 stale rows/);
  assert.equal(resumePrompt(null), null);

  // A caller cannot smuggle instructions through a non-string summary.
  const coerced = normalizeResume({ summary: { toString: () => "evil" }, data: [1, 2, 3] });
  assert.equal(coerced, null);

  // The grace turn is one fixed instruction, not caller text.
  assert.match(GRACE_PROMPT, /report_to_parent/);
  assert.match(GRACE_PROMPT, /success\/partial\/failed/);
});
