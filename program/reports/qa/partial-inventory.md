# Partial route inventory (64 routes)

Generated from program/contracts/hive-api.json on 2026-11-20. One domain = one work unit: implement for real + one semantic test per route.

## Domain counts

- queens: 14
- config: 9
- data: 9
- mcp: 7
- credentials: 6
- models: 4
- sentinel: 3
- skills: 3
- agents: 2
- sessions: 2
- prompts: 2
- soul: 2
- claude-code-queens: 1

## queens — 14
- POST /queen/create
- POST /queen/:queen/remove
- POST /queen/:queen/restore
- PATCH /queen/:queen/profile
- PUT /queen/:queen/llm
- PUT /queen/:queen/persona
- POST /queen/:queen/avatar
- DELETE /queen/:queen/avatar
- GET /queen/:queen/avatar
- POST /queen/:queen/session
- POST /queen/:queen/session/select
- POST /queen/:queen/session/new
- PATCH /queen/:queen/tools
- DELETE /queen/:queen/tools

## config — 9
- PUT /config/llm-sections
- PUT /config/provider-library
- POST /config/provider-library/apply
- PUT /config/external-skills
- PUT /config/features
- PUT /config/llm
- PUT /config/profile
- PUT /config/rate-limits
- POST /config/profile/avatar

## data — 9
- GET /global/data/tables
- GET /global/data/changes
- GET /global/data/tables/:table/rows
- PATCH /global/data/tables/:table/rows
- POST /global/data/tables/:table/query
- POST /global/data/tables/:table/group-counts
- POST /global/data/tables/:table/rows
- DELETE /global/data/tables/:table/rows
- GET /global/data/foreign-keys

## mcp — 7
- GET /mcp/servers
- POST /mcp/servers
- DELETE /mcp/servers/:server
- POST /mcp/servers/:server/enable
- POST /mcp/servers/:server/disable
- POST /mcp/servers/:server/mode
- POST /mcp/servers/:server/health

## credentials — 6
- POST /credentials
- DELETE /credentials/:credential
- POST /credentials/local
- DELETE /credentials/local/:credential/:alias
- POST /credentials/resync
- POST /sessions/:session/credential-form

## models — 4
- PUT /models/slots/:slot
- DELETE /models/slots/:slot
- PUT /models/endpoints/:endpoint
- DELETE /models/endpoints/:endpoint

## sentinel — 3
- POST /sentinel/telegram/validate
- POST /sentinel/telegram/detect-chat
- POST /sentinel/slack/validate

## skills — 3
- POST /skills/upload
- GET /sessions/:session/skill-installs
- POST /sessions/:session/skill-installs/:install

## agents — 2
- DELETE /agents
- PATCH /agents/metadata

## sessions — 2
- POST /sessions/:session/compact-and-fork
- POST /sessions/:session/report-bundle

## prompts — 2
- POST /prompts
- DELETE /prompts/:prompt

## soul — 2
- POST /queen/:queen/soul/proposals/:proposal/probe
- POST /queen/:queen/soul/reflect

## claude-code-queens — 1
- GET /claude-code-queens/:queen/conversations/:conversation
