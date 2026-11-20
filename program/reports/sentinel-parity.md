# Sentinel parity — 3 transport checks implemented

Date: 2026-11-20 (+08:00). Domain: `sentinel` (telegram validate, telegram
detect-chat, slack validate).

## What runs now

| Route | Real call | Result |
|---|---|---|
| `POST /sentinel/telegram/validate` | `https://api.telegram.org/bot<token>/getMe` | `{ok:true, bot_username, bot_name}` or `{ok:false, error:<provider description>}` |
| `POST /sentinel/telegram/detect-chat` | `getUpdates?limit=10&timeout=0` | `{ok:true, pending:false, chat_id, chat_title, sender_id, sender_name}`; `pending:true` when the bot has no message yet |
| `POST /sentinel/slack/validate` | `POST https://slack.com/api/auth.test` | `{ok:true, team, bot_user}` or `{ok:false, error:<slack error>}` |

Implementation: `telegramApi()` / `slackAuthTest()` in
`src/compat/handlers/autonomy.js` — `fetch` with an 8 s `AbortController` timeout, token
from the request body or the saved sentinel config, used only as a URL segment / bearer
header and never echoed back. A `ctx` provider still wins, so tests and embeddings can
substitute their own transport.

A transport refusal is a **result**, not a capability gap: `200 {ok:false, error}` with
the provider's own text (`Unauthorized`, `invalid_auth`, `connect ECONNREFUSED`, or the
timeout message). Nothing 400s just because the provider said no.

## Evidence

```
node --test tests/compat/autonomy-handlers.test.js   # 26 tests, 26 pass
npm test                                             # 232 tests, 232 pass
node /tmp/sync-contract.mjs   # changed=3 by_status={"implemented":164,"partial":7,...}
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
  # STATUS {"implemented":164,"partial":7} … failures=0 warnings=0
```

Live HTTP on port 8790:

- `POST /api/sentinel/telegram/validate {}` → `400 {ok:false, error:"no token provided or saved"}`.
- `POST /api/sentinel/telegram/validate {"token":"123:abc"}` → `200 {ok:false, error:"fetch failed"}`
  (api.telegram.org is unreachable from this host — reported, not masked).
- `POST /api/sentinel/slack/validate {"token":"xoxb-not-real"}` → `200 {ok:false, error:"invalid_auth"}`
  — a real Slack response, proving the call leaves the machine.

The tests stub `globalThis.fetch` and assert the mapping: `getMe` → `bot_username`/
`bot_name`, `getUpdates` → the chat id/title/sender as strings, `auth.test` → `team`/
`bot_user`, an upstream `{ok:false, description}` → `{ok:false, error}`, and a throwing
fetch → `{ok:false, error:/ECONNREFUSED/}`.

## Not covered

- No message **delivery**: `POST /sentinel/test` and real notifications still go to the
  local inbox; only token/chat validation talks to the providers.
- `detect-chat` consumes `getUpdates` (a webhook-configured bot answers `409 Conflict`,
  surfaced as `ok:false`); it does not register or delete a webhook.
- Tokens are read from the request or the saved config and are never persisted by these
  routes, so a validated token still needs the normal sentinel config to be used later.
