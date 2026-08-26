# Agent handoff protocol

Agents communicate through committed JSON artifacts, not ephemeral chat or
concurrent cross-repository edits. `handoffId` is the correlation key across all
three repositories.

New handoffs may also carry `specId` and `jiraId`; bug receipts may carry
`bugJiraId` and `defectClassification`. Use `/develop-backend` and
`/fix-backend-bug` as the human-facing commands. Agents execute the npm lifecycle
steps below internally; all immutable revision and completion rules remain.

## Folder ownership

- `PruactionSpec/handoffs/outbound/` — spec agent publishes handoffs.
- `PruactionSpec/handoffs/receipts/backend|frontend/` — application receipts.
- `PruactionBackend/handoffs/inbox/spec/` — immutable inbound spec handoffs.
- `PruactionBackend/handoffs/outbox/receipts/` — backend receipts.
- `PruactionWeb/handoffs/inbox/spec/` — immutable inbound spec handoffs.
- `PruactionWeb/handoffs/outbox/receipts/` — frontend receipts.

Schemas live under each repository's `handoffs/schemas/` so every agent can
validate locally without reaching into another worktree.

## Lifecycle

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

Never promote dirty work to `READY`/`COMPLETE`, use a mutable branch name as the
recorded revision, or edit vendored contracts to satisfy application code.

The backend repository owns the cross-repository regression test:
`npm run handoff:test`. It creates temporary Spec/application clones and verifies
the two-commit publish/sync/correlation flow without modifying real worktrees.