# Monthly history source (ARVIJ-1450, Team Historical Data)

Backs `GET /insights/v1/agents/{agentId}/monthly-history` (operationId `getAgentMonthlyHistory`) and,
through it, `GET /api/bff/v1/performance/historical-data` (S-P4-03 v2.0.0). Implementation:
`PerformanceSource.monthlyHistory` (Mongo), `src/data/monthly-history.ts` (mapping, selection, assembly),
`src/data/mocks/monthly-history.ts` (offline memory stub). Tests: `test/monthly-history-source.test.ts`,
`test/monthly-history-domain.test.ts`, `test/bff-historical-data.test.ts`.

## What is read

Read-only `find`, four reads per request run in parallel:

| Database | Collection |
|---|---|
| `pa_performance_PAMB-dev` | `my_production`, `my_mapa` |
| `pa_performance_PBTB-dev` | `my_production`, `my_mapa` |

`my_persistency` is not read (persistency is YTD-only, there is no MTD leaf) and neither is
`my_agent_hierarchy` (identity resolution is the existing, separate lookup).

Filter per read: `agentId` = the agent, `entity` = the database key literal (`'PAMB'` in the PAMB
database, `'PBTB'` in PBTB), `period.year` in `[from.year, to.year]`, `agentAggregation` only when the
request names one, and `caseStatus: 'Collected'` for `my_production` only (as the dashboard's `latest()`).
Months are filtered in code: `period.yyyymm` is spelled `"202401"` in one collection and `"2025-01"` in
another, so it is never used. Each read has `maxTimeMS = PERFORMANCE_READ_TIMEOUT_MS` (30 s) and one
retry for a transient connection error (`withRetry`); nothing is cached.

There is **no aggregation fallback**: the dashboard falls back to "any row" when the requested
aggregation is absent, this read does not. A month with no row for the requested aggregation has no record.
There is no cross-source arithmetic either: PAMB and PBTB records are returned side by side and the BFF
picks one (INSURANCE and ALL read PAMB, TAKAFUL reads PBTB; the dashboard's interim `entityFor` rule).

## Which row counts (decision D2)

Several rows can exist for one (collection, source, month, aggregation) (re-runs, intra-month snapshots).
The monthly value is the `ptd.<metric>.mtd` of exactly one of them, chosen in this order:

1. a row flagged month-end (`isMonthEnd`, a String in the source: `/^(y|yes|true|1)$/i` is true; null or
   anything else is false);
2. else the greatest declared as-on day (`period.asOnMonthDay`); a row that declares none ranks below one that does;
3. else the greatest `asOnDate`;
4. else the greatest `id`, then the greatest `_id` (the read sorts `period.year, period.month, id desc, _id desc`,
   the same tie-break as `latest()`; the selection is stable).

`period.asOnMonthDay` is accepted as a BSON Int, a UTC Date (production stores a full date whose year and month
must agree with the period) or a numeric string, exactly as `performanceRecordMetadata` validates it.

`asOnDate` on the returned part is the as-on date **inside the month**: the period's year-month with the declared
as-on day (`period.asOnMonthDay`), or the month's last day when no day is declared. It is never the load
watermark: the row's own `asOnDate` is the pipeline run date (in the dev cluster 2026-09-29/30 for rows of 2025) and
is used only as the third D2 tie-break, then discarded. This is the same rule as the dashboard's
AC-PA-DIRECT-29 (the as-of date is the period end date, never the watermark). The BFF `meta.asOfDate` is the newest
part `asOnDate` of the chosen source, so it is an in-month date too (e.g. `2025-07-12`).

`monthEnd` on the returned part is true when the selected row is flagged month-end **or** its declared as-on
day is the last day of the month. A partial (still running) month therefore reports `monthEnd: false`.
The exact `isMonthEnd` spelling is pending data-owner confirmation (open question); the tolerant check above
covers the plausible ones.

## Field mapping

Reuses `PERFORMANCE_METRIC_MAPPING` (the same table as the dashboard), MTD leaf, values through
`sourceMetricScalar` (Decimal128/Long/Double/Int32 and numeric text are handled exactly; money never goes
through Number). A null, missing or invalid value is `value: null`, never zero-filled. Zero stays zero.

| Collection | `metricCode` (`variant`) | Source path |
|---|---|---|
| `my_production` | `TPC` (`WITHOUT_REPRICING`) | `ptd.tpc.withoutRepricing.mtd` |
| | `TPC` (`WITH_REPRICING`) | `ptd.tpc.withRepricing.mtd` |
| | `PTPC` (`WITHOUT_REPRICING`) | `ptd.ptpc.withoutRepricing.mtd` |
| | `PTPC` (`WITH_REPRICING`) | `ptd.ptpc.withRepricing.mtd` |
| | `FYP` | `ptd.fyp.mtd` |
| | `FYC` | `ptd.fyc.mtd` |
| | `CASE_COUNT` | `ptd.caseCount.total.mtd` |
| `my_mapa` | `MANPOWER` | `ptd.manpowerTotal.mtd` |
| | `ACTIVITY_RATIO` | `ptd.activityRatio.mtd` |
| | `PRODUCTIVITY` | `ptd.productivity.mtd` |
| | `AVERAGE_CASE_SIZE` | `ptd.averageCaseSize.mtd` |
| | `NEW_RECRUIT_CONTRACTED` | `ptd.newRecruits.mtd` |

Output (`asOnDate` as described above): one `MonthlyHistoryRecord` per (period, source, aggregation) that has a row in either collection,
ascending by period, then source (PAMB, PBTB), then aggregation (Personal, DirectUnit, Group); `production`
and `mapa` are `null` when that collection has no row. The PBTB database may have no `my_mapa` rows at all:
its records then have `mapa: null` and the MAPA metrics are N/A in the BFF.

A row whose `period`/`asOnDate` metadata is malformed, or whose `agentAggregation` is not one of the three
values, is dropped from the result and counted in the log line (`skipped=N`, no content). One corrupt old
month must not take down a 48-month screen; the dashboard's stricter "bad selected metadata is a service
error" rule stays in force for the latest-period reads.

## Limits and errors

`from`/`to`: `YYYY-MM`, `from <= to`, at most 48 months (`400 INS-4000`, problem+json). Unknown `aggregation`
is `400 INS-4000`. Identity follows the `series` route (`x-agent-id`; in source mode `ownIdentityOnly`: a caller
reads only its own `agentId`, `403 INS-4030` otherwise). A failed read is `503 INS-5030` whose title carries only
the sanitized category (`timeout`, `network`, `authentication`, `other`); driver messages, hosts and URIs are
never returned or logged. An agent with no rows gets `200` with `records: []`.

## Privacy

Projection whitelist: `period`, `asOnDate` (watermark, tie-break only; not returned), `isMonthEnd`, `agentAggregation`, `ptd`, `id` (`_id` excluded).
No names, vault references, agent codes or other identifiers leave Mongo, and none are in the response (the
response repeats only the caller's own `agentId` from the path). Logs carry database/collection names, row
counts and error categories only: no agent codes, money amounts or record content.

## Recommended index (not applied)

The source collections carry only the `_id` index, so every read is a collection scan filtered by `agentId`.
Four reads per request makes that visible on a populated cluster. Recommended for each of `my_production` and
`my_mapa` in both databases, to be created by the data owner (this change does **not** touch `db:setup` and
nothing here creates it):

```js
db.my_production.createIndex({ agentId: 1, entity: 1, 'period.year': 1, 'period.month': 1 })
db.my_mapa.createIndex({ agentId: 1, entity: 1, 'period.year': 1, 'period.month': 1 })
```

The read's filter prefix (`agentId`, `entity`, `period.year` range) and its sort (`period.year`, `period.month`)
match that key; `id`/`_id` only break ties inside one month.

## Offline stub

`INSIGHTS_DATA_SOURCE=memory` (tests only) serves a deterministic stub: 2023-01..2026-06 closed months (asOn =
last day, month-end) plus a partial 2026-07 (asOn 2026-07-27); later months have no row. Both databases, all
three aggregations and both collections; PBTB is one fifth of PAMB, DirectUnit three times and Group 33/5 of
Personal. No randomness and no clock. The EMPTY/PROCESSING demo agents have no rows.

## Desktop Total row (BFF, AC-P4-03-32)

`HistoricalDataVM.totals` is composed in the BFF from the same monthly values (no extra read), only for metrics whose
config entry has `total: true` (TPC both variants, CASE_COUNT, NEW_RECRUIT_CONTRACTED). Like-for-like YTD: for each
year the sum covers only the months in which the anchor year has a value; a year lacking a value for any of those
months has a null total (never a partial sum). The LAST_YEAR / LAST_2_YEARS changes compare total(A) with the like-for-like total of A-1 / A-2; the LAST_MONTH column of the Total row is always null (a month-over-month change of a total is undefined).

Row changes follow the user story (Jira AC7/AC8/AC9; requester decision "go as per the user story", 2026-10-01): Current Year is month-over-month (`LAST_MONTH`, January against the previous December), Vs Last Year and Vs Last 2 Years compare the same month of the previous year(s). The single 48-month read covers all bases.

## Self scope (same screen)

`GET /api/bff/v1/performance/historical-data?scope=SELF` reads the `Personal` aggregation (`aggregation=Personal` on the
domain read, so the query filters `agentAggregation: 'Personal'`) for the caller's own agent; any persona may call it. Its
metric list comes from `screens.historicalData.self` (TPC both variants, CASE_COUNT, FYP, FYC, all with a Total row). The
VM `context` has no `teamView`. Everything else (source database by `businessLine`, anchor year, change rules, totals)
is identical to TEAM.
