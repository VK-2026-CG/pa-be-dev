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

The service has two data sources behind one seam (`src/data/source.ts`):
the deterministic in-memory engine (default — tests/smoke need no DB), and
MongoDB, enabled whenever `MONGODB_URI` is set (a repo-root `.env` is
auto-loaded; see `.env.example`).

One-time setup against your Atlas cluster:

```bash
npm run db:ping    # connectivity check (Atlas Network Access must allow your IP)
npm run db:setup   # creates the C1 collections + $jsonSchema validators + unique indexes
npm run db:seed    # materializes the deterministic engine into Atlas (idempotent upserts)
npm run dev        # boots in Mongo mode: "data source: MongoDB (insights)"
```

`npm run db:seed -- --dry-run` prints document counts without connecting
(972 snapshots, 900 series docs, 10 milestone rows, 13 definitions,
2 milestone ladders, 7 recommendation docs). Document shape: unique keys +
lineage per `pruaction-spec/domains/insights/data/mongodb.md`; the engine's
API-shaped bodies sit under `payload`/`detailPayload` (a production pipeline
would flatten values to Decimal128 per C1 — noted in the seeder header).
In Mongo mode the two service-written aggregates persist to
`metric_preferences` and `recommendation_feedback`. Tests and the app's
`smoke.sh` pin `MONGODB_URI=""` so they always exercise the in-memory engine.
`.env` is gitignored — never commit credentials.
