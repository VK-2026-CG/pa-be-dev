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

The requester-approved development profile (SPEC-2026-002) now reads only
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
No production readiness or COMPLETE handoff is implied by live mock verification.

**Dev mock fallback (approved exception, 2026-09-24; widened by requester ruling
2026-09-25).** `INSIGHTS_DEV_MOCK_FALLBACK=true` is the one sanctioned exception
to "no synthetic values in Mongo requests". Off by default; honoured only in
Performance source mode **and** `NODE_ENV=development` (ignored, with a log line,
under test or anything else). Rule: **Mongo first, stub second** — a real value
is never overwritten. It fills, from the stub engine in `src/data/values.ts`:
metric detail parts (`mockFillDetail`), EMPTY metrics in lists, the stub
context when the agent has no Mongo rows (instead of 404), history series,
milestones, recommendations/feedback, and the team roster/member previews
(`src/data/mocks/team-members.ts`) after the real self entry. Every fill logs
`DEV MOCK fallback`. Never enable it in a shared or production-like
environment; any further widening needs a new ruling.
`npm run dev:mock` (`scripts/dev-mock.mjs`) is the shared, credential-free dev
profile: it starts in `INSIGHTS_DATA_SOURCE=memory` with Mongo unset. Memory is a
start-time choice only, never a runtime fallback after a Mongo error.
`.env`, `.env.local`, and local allowlists are ignored — never commit credentials.
