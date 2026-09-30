# pruaction-insights-service + contest configurator backend

Fastify implementation of the PRUAction **Insights domain API**
(`insights/v1`) with direct reads from **three Performance Mongo collections**.
Contract: `vendor/spec/insights.v1.yaml` (v1.4.0, pinned by
`vendor/spec/INSIGHTS_CONTRACT_COMMIT`). See [the direct-source guide](docs/performance-direct-source.md).
The previous Performance Mongo read-model adapter and seed mappings are removed.

## Agent workflow

With `PruactionSpec` added to the VS Code workspace or accessible to Claude Code,
use the same commands in Copilot or Claude:

```text
/develop-backend PRU-1234-SP01
/fix-backend-bug PRU-5681 PRU-1234-SP01
```

The agent resolves the ID entrypoint and canonical Markdown/OpenAPI files, runs
spec synchronization, validation, receipts, tests and builds internally, and
reports AC evidence. A bug command traces the symptom across UI, BFF, backend,
data and configuration; it does not assume this repository owns the defect.
Missing or changed expected behavior is routed through `/update-spec` rather
than invented locally. See `docs/agent-workflows/`.

## Quick start
```bash
npm install
npm run dev          # http://localhost:4600
npm run dev:mock     # same port, offline stub data — no Mongo, no .env needed
npm test             # 24 integration tests (fastify.inject)
npm run typecheck
npm run build && npm start
```

## Mock mode (no DB)

`npm run dev:mock` is a test/fixture-only profile: it starts the watch server
with `INSIGHTS_DATA_SOURCE=memory` (overriding any local `.env`), so every
persona × scope × teamView × period × businessLine × basis returns the
deterministic stub data from `src/data/values.ts`. Pair it with the frontend's
`npm run dev:mock`, which drives persona from the header dropdown (`x-persona`).
Entitlement guards are unchanged (TEAM ⇒ leader, GROUP ⇒ P2). The in-memory
source is test-only, fails outside `NODE_ENV=test`, and is never a runtime fallback.

**MongoDB source mode:** run `npm run dev` with
`INSIGHTS_DATA_SOURCE=performance` and `NODE_ENV=development`. Runtime responses
are not filled from fixtures or synthetic fallback helpers. Missing metrics stay
EMPTY, absent history is represented by null points, support collections remain
Fixtures are available only by explicitly selecting `INSIGHTS_DATA_SOURCE=memory`
under `NODE_ENV=test`.

## Identity (development only, not production JWT)

Mongo mode requires an explicit `x-agent-id` from the configured mock allowlist
for both domain and BFF requests. It never aliases imported identities to old
personas or merges agents across files. The following identities apply **only to
the isolated offline regression fixture engine**, not the Mongo API:

| agentId | level | purpose |
|---|---|---|
| A1001 | P4 agent | happy path |
| A1002 | P4 | every metric detail returns `dataState: EMPTY` |
| A1003 | P4 | every metric detail returns `dataState: PROCESSING` |
| L2001 | P3 leader | TEAM scope, DIRECT only (GROUP → 403 INS-4031) |
| L3001 | P2 leader | TEAM scope, DIRECT + GROUP |

## Endpoints (all under `/insights/v1`)
`GET /agents/:agentId/metrics` (listScope, codes, period, businessLine,
basis, scope, teamView) · `GET /agents/:agentId/metrics/:metricCode` ·
`GET /agents/:agentId/metrics/:metricCode/series` (anchorYear, yearsBack 0–4)
· `GET /agents/:agentId/milestones` · `GET /metric-definitions` ·
`GET|PUT /agents/:agentId/metric-preferences?scope=` ·
`GET /agents/:agentId/recommendations` ·
`POST /agents/:agentId/recommendations/:id/feedback` ·
`GET /healthz` · `GET /insights/v1/debug/*` (non-contract helpers).

## Contest Administration (`/contests/v1`)

The governed Contest API is defined verbatim by `vendor/spec/contests.v1.yaml`.
The obsolete ungoverned `/v1` Contest API has been removed. Development identity
uses `x-agent-id` and `x-tenant`; `x-tenant` must match deployment-owned
`COUNTRY_CODE` or the request is denied with `CON-4031`.

Contest PDF brochure upload/import is temporarily capped at **10 MiB**
(`10,485,760` bytes). `CONTEST_BROCHURE_MAX_BYTES` may lower this deployment
limit, but the service hard ceiling remains 10 MiB.

