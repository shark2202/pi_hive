# Models parity — 4 partial routes implemented

Date: 2026-11-20 (+08:00). Domain: `models`.

## What runs now

| Route | Behaviour |
|---|---|
| `PUT /api/models/slots/:slot` | validates the slot id first, then the `ModelChoice` (`catalog` needs `provider`, `endpoint` needs a stored endpoint, `model` always), persists a real summary and returns `{slot, summary, sessions_switched}` |
| `DELETE /api/models/slots/:slot` | clears the slot → `{slot, summary: null}` (`llm` also swaps sessions) |
| `GET /api/models/endpoints/:endpoint/models` | for a stored endpoint, asks `{api_base}/models` over HTTP with the stored key (5 s timeout); for the env-configured provider, answers from the catalogue |
| `PUT /api/models/endpoints/:endpoint` | adds/edits `api_base` and `api_key`, validates the URL and the name, returns `ModelEndpoint` |
| `DELETE /api/models/endpoints/:endpoint` | `{deleted: name}`, 404 for unknown |

### Slot semantics (what each one actually does)

| Slot | Effect |
|---|---|
| `llm` | writes the saved LLM override that `modelConfig()` reads, then `server.swapModelRuntime()` drops the cached runtime + colony runtimes, so the next turn builds against the new model |
| `worker_llm` | `workerModelConfig()` in `src/config.js` reads it, and `GET /api/colonies/:colony/workers` launches `runWorker` with `server.workerModelRuntime` — so an assigned worker model is what a worker run uses |
| `vision_fallback` | stored and reported; nothing reads it, because `src/kernel/model.js` declares `input: ["text"]` |
| `queen:<id>` | writes that queen's own llm section through `queen-state.writeLlm`, so it re-binds her DM sessions and she shows up in `ModelsOverview.queens` |

### Endpoints and the key

`hiveHome()/config/endpoints.json` is written mode `0600` (skipped on Windows) because
it may hold an endpoint key. No response ever contains the key: `endpointBody()` exposes
`has_key` only, and the overview maps the same way. `api_base` edits keep the stored key;
`api_key: null` removes it.

`GET .../endpoints/:endpoint/models` is a real network call, so an unreachable endpoint
answers honestly instead of pretending to be empty:

```
$ curl -s -w '%{http_code}' -X GET $B/api/models/endpoints/local-vllm/models
502 {"error":"could not reach local-vllm: fetch failed","endpoint":"local-vllm"}
```

## Evidence

```
node --test tests/compat/config-extra-handlers.test.js   # 29 tests, 29 pass
npm test                                                 # 234 tests, 234 pass
node /tmp/sync-contract.mjs   # changed=4 by_status={"implemented":154,"partial":17,...}
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
  # STATUS {"implemented":154,"partial":17} … failures=0 warnings=0
```

Live HTTP on port 8790:

- `PUT /api/models/endpoints/local-vllm {api_base:"http://127.0.0.1:1/v1", api_key:"sk-not-real"}`
  → `{name, api_base, builtin:false, has_key:true, running:false}` (no key in the body).
- `PUT /api/models/slots/worker_llm {source:"endpoint", endpoint:"local-vllm", model:"qwen"}`
  → summary with `api_base` inherited from the endpoint; `GET /api/models/overview`
  reported it under `slots.worker_llm`.
- `PUT /api/models/slots/queen:growth {model:"queen-m"}` → the overview's `queens`
  listed `{id:"growth", model:"queen-m"}` (and a queen left over from the queens
  domain with her own stored section appeared too).
- `PUT /api/models/slots/llm {model:"slot-model"}` → `sessions_switched: 0` (the runtime
  was injected by the CLI in this environment); `GET /api/config/llm` returned
  `model: "slot-model"`, and clearing the slot returned the env model again.
- `GET .../endpoints/local-vllm/models` → `502` with the endpoint's own error.
- `DELETE` on both slots and the endpoint cleaned up (`{deleted:"local-vllm"}`).

New tests assert the effects, not the status codes: the key is on disk with mode 0600
and absent from every response, an `api_base` edit keeps the key, `workerModelConfig()`
really returns the slot's model and falls back after DELETE, a queen slot appears in the
overview and disappears when cleared, `llm` writes through to `GET /api/config/llm`, and
the validation test asserts nothing was written when validation failed.

## Not covered

- `vision_fallback` is stored but unused: the kernel's model declares text-only input.
- No catalogue discovery per provider: `ModelChoice {source:"catalog"}` is accepted for
  the configured provider id only, and the provider list still has one entry.
- `queen:<id>` slots do not re-bind live sessions: the queen DM session keeps the runtime
  it was created with until the process rebuilds it (`sessions_switched: 0` is reported,
  not hidden).
- An endpoint key is not yet used to build a model runtime; only `GET .../models` sends it.
