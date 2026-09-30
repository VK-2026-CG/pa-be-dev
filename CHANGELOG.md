# Changelog

## 2026-09-30
- Replaced READY-handoff development requirements with direct sync from the
  canonical spec working tree; changelog and application checks remain the local
  development record.
- Validation: `npm run sync:specs` passed; tests/typecheck/build could not run
  because this checkout has no `node_modules` (`vitest` unavailable).