# Skills parity — 3 routes implemented

Date: 2026-11-20 (+08:00). Domain: `skills` (the three that were partial:
`POST /skills/upload`, `GET /sessions/:session/skill-installs`,
`POST /sessions/:session/skill-installs/:install`).

## Shared library — `src/domain/skill-library.js`

`POST /api/skills/upload` (multipart) installs into `hiveHome()/skills/<name>/`:

- the `file`/`files` part must be a `SKILL.md`; `name`/`description` come from the
  front matter, else from `# heading` or the filename, normalized the way the client does
  (`lowercase`, non-alphanumerics → `-`, ≤64 chars);
- extra file parts are stored beside it, up to 32 files of 256 KiB, and a path that is
  absolute or contains `..` is **refused** rather than sanitized;
- the response is the official shape `{name, installed_path, replaced, scope, target_id, enabled}`
  with `replaced: true` when a `SKILL.md` already existed;
- `.zip` bundles answer `400 zip bundles are not supported: upload a SKILL.md …` — this
  host stores text files and will not pretend to unzip.

## Install queue

A `session_id` form field turns the upload into a **request** instead of an install:
`{scope:"session", target_id:<session>, enabled:false, installed_path:""}`. The queue is
`hiveHome()/sessions/<id>/skill-installs.json` and each request carries
`{id, name, description, body, files, requested_at, replaces}` — exactly
`SkillInstallRequest`.

`GET /api/sessions/:session/skill-installs` lists it. `POST .../:install` with
`{decision:"approve"}` installs the stored copy into the shared library and drops the
request from the queue; `deny` drops it without installing. Unknown id → 404, bad
decision → 400, `queen_told` is reported as `false` because no inbound channel exists to
tell a queen anything.

## Evidence

```
node --test tests/compat/catalog-handlers.test.js   # 12 tests, 12 pass
npm test                                            # 231 tests, 231 pass
node /tmp/sync-contract.mjs   # changed=3 by_status={"implemented":157,"partial":14,...}
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
  # STATUS {"implemented":157,"partial":14} … failures=0 warnings=0
```

Live HTTP on port 8790:

- upload `SKILL.md` → `{name:"live-skill", installed_path:"…/.tmp-home/skills/live-skill",
  replaced:false, scope:"global", enabled:true}`; a second upload → `replaced:true`.
- upload with `session_id=sess-live` → `{scope:"session", enabled:false, replaced:true}`.
- `GET /api/sessions/sess-live/skill-installs` → one request
  `{id:"inst-mwoa19yww6o11z", name:"live-skill", body:"Do the thing.", replaces:true}`.
- approve → `{decision:"approve", installed_path:"…/skills/live-skill"}`, `SKILL.md` present
  on disk, and the queue then listed `{requests: []}`.

Tests cover the semantics rather than the codes: the installed file's content, the
`replaced` flag on re-upload, the zip refusal, a denied request installing nothing, an
approved one leaving the queue and landing in the library, and the 404/400 paths.

## Not covered

- `.zip` bundles (multi-file SKILL.md bundles) are refused; only text parts are stored.
- Uploads land in the global library; `scope` is never `queen` because the upload route
  carries no queen id, and queen-scoped skills keep using `/api/queen/:queen/skills`.
- `queen_told` is always `false`: nothing pushes the decision back into a queen's chat.
- Skill installs are not loaded into agent tool lists automatically; the library is a
  directory that tools can walk (the colony-level `list_skills` still reads colony scope).
