# Performance direct-source Mongo development guide

## Scope and safety

Requester-approved development work under SPEC-2026-002. Mongo Performance reads
use **only** `my_production`, `my_mapa`, `my_persistency` in
`pa_performance_PAMB-dev`. The old adapter/mappings are removed; old database
contents are not deleted. Contest connections and runtime collections are unchanged.
This is not production authentication or approved production source mapping.

`vendor/spec/insights.v1.yaml` is the existing API 1.4.0 from immutable Spec commit
`8d01e03dadb4825342a3e1e78690ca4e31abe64f`. The BSON schema export is preserved in
`vendor/spec/performance-source.schema.json` with SHA-256
`920c2d971a23be193e50bbc9525eb350ffb46a0c451072cfdf462f1bce81bff0`.
No dirty/READY handoff or production implementation-complete claim is made.

## Local configuration

Retain existing `MONGODB_URI` and `MONGODB_CONTEST_DB` credentials/configuration.
For Performance on a different Mongo endpoint or a read-only account, optionally
set `MONGODB_PERFORMANCE_URI` using your secret configuration. This creates a
separate Performance client and does not redirect Contest. Omit it to reuse the
existing connection; an explicitly empty value fails instead of falling back.
Set the following in ignored `.env.local` (shell environment wins):

```dotenv
NODE_ENV=development
INSIGHTS_DATA_SOURCE=performance
MONGODB_PERFORMANCE_DB=pa_performance_PAMB-dev
INSIGHTS_MOCK_AGENTS_FILE=data/performance-mocks/agents.json
```

`MONGODB_PERFORMANCE_DB` may be omitted: the database defaults to the exact name
above. A conflicting name is rejected. The only source collections remain
`my_production`, `my_mapa`, `my_persistency`; requests cannot choose a database.

### Reading resident data (no import required)

If the records are already in these collections, start the service and query the
existing routes. Do **not** run `db:setup`, `db:seed` or `db:import:performance`
to make reads work: those are separate maintenance/import commands. The reader
uses `find` only and reflects later data updates without a reseed or restart.

`src/data/performance-mapping.ts` is the single source-path table, tested against
the vendored schema. Production identity/aggregation fields are snake_case;
MAPA/persistency use camelCase. Entity remains PAMB and production case status
Collected under the previously approved mapping. No identity or numeric sample
values are hardcoded into these mappings. Adding a new agent to a source does
not authorize access: update the configured development identity allowlist or
integrate approved authentication separately.

Runtime numeric compatibility covers BSON Double/Int32/Long/Decimal128 and strict
decimal numeric text. Money avoids Number conversion; fractional/unsafe counts,
malformed values and nulls remain unavailable. Schema-compatible BSON numeric
year/month dimensions and real UTC watermark dates are validated; malformed
metadata returns a sanitized error rather than misleading values. An allowlisted
identity with no source records returns `404 INS-4040` on domain/BFF routes.
Every source read has an 8-second database execution budget. Database errors
are not converted to EMPTY and raw driver messages are not exposed.

The allowlist file is a JSON object of explicitly authorized mock agent ID to
P4/P3/P2. Do not infer IAM from source tier or source presence. P4 cannot request
TEAM, P3 cannot request GROUP, and all mock principals are own-identity-only.
For isolated tests use `INSIGHTS_DATA_SOURCE=memory`; test data is never stored.

## Provision/import

```powershell
# Commands run from the backend root. Replace paths with the supplied local files.
npm.cmd run db:import:performance -- --production 'C:\path\production.txt' --mapa 'C:\path\mapa.txt' --persistency 'C:\path\persistency.txt'
# After dry-run is reviewed, repeat the same command with --apply.
```

Dry-run validates all input before reads and reports only counts/checksums.
Apply provisions exact BSON schemas/indexes and transactionally inserts only
missing records. Same _id/id plus identical sanitized content is skipped; conflicts
abort, never overwrite. Existing incompatible/nonempty unvalidated collections
are not silently modified. `db:setup` only provisions schemas and indexes;
`db:seed` delegates to the same guarded importer with no generated data.

Normalization: string/ObjectId extended JSON, BSON dates, explicit Double/Int32,
required scheme null, final-array comma in supplied persistency file, MAPA day
integer to schema-required string. String `null` is converted only in nullable
fields. Encrypted names/vault references and undeclared extras are excluded;
required descriptive labels are redacted. Input files remain external/unmodified.
Source BSON numeric types are retained; wire money is decimal-string half-up cents.

## Mapping and limitations

- `PAMB` → INSURANCE; `Personal` → SELF; `Group` → TEAM/GROUP; STANDARD only.
- ALL/TAKAFUL/DIRECT/SCHEME values are EMPTY, not inferred. Pass the supported
  lens explicitly: default ALL will correctly show unavailable values.
- Production: exact PTD period leaf for TPC/PTPC/FYP/CASE_COUNT; FYC null is EMPTY.
  WITH_REPRICING is detail alternate only. No weighted-product/credit-point guess.
- MAPA: PTD manpower/count, activity ratio as 0–100 percent, productivity decimal,
  average case size MYR major units, new recruits count. No invented bar history.
- Persistency: YTD fields only, fractions ×100; no bonus substitution or MTD/QTD.
- Three sample files have disjoint identities: one person's production is never
  joined to another person's MAPA/persistency. Missing metrics remain visible/EMPTY.
- Select newest reporting year/month for the identity/lens, align contributing
  sources to that month, keep the source watermark independent of reporting dates.
  The supplied periods are in **2025**, even though refresh watermarks are in 2026.
- No extra Mongo collections for catalogue, preferences, recommendations or
  milestones. Static catalogue is reused; preferences are volatile and reset on
  restart. History returns null cells; support lists are empty; feedback cannot
  create a nonexistent recommendation. Goals are NOT_SET, never invented targets.

## Existing API usage

Send `x-agent-id` with the exact allowed identity for both API and BFF.

```http
GET /insights/v1/agents/{agentId}/metrics?period=YTD&businessLine=INSURANCE&scope=SELF&basis=STANDARD
x-agent-id: {same-agentId}

GET /insights/v1/agents/{groupAgentId}/metrics?period=YTD&businessLine=INSURANCE&scope=TEAM&teamView=GROUP&basis=STANDARD
x-agent-id: {same-groupAgentId}

GET /api/bff/v1/performance/dashboard?period=YTD&businessLine=INSURANCE&scope=SELF
x-agent-id: {agentId}
```

No implicit A1001 alias. The development frontend's configured source sample
selector chooses the matching identity and supported filters; API clients use
the headers above. The selector does not grant access or join different agents.

## Validation

`npm run typecheck`, `npm test`, `npm run build`, `npm run handoff:validate`.
Backend tests cover source AC-PA-DIRECT-01–11 and resident-read AC-PA-DIRECT-18–24
using synthetic data and fake Mongo. Frontend owns AC-PA-DIRECT-12–17. Live
read-only comparison with resident records is reported separately. The build
script uses Node filesystem APIs so it also works on Windows.