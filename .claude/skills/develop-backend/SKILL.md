---
name: develop-backend
description: Implement a PRUAction backend feature by Spec ID or Jira ID, using the spec as reference.
argument-hint: "<spec-id-or-jira-id> [context]"
---

Execute `docs/agent-workflows/develop-backend.md` and obey `AGENTS.md`. The
request is `$ARGUMENTS`. Locate the accessible PruactionSpec repository, read
the related spec as reference (no READY/approval status is required), implement
the backend behavior, run internal synchronization and all validation, and
update evidence. Do not stop at a plan when edits are allowed.