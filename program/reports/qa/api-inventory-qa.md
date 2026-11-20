# Hive Frontend API Inventory — Independent QA (lane C1)

**Lane:** `contract-qa` · **Date:** 2026-11-19 · **Scope:** official Hive web frontend
(`<hive-core>/frontend/src`), same-origin `/api` surface only.

## Method

1. Enumerated the client layer: `src/api/*.ts` — 22 files, 3,113 lines (20 endpoint
   modules + `client.ts` + `types.ts`).
2. Grepped every `api.get/post/put/patch/delete/upload`, `subscribeSse`, `apiUrl`
   and raw `fetch` call site, in `src/api` **and** outside it (components, hooks,
   pages, lib). Grep found 165 `api.*` call sites inside `src/api`:

   ```
   $ grep -ohE 'api\.(get|post|put|patch|delete|upload)' *.ts | sort | uniq -c
     16 api.delete
     62 api.get
      9 api.patch
     57 api.post
     17 api.put
      4 api.upload
   ```

   Five more call sites live outside `src/api` (DebugPanel, BrowserStatusBadge,
   use-runtime-logs, queen-dm, colony-chat) → **170 raw call sites**.
3. Extracted each call with a balanced-delimiter scanner (`program/scripts/extract_api.py`)
   — regex + quote/bracket awareness, **no AST dependency** — then hand-read all 22
   modules to validate paths, methods, types and helper-built paths.
4. Normalized template literals to `{param}` paths, expanded the two multi-route
   call sites (`/mcp/servers/{name}/{enable|disable}`) and the `queenPath()` helper,
   and deduped by `method + path` (`program/scripts/build_inventory.py`).
5. Cross-checked shapes read-only against the official Go runtime route table
   (`go_hive/go-hive/internal/server`, `mux.HandleFunc("METHOD /api/…")`, 196 routes).

## Counts

| Measure | Count |
|---|---|
| Client modules with endpoints | 20 |
| Files containing call sites | 25 |
| Raw `api.*` call sites (incl. outside `src/api`) | 170 |
| **Unique HTTP routes (method + path)** | **168** |
| — JSON / multipart | 165 |
| — URL-only GET resources (`<img>`, attachment, download) | 3 |
| **SSE endpoints consumed** | **3** |
| SSE endpoints the runtime offers but this frontend does not subscribe | 2 |
| `EventTypeName` union members (SSE payload `type`) | 75 |

By method (unique routes): **GET 68 · POST 61 · PUT 15 · PATCH 9 · DELETE 15**.

By domain: sessions 21, queens 26, config 18, skills 14, credentials 11, global-data 9,
colonies 7, mcp 7, workers 7, triggers 6, models 6, observability 4, memories 4,
sentinel 4, colony-data 4, discovery 3, notifications 3, tasks 3,
claude-code-queens 2, browser 1, resources 3.

## Domains covered

- **discovery/agents** — `GET /discover`, `DELETE /agents`, `PATCH /agents/metadata`
- **claude-code-queens** — list + transcript
- **colonies** — tools index, scaffold, rename, reveal, delete, per-colony tools, colony sessions/active-session
- **colony-data** — tracker tables, paged rows, change cursor, row PATCH
- **notifications (Sentinel)** — per-colony config GET/PUT/test
- **sessions** — CRUD, history, fork, title, stop, stats, reveal, dismiss-colony-pivot, report-bundle
- **triggers** — list/create/update/activate/deactivate/run
- **execution** — chat, queen-context, record-message, cancel-queen, presence, mark-colony-spawned, compact-and-fork, upload-attachment, credential-form
- **workers** — list/detail/conversation, stop, stop-all, colony skills/tools
- **tasks** — snapshot, unarchive, clear-completed
- **skills** — global library, scopes, detail, upload, queen-scoped CRUD/body/rename/reload, install requests
- **credentials** — specs, CRUD, local accounts, check-agent, resync, oauth-status, validate-key
- **config** — LLM, sections, provider library, external skills, features, models catalogue, profile, rate limits, avatars, startup-status
- **models** — overview, slots (incl. `queen:<id>`), endpoints + endpoint models
- **mcp** — servers CRUD, enable/disable, mode, health
- **memories** — list + file read/update/delete
- **prompts** — list, create, delete (update is POST+DELETE, see below)
- **queens** — profiles, create/remove/restore, profile/persona/llm/overview, soul (get/put/decide/rollback/probe/reflect), avatar, sessions, tools
- **global-data** — tables, rows, query, group-counts, changes, foreign-keys
- **observability** — events/history, snapshot, live_tools, runtime-logs
- **browser** — status poll; **resources** — queen avatar, profile avatar, session attachment

