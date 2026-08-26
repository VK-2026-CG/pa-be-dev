---
name: develop-backend
description: Implement an approved PRUAction backend specification by Spec ID or Jira ID.
argument-hint: "<spec-id-or-jira-id> [context]"
---

Execute `docs/agent-workflows/develop-backend.md` and obey `AGENTS.md`. The
request is `$ARGUMENTS`. Locate the accessible PruactionSpec repository, resolve
the exact READY spec, implement its backend actions, run internal synchronization
and all validation, and update evidence. Do not stop at a plan when edits are
allowed.