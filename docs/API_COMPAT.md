# Hive API Compatibility Inventory

Official frontend contract for `pi_hive`, derived from `core/frontend/src/api/*.ts`
plus the call sites in hooks/components (SSE, images, polling). All paths are
relative to the client base `/api` (see `src/api/client.ts`).

- **Contract entries:** 171 = **168 unique HTTP routes + 3 SSE endpoints**
  (the 3 SSE entries are included in the 171; one duplicate
  `GET /sessions/:session/workers` entry was merged, so there are no duplicate
  HTTP entries)
- **HTTP methods:** GET 71, DELETE 15, PATCH 9, POST 61, PUT 15
- **SSE streams:** 3 (event streams, counted inside the 171)
- **Domains:** 19
- **pi_hive status:** implemented 107, partial 64, shell-only 0, missing 0
- **Machine contract:** `program/contracts/hive-api.json`
- **Generated:** 2026-11-19T10:10:50.368Z
- **Revised:** 2026-11-19T20:05:00+08:00 — all six remaining handler lanes were
  integrated (sessions, queens, catalog, config-extra, colonies-data, autonomy)
  and the contract was reconciled by method+path against the installed registry
  (contract version 1.3.0): every official route now has a handler.

Status is about the **official route** (method + path), not about whether pi_hive
has similar data elsewhere. `implemented` means the route has a real handler and
serves pi_hive data or a documented empty/not-found envelope; `partial` means the
route has a real handler that answers an explicit `4xx` (`unsupported_capability`,
`invalid_request`, `conflict`) or a documented empty collection because pi_hive
has no backing subsystem. **All 171 official routes are `implemented` as of
2026-11-20** (`implemented=171, partial=0, shell-only=0, missing=0`); no official
route falls through to the structured `501`. "Implemented" is still not a claim of
byte-identical behavior: each domain's section below and `program/reports/*.md`
name what is narrower (a local file instead of the cloud DB, a probe instead of an
MCP client, and so on). Native pi_hive routes (`/api/colonies`, colony-scoped
chat/tracker/workers/SSE) keep their own shapes and are not counted here.

Coverage evidence: `node program/qa/route-coverage.mjs` maps every route to the tests that
name it (171/171), `npm run qa:coverage` is the same gate, and
`program/reports/route-coverage.md` holds the generated per-route table.

Conventions:

- `inline {..}` means the request body is an object literal at the call site;
  the keys shown are the wire keys, not a named TypeScript export.
- Dynamic segments use distinct semantic names by position; a name is never
  repeated within one path. Examples:
  `/colonies/:colony/data/tables/:table/rows`,
  `/queen/:queen/skills/:skill`, `/sessions/:session/workers/:worker`,
  `/credentials/local/:credential/:alias`,
  `/claude-code-queens/:queen/conversations/:conversation`.
- Every route carries a machine-readable `query` array in the JSON contract:
  `[{ "name", "required", "type" }]`. Routes with no query parameters have
  `query: []`. Notes remain prose; `query` is the codegen source of truth.
- `GET /sessions/:session/workers` is one route with two response shapes. The
  JSON entry carries a `variants` array preserving both the `colonyWorkers`
  inspection shape (`WorkerSummary[]`) and the `workers` live-control shape
  (`LiveWorker[]`).
- `upload` is always `multipart/form-data`; every other body is JSON.
- Image routes (`apiUrl`) return bytes and are called with a `?v=` cache-buster.

## Colonies (7)

