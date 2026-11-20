# Per-route test coverage

Generated from `program/contracts/hive-api.json` and `tests/**/*.test.js` by
`node program/qa/route-coverage.mjs`. **171/171 routes are named by at least one test.**

Detection is a floor: a route counts as covered when a test file contains a quoted
`/api/...` path whose segments match the route pattern (template wildcards included,
query strings ignored) and the file also names the route's HTTP method. Semantic
strength is the next column's job: the reports under `program/reports/` state what each
domain's assertions actually check.

## Summary by domain

| Domain | Routes | Covered |
|---|---|---|
| agents | 3 | 3 |
| claude-code-queens | 2 | 2 |
| colonies | 7 | 7 |
| config | 19 | 19 |
| credentials | 12 | 12 |
| data | 13 | 13 |
| events | 3 | 3 |
| mcp | 7 | 7 |
| memories | 4 | 4 |
| models | 6 | 6 |
| prompts | 3 | 3 |
| queens | 21 | 21 |
| sentinel | 7 | 7 |
| sessions | 32 | 32 |
| skills | 14 | 14 |
| soul | 6 | 6 |
| system | 2 | 2 |
| tasks | 3 | 3 |
| workers | 7 | 7 |

| **total** | **171** | **171** |

## Route map

| Route | Test file(s) |
|---|---|
| `DELETE /agents` | catalog-handlers.test.js |
| `GET /discover` | config-handlers.test.js, organization-handlers.test.js |
| `PATCH /agents/metadata` | catalog-handlers.test.js |
| `GET /claude-code-queens` | queens-handlers.test.js |
| `GET /claude-code-queens/:queen/conversations/:conversation` | queens-handlers.test.js |
| `DELETE /colonies/:colony` | colonies-data-handlers.test.js |
| `GET /colonies/tools-index` | organization-handlers.test.js, tests/compat-shell.test.js |
| `GET /colony/:colony/tools` | colonies-data-handlers.test.js |
| `PATCH /colony/:colony/tools` | colonies-data-handlers.test.js |
| `POST /colonies/:colony/rename` | colonies-data-handlers.test.js |
| `POST /colonies/:colony/reveal` | colonies-data-handlers.test.js |
| `POST /colonies/:colony/scaffold` | colonies-data-handlers.test.js |
| `GET /config/external-skills` | config-extra-handlers.test.js |
| `GET /config/features` | config-extra-handlers.test.js, config-handlers.test.js |
| `GET /config/llm` | config-extra-handlers.test.js, config-handlers.test.js |
| `GET /config/llm-sections` | config-extra-handlers.test.js |
| `GET /config/models` | config-handlers.test.js |
| `GET /config/profile` | config-extra-handlers.test.js, config-handlers.test.js |
| `GET /config/profile/avatar` | config-extra-handlers.test.js |
| `GET /config/provider-library` | config-extra-handlers.test.js |
| `GET /config/rate-limits` | config-extra-handlers.test.js |
| `GET /startup-status` | config-extra-handlers.test.js |
| `POST /config/profile/avatar` | config-extra-handlers.test.js |
| `POST /config/provider-library/apply` | config-extra-handlers.test.js |
| `PUT /config/external-skills` | config-extra-handlers.test.js |
| `PUT /config/features` | config-extra-handlers.test.js |
| `PUT /config/llm` | config-extra-handlers.test.js |
| `PUT /config/llm-sections` | config-extra-handlers.test.js |
| `PUT /config/profile` | config-extra-handlers.test.js |
| `PUT /config/provider-library` | config-extra-handlers.test.js |
| `PUT /config/rate-limits` | config-extra-handlers.test.js |
| `DELETE /credentials/:credential` | config-extra-handlers.test.js |
| `DELETE /credentials/local/:credential/:alias` | config-extra-handlers.test.js |
| `GET /credentials` | config-extra-handlers.test.js, config-handlers.test.js |
| `GET /credentials/:credential` | config-extra-handlers.test.js, config-handlers.test.js |
| `GET /credentials/oauth-status` | config-extra-handlers.test.js |
| `GET /credentials/specs` | config-extra-handlers.test.js, config-handlers.test.js |
| `POST /credentials` | config-extra-handlers.test.js, config-handlers.test.js |
| `POST /credentials/check-agent` | config-extra-handlers.test.js |
| `POST /credentials/local` | config-extra-handlers.test.js |
| `POST /credentials/resync` | config-extra-handlers.test.js |
| `POST /credentials/validate-key` | config-extra-handlers.test.js |
| `POST /sessions/:session/credential-form` | config-extra-handlers.test.js |
| `DELETE /global/data/tables/:table/rows` | global-data-handlers.test.js |
| `GET /colonies/:colony/data/changes` | colonies-data-handlers.test.js |
| `GET /colonies/:colony/data/tables` | colonies-data-handlers.test.js |
| `GET /colonies/:colony/data/tables/:table/rows` | colonies-data-handlers.test.js |
| `GET /global/data/changes` | global-data-handlers.test.js |
| `GET /global/data/foreign-keys` | global-data-handlers.test.js |
| `GET /global/data/tables` | global-data-handlers.test.js |
| `GET /global/data/tables/:table/rows` | global-data-handlers.test.js |
| `PATCH /colonies/:colony/data/tables/:table/rows` | colonies-data-handlers.test.js |
| `PATCH /global/data/tables/:table/rows` | global-data-handlers.test.js |
| `POST /global/data/tables/:table/group-counts` | global-data-handlers.test.js |
| `POST /global/data/tables/:table/query` | global-data-handlers.test.js |
| `POST /global/data/tables/:table/rows` | global-data-handlers.test.js |
| `GET /events/global` | streams-handlers.test.js |
| `GET /sessions/:session/events` | session-events-stream.test.js, streams-handlers.test.js, tests/compat-shell.test.js |
| `GET /sessions/live` | streams-handlers.test.js |
| `DELETE /mcp/servers/:server` | autonomy-handlers.test.js |
| `GET /mcp/servers` | autonomy-handlers.test.js |
| `POST /mcp/servers` | autonomy-handlers.test.js |
| `POST /mcp/servers/:server/disable` | autonomy-handlers.test.js |
| `POST /mcp/servers/:server/enable` | autonomy-handlers.test.js |
| `POST /mcp/servers/:server/health` | autonomy-handlers.test.js |
| `POST /mcp/servers/:server/mode` | autonomy-handlers.test.js |
| `DELETE /memories/file` | catalog-handlers.test.js |
| `GET /memories` | catalog-handlers.test.js |
| `GET /memories/file` | catalog-handlers.test.js |
| `PUT /memories/file` | catalog-handlers.test.js |
| `DELETE /models/endpoints/:endpoint` | config-extra-handlers.test.js |
| `DELETE /models/slots/:slot` | config-extra-handlers.test.js |
| `GET /models/endpoints/:endpoint/models` | config-extra-handlers.test.js |
| `GET /models/overview` | config-extra-handlers.test.js, config-handlers.test.js |
| `PUT /models/endpoints/:endpoint` | config-extra-handlers.test.js |
| `PUT /models/slots/:slot` | config-extra-handlers.test.js |
| `DELETE /prompts/:prompt` | catalog-handlers.test.js |
| `GET /prompts` | catalog-handlers.test.js, config-handlers.test.js |
| `POST /prompts` | catalog-handlers.test.js, config-handlers.test.js |
| `DELETE /queen/:queen/avatar` | queens-handlers.test.js |
| `DELETE /queen/:queen/tools` | queens-handlers.test.js |
| `GET /queen/:queen/avatar` | queens-handlers.test.js |
| `GET /queen/:queen/llm` | queens-handlers.test.js |
| `GET /queen/:queen/overview` | queens-handlers.test.js |
| `GET /queen/:queen/persona` | queens-handlers.test.js |
| `GET /queen/:queen/profile` | queens-handlers.test.js |
| `GET /queen/:queen/tools` | queens-handlers.test.js |
| `GET /queen/profiles` | organization-handlers.test.js |
| `GET /queen/removed` | queens-handlers.test.js |
| `PATCH /queen/:queen/profile` | queens-handlers.test.js |
| `PATCH /queen/:queen/tools` | queens-handlers.test.js |
| `POST /queen/:queen/avatar` | queens-handlers.test.js |
| `POST /queen/:queen/remove` | queens-handlers.test.js |
| `POST /queen/:queen/restore` | queens-handlers.test.js |
| `POST /queen/:queen/session` | queens-handlers.test.js |
| `POST /queen/:queen/session/new` | queens-handlers.test.js |
| `POST /queen/:queen/session/select` | queens-handlers.test.js |
| `POST /queen/create` | queens-handlers.test.js |
| `PUT /queen/:queen/llm` | queens-handlers.test.js |
| `PUT /queen/:queen/persona` | queens-handlers.test.js |
| `GET /colony/:colony/notifications` | autonomy-handlers.test.js |
| `GET /sentinel/credentials` | autonomy-handlers.test.js |
| `POST /colony/:colony/notifications/test` | autonomy-handlers.test.js |
| `POST /sentinel/slack/validate` | autonomy-handlers.test.js |
| `POST /sentinel/telegram/detect-chat` | autonomy-handlers.test.js |
| `POST /sentinel/telegram/validate` | autonomy-handlers.test.js |
| `PUT /colony/:colony/notifications` | autonomy-handlers.test.js |
| `DELETE /sessions/:session` | sessions-handlers.test.js |
| `DELETE /sessions/history/:session` | sessions-handlers.test.js |
| `GET /colonies/:colony/active-session` | sessions-handlers.test.js |
| `GET /colonies/:colony/sessions` | sessions-handlers.test.js |
| `GET /sessions` | organization-handlers.test.js, sessions-handlers.test.js, tests/compat-shell.test.js |
| `GET /sessions/:session` | organization-handlers.test.js, sessions-handlers.test.js, streams-handlers.test.js |
| `GET /sessions/:session/attachment/:attachment` | sessions-handlers.test.js |
| `GET /sessions/:session/events/history` | sessions-handlers.test.js |
| `GET /sessions/:session/live_tools` | sessions-handlers.test.js |
| `GET /sessions/:session/snapshot` | sessions-handlers.test.js |
| `GET /sessions/:session/stats` | sessions-handlers.test.js |
| `GET /sessions/:session/triggers` | sessions-handlers.test.js |
| `GET /sessions/history` | organization-handlers.test.js |
| `PATCH /sessions/:session/title` | sessions-handlers.test.js |
| `PATCH /sessions/:session/triggers/:trigger` | sessions-handlers.test.js |
| `POST /sessions` | sessions-handlers.test.js, tests/compat-shell.test.js |
| `POST /sessions/:session/cancel-queen` | sessions-handlers.test.js |
| `POST /sessions/:session/chat` | sessions-handlers.test.js |
| `POST /sessions/:session/compact-and-fork` | sessions-handlers.test.js |
| `POST /sessions/:session/dismiss-colony-pivot` | sessions-handlers.test.js |
| `POST /sessions/:session/fork` | sessions-handlers.test.js |
| `POST /sessions/:session/mark-colony-spawned` | sessions-handlers.test.js |
| `POST /sessions/:session/presence` | sessions-handlers.test.js |
| `POST /sessions/:session/queen-context` | sessions-handlers.test.js |
| `POST /sessions/:session/record-message` | sessions-handlers.test.js |
| `POST /sessions/:session/report-bundle` | sessions-handlers.test.js |
| `POST /sessions/:session/reveal` | sessions-handlers.test.js |
| `POST /sessions/:session/triggers` | sessions-handlers.test.js |
| `POST /sessions/:session/triggers/:trigger/activate` | sessions-handlers.test.js |
| `POST /sessions/:session/triggers/:trigger/deactivate` | sessions-handlers.test.js |
| `POST /sessions/:session/triggers/:trigger/run` | sessions-handlers.test.js |
| `POST /sessions/:session/upload-attachment` | sessions-handlers.test.js |
| `DELETE /queen/:queen/skills/:skill` | catalog-handlers.test.js |
| `GET /queen/:queen/skills` | catalog-handlers.test.js |
| `GET /queen/:queen/skills/:skill/body` | catalog-handlers.test.js |
| `GET /sessions/:session/skill-installs` | catalog-handlers.test.js |
| `GET /skills` | config-handlers.test.js |
| `GET /skills/:skill` | catalog-handlers.test.js |
| `GET /skills/scopes` | catalog-handlers.test.js |
| `PATCH /queen/:queen/skills/:skill` | catalog-handlers.test.js |
| `POST /queen/:queen/skills` | catalog-handlers.test.js |
| `POST /queen/:queen/skills/:skill/rename` | catalog-handlers.test.js |
| `POST /queen/:queen/skills/reload` | catalog-handlers.test.js |
| `POST /sessions/:session/skill-installs/:install` | catalog-handlers.test.js |
| `POST /skills/upload` | catalog-handlers.test.js |
| `PUT /queen/:queen/skills/:skill/body` | catalog-handlers.test.js |
| `GET /queen/:queen/soul` | queens-handlers.test.js |
| `POST /queen/:queen/soul/proposals/:proposal/decide` | queens-handlers.test.js |
| `POST /queen/:queen/soul/proposals/:proposal/probe` | queens-handlers.test.js |
| `POST /queen/:queen/soul/reflect` | queens-handlers.test.js |
| `POST /queen/:queen/soul/rollback` | queens-handlers.test.js |
| `PUT /queen/:queen/soul` | queens-handlers.test.js |
| `GET /browser/status` | autonomy-handlers.test.js |
| `GET /runtime-logs` | autonomy-handlers.test.js |
| `GET /sessions/:session/tasks` | autonomy-handlers.test.js, sessions-handlers.test.js |
| `POST /sessions/:session/tasks/clear-completed` | autonomy-handlers.test.js |
| `POST /sessions/:session/tasks/unarchive` | autonomy-handlers.test.js |
| `GET /sessions/:session/colony/skills` | autonomy-handlers.test.js |
| `GET /sessions/:session/colony/tools` | autonomy-handlers.test.js |
| `GET /sessions/:session/workers` | autonomy-handlers.test.js, sessions-handlers.test.js |
| `GET /sessions/:session/workers/:worker` | autonomy-handlers.test.js |
| `GET /sessions/:session/workers/:worker/conversation` | autonomy-handlers.test.js |
| `POST /sessions/:session/workers/:worker/stop` | autonomy-handlers.test.js |
| `POST /sessions/:session/workers/stop-all` | autonomy-handlers.test.js |

## What this gate does not prove

- It does not prove an assertion exists: a path mentioned in a comment or a helper still counts.
- It does not prove the response shape; `tests/compat/contract.test.js` and the per-domain
  tests do that for the routes they touch.
- It cannot see a path composed at runtime from two strings (`base + '/' + id`). Where that
  happened the test was rewritten to spell the route out, which is why the gate can stay red
  on a genuinely uncovered route instead of passing on a coincidence.
