# Backend bug workflow

Invocation: `/fix-backend-bug <bug-jira-id> [spec-id] [context]`

1. Analyze accessible Jira PDF, description, logs, trace IDs, requests,
   responses, screenshots and reproduction steps. Never claim a private Jira URL
   was read when it was only recorded.
2. Resolve the related Spec entrypoint from an explicit Spec ID or from routes,
   operation/AC IDs, fields and terminology. Ask for confirmation when matches
   remain ambiguous.
3. Read the approved version and traceability, then execute
   `bug-localization.md`. Inspect Web/BFF evidence when accessible before
   assuming backend ownership.
4. Reproduce and classify before edits. If evidence is insufficient, return
   `NEEDS_EVIDENCE` with verified facts and prioritized evidence requests.
5. For a clear backend implementation/test/config/data defect, add a regression
   test named `<AC-ID> / <BUG-JIRA-ID>`, make the smallest contract-conforming
   correction and remove temporary diagnostics.
6. Do not change approved behavior for `SPEC_DEFECT` or `NEW_REQUIREMENT`; route
   through `/update-spec` first. Do not weaken auth, country or data safeguards
   as a workaround.
7. Run relevant focused checks, then repository tests, typecheck and build as
   applicable. Record meaningful fixes and checks in `CHANGELOG.md`.
8. Report localization, root cause, fix, regression test, validation and any
   containment/data remediation separately.