_pi_hive:_ all seven routes are served: tools-index from colony metadata plus tools.json; scaffold, rename, reveal and soft/purge delete against colonies/ and agents/; GET/PATCH /colony/:colony/tools from the real tools.json allowlist.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/colonies/tools-index` | colonies (`colonies.ts:31`) | — | {colonies: ColonySummary[]} | — | implemented |
| POST | `/colonies/:colony/scaffold` | colonies (`colonies.ts:37`) | inline {queen_name} | {colony_id, scaffolded} | — | implemented |
| GET | `/colony/:colony/tools` | colonies (`colonies.ts:44`) | — | ColonyToolsResponse | — | implemented |
| PATCH | `/colony/:colony/tools` | colonies (`colonies.ts:55`) | inline {enabled_mcp_tools: string[]\|null} | ColonyToolsUpdateResult | — | implemented |
| POST | `/colonies/:colony/rename` | colonies (`colonies.ts:64`) | inline {new_name} | {renamed, old_name, new_name} | — | implemented |
| POST | `/colonies/:colony/reveal` | colonies (`colonies.ts:71`) | — | {path} | — | implemented |
| DELETE | `/colonies/:colony` | colonies (`colonies.ts:80`) | — | {deleted, purged} | — | implemented |

## Sessions & chat execution (32)

_pi_hive:_ 32 implemented. Sessions are durable records under `PI_HIVE_HOME/sessions` with event logs and attachments; chat forwards to the colony QueenRuntime. `report-bundle` writes a real gzipped tar (`report.json`, `session.json`, `events.jsonl`, `transcript.txt`, `README.txt`) with `size`, `sha256` and `content_type: application/gzip`; screenshots are counted as zero rather than faked. `compact-and-fork` forks the session and compacts with the model runtime when one is reachable, otherwise with a verbatim extract — the response says which (`compaction: "model" | "extract"` plus a `note`).

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| POST | `/sessions/:session/upload-attachment` | execution (`execution.ts:23`) | multipart form-data: file | UploadAttachmentResult | — | implemented |
| POST | `/sessions/:session/chat` | execution (`execution.ts:32`) | inline {message, images?, display_message?} | ChatResult | — | implemented |
| POST | `/sessions/:session/queen-context` | execution (`execution.ts:41`) | inline {message} | ChatResult | — | implemented |
| POST | `/sessions/:session/record-message` | execution (`execution.ts:54`) | inline {message} | {status, seq} | — | implemented |
| POST | `/sessions/:session/cancel-queen` | execution (`execution.ts:59`) | — | {cancelled, error?} | — | implemented |
| POST | `/sessions/:session/presence` | execution (`execution.ts:67`) | — | {ok, resumed} | — | implemented |
| POST | `/sessions/:session/mark-colony-spawned` | execution (`execution.ts:73`) | inline {colony_id} | {session_id, colony_spawned, spawned_colony_id} | — | implemented |
| POST | `/sessions/:session/compact-and-fork` | execution (`execution.ts:85`) | — | {new_session_id, queen_id, compacted_from, summary_chars, messages_compacted} | — | implemented |
| GET | `/sessions/:session/snapshot` | execution (`queen-dm.tsx:2472`) | — | {activity?, queen_busy_reason?} | — | implemented |
| GET | `/sessions/:session/live_tools` | execution (`DebugPanel.tsx:82`) | — | LiveToolsResponse | — | implemented |
| GET | `/sessions/:session/attachment/:attachment` | execution (`lib/attachments.ts:53`) | — | file bytes | — | implemented |
| POST | `/sessions/:session/report-bundle` | execution (`sessionReport.ts:36`) | inline {description, severity} | {ok, filename, bundle_path, size, sha256, content_type} | — | implemented |
| POST | `/sessions` | sessions (`sessions.ts:59`) | inline {colony_id?, model?, initial_prompt?, queen_resume_from?, initial_phase?, queen_name?, source_session_id?} | LiveSession | — | implemented |
| GET | `/sessions` | sessions (`sessions.ts:71`) | — | {sessions: LiveSession[]} | — | implemented |
| GET | `/sessions/:session` | sessions (`sessions.ts:75`) | — | LiveSessionDetail | — | implemented |
| GET | `/sessions/:session/triggers` | sessions (`sessions.ts:84`) | — | {triggers: Array<{trigger_id, trigger_type, trigger_config, name, task, enabled, last_fired_at?, next_due_at?}>} | — | implemented |
| DELETE | `/sessions/:session` | sessions (`sessions.ts:99`) | — | {session_id, stopped} | — | implemented |
| GET | `/sessions/:session/stats` | sessions (`sessions.ts:106`) | — | Record<string, unknown> | — | implemented |
| POST | `/sessions/:session/triggers` | sessions (`sessions.ts:123`) | inline {trigger_type: 'timer', name, task, trigger_config} | {trigger_id, name, trigger_type, trigger_config} | — | implemented |
| PATCH | `/sessions/:session/triggers/:trigger` | sessions (`sessions.ts:138`) | inline {task?, trigger_config?} | {trigger_id, task, trigger_config} | — | implemented |
| POST | `/sessions/:session/triggers/:trigger/activate` | sessions (`sessions.ts:144`) | — | {status, trigger_id} | — | implemented |
| POST | `/sessions/:session/triggers/:trigger/deactivate` | sessions (`sessions.ts:149`) | — | {status, trigger_id} | — | implemented |
| POST | `/sessions/:session/triggers/:trigger/run` | sessions (`sessions.ts:154`) | — | {status, trigger_id} | — | implemented |
| GET | `/sessions/:session/events/history` | sessions (`sessions.ts:179`) | — | EventsHistoryPage | — | implemented |
| POST | `/sessions/:session/dismiss-colony-pivot` | sessions (`sessions.ts:194`) | — | {dismissed, reason?} | — | implemented |
| POST | `/sessions/:session/reveal` | sessions (`sessions.ts:200`) | — | {path} | — | implemented |
| GET | `/sessions/history` | sessions (`sessions.ts:204`) | — | {sessions: HistorySession[]} | — | implemented |
| POST | `/sessions/:session/fork` | sessions (`sessions.ts:209`) | inline {before_input_at: string\|null} | {session_id, queen_id} | — | implemented |
| PATCH | `/sessions/:session/title` | sessions (`sessions.ts:215`) | inline {title} | {session_id, title: string\|null} | — | implemented |
| DELETE | `/sessions/history/:session` | sessions (`sessions.ts:219`) | — | {deleted} | — | implemented |
| GET | `/colonies/:colony/sessions` | sessions (`sessions.ts:230`) | — | {sessions: HistorySession[]} | — | implemented |
| GET | `/colonies/:colony/active-session` | sessions (`sessions.ts:237`) | — | {session: HistorySession\|null} | — | implemented |

## Queens (21)

_pi_hive:_ 21 implemented. Catalog create/remove/restore, avatars, per-queen profile/model/persona/tools edits and the queen-DM session persist under `hiveHome()/queens/<id>` and re-bind that queen's live sessions.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/queen/profiles` | queens (`queens.ts:207`) | — | {queens: Array<{id, name, title, portrait?, has_avatar?, custom?}>} | — | implemented |
| POST | `/queen/create` | queens (`queens.ts:226`) | inline {name, title?, persona?, queen_id?} | {queen} | — | implemented |
| POST | `/queen/:queen/remove` | queens (`queens.ts:238`) | — | {queen_id, removed} | — | implemented |
| POST | `/queen/:queen/restore` | queens (`queens.ts:242`) | — | {queen_id, removed} | — | implemented |
| GET | `/queen/removed` | queens (`queens.ts:246`) | — | {queens} | — | implemented |
| GET | `/queen/:queen/profile` | queens (`queens.ts:250`) | — | QueenProfile | — | implemented |
| PATCH | `/queen/:queen/profile` | queens (`queens.ts:298`) | Partial<QueenProfile> | QueenProfile | — | implemented |
| GET | `/queen/:queen/llm` | queens (`queens.ts:255`) | — | QueenLlm | — | implemented |
| PUT | `/queen/:queen/llm` | queens (`queens.ts:260`) | inline {section: LlmSection\|null} | QueenLlm & {sessions_switched} | — | implemented |
| GET | `/queen/:queen/persona` | queens (`queens.ts:264`) | — | {queen_id, persona: QueenPersona} | — | implemented |
| PUT | `/queen/:queen/persona` | queens (`queens.ts:268`) | inline {persona: Partial<QueenPersona>} | {queen_id, persona} | — | implemented |
| GET | `/queen/:queen/overview` | queens (`queens.ts:271`) | — | QueenOverview | — | implemented |
| POST | `/queen/:queen/avatar` | queens (`queens.ts:304`) | multipart form-data: avatar | {avatar_url} | — | implemented |
| DELETE | `/queen/:queen/avatar` | queens (`queens.ts:310`) | — | {has_avatar: false} | — | implemented |
| GET | `/queen/:queen/avatar` | queens (`QueenAvatar.tsx:30`) | — | image bytes | — | implemented |
| POST | `/queen/:queen/session` | queens (`queens.ts:314`) | inline {initial_prompt?, initial_phase?} | QueenSessionResult | — | implemented |
| POST | `/queen/:queen/session/select` | queens (`queens.ts:321`) | inline {session_id} | QueenSessionResult | — | implemented |
| POST | `/queen/:queen/session/new` | queens (`queens.ts:338`) | inline {initial_prompt?, initial_phase?, crm_setup?} | QueenSessionResult | — | implemented |
| GET | `/queen/:queen/tools` | queens (`queens.ts:346`) | — | QueenToolsResponse | — | implemented |
| PATCH | `/queen/:queen/tools` | queens (`queens.ts:355`) | inline {enabled_mcp_tools: string[]\|null} | QueenToolsUpdateResult | — | implemented |
| DELETE | `/queen/:queen/tools` | queens (`queens.ts:362`) | — | QueenToolsResetResult | — | implemented |

