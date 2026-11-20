# Hive Feature Parity

> Baseline: Hive v1.0.14, Python edition. Target: `pi_hive` on `@earendil-works/pi-agent-core` 1.5.2.
>
> Status is deliberately conservative. "Done" means exercised in this repo, not just designed.

## Legend

| Mark | Meaning |
|---|---|
| ✅ | Implemented and exercised |
| 🟡 | Partial / narrower than Hive |
| ⬜ | Missing |
| ➖ | Not applicable to pi_hive's scope |

## Core runtime

| Feature | Status | Notes |
|---|---|---|
| Agent loop | ✅ | Provided by pi-agent-core `Agent`; not reimplemented |
| Streaming events / deltas | ✅ | `queen_event` + `delta`; HTTP SSE |
| Turn/tool lifecycle | ✅ | pi kernel |
| Session transcript persistence | 🟡 | JSON per Queen; loaded on restart; no compaction |
| Crash-safe park/resume | 🟡 | Transcript loads; no explicit park state machine |
| Tool registration | ✅ | Hive tools registered as pi `AgentTool`s |
| Tool execution modes | ✅ | pi parallel/sequential support |
| Budget/turn limits | 🟡 | `maxTurns` per Agent; no Hive token/tool budget accounting |

## Organization

| Feature | Status | Notes |
|---|---|---|
| Colony directory | ✅ | `~/.pi-hive/colonies/<name>/` |
| Colony metadata | ✅ | `metadata.json` |
| Colony list | ✅ | `GET /api/colonies`, CLI |
| Colony import/export | ⬜ | tar import/export not implemented |
| Global team data | ✅ | `/api/global/data/*` runs against `hiveHome()/global-data/team.db`: schema-driven tables/rows, insert (minted pk, `409` on duplicate), pk-addressed update/delete, filter/search/sort, group counts, inferred foreign keys and a `_global_changes` feed. Local file, not Hive's cloud team DB — no cross-machine sync |
| Queen identity / persona | 🟡 | 4 built-in personas; no full 13/Org Chart |
| Queen profile editing | ✅ | PATCH profile, PUT persona, PUT llm, tools allowlist, avatar upload/read/delete persist per queen under `hiveHome()/queens/<id>`; edits re-bind her live sessions |
| Queen DM vs colony chat | ✅ | Queen DM sessions are durable (create/resume/select/new) and bound to the queen; colony chat stays a separate session |
| Multiple colonies per Queen | ✅ | By directory/metadata |
| Worker | ✅ | Ephemeral, one task, narrow tools |
| Worker profiles | 🟡 | Stored in metadata; not enforced for tool/credential routing |
| Worker resume | ⬜ | No `resume_worker_ids` |
| Worker concurrency | ✅ | Queue + `maxConcurrentWorkers` |
| Worker report | ✅ | `report_to_parent` → `[WORKER_REPORT]` |
| Queen Mail | 🟡 | In-process letters, allowlist by registered Queen, max depth/daily limit; no Claude Code peer, no restart routing |
| Claude Code Queen | ⬜ | No peer bridge |

## State and coordination

| Feature | Status | Notes |
|---|---|---|
| Tracker SQLite | ✅ | `tracker/tracker.db`, WAL |
| Tracker SELECT guard | ✅ | `tracker_query` only SELECT/WITH |
| Tracker upsert | ✅ | key-based upsert |
| Tracker DDL/DML | ✅ | Queen-only `tracker_sql` |
| Tracker binding | 🟡 | Runtime is colony-scoped; no cryptographic binding |
| Task plan | ✅ | `plan.json` + task tools |
| Event bus | 🟡 | In-process EventEmitter + SSE; no durable event log |
| Reminder Hub | 🟡 | Tracker snapshot, active workers, colony-parallel nudge, idle; no compaction/stream-stall sources |
| Idle nudge | ✅ | `PI_HIVE_IDLE_SECONDS` |
| Sentinel | 🟡 | Parked classifier, continue/needs_human/done, local inbox + optional webhook; no Telegram/Slack, no UI |
| Human-in-the-loop | 🟡 | Queen can ask in chat; Sentinel reply route resumes |
| Queen Mail | 🟡 | In-process `QueenMail`; registered Queens, depth/daily limit; no Claude Code peer |

## Methods and sedimentation

| Feature | Status | Notes |
|---|---|---|
| Skills discovery | ✅ | `skills/*/SKILL.md` |
| `write_skill` | ✅ | Colony scope |
| Skill catalog in prompts | ✅ | Queen and Worker |
| Global/queen skill scopes | ⬜ | Only colony scope |
| Memory read/write/search | ✅ | global, queen, colony scopes |
| Memory reflection | ⬜ | No cooldown reflection/consolidation |
| Recall selector | ⬜ | No semantic/keyword selector; prompt reads memory directly |
| Soul | 🟡 | `soul.json`, evidence-backed proposals, review/auto/off, API + dashboard; no daily scheduler |
| Playbook runner | 🟡 | JS modules; converge/worker/dead-letter |
| Playbook retry/backoff | 🟡 | `retries`, `backoff: linear/exp`; no jitter or dead-letter retry policy |
| Playbook lanes/rate limits | 🟡 | `ctx.lane(name,{concurrency,rate_per_min})`; no persisted lane metrics |
| Playbook receipt schema | 🟡 | Schema is passed to the worker prompt; not validated at runtime |
| Playbook resume | ✅ | Pending query + tracker; re-run skips done rows |
| Playbook run log | ✅ | `colony.db` `playbook_runs` |

## Autonomy

