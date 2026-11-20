# Cycle: UI independence (step-1)

Date: 2026-11-20. Scope: `frontend/`, `src/server.js`, `program/qa/check.mjs`, `package.json`, docs.

## What changed

- Official frontend forked into this repo at `frontend/` (source copied from
  `<hive-core>/frontend`, excluding `node_modules/` and `dist/`).
- `frontend/vite.config.ts`: app version now read from this repo's root
  `package.json` instead of `core/pyproject.toml`; dev proxy targets
  `127.0.0.1:${PI_HIVE_PORT||8790}` instead of `localhost:8787`.
- `src/server.js`: `DEFAULT_FRONTEND_DIST` is now
  `path.resolve(import.meta.dirname, "../frontend/dist")` — repo-relative, no
  machine-specific absolute path. The 503 message points at `npm run ui:build`.
- `program/qa/check.mjs`: dist default is repo-relative as well.
- Root `package.json`: added `ui:install`, `ui:build`, `ui:test`, `ui:dev`;
  `npm test` now also runs `tests/compat/*.test.js`.
- Two fork-side type fixes: `tool_modules: []` added in
  `src/data/byokCatalog.ts` and `src/pages/credentials.tsx`. Upstream
  `core/frontend` fails `tsc --noEmit` on the same two sites (its committed
  `dist` predates the `CredentialSpec.tool_modules` change), so
  `npm run ui:build` — which runs `tsc && vite build` — could not have
  succeeded without fixing them here.

## Verified now (this environment, macOS, node 24)

| Check | Result |
| --- | --- |
| `npm run ui:build` | `✓ built in 9.30s`, `frontend/dist` = 1000 files / 14M |
| served `/` | 200, index references `/assets/index-BOK9fhAj.js`, which is this build |
| `GET /api/health` | `{"ok":true,"service":"pi-hive","version":"0.1.0"}` |
| `GET /ui/` (native dashboard) | 200 |
| `npm test` | 213 pass / 0 fail (core 24 + compat 189 + compat-shell included) |
| `PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs` | `failures=0 warnings=0`, dist path is `pi_hive/frontend/dist` |
| machine paths in runtime | `grep -rn '<home>' src tests program/qa program/contracts scripts` → 0 hits |

## Not verified (must not be claimed)

- **Chat end-to-end today**: no `PI_HIVE_API_KEY` / `BROADTOKEN_API_KEY` in this
  environment, and per user instruction the pi agent's own config and
  environment must not be borrowed to work around that. The earlier desktop chat
  screenshot (Queen reply over SSE) stands as a 2026-11-19 verdict, not a
  re-run.
- **Browser-level UI behaviour of the fork** (boot, API calls, SSE): not driven
  in a browser yet; only the served HTML/asset wiring and `/api` surface were
  checked.
- **Linux / Windows**: nothing built or run there yet.
- `frontend/` vitest suite (`npm run ui:test`) not executed in this cycle.
