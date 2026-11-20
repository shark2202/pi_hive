# Sedimentation & autonomy — import/export and missed-fire (part 1)

Date: 2026-11-20 (+08:00). Step-5 of the objective. Part 1 covers colony
import/export and trigger missed-fire reconciliation; the remaining items (memory
reflection/recall, 13 personas, durable colony event log, Sentinel delivery) are
tracked below.

## Colony import/export — `src/domain/archive.js`

| Piece | Behaviour |
|---|---|
| `exportColony(name)` | real gzipped ustar tar of `colonies/<name>`: files, directories and symlinks; `.sock`, `.lock` and `node_modules` are excluded as runtime noise |
| `exportColonyToFile(name, file)` | writes it and reports `{colony, path, size, sha256}` |
| `importColony(bytes, {name, overwrite})` | restores the tree; the colony name comes from `metadata.json` unless `--name` renames it; an existing colony is refused without `overwrite` |
| `readTar(bytes)` | parses members and refuses any path that is absolute, drive-prefixed or contains `..` **before** a single file is written |

CLI: `pi-hive export <colony> <file.tar.gz>`, `pi-hive import <file> [--name <colony>] [--overwrite]`.

Evidence — `node --test tests/archive.test.js` (5 tests):

- export magic bytes are `1f 8b`, members include `metadata.json`, `memory/notes.md`,
  `skills/demo/SKILL.md`, and exclude `live.sock` / `tracker.lock`;
- a round-trip restores file contents byte-for-byte;
- `--name` renames; a second import is refused with
  `already exists; pass overwrite`; `overwrite: true` replaces;
- a hand-built tar containing `../escape.txt` or `/etc/passwd` throws
  `refusing unsafe member path` and leaves no file outside the colony;
- an empty archive is refused with `no members` (no invented colony).

## Trigger missed-fire — `src/runtime/triggers.js`

`TriggerManager.start(now)` now reconciles before arming:

- a trigger that never fired is armed from `now` — not treated as infinitely overdue;
- a stop shorter than one interval fires nothing;
- a longer stop fires **once** per trigger with `{missed: true, missed_intervals: N}`,
  so a week offline is one catch-up run, not a burst of hundreds;
- disabled triggers are skipped; a cron trigger counts as missed past a 2-minute grace
  window (its slot count is reported as 1, since each slot is not enumerated);
- `start()` writes the logical `now` into `last_fired_at`, so an immediate restart does
  not replay the same catch-up.

Evidence — `node --test tests/triggers.test.js` (6 tests, 4 new): the first-arm,
short-stop, long-stop (4 and 10 intervals → exactly one fire each, `user-off` skipped,
second start quiet) and cron-grace cases all assert the recorded payloads.

## Still open in step-5

| Item | State |
|---|---|
| Memory reflection/consolidation | not implemented |
| Recall selector (semantic/keyword) | not implemented |
| 13 Queen personas | 4 built-in |
| Durable colony-level event log | per-session `events.jsonl` only |
| Sentinel delivery (Telegram/Slack send) | validation only; delivery is the local inbox |
