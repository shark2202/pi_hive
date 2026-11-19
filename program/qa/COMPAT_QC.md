# API/UI Compatibility QC

## What "official frontend runs unchanged" means

The official `core/frontend/dist` is served at `/`; pi_hive does not rewrite it.
The frontend's `/api` calls are answered by pi_hive. A route is only "compatible"
when the frontend can consume the response shape, not when a route merely exists.

## Boot gate

| Check | Evidence required |
|---|---|
| Dist present | `dist/index.html` exists and references `/assets/` |
| Index served | `GET /` → 200, `text/html`, contains the official app bundle |
| Assets served | first `/assets/*.js` and `/assets/*.css` → 200 with correct content-type |
| Health | `GET /api/health` → 200 JSON |
| Compat map | `GET /api/compat/routes` → 200 JSON with counts |
| Unimplemented route | `GET /api/__not_a_route__` → 501 JSON with `type:"not_implemented"` |
| No generic API 404 | unknown `/api/*` never falls through to the SPA HTML |
| SPA fallback | a non-API GET path → official `index.html`, not a 404 |
| Existing UI | `/ui/` still serves the pi_hive dashboard |

A browser boot is not enough: record the console errors and the first failing
network requests. A blank page with a 200 index is a failure.

## Contract gate

- `program/contracts/hive-api.json` parses and has unique ids.
- Every entry has `method`, normalized `path`, `client`, `pi_hive_status`.
- The official frontend clients and the contract are derived from the same
  source version; record the source commit or mtime.
- The contract must include SSE routes separately from JSON routes.
- A route marked `implemented` must have a live request or a unit test.
- A route marked `shell-only` or `missing` must not be claimed as compatible.

## Honesty gate

- "Serves the official frontend" ≠ "Hive-compatible API".
- "Boots" ≠ "screens work".
- "Dashboard parity" is not claimed for the official UI until real screens are
  exercised against real API responses.
- Every failing request from the boot report becomes a contract backlog item.
