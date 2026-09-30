# Repository instructions

Read `AGENTS.md` first. The OpenAPI files under `vendor/spec` are verbatim
contracts synced from `PruactionSpec`; do not invent response fields or routes.

Use `/develop-backend <SPEC-ID-or-JIRA-ID>` for approved work and
`/fix-backend-bug <BUG-JIRA-ID> [SPEC-ID]` for defects. The shared workflows in
`docs/agent-workflows/` resolve an accessible Spec workspace, run lifecycle npm
automation internally, and localize bugs across frontend, BFF, backend, data and
configuration before editing.

Contest is `/contests/v1` only. Never reintroduce the obsolete `/v1` Contest API
or its query/catalogue repositories. One backend deployment serves one
`COUNTRY_CODE`; request-selected country/database routing and Insights/Contest
database fallbacks are forbidden. Run `npm test`, `npm run typecheck`, and
`npm run build` for behavioral changes.

For contract work, read the canonical files in the accessible `pa-spec-dev`
working tree and run `npm run sync:specs` as needed. Handoff status and receipts
are not development gates. Do not hand-edit generated vendored contracts; edit
the spec source, sync it, and record meaningful changes in `CHANGELOG.md`.