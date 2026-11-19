# Queens domain — partial → implemented (step-2, batch 1)

Date: 2026-11-20 · commits after `92f2c94`

## What changed

14 official queen routes that answered `400 unsupported` now do real, durable work.

New state module `src/domain/queen-state.js` stores per-queen mutable state under
`hiveHome()/queens/<queen_id>/`:

| file | purpose |
|---|---|
| `profile.json` | name/title/summary/experience/skills/portrait overrides |
| `persona.json` | persona override (`null` restores the role persona) |
| `llm.json` | per-queen LLM section |
| `tools.json` | per-queen `enabled_mcp_tools` allowlist |
| `removed.json` | removal flag (drives `GET /api/queen/removed`) |
| `avatar.bin` + `avatar.json` | avatar bytes + content type (5 MiB cap) |
| `dm_session.json` | the queen's current DM session id |

JSON writes go through a temp file plus `rename`, so a crash cannot leave a half-written
state file. Queen ids are validated against `[a-z0-9][a-z0-9_-]{0,63}` before any path is built.

`src/server.js` now dispatches handler results that carry a `Buffer` body and/or
`content_type`, which is what `GET /api/queen/:queen/avatar` needs to serve image bytes.

| route | behaviour |
|---|---|
| `POST /queen/create` | persists a custom queen (id derived from name, or given), 409 on built-in clash |
| `POST /queen/:q/remove` / `/restore` | removal persists; restore 400s when she was never removed |
| `GET /queen/removed` | lists persisted removals with the catalog entry |
| `PATCH /queen/:q/profile` | field-level overrides, 400 when nothing patchable was sent |
| `PUT /queen/:q/llm` | stores the section, re-binds her live sessions, reports `sessions_switched`; `null` clears |
| `PUT /queen/:q/persona` | stores the persona (typed field validation), `null` restores the role persona |
| `POST/DELETE/GET /queen/:q/avatar` | multipart upload → bytes on disk → served back with its content type |
| `POST /queen/:q/session` | resumes the stored DM session when live, else creates one |
| `POST /queen/:q/session/select` | 400 without `session_id`, 404 unknown, 409 when the session belongs to another queen |
| `POST /queen/:q/session/new` | always creates a fresh session and binds it |
| `PATCH/DELETE /queen/:q/tools` | allowlist persists, narrows the returned catalog, refreshes her sessions |

## Evidence

- `node --test tests/compat/queens-handlers.test.js` → 15/15 pass. Tests were rewritten from
  "explicit unsupported" expectations to semantic round-trips (create → profile → persona,
  llm switch → `sessions_switched` → clear, multipart avatar bytes in/out, session
  resume/409/404, allowlist narrow → reset, remove → removed list → restore).
- `npm test` → `tests 213 / pass 213 / fail 0`.
- Route table: 25 implemented, 3 partial in the queen module (soul probe, soul reflect,
  Claude Code transcript), verified by `registers exactly the 28 official routes`.
- `program/contracts/hive-api.json` recount: `implemented=121 partial=50 missing=0`
  (was 107/64); statuses were taken from the live route table, not hand-typed.
- Live server (`PI_HIVE_HOME=.tmp-home PI_HIVE_PORT=8790`): every one of the 14 routes
  exercised over HTTP — custom queen `queen_parity_bot` created, profile patched,
  `llm` section stored then read back, persona stored, DM session `sess-c773fa15…`
  created, allowlist patched/read/reset, 8-byte PNG uploaded and served back as
  `content-type: image/png` with 8 bytes, remove → `GET /queen/removed` listed her →
  restore returned `removed: false`.
- `PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs` → `failures=0 warnings=0`.

## Not covered yet

- Persona PUT replaces the whole persona document (matching the official editor that sends
  the full form); there is no field merge.
- The queen DM session is durable but not yet wired to a model turn, so `resume` semantics
  for in-flight prompts are untested (no model key in this environment).
- Soul `probe`/`reflect` and the Claude Code transcript route stay partial.
