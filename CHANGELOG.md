# Changelog

## 2026-09-30
- Fixed metric-detail comparison construction (BFF-5020): absent prior rows or null/missing prior metric values now produce a typed zero prior and neutral flat change; genuine zero baselines and prior-read errors retain existing behavior. Added detail/BFF regression coverage.
- Aligned Insights persisted-source metric mapping with the 2026-09-30 observed export: camelCase persistency YTD leaves; corrected hierarchy self-reference detection to fail as a cycle.
- Validation: pending focused source/spec tests and typecheck; unavailable checks will be recorded below.
- Corrected performance source import normalization: preserve numeric BSON reporting days and actual null values; retained exact collection-specific schema names/types.
- Added a read-only, explicitly development/test-opted-in `my_agent_hierarchy` organization reader and `getAgentOrganization` route, including PAMB-first lookup, safe projections, deterministic snapshot selection, and hierarchy error mapping.
- Validation: spec sync and `git diff --check` passed. Backend tests/typecheck were attempted but this checkout has no `node_modules`; handoff validation was intentionally not run because handoffs are historical, not development gates.
- Replaced READY-handoff development requirements with direct sync from the
  canonical spec working tree; changelog and application checks remain the local
  development record.
- Validation: `npm run sync:specs` passed; tests/typecheck/build could not run
  because this checkout has no `node_modules` (`vitest` unavailable).