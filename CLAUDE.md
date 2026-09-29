# CLAUDE.md — pruaction-insights-service

Fastify 5 + TypeScript (NodeNext, strict) implementation of the **Insights
domain API** with deterministic stub data. The contract is
`vendor/spec/insights.v1.yaml` (synced from the separate `pruaction-spec`
repo) — **field names and shapes there win over this code**; read
`AGENTS.md` before changing anything.

Commands: dev `npm run dev` (port 4600) · test `npm test` ·
typecheck `npm run typecheck` · build `npm run build` · start `npm start` ·
sync specs `npm run sync:specs`.

Human-facing Claude Code workflows are `/develop-backend
<SPEC-ID-or-JIRA-ID>` and `/fix-backend-bug <BUG-JIRA-ID> [SPEC-ID]`. Their
skills under `.claude/skills/` use `docs/agent-workflows/` and run the lower-level
commands above internally.

For spec-driven work, first read `handoffs/README.md` and the matching inbound
handoff. Never implement a dirty `DRAFT` as complete. Sync the handoff's exact
commit, run `npm run handoff:validate`, and maintain the backend receipt in
`handoffs/outbox/receipts/` through `IN_PROGRESS`/`BLOCKED`/`COMPLETE`.

Auth is a stub: identity comes from `x-agent-id` (see
`src/data/registry.ts`: A1001 P4 agent · A1002 EMPTY demo · A1003 PROCESSING
demo · L2001 P3 leader · L3001 P2 leader). Gating rules (403 INS-4031/4032)
are real and tested — never remove them to "make something work".

## MongoDB Atlas (Mongo mode)

Mongo-backed Performance uses only `my_production`, `my_mapa`, `my_persistency`
across two databases on the same cluster/credentials: `pa_performance_PAMB-dev`
(INSURANCE and ALL/Hybrid) and `pa_performance_PBTB-dev` (TAKAFUL) — routed by
`businessLine`, SPEC-2026-002 0.4.0-draft development profile. Old collection
mappings are removed. Read `docs/performance-direct-source.md` before source work.
`db:setup` provisions the three source schemas; `db:seed` delegates to the guarded
file importer. Static catalogue/config and temporary preferences remain; missing
support data is not fabricated. Contest runtime/storage stays independent.

Mongo identity requires explicit allowlist + `x-agent-id`; existing A1001/L3001
personas above are for offline regression fixtures only. Tests select memory mode
explicitly. Source mode never falls back to synthetic or old Mongo data. Credentials,
local allowlists and raw records must not be committed. No production-ready claim
may be made from the still-Draft Spec work item.
