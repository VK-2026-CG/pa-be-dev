# Team Drilldown hierarchy source integration status

## Current status (2026-10-01)

Team Drilldown reads `my_agent_hierarchy` at runtime in Performance source mode
(`PerformanceSource.listTeamMembers` / `findTeamMember`). There is no opt-in flag. The caller's
newest snapshot (PAMB first, PBTB when absent) supplies direct reports via
`subtree.scopeProfileIds`, minus the leader's own ID. Tiers map case-insensitively
(AM→P2/AM, UM*→P3/UM, AGENT→P4/AGENT). Reportees without a snapshot are ID-only
AGENT leaves. TPC/PTPC come from `my_production`. Names stay encrypted and are never
projected; the agent ID is the display name.

The notes below are the original pre-implementation record. They are history,
not gates: the `READY` handoff/approval items they mention are no longer required
(specs are reference material only).

## Original status

The proposed read-only source was
`pa_performance_PAMB-dev.my_agent_hierarchy`. It was **not authorized
for runtime use** by the checked-in Performance source profile. `AGENTS.md`,
`CLAUDE.md`, `README.md`, `docs/performance-direct-source.md`, and the fixed
collection constants currently permit only `my_production`, `my_mapa`, and
`my_persistency`.

No runtime query, collection ownership change, provisioning, import, or fallback
for `my_agent_hierarchy` is implemented until a committed `READY` handoff updates
that source boundary and defines the hierarchy semantics below.

## Intended contract-preserving mapping

The existing `TeamDrilldownVM` remains unchanged:

- `displayRows[].profileId` becomes `member.agentId` and the temporary
  `member.displayName`.
- Approved normalized hierarchy-role fields become `roleCode` and determine the
  requested `hierarchyBasis` (`AGENT`, `AM`, or `UM`).
- `as_on_date` becomes the Team Drilldown `asOfDate` after strict ISO-date
  validation.
- `metrics.combined.tpcValue` and `metrics.combined.ptpcValue` become MONEY cards
  for the selected member.
- Null, missing, malformed, or unsupported metric values become cards with
  `dataState: EMPTY`; `value` is omitted and is never zero-filled.
- MAPA-derived summary metrics remain unavailable until an approved source and
  mapping are supplied.

Encrypted `fullName`, encrypted `leaderName`, vault references, headcount, rank,
and fields not represented by `TeamDrilldownVM` must not be projected, parsed,
logged, or returned.

## Required decisions before implementation

1. Publish a committed `READY` handoff authorizing read-only access to
   `my_agent_hierarchy` and identifying the governing Spec/acceptance criteria.
2. Define the canonical caller/leader lookup field and the exact DIRECT-report
   relationship. A full GROUP subtree must not be presented as DIRECT by guesswork.
3. Confirm the normalized role-to-`AGENT|AM|UM` mapping and handling of unknown
   role values.
4. Verify collection indexes and field distributions read-only against the
   configured MongoDB environment.
5. Define the accepted BSON types and units for TPC/PTPC, including whether the
   values are MYR major units and which reporting period they represent.

## Required runtime safeguards after approval

- Use a strict inclusion projection containing only approved hierarchy IDs,
  relationship/role fields, `as_on_date`, and combined TPC/PTPC values.
- Apply the existing Performance read timeout and sanitize database errors.
- Validate the caller against the configured development identity allowlist.
- Authorize a selected member through the caller's resolved hierarchy scope.
- Return the same sanitized `404 INS-4040` for unknown and out-of-scope member IDs.
- Keep the hierarchy collection outside metric import/provisioning commands; it is
  an independently managed read-only source.