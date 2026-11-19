# pi-hive

Hive's colony orchestration, rebuilt on the **pi-agent kernel**. Independent project — no Hive agent loop is copied or refactored.

> Status: **v0.1 core slice + dashboard**. The Colony / Queen / Worker / Tracker / Plan / Skill / Memory / Playbook / Trigger / Sentinel loop is working against a real model, and the dashboard covers the main views. Hive parity is not complete; see [docs/PARITY.md](docs/PARITY.md) before treating this as a Hive replacement.

## What it is

```text
pi-agent-core          → the agent loop, tools, streaming, turns
pi-hive (this project) → Colony, Queen, Worker, Tracker, Plan, Skills,
                         Memory, Playbook, Triggers, Reminders, API/SSE
```

The kernel is not modified. `pi_hive` owns the Hive-shaped substrates around it.

## Requirements

- Node.js **>= 22.19** (uses `node:sqlite`)
- An OpenAI-compatible model endpoint
- `PI_HIVE_API_KEY` (or `BROADTOKEN_API_KEY`)

## Quick start

```bash
cd pi_hive
npm install

export PI_HIVE_API_KEY="..."
# optional:
export PI_HIVE_BASE_URL="https://token.tokenbroad.com/v1"
export PI_HIVE_MODEL="deepseek-flash-1017"

node src/cli.js colony create growth-lab \
  --queen queen_growth \
  --goal "Find and validate three growth experiments" \
  --workspace /absolute/path/to/repo

node src/cli.js chat growth-lab \
  "列出你负责的领域，并给出一个先做 pilot 的计划。不要调用工具。"
```

`--workspace` is optional. File and terminal tools are scoped to it; without it they are scoped to the colony directory. Set it for software-development colonies.

Start the HTTP/SSE service:

```bash
node src/cli.js serve
# server: http://127.0.0.1:8790
# official Hive frontend: http://127.0.0.1:8790/
# native pi_hive dashboard: http://127.0.0.1:8790/ui/
```

`/` serves the official Hive `core/frontend/dist` unchanged. `/ui/` is the native vanilla-JS dashboard. The official frontend boots with real queens/colonies, creates sessions, and renders Queen replies over the durable session SSE stream. All **171** official API routes now have handlers: **107 implemented + 64 partial + 0 missing**; the partial rows are explicit unsupported/limited capabilities, not 501s. See `program/reports/frontend-boot.md` and `docs/API_COMPAT.md`.

The native dashboard supports colonies, streaming chat, workers, read-only tracker SQL, playbook runs, triggers, the Sentinel inbox, and Soul review/apply. It is vanilla JS with no build step.

```bash
curl -s http://127.0.0.1:8790/api/health
curl -s -X POST http://127.0.0.1:8790/api/colonies \
  -H 'content-type: application/json' \
  -d '{"name":"demo","queen_id":"queen_tech","goal":"ship a vertical slice"}'

curl -s -X POST http://127.0.0.1:8790/api/colonies/demo/chat \
  -H 'content-type: application/json' \
  -d '{"text":"用一句话说明你的职责。"}'
```

## Layout

```text
pi_hive/
├── src/
│   ├── kernel/          # pi-agent adapter (model + Agent wrapper)
│   ├── domain/          # colony, tracker, plan, skill, memory, run log
│   ├── runtime/         # Queen, Worker, Playbook, Triggers, Reminders, Sentinel, tools
│   ├── ui/              # vanilla JS dashboard
│   ├── server.js        # HTTP + SSE + static UI
│   └── cli.js
├── tests/               # node:test coverage for non-LLM substrates
├── examples/playbooks/  # JavaScript playbooks
└── docs/
    ├── ARCHITECTURE.md
    ├── DELIVERY_PLAN.md
    └── PARITY.md
```

## Data

Default home: `~/.pi-hive` (override with `PI_HIVE_HOME`).

```text
~/.pi-hive/
├── memory/global/                  # global memory
├── memory/queens/<queen>/          # queen-scoped memory
└── colonies/<colony>/
    ├── metadata.json
    ├── plan.json
    ├── tracker/tracker.db
    ├── skills/<name>/SKILL.md
    ├── playbooks/*.play.js
    ├── sessions/queen_<queen>.json
    ├── workers/*.json
    ├── triggers.json
    ├── colony.db                   # playbook run log
    ├── inbox.jsonl                 # Sentinel escalations
    └── memory/                     # colony-scoped memory
```

## Tests

```bash
npm test
```

The substrate tests do not call a model. The smoke scripts do:

```bash
PI_HIVE_API_KEY=... node tests/smoke-queen.js
```

## Design rules

- **pi is the kernel.** No custom agent loop, no reimplementation of tool execution or streaming.
- **Tracker is the source of truth.** Workers write rows; the Queen reads SQL.
- **Workers are ephemeral.** One task, a narrow tool set, no delegation, no user interaction.
- **Playbooks are deterministic orchestration.** The script controls converge/retry/dead-letter; the tracker is the resume point.
- **No graph.** The colony shape is created at runtime by the Queen, not wired in advance.

## Known gaps

See [docs/PARITY.md](docs/PARITY.md). The official Hive frontend is served at `/` and boots cleanly with real queens/colonies. All **171** official API routes have handlers — **107 implemented + 64 partial + 0 missing** — including session creation/chat and durable SSE replay/tail. The 64 partial rows are explicit capability gaps (MCP loader, Telegram/Slack transport, global team DB, Claude Code peer routing, compaction, credential writes), not 501s. Sentinel has a local classifier/inbox; memory reflection and exact Hive UI parity remain. Queen Mail is in-process only.
