# AGENTS.md — pruaction-insights-service

## Source of truth
1. `vendor/spec/insights.v1.yaml` (spec repo `pruaction-spec`, see SPEC_VERSION)
2. `src/types.ts` — hand-mirrored contract types; change only with a spec bump
3. `test/service.test.ts` — behavior lock (24 cases map to spec AC ids)

## Spec-agent handoff
- Preferred human commands are `/develop-backend <SPEC-ID-or-JIRA-ID>` and
  `/fix-backend-bug <BUG-JIRA-ID> [SPEC-ID]` in Copilot or Claude Code. Agents
  resolve `PruactionSpec/work-items`, then run sync/validation/receipt npm
  automation internally. One Jira may map to multiple specs; never guess among
  them.
- Inbound instructions live in `handoffs/inbox/spec/`; never edit them. The spec
  agent owns `PruactionSpec/handoffs/outbound/`.
- Consume only a `READY` handoff pinned to a full commit. Sync with
  `SPEC_REF=<handoff.spec.commit> HANDOFF_REF=<handoff-publication-commit>
  npm run sync:specs`; `vendor/spec/SPEC_COMMIT` must match the handoff before
  implementation starts, while `HANDOFF_COMMIT` records its publication.
- A `DRAFT` handoff is for planning only. Do not claim contract implementation
  complete or migrate production data against it.
- Implement only `consumers.backend.requiredActions`. Missing/contradictory
  requirements become a `BLOCKED` receipt and a spec change, never invented code.
- Bug work must first classify and localize the first contract divergence as
  `IMPLEMENTATION_DEFECT`, `TEST_DEFECT`, `DATA_DEFECT`,
  `CONFIGURATION_DEFECT`, `SPEC_DEFECT`, `NEW_REQUIREMENT`, or `UNKNOWN`.
  Spec defects and new requirements require `/update-spec` before behavior
  changes; regression tests name both the governing AC and bug Jira ID.
- Update the matching file in `handoffs/outbox/receipts/` with commands, OpenAPI
  operation evidence, AC evidence, migrations, and gaps. Run
  `npm run handoff:validate` before every handoff/receipt commit.
- `COMPLETE` is allowed only after both spec and backend work are committed,
  `dirty=false`, all required ACs are covered, validation passes, and gaps are
  empty. Copy the final receipt to `PruactionSpec/handoffs/receipts/backend/`.

## Rules
- Response field names/shapes come from the OpenAPI **verbatim**. Never add
  fields, params, or endpoints beyond it (debug/* routes are the only marked
  exception). Need one → propose a spec PR first.
- Money is a **decimal string**; all arithmetic via `src/lib/money.ts`
  (integer cents). `parseFloat` on money is a review-reject.
- Sentiment/direction derive from catalog `favourability` (D-05); change
  rendering fields follow `changeDisplay` (D-10). Both live in
  `src/data/catalog.ts`, which mirrors the spec's Mongo seed §4 — keep them
  in lockstep.
- Gating (D-14): scope=TEAM ⇒ leader; teamView=GROUP ⇒ P2 (403 INS-4031).
  SCHEME composition is an OQ-20 placeholder — flagged in catalog.ts; don't
  extend it without a ruling.
- Every behavior change lands with a test; run `npm test` and
  `npm run typecheck` before finishing. Keep stub values deterministic
  (rational multipliers, no Math.random / Date.now in payload values).

## Definition of done
Tests green · typecheck green · `npm run build && npm start` boots ·
new/changed routes exercised in `test/service.test.ts` with the relevant
Problem codes asserted · inbound handoff validated · backend receipt updated.

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