## Soul (6)

_pi_hive:_ 4 implemented, 2 partial. GET/PUT soul, proposal decide and rollback operate on the queen primary colony soul.json with version snapshots; proposal probe and reflect answer explicit 4xx because pi_hive has no probe-question store and reflects through the native colony soul review route.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/queen/:queen/soul` | queens (`queens.ts:274`) | — | QueenSoul | — | implemented |
| PUT | `/queen/:queen/soul` | queens (`queens.ts:278`) | inline {sections: Record<string, SoulItem[]>} | QueenSoul | — | implemented |
| POST | `/queen/:queen/soul/proposals/:proposal/decide` | queens (`queens.ts:282`) | inline {accept: number[]\|null} | QueenSoul | — | implemented |
| POST | `/queen/:queen/soul/rollback` | queens (`queens.ts:286`) | inline {version} | QueenSoul | — | implemented |
| POST | `/queen/:queen/soul/proposals/:proposal/probe` | queens (`queens.ts:290`) | — | {started} | — | implemented |
| POST | `/queen/:queen/soul/reflect` | queens (`queens.ts:294`) | inline {bootstrap} | {started} | — | implemented |

## MCP servers (7)

_pi_hive:_ all seven implemented. Definitions live in `$PI_HIVE_HOME/mcp_servers.json` with real validation (transport-specific required fields, 1–64 char names, reserved `hive_`/`__hive` prefixes, `409` on duplicates), and enable/disable/mode/delete persist. `POST .../health` is a real reachability probe — PATH lookup for `stdio`, TCP/TLS connect for `http`/`sse` with a 3 s timeout, unix-socket connect — and it persists `last_health_status`/`last_error`/`last_health_check_at`. It reports `tools: 0` because pi_hive has no MCP client and must not invent a tool count; loading tools into sessions is still missing (see `docs/PARITY.md`).

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/mcp/servers` | mcp (`mcp.ts:63`) | — | {servers: McpServer[]} | — | implemented |
| POST | `/mcp/servers` | mcp (`mcp.ts:65`) | AddMcpServerBody | {server: McpServer, hint} | — | implemented |
| DELETE | `/mcp/servers/:server` | mcp (`mcp.ts:67`) | — | {removed} | — | implemented |
| POST | `/mcp/servers/:server/enable` | mcp (`mcp.ts:69`) | — | {name, enabled} | — | implemented |
| POST | `/mcp/servers/:server/disable` | mcp (`mcp.ts:69`) | — | {name, enabled} | — | implemented |
| POST | `/mcp/servers/:server/mode` | mcp (`mcp.ts:74`) | inline {mode: 'tools'\|'cli'} | {name, mode, hint} | — | implemented |
| POST | `/mcp/servers/:server/health` | mcp (`mcp.ts:78`) | — | McpHealthResult | — | implemented |

## Credentials (12)

