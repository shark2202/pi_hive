# Lane Results — Cycle 1

## api-cartographer

- Contract: `program/contracts/hive-api.json`
- Docs: `docs/API_COMPAT.md`
- Test: `tests/compat/contract.test.js`
- Counts: **172 entries** (169 HTTP incl. one duplicate + 3 SSE), all `missing` against the current pi_hive route shapes.
- Tests: 7 passed.
- Top families: sessions 32, queens 21, config 19, skills 14, data 13, credentials 12.

## compat-shell

- Files: `src/compat/router.js`, `src/server.js`, `tests/compat-shell.test.js`, `tests/fixtures/dist/`.
- Registry: 51 routes — 9 implemented, 13 partial, 29 missing.
- Serves the official dist at `/`, assets/logos/favicon/SPA fallback; structured 501 for missing API routes; `/ui/` preserved.
- Tests: 8 shell tests passed; `npm test` 23 passed.
- Observed: `GET /` 200 HTML, JS 200 1.14 MB, CSS 200 179 KB, `/api/unknown` 501 JSON.

## contract-qa

- Independent inventory: **168 unique HTTP + 3 SSE**.
- Diff: 0 missing, 0 invented, 0 method mismatches.
- Verdict: `needs-fix (minor)` — duplicate `GET /sessions/:id/workers`; repeated `:id` params; query params only in prose; docs counts conflate SSE.
- Important: 18 frontend route shapes are absent from go_hive's 196-route table, so go_hive cannot be used as the contract source for those families.

## Integration

Integrated in `.lanes/integration`; the manifest was verified and applied to main.
Main now has the compat shell, contract, docs, and tests. Verified after merge:
contract 11/11, compat-shell 8/8, npm test 23/23, served surface 6/6.
The official frontend boots at `/`; see `program/reports/frontend-boot.md`.
