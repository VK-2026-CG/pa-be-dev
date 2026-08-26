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

For contract work, consume only `READY` files in `handoffs/inbox/spec` after
syncing their exact commit. Never modify inbound handoffs or vendored contracts.
Update the correlated backend receipt and run `npm run handoff:validate`.