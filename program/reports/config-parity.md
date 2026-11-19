# Config parity — 9 partial routes converted

Date: 2026-11-20 (+08:00). Domain: `config` (9 official routes that used to answer
`400 unsupported_capability`).

## What backs the writes now

`src/domain/config-store.js` — durable state under `hiveHome()/config/`, atomic JSON
writes (temp file + rename), avatar bytes alongside:

| File | Written by |
|---|---|
| `llm.json` | `PUT /api/config/llm` (model/base override, no secret) |
| `sections.json` | `PUT /api/config/llm-sections` |
| `library.json` | `PUT /api/config/provider-library` |
| `skills.json` | `PUT /api/config/external-skills` |
| `features.json` | `PUT /api/config/features` |
| `profile.json` | `PUT /api/config/profile` |
| `rate-limits.json` | `PUT /api/config/rate-limits` |
| `avatar.bin` + `avatar.json` | `POST /api/config/profile/avatar` |

`src/config.js` `modelConfig()` reads the saved override before the environment, so a
model written through the API is what the next runtime is built from. Secrets are still
environment-only: a section carrying `api_key` is refused (`sectionError`).

`src/server.js` gained `swapModelRuntime()`; it drops the cached env-derived runtime and
every colony runtime, so the next turn of a live session resolves the saved model. The
compat dispatcher passes the server instance as `ctx`, so `sessions_swapped` is that
dropped count (`0` when the runtime was injected by tests/CLI — not ours to swap).

## Route behaviour (all exercised over HTTP)

- `PUT /api/config/llm` → `{"model":"live-model"}` served back by `GET /api/config/llm`.
- `PUT /api/config/llm-sections` judge slot stored; `GET /api/config/llm-sections` reads it.
- `PUT` with `api_key` → `400 api_key is not accepted; name it through api_key_env_var`.
- `PUT /api/config/provider-library` saved `local-llama`; list shows it;
  `POST .../apply` copied it into the `llm` slot; unknown name → `400 There's no provider 'nope'`;
  `section: null` deleted the entry.
- `PUT /api/config/external-skills` de-duplicated, `~` expanded, per-path
  `{resolved, exists, skills}` (1 skill found under `/tmp/pihive-sk-demo`, `~/nope` → exists false).
- `PUT /api/config/features` `{stall_check:true}` persisted, all three flags returned,
  `colonies_applied: 3`; unknown flag → `400 unknown feature flags: bogus`.
- `PUT /api/config/profile` `{displayName, about, theme, prompt_library_sort}` persisted.
- `PUT /api/config/rate-limits` kept the two well-formed keys and warned
  `ignored 'broken': expected 'platform:action_type'`, `ignored 'x:y': delay must be …`.
- `POST /api/config/profile/avatar` multipart PNG → `avatar_url`; `GET` returned
  `200 image/png 8 bytes`, byte-identical to the upload (`cmp` clean); `has_avatar` flipped.

## Evidence commands and results

```
node --test tests/compat/config-extra-handlers.test.js   # 27 tests, 27 pass
npm test                                                  # 222 tests, 222 pass
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
  # STATUS {"implemented":130,"partial":41} … failures=0 warnings=0
node /tmp/sync-contract.mjs   # changed=9 by_status={"implemented":130,"partial":41,"shell-only":0,"missing":0}
```

Tests assert round-trips, not status codes: each write is read back through its GET, a
secret-bearing section is refused and never echoed, provider-library apply mutates the
slot, skill roots report on-disk resolution, unusable pacing keys come back as warnings,
avatar bytes compare equal. Each test registry gets its own `PI_HIVE_HOME`, so one test's
write cannot leak into another.

## Not covered

- Feature switches are stored but nothing consumes them yet (`colonies_applied` counts
  colonies, it does not apply behaviour).
- External skill roots are recorded and counted; the runtime does not load skills from them.
- Rate limits are a stored table only; no platform action is paced by it.
- Model swap drops runtimes; there is no live model turn to prove the new model answered,
  because this environment has no `PI_HIVE_API_KEY`/`BROADTOKEN_API_KEY`.
- Profile fields outside the official four (`displayName`, `about`, `theme`,
  `prompt_library_sort`) are ignored, as in the official client.
