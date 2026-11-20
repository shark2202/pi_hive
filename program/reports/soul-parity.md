# Soul parity — probe and reflect implemented

Date: 2026-11-20 (+08:00). Domain: `soul` (2 routes).

## Both routes now start real background work

The official client expects `{started: true}` and polls the soul view for the result, so
the routes do the work asynchronously and record whatever happened:

| Route | Behaviour |
|---|---|
| `POST /queen/:queen/soul/proposals/:proposal/probe` | validates the queen + proposal (`404` for an unknown/moot proposal, `409` when the soul is off), returns `{started:true}`, then asks the model for one question and appends a `{kind:"probe", status:"probing", probe_of:<id>, question}` entry |
| `POST /queen/:queen/soul/reflect` | `409` while a proposal is pending, `409` when the soul is off; accepts `{bootstrap}`, returns `{started:true}`, then asks the model for up to two proposals and appends them as pending `soul_proposals.jsonl` records (`source: bootstrap|reflect`) |

`src/compat/handlers/queens.js` gained `soulModelText()` (one non-streaming model turn,
`null` when no runtime is reachable), `parseModelJson()` (tolerates a fenced block or prose
around the JSON) and `rememberProbe()`.

## Honesty on failure

Without `PI_HIVE_API_KEY` the background job writes the failure instead of doing nothing:

```json
{"kind":"probe","status":"probing","probe_of":"soul_p1",
 "error":"no model runtime was reachable, so no question could be asked"}
{"kind":"reflection","status":"rejected",
 "error":"no model runtime was reachable, so nothing was proposed"}
```

A model answer with no usable JSON is recorded as `the model answer carried no usable
proposals`, so an empty queue always has a reason attached.

## Evidence

```
node --test tests/compat/queens-handlers.test.js   # 16 tests, 16 pass
npm test                                           # 232 tests, 232 pass
node /tmp/sync-contract.mjs   # changed=2 by_status={"implemented":161,"partial":10,...}
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
  # STATUS {"implemented":161,"partial":10} … failures=0 warnings=0
```

Live HTTP: `POST /api/queen/queen_tech/soul/reflect {"bootstrap":true}` →
`{started:true, queen_id:"queen_tech", colony_id:"smoke-queen", bootstrap:true}`, and
`GET /api/queen/queen_tech/soul` still serves the versioned soul view.

Tests cover both paths: with no runtime the probe entry carries the "no model runtime"
error; with an injected stub runtime the probe records the model's exact question and
reflection appends a pending proposal with `section`, `change`, `evidence` and
`source:"reflect"`.

## Not covered

- No live model call in this environment (no key), so the prompt quality is unproven; the
  model path is exercised with a stub runtime only.
- Reflection is capped at two proposals per run; there is no scheduling/cooldown loop in
  this route (the automation lives outside it).
- The probe question is stored but nothing sends it to the owner or feeds the answer back
  into the soul record.
