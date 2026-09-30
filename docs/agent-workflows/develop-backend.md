# Backend development workflow

Invocation: `/develop-backend <spec-id-or-jira-id> [context]`

1. Locate the accessible `pa-spec-dev` workspace and relevant canonical API,
   data and behavior contracts. If supplied context maps to multiple plausible
   specs, list them and ask the user to choose.
2. Read the linked spec contracts and `AGENTS.md`. Specs are reference
   material, not gates: no READY/approval/handoff/receipt status is needed to
   implement, change or ship behavior.
3. Read this repository's instructions, architecture, relevant code and tests.
   Inventory reuse and present a concise implementation plan.
4. Run `npm run sync:specs` when vendored contracts need refresh. Never hand-edit
   generated vendored contracts.
5. Implement the requested behavior, tracing against the spec. Where code and
   spec differ or the spec has gaps, decide on the merits; update the spec
   afterwards if it helps others.
6. Add tests named with every affected AC ID. Preserve money, country isolation,
   deterministic data and other repository invariants.
7. Run relevant tests during development and the full required test, typecheck,
   build and boot checks. Update `CHANGELOG.md` with meaningful changes and
   checks actually run.
8. Report changed files, operation and AC coverage, migrations, validation,
   gaps and anything not verified.