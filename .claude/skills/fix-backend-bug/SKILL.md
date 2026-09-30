---
name: fix-backend-bug
description: Investigate, localize, classify and fix a PRUAction backend bug using the specification as reference.
argument-hint: "<bug-jira-id> [spec-id] [context]"
---

Execute `docs/agent-workflows/fix-backend-bug.md` and
`docs/agent-workflows/bug-localization.md`; obey `AGENTS.md`. The request is
`$ARGUMENTS` (`$0` is normally the bug Jira and `$1` the optional Spec ID).
Classify and localize before editing. Do not assume backend ownership merely
because this skill was invoked here.