# Cycle 1 — API contract + official frontend shell

Started: 2026-11-19 18:04 +08:00
Deadline: 2026-11-19 18:49 +08:00

## Decision

Official Hive frontend is the fixed client. pi_hive must satisfy its `/api`
contract. The first cycle is contract-first, not full endpoint implementation.

## Lanes

| Lane | Scope | Status source |
|---|---|---|
| api-cartographer | API inventory, machine contract, contract shape test | `.lanes/api-cartographer/LANE_STATUS.json` |
| compat-shell | official `dist` serving + `/api` compat router | `.lanes/compat-shell/LANE_STATUS.json` |
| contract-qa | independent inventory + diff | `.lanes/contract-qa/LANE_STATUS.json` |
| frontend-boot | browser boot against shell (after merge) | `.lanes/frontend-boot/LANE_STATUS.json` |

## Governance

- `program/PROGRAM.md` — RASCI, SOP, PDCA, acceptance.
- `program/state.json` — deadlines and lane status paths.
- `program/watchdog.mjs` — active macOS notification on stale/missing heartbeats or deadline.
- `program/qa/check.mjs` — contract shape, official dist presence, served-surface checks.
- `program/qa/COMPAT_QC.md` — boot/contract/honesty gates.

## Baseline evidence

```text
node program/qa/check.mjs
PASS official dist index exists — /Users/mac/hive/core/frontend/dist/index.html
PASS index references assets
PASS first JS asset present — /assets/index-DpsIUdOC.js
warnings=1 (contract missing; cartographer lane)
```

## Next actions

1. Merge cartographer contract and QA diff.
2. Merge compat shell; run `program/qa/check.mjs --base http://127.0.0.1:<port>`.
3. Spawn `frontend-boot` to open the official frontend and record failing requests.
4. Convert failing requests into the next contract backlog.