## SSE (3 consumed)

| Path | Client | Events |
|---|---|---|
| `GET /sessions/{sessionId}/events` (+`?types=`,`?watch=`) | `hooks/use-sse.ts` — `useSSE`, `useMultiSSE` | `AgentEvent` envelope, 75 `EventTypeName` values; 404 is terminal → resume from disk |
| `GET /events/global` | `hooks/use-sse.ts` — `useGlobalEvents` | `credential_provider_connected`, `credential_provider_disconnected`, `tool_catalog_refreshed`, `tools_config_changed`, `crm_changed` |
| `GET /sessions/live` | `hooks/use-live-sessions.ts` — `useLiveSessions` | live-session rows |

Runtime registers two more SSE routes this web build never subscribes:
`GET /browser/status/stream` (comment says desktop-shell only; web polls
`/browser/status`) and `GET /sessions/{id}/workers/stream`.

## Endpoints that resist a clean classification

1. **`GET {bundle_path}`** — `sessionReport.ts` downloads whatever path the
   `report-bundle` response returns. It is a runtime-minted URL, not a literal
   route, so it is excluded from the 168.
2. **`PATCH /prompts/{promptId}`** — never called. `prompts.update()` documents that
   PUT is rejected (405) and emulates update with `POST /prompts` + `DELETE
   /prompts/{id}`. The Go runtime *does* register `PATCH /api/prompts/{prompt_id}`,
   but the frontend never uses it.
3. **`POST /queen/{queenId}/soul/proposals/{proposalId}/probe`** — called by
   `queens.ts`, but **absent** from the Go runtime route table (only `/decide` is
   registered). Either a `go_hive` port gap or a dead frontend call.
4. **Skills / local-credentials family** — `/skills*`, `/queen/{id}/skills*`,
   `/sessions/{id}/skill-installs*`, `/credentials/local*` and
   `/sessions/{id}/credential-form` are called by the frontend but have **no**
   `mux.HandleFunc` in `go_hive` (live Go table = 196 routes). This is a `go_hive`
   port gap, not frontend ambiguity — do not use `go_hive` as the contract source
   for those families.

### Read-only Go-runtime cross-check (secondary evidence)

```
$ grep -rhoE 'mux\.HandleFunc\("(GET|POST|PUT|PATCH|DELETE) /api/[^"]+"' --include='*.go' . \
    | sed -E 's/mux\.HandleFunc\("//; s/"$//' | sort -u | wc -l
196
```

20 frontend route shapes have no exact Go match; 2 are false positives
(`/runtime-logs` is served by a manual path in `app.go`; `DELETE /sessions/history/{id}`
is covered by Go's generic `DELETE /sessions/{first}/{second}` pattern). The other
**18** are the skills/credentials-local/credential-form/skill-install/soul-probe gaps above.

## Data files

- `program/reports/api-inventory-qa.json` — every route: module, export, method,
  normalized path, request/response type, transport, notes, call sites.
- `program/scripts/extract_api.py`, `program/scripts/build_inventory.py` — reproducible
  extraction/normalization (run with `uv run`).
