# Official Frontend End-to-End — API Surface Complete

Status: **route surface complete; behavior partially aligned**. This is not a
claim of full Hive behavioral parity.

## Contract result

```text
171 entries = 168 unique HTTP + 3 SSE
implemented 107
partial      64
shell-only   0
missing       0
```

Every official route now has a handler. `partial` means the route answers an
explicit `unsupported_capability` / `invalid_request` / `conflict` or a
documented empty collection; no route falls through to the structured 501.
Contract: `program/contracts/hive-api.json` (v1.3.0), inventory:
`docs/API_COMPAT.md`.

## Verified live flow

Server: `PI_HIVE_HOME=.tmp-home PI_HIVE_PORT=8801 node src/cli.js serve`.

```text
POST /api/sessions                -> 201
GET  /api/colonies/server-demo/sessions -> 200
GET  /api/sessions/:id            -> 200
GET  /api/sessions/:id/workers    -> 200 {"workers":[]}
GET  /api/sessions/:id/tasks      -> 200
POST /api/sessions/:id/chat       -> 200 {"reply":"在线。"}
GET  /api/sessions/:id/events     -> 200 text/event-stream
```

The SSE route replays and tails the durable
`PI_HIVE_HOME/sessions/<id>/events.jsonl`; frames are the exact stored records
(`client_input_received`, `llm_text_delta`). No synthetic events.

Official frontend desktop (1440×900) rendered both bubbles:

- user: “只回答两个字：在线。”
- Queen: “在线” (Agent Manager)

Screenshot: `program/reports/frontend-chat-rendered.png`.
`window.__apiFailures: []`.

## Tests run

```text
node --test tests/compat/*.test.js       189/189 pass
node --test tests/compat-shell.test.js     9/9 pass
npm test                                  24/24 pass
program/qa/check.mjs                      failures=0 warnings=0
```

## Honest gaps (the 64 partials)

- MCP: no client/loader; server list/config endpoints persist configuration only.
- Telegram/Slack: no transport; validation returns explicit integration_unavailable.
- Credential vault: local CRUD only; no external provider authorization.
- Global team DB: no global database; empty collections/404 where appropriate.
- Claude Code peer routing / transcript / queen DM / avatar: not implemented.
- LLM compaction / `compact-and-fork`: partial/unsupported.
- Config writes: 19 routes return structured unsupported capability.
- Worker views are colony-scoped; session worker list can be empty.
- Official mobile layout is desktop-first: at 390×844 the page has no horizontal
  scrollbar (`scrollWidth == innerWidth`), but the sidebar consumes most of the
  width and the right panel is clipped. The native `/ui/` is responsive; the
  official frontend is not claimed responsive.
- The official page still shows the `BrowserStatusBadge` text “Bridge runtime
  offline”; this is the browser-tool bridge indicator, not a chat/API failure.
  Queen chat works with no failed fetch.
- No full behavioral parity claim: the 64 partial rows remain explicit work.

## Screenshots

- Desktop: `program/reports/frontend-chat-rendered.png`
- Mobile: `program/reports/frontend-chat-mobile.png`
- Colony page: `program/reports/frontend-colony-open-fixed.png`
