# Backend development workflow

Invocation: `/develop-backend <spec-id-or-jira-id> [context]`

1. Locate the accessible `pa-spec-dev` workspace and relevant canonical API,
   data and behavior contracts. If supplied context maps to multiple plausible
   specs, list them and ask the user to choose.
2. Read all linked canonical contracts and `AGENTS.md`. Handoff state and
   publication commits are not prerequisites for development. Clarify genuinely
   missing or contradictory contract behavior in the spec.
3. Read this repository's instructions, architecture, relevant code and tests.
   Inventory reuse and present a concise implementation plan.
4. Run `npm run sync:specs` when vendored contracts need refresh. Never hand-edit
   generated vendored contracts.
5. Implement the requested behavior against the canonical spec. Clarify gaps in
   the spec rather than inventing API fields, routes or business rules.
6. Add tests named with every affected AC ID. Preserve money, country isolation,
   deterministic data and other repository invariants.
7. Run relevant tests during development and the full required test, typecheck,
   build and boot checks. Update `CHANGELOG.md` with meaningful changes and
   checks actually run.
8. Report changed files, operation and AC coverage, migrations, validation,
   gaps and anything not verified.