/**
 * Token/cost metering per colony.
 *
 * A Hive colony can be held to a token budget; without a counter that rule is a
 * wish. Every finished turn sums the assistant messages' `usage` into
 * `colonies/<name>/metering.json` (per day and in total) and reports whether the
 * budget is exhausted. Unknown usage counts as zero rather than being guessed.
 */
import fs from "node:fs";
import path from "node:path";

import { colonyPaths } from "./colony.js";

export function meteringPath(name) {
  return path.join(path.dirname(colonyPaths(name).plan), "metering.json");
}

function emptyUsage() {
  return { turns: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 };
}

export function getUsage(name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(meteringPath(name), "utf8"));
    return {
      total: { ...emptyUsage(), ...(parsed.total ?? {}) },
      by_day: parsed.by_day && typeof parsed.by_day === "object" ? parsed.by_day : {},
      last_turn_at: parsed.last_turn_at ?? null,
    };
  } catch {
    return { total: emptyUsage(), by_day: {}, last_turn_at: null };
  }
}

function sumMessageUsage(messages) {
  const total = emptyUsage();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "assistant") continue;
    const usage = message.usage ?? {};
    const input = Number(usage.input ?? usage.inputTokens ?? usage.prompt_tokens ?? 0) || 0;
    const output = Number(usage.output ?? usage.outputTokens ?? usage.completion_tokens ?? 0) || 0;
    const cost = Number(usage.cost ?? usage.costUsd ?? usage.totalCost ?? 0) || 0;
    total.tokens_in += input;
    total.tokens_out += output;
    total.cost_usd += cost;
    total.turns += 1;
  }
  return total;
}

/**
 * Add one turn's usage. `messages` may be the whole transcript; only assistant
 * messages are counted, so re-recording the same transcript would double count —
 * callers pass the messages produced by the turn they just finished.
 */
export function recordTurnUsage(name, messages, { at = new Date() } = {}) {
  const delta = sumMessageUsage(messages);
  if (delta.turns === 0) return { ...getUsage(name), recorded: null };

  const current = getUsage(name);
  const day = at.toISOString().slice(0, 10);
  const dayUsage = { ...emptyUsage(), ...(current.by_day[day] ?? {}) };
  for (const key of ["turns", "tokens_in", "tokens_out", "cost_usd"]) {
    current.total[key] += delta[key];
    dayUsage[key] += delta[key];
  }
  current.by_day[day] = dayUsage;
  current.last_turn_at = at.toISOString();

  const file = meteringPath(name);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  return { ...current, recorded: delta };
}

/**
 * Budget check against a goal's `budget.max_tokens`.
 *
 * @returns {{ limit: number|null, used: number, exhausted: boolean, remaining: number|null }}
 */
export function budgetState(name, goal = null) {
  const limit = Number(goal?.budget?.max_tokens ?? NaN);
  const used = getUsage(name).total.tokens_in + getUsage(name).total.tokens_out;
  if (!Number.isFinite(limit) || limit <= 0) {
    return { limit: null, used, exhausted: false, remaining: null };
  }
  return { limit, used, exhausted: used >= limit, remaining: Math.max(0, limit - used) };
}
