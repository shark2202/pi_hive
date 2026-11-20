/**
 * Stall and doom-loop detection for a colony's loop.
 *
 * Two failure shapes matter and both look like "still working":
 *   - a stall: N turns pass without the loop touching anything new (no tool call,
 *     no file write, no message);
 *   - a doom loop: the same action repeats, so the loop is busy but going nowhere.
 *
 * The guard keeps a short window of action signatures per colony and answers with
 * a verdict plus the reason, so the caller can park the loop instead of burning
 * turns. It never decides by wall-clock time: a slow turn is not a stall.
 */
import fs from "node:fs";
import path from "node:path";

import { colonyPaths } from "./colony.js";

const WINDOW = 12;
const REPEAT_LIMIT = 4;
const IDLE_LIMIT = 3;

export function guardPath(name) {
  return path.join(path.dirname(colonyPaths(name).plan), "loop-guard.json");
}

function readState(name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(guardPath(name), "utf8"));
    return {
      window: Array.isArray(parsed.window) ? parsed.window.slice(-WINDOW) : [],
      idle: Number(parsed.idle ?? 0) || 0,
      parked: parsed.parked === true,
      park_reason: parsed.park_reason ?? null,
    };
  } catch {
    return { window: [], idle: 0, parked: false, park_reason: null };
  }
}

function writeState(name, state) {
  const file = guardPath(name);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  return state;
}

/**
 * Record one turn.
 *
 * @param {string} name colony
 * @param {{ signature?: string|null }} turn `signature` is a stable description of
 *        what the turn did (e.g. `tool:read:src/a.js`); `null`/absent means the
 *        turn produced nothing observable.
 */
export function observeTurn(name, { signature = null } = {}) {
  const state = readState(name);
  const sig = typeof signature === "string" && signature.trim() ? signature.trim() : null;
  const window = [...state.window, { signature: sig, at: new Date().toISOString() }].slice(-WINDOW);
  const idle = sig === null ? state.idle + 1 : 0;
  const next = { ...state, window, idle };

  const verdict = evaluate(next);
  if (verdict.stalled) {
    next.parked = true;
    next.park_reason = verdict.reason;
  }
  writeState(name, next);
  return { ...verdict, idle, parked: next.parked, park_reason: next.park_reason };
}

/** Pure judgement over a state, so a test can drive it without a filesystem. */
export function evaluate(state) {
  const window = Array.isArray(state?.window) ? state.window : [];
  const signatures = window.map((entry) => entry.signature).filter((sig) => typeof sig === "string");

  // A doom loop: the same signature repeated without anything else in between.
  let streak = 0;
  let last = null;
  for (const signature of signatures) {
    streak = signature === last ? streak + 1 : 1;
    last = signature;
    if (streak >= REPEAT_LIMIT) {
      return {
        stalled: true,
        kind: "doom_loop",
        reason: `the same action repeated ${streak} times: ${signature}`,
        signature,
      };
    }
  }

  if ((Number(state?.idle) || 0) >= IDLE_LIMIT) {
    return {
      stalled: true,
      kind: "stall",
      reason: `${state.idle} turns in a row produced nothing observable`,
      signature: null,
    };
  }
  return { stalled: false, kind: null, reason: null, signature: null };
}

/**
 * Clear the park flag after a human fixes the cause. The window resets too: the
 * repetitions that caused the park are history, not a verdict about the retry.
 */
export function clearPark(name) {
  const state = readState(name);
  return writeState(name, { ...state, parked: false, park_reason: null, idle: 0, window: [] });
}

export function guardState(name) {
  return readState(name);
}

/**
 * The signature of one finished turn: the tools it called, else a text marker.
 * Deterministic, so two identical turns produce the same string.
 */
export function turnSignature(messages) {
  const calls = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "tool_use" && part?.type !== "tool-call") continue;
      const input = part.input ?? part.args ?? {};
      const detail = typeof input === "object" ? JSON.stringify(input) : String(input);
      calls.push(`${part.name ?? part.toolName ?? "tool"}:${detail}`.slice(0, 300));
    }
  }
  if (calls.length) return calls.join("|").slice(0, 1000);
  const text = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "assistant")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("")
    .trim();
  return text ? `text:${text.slice(0, 200)}` : null;
}
