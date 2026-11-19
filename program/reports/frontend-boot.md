# Official Hive Frontend Boot — Compat Shell

> **Superseded.** This is the pre-handler baseline (12 unique 501s). The final
> complete API-surface + chat verification is in
> `program/reports/frontend-chat-e2e.md` (107 implemented / 64 partial / 0
> missing; desktop Queen reply rendered over SSE).

Date: 2026-11-19 18:27 +08:00
Server: `pi_hive serve` on `127.0.0.1:8801`, `HIVE_HOME=.tmp-compat`
Frontend: `/Users/mac/hive/core/frontend/dist` served unchanged by `src/server.js`
Screenshots: `program/reports/frontend-boot-desktop.png` (1440×900), `program/reports/frontend-boot-mobile.png` (390×844)

## Result

The official frontend **loads and renders** against the compat shell. It is not
API-compatible yet: the data layer is missing, and the frontend shows its own
connectivity banner.

Observed at 1440×900:

- `document.title`: `Hive`
- App shell rendered: sidebar, OpenHive wordmark, colony/queen counters, onboarding modal, task composer
- Visible banner: **“Backend requests are failing (14 recent errors)”**
- `COLONIES`: “No colonies yet”
- `QUEEN BEES`: “Loading queens...”
- Counters: 0 queens / 0 colonies / 0 working

At 390×844:

- `scrollWidth == innerWidth` (390) — no horizontal page overflow from the shell
- Banner: **“Reconnecting (2 streams)…”**
- The official frontend’s own layout is desktop-first at this width: sidebar ~50%, compressed main pane, onboarding modal overlapping. This is the official UI’s responsive behavior, not a pi_hive edit.
- No native pi_hive dashboard is served at `/`; `/ui/` remains available.

## Failed requests captured in the browser

The compat router returned `501` for these official routes:

```text
GET /api/config/llm
GET /api/config/models
GET /api/config/profile
GET /api/queen/profiles
GET /api/sessions
GET /api/sessions/history
GET /api/sessions/live          (SSE; EventSource reconnecting)
GET /api/events/global          (SSE; EventSource reconnecting)
GET /api/skills
GET /api/prompts
GET /api/credentials/specs
GET /api/discover
```

The banner count (14) includes repeated SSE retries; the unique boot-critical
routes are the list above.

## What passed

```text
GET /                        200 text/html       450 B  (official index)
GET /assets/index-*.js       200 text/javascript 1,142,385 B
GET /api/health              200 application/json
GET /api/compat/routes       200 application/json (51 registry routes)
GET /api/__nope__            501 application/json not_implemented
GET /ui/                     200 text/html (native dashboard preserved)
```

`program/qa/check.mjs` with `PI_HIVE_BASE=http://127.0.0.1:8801`:
`failures=0 warnings=1` (contract-freeze: no official route implemented).

## Honest conclusion

- **Serving the official frontend: works.**
- **Official frontend boot: works visually.**
- **Official API compatibility: 0 / 171 routes.** The contract has 168 unique
  HTTP + 3 SSE routes; all are intentionally `missing` at this freeze.
- **Usable product: no.** Onboarding, queens, colonies, chat, settings, and
  live streams all depend on endpoints that currently return 501.

## Next backlog (boot order)

1. `GET /api/config/llm`, `/api/config/models`, `/api/config/profile`
2. `GET /api/queen/profiles`, `/api/queens` equivalents
3. `GET/POST /api/sessions`, `/api/sessions/history`
4. `GET /api/colonies` in the official shape + colony detail
5. SSE: `/api/sessions/live`, `/api/events/global`, `/api/sessions/:id/events`
6. `GET /api/skills`, `/api/prompts`, `/api/credentials/specs`, `/api/discover`
7. Onboarding and queen/colony creation flows

Each becomes a real handler backed by pi_hive state; no fake fixtures.