| Feature | Status | Notes |
|---|---|---|
| Interval trigger | ✅ | `triggers.json` + ticker |
| Cron trigger | 🟡 | 5-field parser; UTC; basic ranges/steps/lists |
| Webhook trigger | 🟡 | `POST .../triggers/:name/webhook`; no signature verification |
| Trigger autostart | 🟡 | Starts when colony runtime is created; no global daemon |
| Missed-trigger reporting | ⬜ | No catch-up; last fire is not reconciled across downtime |
| Sentinel | 🟡 | Same classifier/inbox as above; no Telegram/Slack |
| Queen 24/7 | 🟡 | Server must stay alive; no supervisor/daemon |

## Tools and integrations

| Feature | Status | Notes |
|---|---|---|
| Tracker tools | ✅ | query/upsert/sql |
| Plan tools | ✅ | create/update/list |
| Skill tools | ✅ | list/write |
| Memory tools | ✅ | read/write/search |
| Worker orchestration | ✅ | `spawn_worker` |
| Playbook tool | ✅ | `run_playbook` |
| Trigger tool | ✅ | `set_trigger` |
| File tools | ✅ | read/write/edit/search, workspace-scoped |
| Terminal | ✅ | `terminal_exec`, workspace-scoped cwd, timeout |
| Browser | ⬜ | No browser bridge |
| Web search / scrape | ⬜ | No `web_search`/`web_scrape` |
| MCP definitions + health | ✅ | `/api/mcp/servers*` stores validated definitions in `hiveHome()/mcp_servers.json`; enable/disable/mode/delete persist; health is a real reachability probe (PATH lookup, TCP/TLS, unix socket) recorded on the entry |
| MCP tool loading | ⬜ | No MCP client: stored servers are never started, and `health` reports `tools: 0` on purpose |
| Credentials store | 🟡 | Env only; no encrypted store/UI |
| Model catalog/UI | 🟡 | Env-configured single OpenAI-compatible model |
| Config writes | ✅ | Provider slots, named provider library (+apply), external skill roots, feature switches, the model override, profile, pacing table and profile avatar persist under `hiveHome()/config/`; a saved model outranks the environment for runtimes built afterwards, `api_key` in a payload is refused |

## Interface

| Feature | Status | Notes |
|---|---|---|
| HTTP API | 🟡 | 171 official routes: 150 implemented + 21 partial + 0 missing; every partial is an explicit 4xx, never a fake success |
| SSE | ✅ | Per-session events replay + tail from the durable `events.jsonl`; chat deltas + colony events |
| CLI | 🟡 | serve/colony/chat/worker/playbook/tracker; no skill/mcp/janitor |
| Official Hive frontend (forked at `frontend/`, built here) | ✅ | Fork source + dist live in this repo; served at `/`; desktop chat verified end-to-end (Queen reply over SSE, last verified 2026-11-19 — not re-run: no model key in this environment); mobile official layout is desktop-first and squeezed |
| Web dashboard | 🟡 | Native `/ui/`: colonies, chat (SSE), workers, tracker, playbooks, triggers, inbox, Soul; not Hive UI parity |
| API auth | ⬜ | Local-only; no auth |
| Import/export | ⬜ | No tar import/export |
| Janitor/retention | ⬜ | No retention policy |

## Security and operations

| Feature | Status | Notes |
|---|---|---|
| Multi-user / RBAC | ⬜ | Single user |
| Secrets redaction | 🟡 | Env key not logged; no credential vault |
| Custom prompt library | ✅ | `hiveHome()/prompts/prompts.json`; create mints the id and normalizes skills/tags, delete is by id, list is newest first |
| Agent delete / metadata | ✅ | An agent is a colony dir: soft delete sets `metadata.deleted`, `purge` removes `colonies/<name>` + `agents/<name>`, `PATCH` writes `icon` only |
| Workspace/cwd binding | ✅ | Colony `workspace` or `PI_HIVE_WORKSPACE`; file/terminal tools scoped to it |
| Cost accounting | ⬜ | No token/$ metering |
| Budget hard stop | ⬜ | Turn limits only |
| Audit log | 🟡 | Playbook run log + worker JSON; no full event audit |
| Backup/restore | 🟡 | Plain directory; no CLI import/export |

## What "done" means here

A feature is ✅ only when:

1. it has a code path in `src/`;
2. a test or smoke script exercises it;
3. the behavior is described in `docs/ARCHITECTURE.md` or this file.

## Next milestones

1. **API behavior**: close the 32 remaining partial rows (MCP loader, Telegram/Slack, Claude Code peer, compaction, credential writes, prompts, skills upload, agents); route surface is complete.
2. **Memory reflection**: cooldown reflection and consolidation (Soul proposals exist).
3. **MCP and browser/web tools**: load MCP servers; add browser/web tools.
4. **Sentinel channels**: Telegram/Slack + escalation policy.
5. **Trigger reliability**: missed-fire reconciliation and a global daemon.
6. **Queen Mail transport**: persisted mailbox, Claude Code peer routing.
7. **Operational controls**: cost accounting, import/export, janitor, auth.
8. **Official mobile layout**: desktop-first official UI is squeezed at 390px; native `/ui/` is responsive.

## Bottom line

`pi_hive` currently proves the core loop:

**Queen (pi Agent) → spawn Worker (pi Agent) → Tracker row → Worker report → Queen validation**, plus Plan, Skills, Memory, JS Playbooks, Triggers, Sentinel, HTTP/SSE, a web dashboard, and CLI.

It is **not** a feature-complete Hive replacement yet.