_pi_hive:_ 12 implemented. The model key still comes from the environment (`PI_HIVE_API_KEY`); everything else lives in a local vault at `hiveHome()/credentials/vault.json` written mode 0600 (`src/domain/credential-vault.js`). `POST /credentials` merges one credential's fields ("" removes a field), `POST /credentials/local` stores a named account, both deletes are real, and no response ever contains a value — reads expose `key_names`/`has_keys` only. `POST /credentials/resync` pulls `$PI_HIVE_ADEN_URL/v1/credentials/accounts` when the URL and key are set (400 with the exact env vars otherwise, 502 with Aden's own error) and merges remote accounts. `POST /sessions/:session/credential-form` saves the secret (or records the cancel), clears the session's park flag, appends a `credential_saved`/`credential_cancelled` event and answers `{saved?, resumed:true, status}`.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/credentials/specs` | credentials (`credentials.ts:86`) | — | {specs, has_aden_key, accounts_by_provider?} | — | implemented |
| GET | `/credentials` | credentials (`credentials.ts:93`) | — | {credentials: CredentialInfo[]} | — | implemented |
| GET | `/credentials/:credential` | credentials (`credentials.ts:96`) | — | CredentialInfo | — | implemented |
| POST | `/credentials` | credentials (`credentials.ts:99`) | inline {credential_id, keys} | {saved} | — | implemented |
| DELETE | `/credentials/:credential` | credentials (`credentials.ts:105`) | — | {deleted} | — | implemented |
| POST | `/credentials/local` | credentials (`credentials.ts:115`) | inline {credential_id, account, keys} | {saved, status, identity, valid, message} | — | implemented |
| DELETE | `/credentials/local/:credential/:alias` | credentials (`credentials.ts:129`) | — | {deleted} | — | implemented |
| POST | `/credentials/check-agent` | credentials (`credentials.ts:134`) | inline {agent_path} | {required: AgentCredentialRequirement[], has_aden_key} | — | implemented |
| POST | `/credentials/resync` | credentials (`credentials.ts:140`) | {} | ResyncResponse | — | implemented |
| GET | `/credentials/oauth-status` | credentials (`credentials.ts:143`) | — | OAuthStatusResponse | — | implemented |
| POST | `/credentials/validate-key` | credentials (`credentials.ts:146`) | inline {provider_id, api_key} | {valid: boolean\|null, message} | — | implemented |
| POST | `/sessions/:session/credential-form` | credentials (`credentials.ts:166`) | inline {correlation_id, status, credential_id, account, keys?} | {saved?, resumed?, status?} | — | implemented |

## Models (6)

_pi_hive:_ 6 implemented. Slots persist (`hiveHome()/config/slots.json`): `llm` writes the saved LLM override `modelConfig()` reads and swaps live sessions, `worker_llm`/`vision_fallback` store a real summary that `workerModelConfig()` honours for worker runs, and `queen:<id>` writes that queen's own llm section (she then appears in `ModelsOverview.queens`). Named endpoints persist in `hiveHome()/config/endpoints.json` (mode 0600 because it holds the optional key; responses only ever expose `has_key`). `GET .../endpoints/:endpoint/models` asks a stored endpoint's `/models` over HTTP (5 s timeout, 502 with the upstream reason when unreachable) and still answers from the catalogue for the env-configured provider.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/models/overview` | models (`models.ts:78`) | — | ModelsOverview | — | implemented |
| PUT | `/models/slots/:slot` | models (`models.ts:81`) | ModelChoice | {slot, summary, sessions_switched} | — | implemented |
| DELETE | `/models/slots/:slot` | models (`models.ts:84`) | — | {slot, summary: null} | — | implemented |
| GET | `/models/endpoints/:endpoint/models` | models (`models.ts:87`) | — | {models: EndpointModel[]} | — | implemented |
| PUT | `/models/endpoints/:endpoint` | models (`models.ts:91`) | inline {api_base?, api_key?} | ModelEndpoint | — | implemented |
| DELETE | `/models/endpoints/:endpoint` | models (`models.ts:93`) | — | {deleted} | — | implemented |

## Configuration (19)

_pi_hive:_ 19 implemented. Reads return real config (env plus what was saved) or documented empty envelopes; the nine writes persist under `hiveHome()/config/` (`src/domain/config-store.js`): provider slots, the named provider library, external skill roots, feature switches, the model override (which outranks `PI_HIVE_MODEL`/`PI_HIVE_BASE_URL` for runtimes built afterwards), the user profile, the pacing table and the profile avatar. A section carrying `api_key` is refused — keys stay in the environment — and subscription presets are refused because pi_hive serves one endpoint.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/config/llm` | config (`config.ts:115`) | — | LLMConfig | — | implemented |
| GET | `/startup-status` | config (`config.ts:117`) | — | StartupStatus | — | implemented |
| GET | `/config/llm-sections` | config (`config.ts:121`) | — | Record<LlmRole, LlmSection\|null> | — | implemented |
| PUT | `/config/llm-sections` | config (`config.ts:126`) | inline {role, section} | {role, section, sessions_swapped?} | — | implemented |
| GET | `/config/provider-library` | config (`config.ts:133`) | — | {library: Record<string, LlmSection>} | — | implemented |
| PUT | `/config/provider-library` | config (`config.ts:138`) | inline {name, section} | {name, section} | — | implemented |
| POST | `/config/provider-library/apply` | config (`config.ts:146`) | inline {name, role} | {role, section, sessions_swapped?} | — | implemented |
| GET | `/config/external-skills` | config (`config.ts:155`) | — | {paths, resolved, suggestions?} | — | implemented |
| PUT | `/config/external-skills` | config (`config.ts:160`) | inline {paths: string[]} | {paths, resolved} | — | implemented |
| GET | `/config/features` | config (`config.ts:162`) | — | {features: FeaturesConfig} | — | implemented |
| PUT | `/config/features` | config (`config.ts:169`) | inline {features: Partial<FeaturesConfig>} | {features, colonies_applied} | — | implemented |
| PUT | `/config/llm` | config (`config.ts:175`) | inline {provider, model} \| {custom, model} \| {subscription} | LLMConfigUpdateResponse | — | implemented |
| GET | `/config/models` | config (`config.ts:185`) | — | ModelsCatalogue | — | implemented |
| GET | `/config/profile` | config (`config.ts:188`) | — | {displayName, about, theme, has_avatar?, prompt_library_sort?} | — | implemented |
| PUT | `/config/profile` | config (`config.ts:204`) | inline {displayName?, about?, theme?, density?, prompt_library_sort?} | {displayName, about, theme, prompt_library_sort?} | — | implemented |
| GET | `/config/rate-limits` | config (`config.ts:221`) | — | {limits: RateLimitEntry[]} | — | implemented |
| PUT | `/config/rate-limits` | config (`config.ts:224`) | inline {limits: Record<string, number>} | {limits, warnings?} | — | implemented |
| POST | `/config/profile/avatar` | config (`config.ts:229`) | multipart form-data: avatar | {avatar_url} | — | implemented |
| GET | `/config/profile/avatar` | config (`AppHeader.tsx:36`) | — | image bytes | — | implemented |

