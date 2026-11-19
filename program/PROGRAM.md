# Product Delivery Program — Hive API/Frontend Compatibility

## Decision

The target is **the official Hive frontend running unchanged against pi_hive**.

That means the frontend is treated as a fixed client. pi_hive must implement the
API contract it expects. We do not redesign the official UI, and we do not claim
"frontend parity" from a lookalike dashboard.

## Scope of this cycle

1. Freeze the API surface the official frontend actually calls.
2. Build a machine-readable contract and a conformance harness.
3. Serve the official `core/frontend/dist` from pi_hive.
4. Add a compatibility router that reports implemented vs unimplemented routes.
5. Boot the official frontend once and record every failing request.

This cycle does **not** claim full API compatibility. It establishes the
contract, the shell, and the evidence needed for the next cycles.

## RASCI

| Role | Owner | Responsibility |
|---|---|---|
| Accountable | Supervisor | scope, integration, final claim |
| R — API cartographer | lane `api-cartographer` | inventory official frontend API calls, types, SSE; write contract |
| R — compat shell | lane `compat-shell` | serve official dist; `/api` compatibility router; health/config/colonies |
| C — independent QA | lane `contract-qa` | independently inventory endpoints and diff against cartographer |
| C — frontend boot | lane `frontend-boot` | run official frontend against shell; capture request failures |
| Q — QC | Supervisor | tests, contract coverage, no overclaim |

## SOP for every lane

- Work only inside `pi_hive/.lanes/<lane>/`; never edit the main worktree.
- No `npm install`, no dependency changes, no commits.
- The frontend is forked and maintained at `frontend/`; `/Users/mac/hive/core/frontend` is the read-only reference.
- Write `LANE_STATUS.json` with `updated_at`, `phase`, `blocked`, `next`.
- Write `LANE_REPORT.md` with files changed, commands run, observed results, gaps.
- Finish with `node --check` on changed JS and `npm test` when tests exist.
- Do not claim an endpoint is implemented unless a test or a live request proves it.

## PDCA

- **Plan**: cartographer + QA independently enumerate the official API surface.
- **Do**: shell serves the official frontend and a compat router.
- **Check**: QA diffs the inventories; boot lane records real network failures.
- **Act**: supervisor merges only verified pieces; remaining routes become the next contract backlog.

## Time governance

- Program start: `2026-11-19T18:04:25+08:00`
- Cycle 1 deadline: `2026-11-19T18:49:25+08:00` (completed: contract + shell)
- Cycle 2 deadline: `2026-11-19T19:20:39+08:00` (completed: 17 boot routes)
- Cycle 3 deadline: `2026-11-19T20:55:52+08:00`
- Cycle 3 lane soft stop: `20:15`; integration/QA by `20:45`.
- Watchdog: `node program/watchdog.mjs`; active alerts via macOS Notification Center.
- A lane missing a heartbeat for 12 minutes is treated as stalled.

## Acceptance for this cycle

- `docs/API_COMPAT.md` lists the official frontend's API clients and every route family.
- `program/contracts/hive-api.json` is machine-readable and includes method, path,
  source client, request/response type, and current pi_hive status.
- `tests/compat/contract.test.js` validates the contract shape and route coverage.
- `GET /` serves the official Hive `dist/index.html` (not the pi_hive dashboard).
- `GET /api/health` and the compat router return JSON; unimplemented routes return
  a structured `501 { error, type: "not_implemented" }`.
- `program/reports/frontend-boot.md` records the real browser console/network result.

## Non-goals

- Pixel-perfect visual review of the official frontend in this cycle.
- Implementing all ~100 routes in one cycle.
- Changing the official frontend source.
- Claiming Hive behavioral parity from a bootable shell.
