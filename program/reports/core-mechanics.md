# Core mechanics parity — Goal judge, metering, stall guard, park/resume, worker grace

Date: 2026-11-20 (+08:00). Step-4 of the objective.

## What was missing and what runs now

| Mechanism | Before | Now |
|---|---|---|
| Goal & Outcome judge | plan.json held a `goal` string, nothing judged it | `colonies/<name>/goal.json`: objective, success criteria (each **must** carry an `observable` check), constraints (hard/soft), `budget.{max_attempts,max_tokens}`, attempt log; `judgeGoal` accepts / retries / escalates |
| Token & cost metering | none | `colonies/<name>/metering.json`: turns, tokens in/out, cost, per day and in total, summed from assistant `usage`; `budgetState()` answers exhausted/remaining against the goal |
| Stall / doom loop | only a wall-clock worker timeout | `loop-guard.json` + `evaluate()`: 4 identical action signatures, or 3 turns with nothing observable, park the loop with a reason |
| Crash-safe park/resume | session records survived, no cursor | `SessionStore.park()` writes `parked_at`/`park_reason`/`resume_cursor` (byte offset past the last event); `resume()` returns it and clears the flag |
| Worker resume | no `resume_worker_ids` | `runWorker({resume})` seeds the prompt through `normalizeResume()`+`resumePrompt()`; the record reports `resumed_from` |
| Grace iteration | a worker without `report_to_parent` lost its work | one `GRACE_PROMPT` turn before falling back; the fallback report carries `grace_turn: true` |

New modules: `src/domain/goal.js`, `src/domain/metering.js`, `src/domain/loop-guard.js`.
Wiring: `src/runtime/worker.js` records usage and the turn signature after every run and
exports `normalizeResume`/`resumePrompt`/`GRACE_PROMPT`; `src/compat/sessions.js` gained
`park()`, `resume()` and `lastEventCursor()`.

## Evidence

```
node --test tests/core-mechanics.test.js          # 10 tests, 10 pass
node --test tests/compat/sessions-handlers.test.js # 34 tests, 34 pass
npm test                                          # 250 tests, 250 pass
node program/qa/route-coverage.mjs                # 171/171
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs  # failures=0 warnings=0
```

What the tests actually assert:

- **Goal** — a criterion without `observable` is refused and the stored goal is untouched;
  ids are stable (`crit_1`, `cons_1`); a corrupt `goal.json` reports `status:"invalid"`
  instead of looking absent.
- **Judge** — `accept` closes the goal, `retry` reopens it and counts the attempt, and the
  second retry with `max_attempts: 2` **escalates** with
  `retry budget exhausted after 2 attempts`; `criteria_met` drives `goalSummary().criteria[].met`.
- **Metering** — two assistant messages in one turn produce
  `{turns:2, tokens_in:120, tokens_out:50, cost_usd:0.002}`, a second day lands in its own
  bucket, a usage-free turn is not recorded at all, and the budget flips to `exhausted`
  exactly at the limit.
- **Stall guard** — the fourth identical signature parks with `doom_loop`; three empty
  turns park with `stall`; `clearPark` resets the window so a fixed loop can proceed;
  `evaluate()` is pure and `turnSignature()` is stable for the same transcript.
- **Park/resume** — an empty log parks at cursor 0; after two events the cursor is past
  them; the park record survives a fresh `SessionStore`; events appended while parked move
  the log past the stored cursor; `resume()` returns the stored cursor and the second
  `resume()` reports `resumed:false`.
- **Resume/grace** — `normalizeResume` rejects strings, empty objects and non-string
  summaries (so a caller cannot inject prompt text), and `resumePrompt` carries the prior
  data + summary; `GRACE_PROMPT` is a fixed instruction.

## Not covered

- No end-to-end worker run in the tests: `runWorker` needs a model runtime, and this
  environment has no key. The grace/resume seam is tested as a pure function; the turn
  itself is exercised only by construction.
- Metering counts what the provider reports in `usage`; a provider that omits it records
  zero rather than an estimate.
- Compaction is the session `compact-and-fork` path (model-first, extract fallback), not a
  background compactor inside the loop.
- The stall guard never decides from wall-clock time, so a genuinely slow turn is not a
  stall; only repeated or empty turns are.
