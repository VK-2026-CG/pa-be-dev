# Backend development workflow

Invocation: `/develop-backend <spec-id-or-jira-id> [context]`

1. Locate an accessible `PruactionSpec` repository. Resolve the exact Spec ID
   from its `work-items/` entrypoints. If a Jira ID has multiple backend specs,
   list them and ask the user to choose.
2. Read the entrypoint, every linked canonical contract and `AGENTS.md`. Verify
   status `READY`, backend is required, no backend-blocking question remains and
   the immutable handoff/spec revisions are consistent. A `DRAFT` permits
   analysis only, never completion or production migration.
3. Read this repository's instructions, architecture, relevant code and tests.
   Inventory reuse and present a concise implementation plan.
4. Run existing sync/handoff automation internally when vendored artifacts are
   needed. Never ask the user to type orchestration npm commands and never edit
   inbound handoffs or vendored contracts.
5. Implement only `consumers.backend.requiredActions`. A missing or conflicting
   contract produces a `BLOCKED` receipt and proposed `/update-spec`, not an
   invented API field, route or business rule.
6. Add tests named with every affected AC ID. Preserve money, country isolation,
   deterministic data and other repository invariants.
7. Run relevant tests during development and the full required test, typecheck,
   build and boot gates before completion. Run handoff validation and update the
   correlated receipt with operation, AC, migration and command evidence.
8. Report changed files, operation and AC coverage, migrations, validation,
   gaps and anything not verified.