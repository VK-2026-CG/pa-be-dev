# Repository instructions

Read `AGENTS.md` first. The OpenAPI files under `vendor/spec` are reference
contracts synced from `pa-spec-dev`; consult them, but they do not gate work.

Use `/develop-backend <SPEC-ID-or-JIRA-ID>` for feature work and
`/fix-backend-bug <BUG-JIRA-ID> [SPEC-ID]` for defects. The shared workflows in
`docs/agent-workflows/` resolve an accessible Spec workspace, run lifecycle npm
automation internally, and localize bugs across frontend, BFF, backend, data and
configuration before editing.

Contest is `/contests/v1` only. Never reintroduce the obsolete `/v1` Contest API
or its query/catalogue repositories. One backend deployment serves one
`COUNTRY_CODE`; request-selected country/database routing and Insights/Contest
database fallbacks are forbidden. Run `npm test`, `npm run typecheck`, and
`npm run build` for behavioral changes.

Specs are reference material — requirements, contracts, copy and designs to
consult and trace against. No READY/approval/handoff/receipt status is needed to
implement, change or ship behavior; when code and spec differ, decide on the
merits and update the spec afterwards if it helps others. Security,
authorization, data-privacy and environment safeguards still apply. Refresh
`vendor/spec/` with `npm run sync:specs` rather than hand-editing it, and record
meaningful changes in `CHANGELOG.md`.