Contest creation does not accept a country. Country comes from `COUNTRY_CODE`
and the authenticated principal. Historic archive/reactivation, PDF
upload/streaming and brochure-to-draft import are implemented under the same
namespace.
Reusable rules use
`POST /rules`, `GET|PATCH /rule-versions/:ruleVersionId`, and
`POST /rule-versions/:ruleVersionId/validate`; rule identity and versioned
expressions are stored separately in `rule_definitions` and `rule_versions`.

Six Malaysia 2026 circular configurations are shipped as validated DRAFT seed
documents in `vendor/spec/imported-contests.my-2026.json`. In memory mode the
application repository factory loads them automatically; direct repository
constructors remain empty for isolated tests. To provision/import them in Mongo
mode, use the Contest database independently from Insights storage:

```bash
MONGODB_CONTEST_DB=contests npm run db:setup:contests
npm run db:import:contests -- --dry-run
MONGODB_CONTEST_DB=contests npm run db:import:contests
```

The importer verifies the exact circular codes, source PDF SHA-256 hashes/page
bounds, stable IDs, configuration checksums, catalogue/LOV expressions,
citations, periods and DRAFT statuses before opening one Mongo transaction. It
is idempotent and will not overwrite a non-DRAFT stable version. Import does
not submit, approve, or publish any contest.

Draft mutation requires `If-Match: "<resourceVersion>"`.

The former cross-domain synthetic seeder is retired. `db:seed:contests` fails
closed rather than reading deleted Performance mock mappings or pretending these
files are approved Contest inputs. Governed Contest runtime/imports are unchanged.

## Offline regression fixture model (not Mongo mode)
`src/data/values.ts` scales mock-sourced base figures with **rational
multipliers** per dimension (period, business line, scope, teamView, basis),
so every filter combination is stable and visibly distinct — e.g. TPC YTD/ALL
SELF = RM 100,000 → INSURANCE 80,000 + TAKAFUL 20,000; TEAM×3; GROUP×2.2;
SCHEME×0.5 with a re-composed catalog and goals SET (OQ-20 placeholder).

## MongoDB Atlas (Mongo mode)

Mongo mode reads only `my_production`, `my_mapa`, `my_persistency` in
`pa_performance_PAMB-dev`. It requires NODE_ENV development/test, MY deployment,
the exact configured database and an explicit development identity allowlist.
No legacy Mongo adapter remains. Static catalogue/config and temporary in-memory
preferences are retained; unavailable milestones/recommendations/history are not fabricated.

Resident records need **no import or reseed**. The database defaults to
`pa_performance_PAMB-dev`; `MONGODB_PERFORMANCE_URI` may supply an independent
read-only connection without changing Contest. Exact source paths, BSON numeric
compatibility, metadata checks and no-record 404 behavior are documented in the
direct-source guide. Development authorization guards remain in place.

`db:setup` provisions only these three schemas and indexes. `db:seed` is an alias
for `db:import:performance`: supply all three external file paths, dry-run first,
then `--apply`. It no longer generates data. Existing identical documents are
skipped, conflicts abort and inserts are transactional. Existing database contents
are not deleted. See [configuration/import/API examples](docs/performance-direct-source.md).

Offline tests explicitly select `INSIGHTS_DATA_SOURCE=memory` and need no DB.
Memory is never a fallback after a Mongo error. `.env`, `.env.local` and local
mock identity files are ignored; never commit credentials or raw sample records.

Each country is a physically isolated deployment with its own FE, backend,
MongoDB instance, storage, credentials and hostnames. Within that instance,
`MONGODB_PERFORMANCE_DB` and `MONGODB_CONTEST_DB` are independent. `MONGODB_DB`
remains only for explicit legacy maintenance commands, not Performance requests.
Contest never falls back to the Performance database. Migration and audit commands:

```bash
npm run db:audit:collections
npm run db:migrate:contest-instance              # dry-run
npm run db:migrate:contest-instance -- --apply
npm run db:remove:migrated-contest-source         # guarded dry-run
npm run db:cleanup:legacy                         # guarded dry-run
npm run db:reconcile:contest-data                 # guarded dry-run
```

See [`docs/architecture/country-isolation.md`](docs/architecture/country-isolation.md).

## Spec-driven development

The accessible `pa-spec-dev` working tree is the source of truth. Run
`npm run sync:specs` to refresh `vendor/spec/` directly from its current files,
including uncommitted spec edits. Handoffs and receipts are preserved as
historical records, but do not gate development. Record meaningful backend
changes and checks in [`CHANGELOG.md`](CHANGELOG.md); keep application tests,
typechecks, builds, and runtime safeguards in force.
