# Official Hive Frontend — Boot After Boot-Critical Handlers

Date: 2026-11-19 18:51 +08:00
Server: `pi_hive serve` on `127.0.0.1:8801`, `PI_HIVE_HOME=.tmp-home`
Frontend: official `core/frontend/dist`, served unchanged at `/`
Screenshots:
- `program/reports/frontend-boot-after-handlers.png` (1440×900)
- `program/reports/frontend-boot-after-handlers-mobile.png` (390×844)
- `program/reports/frontend-interaction-colony.png` (after opening a colony)

At 390×844: `scrollWidth == innerWidth` (390), `window.__apiFailures: []`,
no backend banner. The official layout is desktop-first (expanded sidebar
compresses the main pane), but there is no horizontal page overflow or control
overlap.

## Boot result

At 1440×900, the official frontend now boots **without a visible error banner**:

- `document.title`: `Hive`
- Sidebar: `Demo`, `Server Demo`, `Smoke Queen`
- Queen Bees: `Growth Queen`, `Technology Queen`, `Finance Queen`, `Operations Queen`
- Header: `4 QUEENS · 3 COLONIES · 0 WORKING`
- `window.__apiFailures` after boot: **[]**
- No “Backend requests are failing” or “Reconnecting” banner

The 17 boot-critical routes now return real JSON:

```text
GET /api/config/llm          200
GET /api/config/models       200
GET /api/models/overview     200
GET /api/config/profile      200
GET /api/config/features     200
GET /api/credentials         200
GET /api/credentials/specs   200
GET /api/skills              200
GET /api/prompts             200
GET /api/discover            200
GET /api/queen/profiles      200 (4 queens)
GET /api/colonies/tools-index 200 (3 colonies)
GET /api/sessions            200 ({sessions:[]})
GET /api/sessions/history    200 ({sessions:[]})
GET /api/sessions/live       SSE snapshot
GET /api/events/global       SSE heartbeat
GET /api/sessions/:id/events SSE heartbeat
```

## Next interaction gap

Clicking a colony (`#/colony/server-demo`) reveals the next missing layer:

```text
GET  /api/colonies/server-demo/sessions  501
POST /api/sessions                       501
```

The official UI shows:

> **Backend unavailable: not implemented: POST /api/sessions**

So the frontend is now **bootable and readable**, but not yet **usable for
opening a colony or starting a conversation**. The next backlog is session
lifecycle:

1. `GET /api/colonies/:colony/sessions`
2. `GET /api/colonies/:colony/active-session`
3. `POST /api/sessions`
4. `GET /api/sessions/:session`
5. `POST /api/sessions/:session/chat`
6. session event replay + live bridge

## Honest status

- Official frontend served unchanged: **yes**
- Boots clean with real queens/colonies: **yes**
- API compatibility: **17 / 171** official routes implemented; **154 missing**
- Usable end-to-end product: **no** — session creation/chat is still 501
- Native pi_hive dashboard at `/ui/`: preserved
- No claim of Hive behavioral parity
