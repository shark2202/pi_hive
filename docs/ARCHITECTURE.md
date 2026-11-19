# Architecture

## Boundary

```text
┌──────────────────────────────────────────────────────────────┐
│ pi-hive                                                      │
│  Colony · Queen · Worker · Tracker · Plan · Skills · Memory  │
│  Playbook · Triggers · Reminder · Sentinel · Dashboard · CLI │
├──────────────────────────────────────────────────────────────┤
│ pi-agent-core                                                │
│  Agent · tool execution · streaming · turns · transcript     │
├──────────────────────────────────────────────────────────────┤
│ pi-ai                                                        │
│  model/provider catalog · OpenAI-compatible streaming        │
└──────────────────────────────────────────────────────────────┘
```

`pi_hive` does **not** implement an agent loop. It constructs one `Agent` per Queen and one per Worker from `@earendil-works/pi-agent-core`, registers tools, and owns the Hive substrates around it.

## Runtime flow

```text
User
  │ POST /api/colonies/:id/chat
  ▼
QueenRuntime
  ├── Agent (pi-agent-core)
  │     ├── tracker_query / tracker_upsert / tracker_sql
  │     ├── task_create / task_update / task_list
  │     ├── write_skill / list_skills
  │     ├── memory_read / memory_write / memory_search
  │     ├── spawn_worker
  │     ├── run_playbook
  │     └── set_trigger
  │
  ├── WorkerManager
  │     └── WorkerRuntime (one Agent, one task, narrow tools)
  │           ├── tracker_query / tracker_upsert
  │           ├── memory_read / memory_search
  │           └── report_to_parent
  │
  ├── PlaybookRunner
  │     └── converge(pending, dispatch) → worker() → tracker
  │
  ├── TriggerManager
  │     └── interval / cron / webhook → QueenRuntime.injectTrigger()
  │
  └── Sentinel
        └── parked classifier → continue / needs_human / done → inbox/webhook
```

Worker reports are events:

```text
Worker.report_to_parent
  → WorkerManager emits worker_report
  → QueenRuntime.injectReport()
  → Queen Agent gets a [WORKER_REPORT] turn
  → Queen validates tracker rows and continues
```

## Substrates

| Substrate | Implementation | Notes |
|---|---|---|
| Colony | Directory + `metadata.json` | Hive-compatible shape, independent home |
| Tracker | `node:sqlite` (`tracker/tracker.db`) | SELECT guard; WAL; upsert helper |
| Plan | `plan.json` | Persistent task list; task tools |
| Skills | `skills/*/SKILL.md` | Minimal frontmatter; colony-scoped |
| Memory | Markdown under global/queen/colony scopes | Read/write/search tools; no reflection loop yet |
| Soul | `soul.json` + `soul_proposals.jsonl` | Review/auto/off; evidence-backed proposals; injected into the Queen prompt |
| Playbook | JavaScript module + deterministic runner | `meta` + `async run(ctx)`; converge, worker, dead-letter |
| Triggers | `triggers.json` + in-process ticker | interval and 5-field cron; webhook route |
| Reminders | `ReminderHub` sources | Tracker snapshot, active workers, colony-parallel, idle |
| Sessions | JSON transcript per Queen | Loaded on restart; pi Agent owns the transcript |
| Run log | `colony.db` (`playbook_runs`) | Separate from the domain tracker |
| Queen Mail | `queen-mail.jsonl` + in-process registry | Peer letters; depth/daily limits |
| API | `node:http` + SSE | Native colony-scoped API + official `/api` compat router: 107 implemented, 64 partial, 0 missing of 171 |
| Dashboard | `src/ui/*` native, official `core/frontend/dist` at `/` | `/ui/` native; `/` official frontend with desktop chat verified; official mobile layout is desktop-first |
| CLI | `src/cli.js` | serve / colony / chat / worker / playbook / tracker |
| Workspace tools | `src/runtime/fs-tools.js` | file read/write/edit/search + terminal, workspace-scoped |

## Playbook contract (v0.1)

A playbook is a JavaScript module:

```js
export const meta = {
  name: "ci-triage",
  description: "one worker per failing CI job",
  concurrency: 2,
};

export async function run(ctx) {
  ctx.lane("browser", { concurrency: 2, rate_per_min: 20 });
  return ctx.converge({
    pending: () => ctx.trackerQuery(
      "SELECT id, job FROM ci_failures WHERE status='open'"
    ),
    dispatch: async (row) => {
      const r = await ctx.worker(`fix ${row.job}`, {
        data: row,
        lane: "browser",
        retries: 2,
        backoff: "exp",
        timeout: 120000,
        schema: { fixed: "boolean", commit: "string" },
      });
      if (r.status === "done") {
        ctx.trackerExec(`UPDATE ci_failures SET status='done' WHERE id='${row.id}'`);
      }
      return r;
    },
    maxRounds: 3,
    circuitBreaker: 0.5,
  });
}
```

Injected context:

| Member | Contract |
|---|---|
| `trackerQuery(sql)` | synchronous, SELECT only |
| `trackerCount(sql)` | synchronous |
| `trackerExec(sql)` | DDL/DML |
| `worker(task, opts)` | async; `lane`, `retries`, `backoff`, `timeout`, `schema` |
| `lane(name, {concurrency, rate_per_min})` | declare a throttled lane before dispatching |
| `converge({pending, dispatch, maxRounds, chunk, circuitBreaker})` | async; re-query each round; dead-letter the remainder |
| `log(msg)` | run log |
| `deadletter.list()` / `.size` | unresolved rows |
| `meta.concurrency` | default 8, max 32 |

Known differences from Hive's Python playbooks:

- JavaScript modules, not `.play.py`.
- Receipt `schema` is passed to the worker prompt, not enforced.
- Lanes are in-memory per run; no persisted metrics.
- No mid-run escalation; workers report `partial`/`failed` and the Queen decides.

## Why pi-agent-core

The user's constraint: **do not rebuild the agent kernel.** pi already provides:

- tool registration and argument validation;
- streaming events and text deltas;
- turn lifecycle and transcript state;
- model/provider abstraction;
- retries and abort handling.

`pi_hive` only adds Hive's organization and state model. This keeps the port small enough to audit and lets pi's kernel improvements flow through.

## Non-goals (v0.1)

- Exact Hive REST/SSE schema compatibility.
- Python playbook compatibility.
- Multi-user/RBAC.
- Sentinel Telegram/Slack channels.
- Queen Mail Claude Code peer routing, memory reflection, MCP loading, colony import/export, janitor.
