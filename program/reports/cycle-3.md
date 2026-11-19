# Cycle 3 — Complete the remaining official API surface

Started: 2026-11-19 18:56 +08:00
Deadline: 2026-11-19 20:55 +08:00

## Baseline

- Contract: 171 entries; **17 implemented / 154 missing**
- Official frontend: boot clean at `/`, 4 queens / 3 colonies, no API failures
- Blocking gap: colony click → `GET /api/colonies/:colony/sessions` and
  `POST /api/sessions` return 501

## Lane partition (154 routes)

| Lane | Scope | Routes |
|---|---|---|
| api-sessions | session store, lifecycle, chat, events, triggers, attachments | 30 |
| api-queens | queens, soul, claude-code-queens | 28 |
| api-catalog | skills, prompts, memories, agents | 21 |
| api-config-extra | remaining config, models, credentials | 30 |
| api-colonies-data | colony management + tracker/global data browser | 19 |
| api-autonomy | MCP, Sentinel, system, tasks, workers | 26 |

Each lane owns one new `src/compat/handlers/<domain>.js` + test, works in
`.lanes/<lane>/`, and must not edit the default registry or server. Integration
will add `installCompatHandlers` wiring and update contract statuses.

## Rules

- Real data where pi_hive has it (colonies, tracker, skills, memory, workers,
  plans, soul).
- Empty valid collections where there is genuinely no store.
- Explicit 4xx with a reason for unsupported third-party capabilities (MCP
  health, Telegram/Slack validation, credential vault), never fake success.
- No 501 just to clear a contract row; a route is `implemented` only with a
  test and real response, otherwise `partial`.
- No model calls, no fixed ports, no npm install.

## Acceptance

- Every one of the 154 routes is registered by a lane module.
- Every module has tests; main `npm test` and `program/qa/check.mjs` stay green.
- Integration reports implemented/partial/missing by domain, and re-boots the
  official frontend: colony open + chat either works or has a documented next
  gap.
## Final result

- Contract: **171 = 107 implemented + 64 partial + 0 missing**.
- All 154 previously missing routes now have handlers; no official route falls
  through to 501.
- Live sweep: 168 non-SSE routes returned 0 501/500; session create/chat and
  colony sessions verified. See `program/reports/frontend-chat-e2e.md`.
- Official desktop chat verified end-to-end (Queen reply “在线” over SSE);
  tests: compat 189/189, shell 9/9, npm 24/24, QC 0 failures.
- 64 partial rows remain explicit capability gaps; no full behavioral parity
  claim.

