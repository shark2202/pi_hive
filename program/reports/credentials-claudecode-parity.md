# Credentials + Claude Code parity — the last 7 routes

Date: 2026-11-20 (+08:00). Domains: `credentials` (6), `claude-code-queens` (1).
This closes the route surface: **implemented=171, partial=0, missing=0**.

## Credential vault — `src/domain/credential-vault.js`

`hiveHome()/credentials/vault.json`, written mode `0600` (atomic temp + rename). The only
place pi_hive stores a secret, with three rules the module enforces:

- **write-only over the API**: every read maps to `key_names`/`has_keys`; no response,
  log line or event carries a value;
- `""` in a save deletes that field instead of storing an empty string;
- `resync` never invents a key: remote Aden accounts are recorded with `keys: {}` and are
  marked as remote.

| Route | Behaviour |
|---|---|
| `POST /credentials` | merges `{credential_id, keys}`; id must be 1–128 of `[A-Za-z0-9._:-]`, keys validated (≤24 fields, ≤8 KiB each) → `{saved}` |
| `DELETE /credentials/:credential` | `{deleted:true}`, 404 unknown |
| `POST /credentials/local` | named account (`credential_id` + `account`) → `{saved, status:"saved", identity, valid:null, message:"stored locally; no health check was run"}` |
| `DELETE /credentials/local/:credential/:alias` | `{deleted:true}`, 404 unknown |
| `POST /credentials/resync` | `GET $PI_HIVE_ADEN_URL/v1/credentials/accounts` with the bearer key; merges → `{synced, accounts_by_provider}`; 400 naming both env vars when unset, 502 with Aden's own error |
| `GET /credentials/:credential` | the stored credential + its named accounts (presence only), 404 when neither exists |
| `POST /sessions/:session/credential-form` | saves the secret (or records the cancel), clears `parked`/`park_reason`, appends `credential_saved`/`credential_cancelled`, answers `{saved?, resumed:true, status}`; 404 unknown session, 400 bad status |

The model key itself is still environment-only (`PI_HIVE_API_KEY`), so a fresh install
needs no vault to run.

## Claude Code queens — `src/domain/claude-code.js`

A Claude Code queen is configured in `configuration.json` under `queen_mail.claude_code`
(map or list shape). `GET /claude-code-queens` lists her plus the transcripts Claude Code
actually wrote under `$CLAUDE_CONFIG_DIR|~/.claude/projects/*/<id>.jsonl`;
`GET /claude-code-queens/:queen/conversations/:conversation` parses that JSONL into the
official `TranscriptEntry` kinds:

| Record | Entry |
|---|---|
| user text containing a hive-letter marker | `{kind:"letter", text}` |
| other user text | `{kind:"text", text}` |
| assistant text | `{kind:"text", text}` |
| assistant `tool_use` | `{kind:"tool", tool:<name>, text:<JSON input>}` |
| user `tool_result` | `{kind:"result", text, error:is_error}` |

Unknown record types and a half-written trailing line are skipped; 404 covers both an
unconfigured queen and a conversation with no file.

## Evidence

```
node --test tests/compat/config-extra-handlers.test.js   # 33 tests, 33 pass
node --test tests/compat/queens-handlers.test.js         # 16 tests, 16 pass
npm test                                                 # 236 tests, 236 pass
node /tmp/sync-contract.mjs
  # changed=6 by_status={"implemented":171,"partial":0,"shell-only":0,"missing":0}
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
  # STATUS {"implemented":171} … failures=0 warnings=0
```

Live HTTP on port 8790:

- `POST /api/credentials {provider_alpha, keys:{api_key:"live-secret-value"}}` → `{saved:"provider_alpha"}`;
  `GET /api/credentials/provider_alpha` → `key_names:["api_key"]`, no value anywhere.
- `POST /api/credentials/local {notion, account:"work", keys:{token:"tok-secret"}}` →
  `{saved:"notion", status:"saved", identity:{account:"work"}, valid:null}`.
- `POST /api/credentials/resync` without Aden → `400`.
- `DELETE` both → `{deleted:true}`.
- `stat` on the vault → `-rw-------`; `grep -c 'live-secret-value\|tok-secret' /tmp/pihive-serve.log` → `0`.
- `GET /api/claude-code-queens` → `{"queens":[]}` (nothing configured here);
  its transcript route → `404`.

Tests assert semantics and safety: the vault file's mode and stored value, the merge and
`""`-removal behaviour, that responses never contain the secret, the exact Aden request
(URL + bearer header) and its 503 → 502 mapping, that the credential form really unparks
the session and appends the event, and — for Claude Code — that a real JSONL file maps to
letter/text/tool/result entries including `is_error`.

## Not covered

- Vault values are stored in plaintext inside a 0600 file: no encryption at rest and no
  OS keychain integration (Hive encrypts its store).
- `valid` is `null` for local accounts: these routes do not health-check a provider.
- `resync` imports remote **account names** only; it never receives or fabricates secrets.
- Claude Code transcripts are read, not driven: `running` is always `false`,
  `letters` is `0`, and no letter is ever sent to a Claude Code queen from here.