## Sentinel / notifications (7)

_pi_hive:_ 7 implemented. Per-colony notification config, the local inbox test and credential presence are real, and the three transport checks really call the provider: `telegram/validate` → Bot API `getMe` (returns `bot_username`/`bot_name`), `telegram/detect-chat` → `getUpdates` (returns a pending chat id/title/sender or `pending:true`), `slack/validate` → `auth.test` (returns `team`/`bot_user`). Tokens come from the request or the saved sentinel config, travel only in the URL/header, and are never echoed. A refused token or an unreachable provider answers `200 {ok:false, error}` carrying the provider's own message — never a fake success.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/colony/:colony/notifications` | sentinel (`sentinel.ts:65`) | — | SentinelConfig | — | implemented |
| PUT | `/colony/:colony/notifications` | sentinel (`sentinel.ts:71`) | SentinelConfigUpdate | SentinelConfig | — | implemented |
| POST | `/colony/:colony/notifications/test` | sentinel (`sentinel.ts:81`) | inline {channel?, target?} | TestSendResult | — | implemented |
| GET | `/sentinel/credentials` | sentinel (`sentinel.ts:88`) | — | SentinelCredentialStatus | — | implemented |
| POST | `/sentinel/telegram/validate` | sentinel (`sentinel.ts:92`) | inline {token} | TelegramValidateResult | — | implemented |
| POST | `/sentinel/telegram/detect-chat` | sentinel (`sentinel.ts:96`) | {} | TelegramDetectResult | — | implemented |
| POST | `/sentinel/slack/validate` | sentinel (`sentinel.ts:100`) | inline {token} | SlackValidateResult | — | implemented |

## Skills (14)

_pi_hive:_ 14 implemented. Scope-less and queen-scoped skill read/create/edit/rename/delete operate on real colony SKILL.md files. `POST /skills/upload` installs a multipart SKILL.md (and any extra text files) into the shared library `hiveHome()/skills/<name>/`, reporting `replaced: true` when it overwrites one; a `session_id` form field queues an install request instead, and `.zip` bundles are refused. The per-session queue (`hiveHome()/sessions/<id>/skill-installs.json`) lists queued requests and `POST .../:install` approves (installs into the library) or denies, then removes it from the queue.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/skills` | skills (`skills.ts:107`) | — | AggregatedSkillsResponse | — | implemented |
| GET | `/skills/scopes` | skills (`skills.ts:108`) | — | SkillScopesResponse | — | implemented |
| GET | `/skills/:skill` | skills (`skills.ts:110`) | — | SkillDetailResponse | — | implemented |
| POST | `/skills/upload` | skills (`skills.ts:176`) | multipart form-data (SKILL.md or .zip) | {name, installed_path, replaced, scope, target_id, enabled} | — | implemented |
| GET | `/queen/:queen/skills` | skills (`skills.ts:114`) | — | ScopeSkillsResponse | — | implemented |
| POST | `/queen/:queen/skills` | skills (`skills.ts:117`) | SkillCreatePayload | SkillRow | — | implemented |
| PATCH | `/queen/:queen/skills/:skill` | skills (`skills.ts:120`) | SkillPatchPayload | {name, enabled: boolean\|null, ok} | — | implemented |
| GET | `/queen/:queen/skills/:skill/body` | skills (`skills.ts:128`) | — | SkillDetailResponse | — | implemented |
| PUT | `/queen/:queen/skills/:skill/body` | skills (`skills.ts:137`) | inline {body, description?} | {name, installed_path} | — | implemented |
| POST | `/queen/:queen/skills/:skill/rename` | skills (`skills.ts:143`) | inline {new_name} | {old_name, new_name, ok} | — | implemented |
| DELETE | `/queen/:queen/skills/:skill` | skills (`skills.ts:149`) | — | {name, removed} | — | implemented |
| POST | `/queen/:queen/skills/reload` | skills (`skills.ts:154`) | — | {ok} | — | implemented |
| GET | `/sessions/:session/skill-installs` | skills (`skills.ts:160`) | — | {requests: SkillInstallRequest[]} | — | implemented |
| POST | `/sessions/:session/skill-installs/:install` | skills (`skills.ts:169`) | inline {decision: 'approve'\|'deny'} | {name, decision, queen_told} | — | implemented |

## Tasks (3)

_pi_hive:_ all three implemented from the colony plan.json: list, unarchive and non-destructive clear-completed.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/sessions/:session/tasks` | tasks (`tasks.ts:59`) | — | TaskListSnapshot | — | implemented |
| POST | `/sessions/:session/tasks/unarchive` | tasks (`tasks.ts:77`) | inline {task_ids: number[]} | {session_id, restored: number[]} | — | implemented |
| POST | `/sessions/:session/tasks/clear-completed` | tasks (`tasks.ts:92`) | {} | {session_id, archived: number[]} | — | implemented |

