# Cycle 2 — Official frontend boot APIs

Started: 2026-11-19 18:30 +08:00
Closed: 2026-11-19 18:52 +08:00
Deadline: 2026-11-19 19:20 +08:00

## Result (merged to main)

- Contract: 171 entries, **107 implemented + 64 partial + 0 missing**.
- All handler tests: **177/177**; compat shell 9/9; `npm test` 24/24;
  `program/qa/check.mjs` 13 PASS.
- Live sweep: 168 non-SSE official routes, 0 returned 501/500.
- Session flow works: `POST /api/sessions` 201, colony sessions 200,
  `POST /api/sessions/:session/chat` 200 with `reply: "在线。"`.
- Remaining bug under repair: `GET /api/sessions/:session/workers` returned
  404 unknown_session because the autonomy handler could not see the session
  store. A narrow repair lane is attaching `ctx.resolveSession`.
- Official frontend colony page now opens without “Backend unavailable”, but
  shows “Connecting to Queen…” until the event bridge is wired.

## Inputs from Cycle 1

- Contract freeze: 171 entries = 168 unique HTTP + 3 SSE.
- Compat shell merged into main after the integration manifest.
- Official frontend `dist` served at `/`; native dashboard remains at `/ui/`.
- Real boot: official UI renders, but 12 unique boot requests return 501 and the
  frontend shows “Backend requests are failing (14 recent errors)” /
  “Reconnecting (2 streams)…”.

## Cycle 2 lanes

| Lane | Scope | Output module |
|---|---|---|
| api-config | config/model/profile/features/credentials/skills/prompts/discover | `src/compat/handlers/config.js` |
| api-organization | queen profiles, colonies/tools-index, sessions list/history | `src/compat/handlers/organization.js` |
| api-streams | sessions/live, events/global, sessions/:id/events | `src/compat/handlers/streams.js` |

Each lane works in `.lanes/<lane>/`, registers official routes with
`status: implemented`, and writes a test using a fake req/res. No main edits.

## Acceptance for this cycle

- Handler modules load with no dependencies.
- Official frontend boot failures drop from 12 unique routes to only genuinely
  unimplemented flows.
- `/api/sessions/live` and `/api/events/global` stay open with heartbeats, not 501.
- Main `npm test` remains green and `program/qa/check.mjs` passes with the
  contract-freeze warning.
- No claim of full API compatibility; count and report the remaining routes.
