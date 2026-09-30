# Backend bug workflow

Invocation: `/fix-backend-bug <bug-jira-id> [spec-id] [context]`

1. Analyze accessible Jira PDF, description, logs, trace IDs, requests,
   responses, screenshots and reproduction steps. Never claim a private Jira URL
   was read when it was only recorded.
2. Resolve the related Spec entrypoint from an explicit Spec ID or from routes,
   operation/AC IDs, fields and terminology. Ask for confirmation when matches
   remain ambiguous.
3. Read the related spec and traceability as reference, then execute
   `bug-localization.md`. Inspect Web/BFF evidence when accessible before
   assuming backend ownership.
4. Reproduce and classify before edits. If evidence is insufficient, return
   `NEEDS_EVIDENCE` with verified facts and prioritized evidence requests.
5. For a backend defect, add a regression test named `<AC-ID> / <BUG-JIRA-ID>`,
   make the smallest correct fix and remove temporary diagnostics.
6. For `SPEC_DEFECT` or `NEW_REQUIREMENT`, fix in code on the merits and
   optionally update the spec afterwards. Do not weaken auth, country or data
   safeguards as a workaround.
7. Run relevant focused checks, then repository tests, typecheck and build as
   applicable. Record meaningful fixes and checks in `CHANGELOG.md`.
8. Report localization, root cause, fix, regression test, validation and any
   containment/data remediation separately.