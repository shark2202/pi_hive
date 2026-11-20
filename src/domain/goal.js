/**
 * The structured goal a colony is judged against.
 *
 * Hive keeps a Goal document (objective + success criteria + constraints) and an
 * Outcome judge: every candidate result is accepted, sent back for another turn,
 * or escalated to a human. This module stores that document next to the colony
 * and records each verdict, so "done" is a decision with evidence rather than a
 * feeling.
 */
import fs from "node:fs";
import path from "node:path";

import { colonyPaths } from "./colony.js";

const VERDICTS = new Set(["accept", "retry", "escalate"]);
const MAX_CRITERIA = 20;
const MAX_CONSTRAINTS = 20;

export function goalPath(name) {
  return path.join(path.dirname(colonyPaths(name).plan), "goal.json");
}

function emptyGoal() {
  return {
    version: 1,
    objective: "",
    success_criteria: [],
    constraints: [],
    budget: { max_attempts: 3, max_tokens: null },
    status: "open",
    attempts: [],
    updated_at: null,
  };
}

export function getGoal(name) {
  const file = goalPath(name);
  if (!fs.existsSync(file)) return emptyGoal();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...emptyGoal(), ...parsed };
  } catch {
    // A corrupt goal is not a silent "no goal": say so and let the caller fix it.
    return { ...emptyGoal(), status: "invalid", error: "goal.json is not valid JSON" };
  }
}

function writeGoal(name, goal) {
  const file = goalPath(name);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(goal, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  return goal;
}

/** Stable ids so a verdict can name the criterion it failed. */
function assignIds(list, prefix) {
  return list.map((entry, index) => ({
    id: entry.id ?? `${prefix}_${index + 1}`,
    ...entry,
  }));
}

/**
 * Validate a goal document. Returns `{ error }` or `{ goal }` — nothing is
 * written when validation fails.
 */
export function normalizeGoal(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "goal must be an object" };
  }
  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  if (!objective) return { error: "objective is required" };

  const rawCriteria = input.success_criteria ?? [];
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
    return { error: "at least one success criterion is required" };
  }
  if (rawCriteria.length > MAX_CRITERIA) return { error: `at most ${MAX_CRITERIA} success criteria` };
  const success_criteria = [];
  for (const [index, entry] of rawCriteria.entries()) {
    const statement = typeof entry === "string" ? entry.trim() : String(entry?.statement ?? "").trim();
    if (!statement) return { error: `success criterion ${index + 1} has no statement` };
    // A criterion nobody can observe cannot be judged; require the check text.
    const observable = entry && typeof entry === "object" ? String(entry.observable ?? "").trim() : "";
    if (!observable) {
      return {
        error: `success criterion ${index + 1} needs 'observable': the command, file or response that proves it`,
      };
    }
    success_criteria.push({ statement, observable });
  }

  const rawConstraints = input.constraints ?? [];
  if (!Array.isArray(rawConstraints) || rawConstraints.length > MAX_CONSTRAINTS) {
    return { error: `constraints must be an array of at most ${MAX_CONSTRAINTS} entries` };
  }
  const constraints = [];
  for (const [index, entry] of rawConstraints.entries()) {
    const rule = typeof entry === "string" ? entry.trim() : String(entry?.rule ?? "").trim();
    if (!rule) return { error: `constraint ${index + 1} has no rule` };
    const hard = entry && typeof entry === "object" && entry.hard === false ? false : true;
    constraints.push({ rule, hard });
  }

  const budget = {};
  const rawBudget = input.budget && typeof input.budget === "object" ? input.budget : {};
  if (rawBudget.max_attempts !== undefined) {
    const value = Number(rawBudget.max_attempts);
    if (!Number.isInteger(value) || value < 1 || value > 50) {
      return { error: "budget.max_attempts must be an integer between 1 and 50" };
    }
    budget.max_attempts = value;
  }
  if (rawBudget.max_tokens !== undefined && rawBudget.max_tokens !== null) {
    const value = Number(rawBudget.max_tokens);
    if (!Number.isFinite(value) || value <= 0) return { error: "budget.max_tokens must be a positive number" };
    budget.max_tokens = value;
  }

  const existing = getGoal(input.name ?? "");
  return {
    goal: {
      ...emptyGoal(),
      ...(existing.version ? { attempts: existing.attempts ?? [] } : {}),
      objective,
      success_criteria: assignIds(success_criteria, "crit"),
      constraints: assignIds(constraints, "cons"),
      budget: { ...emptyGoal().budget, ...budget },
      status: "open",
      updated_at: new Date().toISOString(),
    },
  };
}

/** Replace the goal. `{ reset: true }` also clears the attempt history. */
export function setGoal(name, input, { reset = false } = {}) {
  const normalized = normalizeGoal({ ...input, name });
  if (normalized.error) throw new Error(normalized.error);
  const goal = normalized.goal;
  // A reset clears the attempt history; otherwise the new goal inherits it.
  goal.attempts = reset ? [] : getGoal(name).attempts ?? [];
  return writeGoal(name, goal);
}

/**
 * Record the judge's decision.
 *
 * - `accept` closes the goal (`status: "accepted"`)
 * - `retry` reopens it for another turn and counts the attempt against the budget
 * - `escalate` parks it (`status: "escalated"`) for a human
 *
 * Retrying past `budget.max_attempts` escalates instead of looping forever.
 */
export function judgeGoal(name, { verdict, reason = "", evidence = [], criteria_met = [] } = {}) {
  const goal = getGoal(name);
  if (goal.status === "invalid") throw new Error(goal.error);
  if (!goal.objective) throw new Error("no goal is set");
  if (!VERDICTS.has(verdict)) {
    throw new Error("verdict must be one of accept, retry, escalate");
  }
  const attempts = goal.attempts ?? [];
  const attempt = attempts.length + 1;
  const entry = {
    attempt,
    verdict,
    reason: String(reason),
    evidence: Array.isArray(evidence) ? evidence.map(String).slice(0, 20) : [],
    criteria_met: Array.isArray(criteria_met) ? criteria_met.map(String) : [],
    at: new Date().toISOString(),
  };

  let status = verdict === "accept" ? "accepted" : verdict === "escalate" ? "escalated" : "open";
  let escalatedBecause = null;
  if (verdict === "retry" && attempt >= (goal.budget?.max_attempts ?? 3)) {
    // The budget, not a feeling, ends the loop.
    status = "escalated";
    escalatedBecause = `retry budget exhausted after ${attempt} attempts`;
  }

  const judged = {
    ...goal,
    status,
    attempts: [...attempts, { ...entry, ...(escalatedBecause ? { verdict: "escalate", reason: escalatedBecause } : {}) }],
    updated_at: new Date().toISOString(),
  };
  return writeGoal(name, judged);
}

/** How far the current result is from a judgement, for a prompt or a UI. */
export function goalSummary(name) {
  const goal = getGoal(name);
  const last = (goal.attempts ?? []).at(-1) ?? null;
  return {
    objective: goal.objective,
    status: goal.status,
    criteria: goal.success_criteria.map((criterion) => ({
      id: criterion.id,
      statement: criterion.statement,
      observable: criterion.observable,
      met: last?.criteria_met?.includes(criterion.id) ?? false,
    })),
    constraints: goal.constraints,
    attempts: goal.attempts.length,
    budget: goal.budget,
    last_verdict: last ? { verdict: last.verdict, reason: last.reason } : null,
  };
}
