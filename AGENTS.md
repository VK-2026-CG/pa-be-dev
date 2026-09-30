# AGENTS.md — pruaction-insights-service

## Key references
1. `vendor/spec/insights.v1.yaml` (spec repo `pa-spec-dev`, see SPEC_VERSION) — reference contract
2. `src/types.ts` — hand-mirrored API types; keep in step with the implemented API
3. `test/service.test.ts` — behavior regression suite (cases map to spec AC ids)

## Specs are reference material
- Specs (`pa-spec-dev`, vendored in `vendor/spec/`) are reference material —
  requirements, contracts, copy and designs to consult and trace against. They
  do not gate work. No READY/approval/handoff/receipt status is needed to
  implement, change or ship behavior. `npm run sync:specs` refreshes the
  vendored copy (including uncommitted edits).
- When code and spec differ, decide on the merits; update the spec afterwards
  if it helps others. Use spec IDs/ACs for traceability where available.
- Security, authorization, data-privacy and environment safeguards are
  engineering rules independent of the spec and still apply.
- Bug work must first classify and localize the first contract divergence as
  `IMPLEMENTATION_DEFECT`, `TEST_DEFECT`, `DATA_DEFECT`,
  `CONFIGURATION_DEFECT`, `SPEC_DEFECT`, `NEW_REQUIREMENT`, or `UNKNOWN`.
  The classification is for traceability; fix in code and optionally update
  the spec. Regression tests name the related AC (if any) and bug Jira ID.
- Record meaningful backend changes in the root `CHANGELOG.md`.

## Rules
- Response field names/shapes mirror the OpenAPI, which clients consume.
  Adding or renaming fields, params or endpoints is fine when needed; treat
  renames/removals as breaking API changes and update the spec afterwards if
  it helps others.
- Money is a **decimal string**; all arithmetic via `src/lib/money.ts`
  (integer cents). `parseFloat` on money is a review-reject.
- Sentiment/direction derive from catalog `favourability` (D-05); change
  rendering fields follow `changeDisplay` (D-10). Both live in
  `src/data/catalog.ts`, which mirrors the spec's Mongo seed §4 (reference;
  note divergences in the changelog).
- Gating (D-14): scope=TEAM ⇒ leader; teamView=GROUP ⇒ P2 (403 INS-4031).
  SCHEME composition is an OQ-20 placeholder — flagged in catalog.ts; extend
  it deliberately and note the change.
- Every behavior change lands with a test; run `npm test` and
  `npm run typecheck` before finishing. Keep stub values deterministic
  (rational multipliers, no Math.random / Date.now in payload values).

## Definition of done
Tests green · typecheck green · `npm run build && npm start` boots ·
new/changed routes exercised in `test/service.test.ts` with the relevant
Problem codes asserted · changelog updated.

## MongoDB Atlas (Mongo mode)

The development profile (SPEC-2026-002) now reads only
`my_production`, `my_mapa`, and `my_persistency` in `pa_performance_PAMB-dev`.
The legacy Performance Mongo adapter/constants/seeder have been removed. Never
reintroduce a fallback to old collections or synthetic values in Mongo requests.
Use `docs/performance-direct-source.md` for exact mapping, privacy and configuration.

`db:setup` provisions only the three source schemas; `db:import:performance`
(also `db:seed`) imports explicit files, dry-run by default and insert-only on
`--apply`. No raw personal data is vendored. Preferences are temporary memory;
missing support data is empty. Contest runtime/storage remains independent.

Tests explicitly select `INSIGHTS_DATA_SOURCE=memory`, `MONGODB_URI=""` and
`NODE_ENV=test`; this preserves offline regression fixtures, not old DB mappings.
Source mode is development/test only and requires a configured identity allowlist.
Live mock verification is not evidence of production behavior.

**Dev mock fallback (added 2026-09-24; widened 2026-09-25).**
`INSIGHTS_DEV_MOCK_FALLBACK=true` is the one sanctioned exception to "no
synthetic values in Mongo requests". Off by default; honoured only in
Performance source mode **and** `NODE_ENV=development` (ignored, with a log line,
under test or anything else). Rule: **Mongo first, stub second** — a real value
is never overwritten. It fills, from the stub engine in `src/data/values.ts`:
metric detail parts (`mockFillDetail`), EMPTY metrics in lists, the stub
context when the agent has no Mongo rows (instead of 404), history series,
milestones, recommendations/feedback, and the team roster/member previews
(`src/data/mocks/team-members.ts`) after the real self entry. Every fill logs
`DEV MOCK fallback`. Never enable it in a shared or production-like
environment; keep any further widening dev-only.
`npm run dev:mock` (`scripts/dev-mock.mjs`) is the shared, credential-free dev
profile: it starts in `INSIGHTS_DATA_SOURCE=memory` with Mongo unset. Memory is a
start-time choice only, never a runtime fallback after a Mongo error.
`.env`, `.env.local`, and local allowlists are ignored — never commit credentials.
