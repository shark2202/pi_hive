# Sedimentation & autonomy — part 2

Date: 2026-11-20 (+08:00). Completes step-5: memory recall/reflection, 13 Queens,
durable event log, Sentinel delivery (import/export and missed-fire are in part 1).

## Recall selector — `src/domain/memory.js`

`recallMemory(colony, query, {queenId, limit})` scores each memory block: 3 points per
query term in the heading, 1 per term in the body, +0.5 for a dated heading, stopwords
dropped. Only matching blocks come back, best first, so an unrelated query returns `[]`
instead of the whole memory. `recallForPrompt()` renders them for a prompt.

The Queen prompt now recalls against the colony goal + open tasks
(`src/runtime/queen.js`) and falls back to recent memory when nothing matches — the full
memory stays reachable through the memory tools.

## Reflection — `reflectMemory()`

Consolidates global/queen/colony notes into `memory/queens/<queen>/reflection.md`:
headings merge, duplicate lines collapse, sections sort stably, and the file carries
`name: reflection` front matter plus `generated_at`. A 6 h cooldown
(`.reflection.json` state, `next_at` reported) stops a busy loop rewriting it; `force`
overrides. CLI: `pi-hive memory reflect <colony> [--force]`.

## 13 Queens

`QUEEN_PERSONA` and `BUILT_IN_QUEENS` now carry 13 personas: growth, tech, finance, ops,
product, marketing, sales, legal, people, support, data, design, research. Each is one
paragraph of voice and standard; `GET /api/queen/profiles` returns all 13 (test updated
from 4 to 13, ids asserted in order, uniqueness checked).

## Durable event bus — `src/domain/event-log.js`

`persistEvents(colony, emitter)` wraps `emit` so every queen/worker event is appended to
`colonies/<name>/events.jsonl`; the live path is untouched (a listener still fires, and an
unserialisable payload cannot throw out of `emit`). `readEvents({cursor, limit})`:

- returns events after a **byte cursor** and the cursor to resume from;
- leaves a trailing line without a newline **unconsumed**, so a writer mid-append is
  retried rather than lost (this is what a crash actually looks like);
- counts a newline-terminated unparseable line as `skipped` instead of throwing;
- trims an oversized event (16 KiB cap, long text cut to 4000 chars) so one tool result
  cannot bloat the log;
- aligns a mid-line cursor forward.

## Sentinel delivery

`POST /api/colony/:colony/notifications/test` now delivers: Telegram `sendMessage`,
Slack `chat.postMessage`, or the local inbox. The inbox record and the response carry the
provider's message id on success, or the provider's error (`chat_not_found`, the socket
error, the timeout message) on failure — never a fake `ok`. Tokens come from the request
target or the environment and are used as URL segment / bearer header only.

## Evidence

```
node --test tests/memory-recall.test.js   # 3 tests, 3 pass
node --test tests/event-log.test.js       # 4 tests, 4 pass
node --test tests/compat/autonomy-handlers.test.js  # 26 tests, 26 pass
npm test                                  # 266 tests, 266 pass
node program/qa/route-coverage.mjs        # 171/171
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs  # failures=0 warnings=0
```

Assertions worth naming: a query with only stopwords returns nothing; two `# Process`
blocks merge into one digest section with the duplicated line appearing once; the cooldown
reports `next_at` and `force` bypasses it while the run counter keeps counting; a
half-written event line is replayed after the writer finishes it; a corrupt terminated line
is counted as `skipped`; an oversized event is trimmed; and the deliver test asserts the
exact `sendMessage` URL, the Slack bearer header and body, plus the inbox record written for
a provider refusal.

## Not covered

- Recall is keyword scoring, not embeddings; semantics beyond shared words are missed.
- Reflection is deterministic (no model digest), so it cannot summarise prose it was never
  given; the model path exists only in session compaction.
- 13 personas change the prompt, not capabilities: every queen has the same tools.
- Colony-level events are replayed by the API/tests; the native `/ui/` dashboard still
  streams from the in-process emitter only.
- Telegram delivery could not be exercised against the real API from this host
  (`fetch failed` — egress blocked); Slack was reached (`invalid_auth` for a fake token).
