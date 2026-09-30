# Agent handoff protocol (retired)

> **Retired — historical and non-blocking.** Specs (`pa-spec-dev`, vendored in
> `vendor/spec/`) are reference material, not gates. No READY/approval/handoff/
> receipt status is needed to implement, change or ship behavior. Existing
> handoff and receipt files are kept as history only; the protocol below
> describes how they were used and is no longer required.

Agents previously communicated through committed JSON artifacts. `handoffId`
was the correlation key across all three repositories.

Handoffs could carry `specId` and `jiraId`; bug receipts could carry
`bugJiraId` and `defectClassification`. `/develop-backend` and
`/fix-backend-bug` remain the human-facing commands and do not require any
handoff or receipt.

## Folder ownership (historical)

- `PruactionSpec/handoffs/outbound/` — spec agent publishes handoffs.
- `PruactionSpec/handoffs/receipts/backend|frontend/` — application receipts.
- `PruactionBackend/handoffs/inbox/spec/` — immutable inbound spec handoffs.
- `PruactionBackend/handoffs/outbox/receipts/` — backend receipts.
- `PruactionWeb/handoffs/inbox/spec/` — immutable inbound spec handoffs.
- `PruactionWeb/handoffs/outbox/receipts/` — frontend receipts.

Schemas live under each repository's `handoffs/schemas/` for reference.

## Former lifecycle (historical, not required)

1. Spec agent writes `DRAFT` while its worktree is dirty (`commit: null`).
2. Spec agent commits contracts, replaces the commit with the full 40-character
   hash, sets `dirty: false`, and promotes the handoff to `READY`. From the Spec
   repo, `npm run handoff:promote -- <draft-file>` performs these checks and
   renames `.draft.json` to `.ready.json`; commit the promoted handoff next.
3. Application agents sync exactly that commit with
   `SPEC_REF=<handoff.spec.commit> HANDOFF_REF=<commit-containing-ready-handoff>
   npm run sync:specs` and run `npm run handoff:validate`. The two revisions are
   separate because a handoff cannot contain its own Git commit hash.
4. Application agents may initialize/refresh a receipt with
   `npm run handoff:receipt -- <handoff-file>`; this records Git state but never
   fabricates validation evidence or a completion status.
5. Application agents implement only their declared actions and publish an
   `IN_PROGRESS`, `BLOCKED`, or `COMPLETE` receipt.
6. `COMPLETE` requires immutable spec/application commits, no dirty worktree,
   passing evidence, operation/AC coverage, migration evidence, and no gaps.
7. Receipts are copied or submitted back to the matching Spec receipt folder.

The related scripts (`scripts/validate-handoffs.mjs`,
`scripts/create-handoff-receipt.mjs`, `scripts/test-handoff-e2e.sh`) are retired
and kept for history; they are not wired to npm scripts and gate nothing.