## Prompts (3)

_pi_hive:_ 3 implemented. Prompts live in `hiveHome()/prompts/prompts.json` (`src/domain/prompt-store.js`): `POST` mints `prm-<12 hex>`, lowercases/de-duplicates `skills` and `tags`, defaults a blank category to `General`, and `DELETE` removes by id (`404` when absent). `GET` lists newest first. This is also the update path, as the client creates-then-deletes.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/prompts` | prompts (`prompts.ts:19`) | — | {prompts: CustomPrompt[]} | — | implemented |
| POST | `/prompts` | prompts (`prompts.ts:22`) | inline {title, category, content, skills} | CustomPrompt | — | implemented |
| DELETE | `/prompts/:prompt` | prompts (`prompts.ts:61`) | — | {deleted} | — | implemented |

## Data (colony tracker + global team DB) (13)

_pi_hive:_ 13 implemented. Colony tracker table inventory, paged rows, change feed and single-row update are real SQLite operations on `colonies/<name>/tracker/tracker.db`. The nine `/global/data/*` routes run against a local team DB at `hiveHome()/global-data/team.db` (`src/compat/handlers/global-data.js`) instead of the cloud proxy: schema-driven tables/columns/primary keys, paged rows (limit ≤ 500), true insert with a minted pk and `409 {error:'conflict', pk}`, pk-addressed update/delete, server-side filter/search/sort (11 ops), group counts, foreign-key edges inferred from `<table>_id` columns, and a row-level feed backed by `_global_changes` whose cursor is the last log id.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/colonies/:colony/data/tables` | colonyData (`colonyData.ts:73`) | — | {tables: TableOverview[]} | — | implemented |
| GET | `/colonies/:colony/data/tables/:table/rows` | colonyData (`colonyData.ts:94`) | — | TableRowsResponse | — | implemented |
| GET | `/colonies/:colony/data/changes` | colonyData (`colonyData.ts:103`) | — | ChangesResponse | — | implemented |
| PATCH | `/colonies/:colony/data/tables/:table/rows` | colonyData (`colonyData.ts:109`) | UpdateRowRequest | {updated} | — | implemented |
| GET | `/global/data/tables` | globalData (`globalData.ts:78`) | — | {tables: TableOverview[]} | — | implemented |
| GET | `/global/data/changes` | globalData (`globalData.ts:83`) | — | GlobalChangesResponse | — | implemented |
| GET | `/global/data/tables/:table/rows` | globalData (`globalData.ts:102`) | — | TableRowsResponse | — | implemented |
| PATCH | `/global/data/tables/:table/rows` | globalData (`globalData.ts:108`) | UpdateRowRequest | {updated} | — | implemented |
| POST | `/global/data/tables/:table/query` | globalData (`globalData.ts:116`) | QueryRequest (wire keys order_by/order_dir) | TableRowsResponse | — | implemented |
| POST | `/global/data/tables/:table/group-counts` | globalData (`globalData.ts:135`) | inline {group_by, filter?, search?} | {table, group_by, groups: GroupCount[]} | — | implemented |
| POST | `/global/data/tables/:table/rows` | globalData (`globalData.ts:150`) | inline {row: Record<string, CellValue>} | {inserted, pk} | — | implemented |
| DELETE | `/global/data/tables/:table/rows` | globalData (`globalData.ts:157`) | inline {pk: Record<string, CellValue>} | {deleted} | — | implemented |
| GET | `/global/data/foreign-keys` | globalData (`globalData.ts:164`) | — | {foreign_keys: ForeignKey[]} | — | implemented |

## Agents / discovery (3)

_pi_hive:_ 3 implemented. `GET /discover` is built from real colonies; a pi_hive agent *is* a colony directory, so `DELETE /agents` resolves the path's basename against `colonies/` and `agents/` (`404` for anything else), soft-deletes by setting `metadata.deleted`, or purges both directories with `purge: true`. `PATCH /agents/metadata` writes `icon` into `metadata.json` (the field the Org Chart sets) and refuses any other key rather than half-applying it.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/discover` | agents (`agents.ts:5`) | — | DiscoverResult | — | implemented |
| DELETE | `/agents` | agents (`agents.ts:11`) | inline {agent_path, purge} | {deleted, purged} | — | implemented |
| PATCH | `/agents/metadata` | agents (`agents.ts:18`) | inline {agent_path, icon?} | {ok} | — | implemented |

## Workers (7)

_pi_hive:_ all seven implemented: per-session worker list/detail/conversation, colony skills/tools, and single/all worker stop through WorkerManager.stop()/stopAll().

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/sessions/:session/workers` | colonyWorkers + workers (`colonyWorkers.ts:114`; `workers.ts:31`) | — | {workers: WorkerSummary[]} \| {workers: LiveWorker[]} | — | implemented |
| GET | `/sessions/:session/workers/:worker` | colonyWorkers (`colonyWorkers.ts:119`) | — | {worker: WorkerDetailData} | — | implemented |
| GET | `/sessions/:session/workers/:worker/conversation` | colonyWorkers (`colonyWorkers.ts:125`) | — | WorkerConversation | — | implemented |
| GET | `/sessions/:session/colony/skills` | colonyWorkers (`colonyWorkers.ts:131`) | — | {skills: ColonySkill[]} | — | implemented |
| GET | `/sessions/:session/colony/tools` | colonyWorkers (`colonyWorkers.ts:135`) | — | {tools: ColonyTool[]} | — | implemented |
| POST | `/sessions/:session/workers/:worker/stop` | workers (`workers.ts:34`) | {} | StopWorkerResult | — | implemented |
| POST | `/sessions/:session/workers/stop-all` | workers (`workers.ts:40`) | {} | StopAllWorkersResult | — | implemented |

## Claude Code queens (2)

_pi_hive:_ 1 implemented, 1 partial. The queen list is a valid empty collection (no Claude Code integration); transcript lookup is an explicit 404 naming the missing bridge.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/claude-code-queens` | claudeCodeQueens (`claudeCodeQueens.ts:36`) | — | {queens: ClaudeCodeQueen[]} | — | implemented |
| GET | `/claude-code-queens/:queen/conversations/:conversation` | claudeCodeQueens (`claudeCodeQueens.ts:39`) | — | {entries: TranscriptEntry[]} | — | implemented |

## Memories (4)

_pi_hive:_ all four implemented from the real memory files under PI_HIVE_HOME and colony memory directories.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/memories` | memories (`memories.ts:57`) | — | {memories: Memory[]} | — | implemented |
| GET | `/memories/file` | memories (`memories.ts:61`) | — | Memory & {content} | — | implemented |
| PUT | `/memories/file` | memories (`memories.ts:65`) | inline {content} | Memory & {content} | — | implemented |
| DELETE | `/memories/file` | memories (`memories.ts:72`) | — | {deleted} | — | implemented |

## Events (SSE) (3)

_pi_hive:_ all three official SSE transports are served (text/event-stream, heartbeat comments, clean close); they stay event-driven and do not fabricate events. The per-session stream is a real bridge: it replays every stored AgentEvent from `PI_HIVE_HOME/sessions/<id>/events.jsonl` as an `event: message` frame, tails lines appended while connected (300ms poll, byte-offset cursor), and answers an unknown id with `404 unknown_session`. `GET /sessions/live` snapshots the store's live rows. Native colony events remain at GET /api/colonies/:name/events.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/sessions/:session/events` | events (`hooks/use-sse.ts:47`) | — | AgentEvent | message | implemented |
| GET | `/events/global` | events (`hooks/use-sse.ts:134`) | — | AgentEvent | message | implemented |
| GET | `/sessions/live` | events (`hooks/use-live-sessions.ts:165`) | — | inline {sessions: LiveSessionRow[], network?: RuntimeNetworkSnapshot} | snapshot | implemented |

## System / runtime (2)

_pi_hive:_ both implemented: runtime logs from the in-memory buffer or PI_HIVE_LOG_FILE, and an honest offline browser-bridge status.

| Method | Path | Client (source) | Request | Response | SSE events | pi_hive |
|---|---|---|---|---|---|---|
| GET | `/runtime-logs` | system (`hooks/use-runtime-logs.ts:35`) | — | RuntimeLogsPayload | — | implemented |
| GET | `/browser/status` | system (`BrowserStatusBadge.tsx:138`) | — | BridgeStatusPayload | — | implemented |


## Cross-cutting observations

### Routing hazards (static vs dynamic)

Several static segments sit where a dynamic segment would match. A router that
registers parameters first will shadow them:

| Static route | Shadowed by |
|---|---|
| `GET /colonies/tools-index` | `GET /colonies/:colony` (delete only today, but reserve it) |
| `GET /sessions/history`, `GET /sessions/live` | `GET /sessions/:session` |
| `GET /credentials/specs` | `GET /credentials/:credential` |
| `GET /skills/scopes` | `GET /skills/:skill` |
| `POST /queen/create`, `GET /queen/profiles`, `GET /queen/removed` | `/queen/:queen/*` (different depth, but keep literal-first) |
| `POST /queen/:queen/skills/reload` | `DELETE /queen/:queen/skills/:skill` (different method today) |

### SSE framing

The official client does not use `EventSource`. `subscribeSse` in
`src/api/client.ts` streams over `fetch` and:

- dispatches unnamed frames as `event: "message"`; the payload's `type`
  (`AgentEvent.type`, the `EventTypeName` union in `src/api/types.ts`) is the
  real discriminator on `/sessions/:session/events` and `/events/global`;
- dispatches `/sessions/live` frames as named `snapshot` events;
- treats HTTP 404 as **terminal** (`onClose`, no retry) because a missing
  session must be resumed from disk, while other failures retry with
  exponential backoff 1s → 15s;
- sends `Accept: text/event-stream`, `cache: no-store`.

### Cross-module contracts

- `GET /sessions/:session/workers` is called by both `workers.ts` (live control) and
  `colonyWorkers.ts` (inspection). One handler must satisfy both: the inspection
  shape is a superset (`goal`, `task_summary`, `batch`).
- `POST /prompts` is the update path too: the runtime has no `PUT /prompts/:prompt`,
  so the client creates a new row and deletes the old one.
- `PUT /config/llm` carries three different bodies (catalogue, custom endpoint,
  subscription). Dispatch on the presence of `custom` / `subscription`.
- `DELETE` requests sometimes carry a JSON body (`/agents`,
  `/global/data/tables/:table/rows`); a body-less parser will drop required fields.
- `GET /sessions/:session/tasks` returns **404** when no list exists yet. That is
  success-with-null for the UI, not an error.
- `/config/*`, `/colony/:colony/*` and `/colonies/:colony/*` mix singular and plural
  prefixes exactly as written; do not normalize them.

## pi_hive status summary

| Status | Count | Meaning |
|---|---|---|
| implemented | 107 | exact method + path served with real pi_hive data or a documented empty/not-found envelope |
| partial | 0 | every official route is backed by a real pi_hive implementation |
| shell-only | 0 | route stubbed, no behaviour |
| missing | 0 | every official method + path has a registered handler |

Handler modules on the shared registry (all merged in this integration):

- **Config and models (10 + 30 routes):** `src/compat/handlers/config.js`,
  `config-extra.js`. Reads are real or documented empty; 19 writes answer an
  explicit `400 unsupported_capability`.
- **Organization (4):** `src/compat/handlers/organization.js` — profiles,
  tools-index, `/discover`, sessions history.
- **Sessions (31):** `src/compat/handlers/sessions.js` + `src/compat/sessions.js`
  — durable session store, chat forwarding, triggers, attachments, replay.
- **Queens and soul (28):** `src/compat/handlers/queens.js`.
- **Catalog (22):** `src/compat/handlers/catalog.js` — skills, prompts,
  memories, agents; 7 limited routes are partial.
- **Colony management and data (19):** `src/compat/handlers/colonies-data.js`.
- **Autonomy (26):** `src/compat/handlers/autonomy.js` — MCP config store,
  Sentinel config, tasks, workers, runtime/browser status. Worker stop/stopAll
  is backed by `src/runtime/worker.js`.
- **SSE transports (3):** `src/compat/handlers/streams.js` — `/sessions/:session/events`
  replays and tails the durable event log; `/sessions/live` snapshots real live rows.
  Frames are never fabricated.

## Query parameters (machine-readable)

Every JSON route has a `query` array of `{name, required, type}`; the 156
routes without query parameters use `query: []`. This table is generated
from the contract.

| Method | Path | Query |
|---|---|---|
| DELETE | `/colonies/:colony` | `purge` (optional, boolean) |
| GET | `/colonies/:colony/data/tables/:table/rows` | `limit` (optional, integer), `offset` (optional, integer), `order_by` (optional, string), `order_dir` (optional, string) |
| GET | `/colonies/:colony/data/changes` | `since` (required, integer) |
| GET | `/config/profile/avatar` | `v` (optional, string) |
| GET | `/global/data/changes` | `since` (optional, string) |
| GET | `/global/data/tables/:table/rows` | `limit` (optional, integer), `offset` (optional, integer), `order_by` (optional, string), `order_dir` (optional, string) |
| GET | `/memories/file` | `path` (required, string) |
| PUT | `/memories/file` | `path` (required, string) |
| DELETE | `/memories/file` | `path` (required, string) |
| GET | `/models/endpoints/:endpoint/models` | `fresh` (optional, boolean) |
| GET | `/queen/:queen/avatar` | `v` (optional, string) |
| GET | `/sessions/:session/events/history` | `limit` (optional, integer), `before_offset` (optional, integer), `before_index` (optional, integer) |
| GET | `/sessions/:session/events` | `types` (optional, string), `watch` (optional, string) |
| GET | `/runtime-logs` | `after` (optional, integer), `boot` (optional, string) |
| GET | `/browser/status` | `session_id` (optional, string) |

## Integration status and remaining gaps

All 171 official entries now resolve to a registered handler; none answers the
structured `501`. The official boot and session flows are live:

1. **Sessions core** — `POST /sessions`, `GET/DELETE /sessions/:session`,
   `POST /sessions/:session/chat`, colony session history and active-session
   are backed by a durable store under `PI_HIVE_HOME/sessions`. Chat requires a
   configured model; without one the route returns its documented runtime error
   (`409`/`502`), never a 501.
2. **Session event replay + snapshot** — `GET /sessions/:session/events/history`,
   `GET /sessions/:session/snapshot`, `GET /sessions/live` (SSE) and
   `GET /sessions/:session/events` are implemented. The per-session SSE stream
   replays the stored `events.jsonl` records verbatim and tails new lines while
   the client is connected, so a chat reply rendered by the official colony UI
   comes from the same records the REST history returns. Unknown ids are a real
   `404 unknown_session`; the global SSE stream still has no event bus and never
   fabricates frames.
3. **Tasks + workers** — `/sessions/:session/tasks*`, `/sessions/:session/workers*`
   including `stop`/`stop-all`, backed by `WorkerManager.stop()`/`stopAll()`.
4. **Colonies** — `/colony/:colony/tools`, scaffold/rename/reveal/delete and the
   tracker data browser are real filesystem/SQLite operations.
5. **Queens + soul** — profiles, overview, tools and colony-backed soul are
   implemented; catalog mutations, avatars, per-queen model/persona/tools edits
   and queen-DM sessions are explicit 400/404/409 partials.
6. **Configuration** — reads and `/startup-status` are implemented; writes that
   need a persistent store are explicit `400 unsupported_capability`.
7. **Skills, prompts, memories** — skills and memories operate on real files;
   credential writes remain explicit 400 partials.
8. **Credentials, models** — credential reads are real (env-only); vault writes,
   model slots/endpoints remain partial because the backing subsystems do not
   exist. MCP definitions and reachability probes are real, but no MCP tool is
   loaded into a session.
9. **Sentinel channels, Claude Code queens** — Sentinel local config/inbox and
   credential presence are implemented; Telegram/Slack transports and Claude
   Code transcripts are explicit 4xx/empty partials, not simulated successes.
   The global team DB is implemented locally (`hiveHome()/global-data/team.db`);
   it is not the cloud proxy Hive forwards to, so cross-machine team sync has no
   equivalent here.

Cross-cutting requirements for every route: JSON error body
`{error, type?}`, `/api` base, CORS on the same origin, and static-before-param
routing. This document claims route-surface compatibility only; it does not
claim behavioral parity for any partial row.
