# pruaction-insights-service + contest configurator backend

Fastify implementation of the PRUAction **Insights domain API**
(`insights/v1`) with deterministic **stub data** — no database. Contract:
`vendor/spec/insights.v1.yaml` (v1.3.0, synced from the `pruaction-spec` repo).

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
npm test             # 24 integration tests (fastify.inject)
npm run typecheck
npm run build && npm start
```

## Identity (stub JWT)
Send `x-agent-id` (default `A1001`). Personas:

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

The synthetic source preserves the five existing Insights agent IDs and creates
12 deterministic 2026 transactions per agent. `db:seed` also materializes these
as the C1 `source_snapshots`, `agent_snapshot_staging`, and
`production_snapshot_staging` collections. Canonical staging excludes names and
all prohibited identity/contact/demographic fields; money is BSON Decimal128.

## Stub-data model
`src/data/values.ts` scales mock-sourced base figures with **rational
multipliers** per dimension (period, business line, scope, teamView, basis),
so every filter combination is stable and visibly distinct — e.g. TPC YTD/ALL
SELF = RM 100,000 → INSURANCE 80,000 + TAKAFUL 20,000; TEAM×3; GROUP×2.2;
SCHEME×0.5 with a re-composed catalog and goals SET (OQ-20 placeholder).

## MongoDB Atlas (Mongo mode)

The service has two data sources behind one seam (`src/data/source.ts`):
the deterministic in-memory engine (default — tests/smoke need no DB), and
MongoDB, enabled whenever `MONGODB_URI` is set (a repo-root `.env` is
auto-loaded; see `.env.example`).

One-time setup against your Atlas cluster:

```bash
npm run db:ping    # connectivity check (Atlas Network Access must allow your IP)
npm run db:setup    # creates Insights collections only
npm run db:setup:contests # creates governed Contest collections in MONGODB_CONTEST_DB
npm run db:seed    # materializes the deterministic engine into Atlas (idempotent upserts)
npm run db:seed:contests # derives a published synthetic contest from existing Mongo agents
npm run dev        # boots in Mongo mode: "data source: MongoDB (insights)"
```

`npm run db:seed -- --dry-run` prints document counts without connecting
(972 snapshots, 900 series docs, 10 milestone rows, 13 definitions,
2 milestone ladders, 7 recommendation docs). Document shape: unique keys +
lineage per `pruaction-spec/domains/insights/data/mongodb.md`; the engine's
API-shaped bodies sit under `payload`/`detailPayload` (a production pipeline
would flatten values to Decimal128 per C1 — noted in the seeder header).
In Mongo mode the two service-written aggregates persist to
`metric_preferences` and `recommendation_feedback`. Tests and the app's
`smoke.sh` pin `MONGODB_URI=""` so they always exercise the in-memory engine.
`.env` is gitignored — never commit credentials.

Each country is a physically isolated deployment with its own FE, backend,
MongoDB instance, storage, credentials and hostnames. Within that instance,
`MONGODB_DB=insights` and `MONGODB_CONTEST_DB=contests` are independent and
Contest never falls back to the Insights database. Migration and audit commands:

```bash
npm run db:audit:collections
npm run db:migrate:contest-instance              # dry-run
npm run db:migrate:contest-instance -- --apply
npm run db:remove:migrated-contest-source         # guarded dry-run
npm run db:cleanup:legacy                         # guarded dry-run
npm run db:reconcile:contest-data                 # guarded dry-run
```

See [`docs/architecture/country-isolation.md`](docs/architecture/country-isolation.md).

## Agent handoffs

Spec and application agents exchange committed, machine-readable artifacts under
[`handoffs/`](handoffs/README.md). Sync immutable contract and instruction
revisions with `SPEC_REF=<contract-commit> HANDOFF_REF=<handoff-commit>
npm run sync:specs`, validate them with
`npm run handoff:validate`, then publish backend evidence under
`handoffs/outbox/receipts/`. A dirty spec handoff remains `DRAFT` and is not an
implementation-complete contract.
