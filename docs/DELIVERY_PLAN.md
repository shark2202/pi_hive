# Delivery plan: toward Hive parity

This project is judged against **behavior**, not build success. A gate passing or a package building is not delivery.

## Definition of done

A Hive feature counts as delivered only when all four exist:

1. production code path;
2. a unit test or real-model smoke that exercises it;
3. documentation in `docs/ARCHITECTURE.md` and an honest row in `docs/PARITY.md`;
4. for a served surface, desktop (1440×900) and mobile (390×844) verification.

`docs/PARITY.md` is the scoreboard. It currently has 84 rows: **35 ✅ / 32 🟡 / 17 ⬜**.

## Milestones

### M1 — Core loop (done)

Queen, Worker, Tracker, Plan, Skills, Memory, JS Playbook, Triggers, Queen Mail, HTTP/SSE, CLI.
Evidence: 15 substrate tests, real-model Queen→Worker smoke, real-model Sentinel smoke, real-model Soul review.

### M2 — Autonomy and product surface (done in this cycle)

- Reminder Hub: tracker snapshot, active workers, colony-parallel, idle.
- Sentinel: parked classifier, continue/needs_human/done, `inbox.jsonl`, optional webhook.
- Playbook: `retries`, `backoff`, `lane(concurrency/rate)`, `timeout`, run `stop`.
- Dashboard: colonies, streaming chat, workers, tracker, playbooks, triggers, inbox.
- Evidence: Reminder/Sentinel/retry/lane tests; dashboard verified at 1440×900 and 390×844 with no horizontal overflow; screenshots in `docs/ui-desktop.png`, `docs/ui-mobile.png`.

### M3 — Reflection and identity (in progress)

- Soul: `soul.json`, review/auto/off mode, evidence-gated proposals, apply, history, Queen tools, API, dashboard tab. Verified with a real-model review and unit tests.
- Memory reflection: cooldown turns, consolidation pass, `memory_reflections.jsonl` (still open).
- Acceptance: a reflection produces a proposal with cited evidence; auto mode is off by default.

### M4 — Tools and integrations

- MCP server loading with namespaces and allowlists.
- Browser bridge and web search/scrape tools.
- Credentials: env + encrypted local store; no plaintext in logs.
- Acceptance: a worker can use an MCP tool and a browser tool under the colony allowlist.

### M5 — Operations and API

- Import/export (tar), janitor/retention, cost accounting, auth.
- Hive-compatible API/SSE shapes where practical; document every divergence.
- Acceptance: export on host A, import on host B, resume a playbook from tracker state.

### M6 — Parity audit

- Re-read Hive's `docs/key_concepts/*`, trigger/sentinel/playbook/reminder code paths.
- Walk every PARITY row; downgrade anything not exercised.
- Run a scripted end-to-end scenario for each of: research colony, software colony, scheduled colony, Sentinel escalation, playbook resume, Queen Mail.
- Acceptance: no row is ✅ without evidence; remaining gaps are listed explicitly.

## Lanes

When parallel work is used, isolate by module and avoid shared-file edits:

| Lane | Owns | Must not touch |
|---|---|---|
| A | `src/runtime/reminders.js`, `sentinel.js` | `src/server.js`, `src/ui/*` |
| B | `src/runtime/playbook.js`, `worker.js` | `src/server.js`, `src/ui/*` |
| C | `src/ui/*`, static routes | runtime modules |
| D | `src/domain/soul.js`, `memory.js` | runtime/server/ui |
| E | API compatibility, export/import, docs | UI |

The parent integrates and reruns `npm test` plus the real-model smoke after each merge.

## Quality gates

```bash
cd pi_hive
npm test
for f in $(find src tests scripts -name '*.js' -o -name '*.mjs'); do node --check "$f" || exit 1; done
node tests/smoke-queen.js        # requires PI_HIVE_API_KEY
node tests/smoke-sentinel.js     # requires PI_HIVE_API_KEY
```

Dashboard gate:

- `/` returns 200 and renders colonies;
- chat streams and completes;
- `document.documentElement.scrollWidth === innerWidth` at 1440 and 390;
- no overlapping controls; screenshots refreshed when layout changes.

## Honest exceptions

- JavaScript playbooks are not Python-compatible.
- Sentinel has no Telegram/Slack channels yet.
- Queen Mail is in-process; no Claude Code peer routing.
- Soul and MCP are not implemented.
- API/UI are not Hive-identical; only behavior-level parity is targeted.
