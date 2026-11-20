# Prompts + agents parity — 4 routes implemented

Date: 2026-11-20 (+08:00). Domains: `prompts` (2), `agents` (2).

## Prompts — `hiveHome()/prompts/prompts.json`

New store `src/domain/prompt-store.js` (atomic temp-file + rename, corrupt file
reads as empty rather than throwing):

| Route | Behaviour |
|---|---|
| `GET /api/prompts` | stored prompts, newest first |
| `POST /api/prompts` | mints `prm-<12 hex>`, trims the title, defaults a blank category to `General`, lowercases/de-duplicates `skills` and `tags`, returns the `CustomPrompt` (`custom: true`); missing title/content or a non-array `skills`/`tags` → 400 |
| `DELETE /api/prompts/:prompt` | `{deleted: id}`; unknown id → 404 |

`buildPrompts()` in `src/compat/handlers/config.js` reads the same store, so the two
GET registrations (catalogue lane and config lane) cannot disagree. This also serves
as the client's update path: `prompts.update()` creates the new row then deletes the
old one, so a failure leaves a duplicate instead of losing the prompt.

## Agents — an agent *is* a colony directory

`DELETE /api/agents` and `PATCH /api/agents/metadata` used to refuse with 400. Both
now resolve the official `agent_path` by basename against `colonies/<name>` and
`agents/<name>` (the desktop may hand back a path from another machine), returning
404 when neither exists:

| Request | Behaviour |
|---|---|
| `DELETE {agent_path, purge:false}` | sets `metadata.deleted: true` — data stays, `GET /discover` no longer lists it |
| `DELETE {agent_path, purge:true}` | removes `colonies/<name>` and `agents/<name>` |
| `PATCH {agent_path, icon}` | writes `icon` (null clears) into `metadata.json`, bumps `updated_at`, returns `{ok:true}` |
| `PATCH` with any other field | 400 `unsupported metadata field '…'` — refused rather than half-applied |

`icon` is what the Org Chart writes (`org-chart.tsx:132`), and `GET /api/discover`
already surfaced `metadata.icon`, so a patched icon is visible in the same response.

## Evidence

```
node --test tests/compat/catalog-handlers.test.js   # 15 tests, 15 pass
npm test                                            # 232 tests, 232 pass
node /tmp/sync-contract.mjs   # changed=2 by_status={"implemented":148,"partial":23,...} (prompts)
                              # then {"implemented":150,"partial":21,...} (agents)
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
  # STATUS {"implemented":150,"partial":21} … failures=0 warnings=0
```

Live HTTP on port 8790:

- `POST /api/prompts` `{title:"Triage", skills:["Review","review"], tags:["Ops"]}` →
  `id:"prm-ff07f7304c84"`, `skills:["review"]`, `tags:["ops"]`; `GET` listed it;
  `DELETE` → `{deleted:"prm-ff07f7304c84"}`; deleting it again → `404`.
- `POST /api/colonies/agents-demo/scaffold` then
  `PATCH /api/agents/metadata {icon:"rocket"}` → `{ok:true}`;
  `GET /api/discover` showed the colony with `icon:"rocket"`.
- `PATCH` with `{goal:"x"}` → `400`.
- `DELETE` soft → `{deleted:"agents-demo", purged:false}` and the directory stayed;
  `DELETE purge:true` → `{deleted:"agents-demo", purged:true}` and the directory was gone.

Tests assert semantics against the filesystem and the read routes: the stored prompt
is re-read from disk by a second registry, the conflicting field is refused before any
write, soft delete keeps the directory while marking metadata, and purge removes it.

## Not covered

- Prompts have no update route (the official runtime rejects `PUT /prompts/:prompt`, so
  the client's create-then-delete is the contract) and no per-queen/colony scoping.
- `PATCH /agents/metadata` accepts `icon` only; `description`, `tags` and `goal` stay
  colony-API territory on purpose, so a rename cannot silently rewrite discovery text.
- Hard delete is immediate and unrecoverable (no trash), matching the official `purge`.
