# Direct Performance source validation — SPEC-2026-002

Verified 2026-09-18 UTC. Development implementation, initial mock import and
subsequent read-only resident-data hardening;
no production mapping approval, READY promotion or committed completion claim.

## Database evidence

Target: `pa_performance_PAMB-dev`. Applied insert-only transaction with:

| Collection | Imported | BSON schema-conforming | Encrypted-name/vault-reference records |
|---|---:|---:|---:|
| my_production | 5 | 5 | 0 |
| my_mapa | 1 | 1 | 0 |
| my_persistency | 6 | 6 | 0 |

All three use strict/error validators from the supplied schema export and indexes
`uq_mock_source_id`, `ix_mock_performance_read`. Production already had an
equivalent validator with reordered required fields and explicit default
additionalProperties; the first apply stopped before writing. Semantic-equivalence
comparison was added and tested before retrying. Persistency's empty collection
had no validator; MAPA was created. No existing document was overwritten/deleted.

Repeat dry-run: production 0 inserts/5 unchanged, MAPA 0/1, persistency 0/6.
Raw source files were not changed or committed. The imported records retain BSON
source numeric types; API money uses decimal-string integer-cent conversion.

## Code and API verification

- Full backend Vitest suite: **145 passing**, 0 failures, including 16 direct-source
  tests. Offline regression engine remains only as a test harness; old Mongo
  adapter/constants/setup/seed mappings were removed.
- TypeScript strict typecheck and import/setup script typecheck: PASS.
- Cross-platform build: PASS. Compiled `dist/src/server.js` boot/read smoke check
  on temporary port 4601: PASS; temporary process stopped afterward.
- Existing server at port 4600: health, domain metric list/detail and BFF
  dashboard/detail read imported records for all three source scenarios.
- Production verification: TPC 48546.12 MYR, PTPC 29248.02 MYR, FYP 68779.01 MYR,
  CASE_COUNT 8. MAPA: manpower 12, activity ratio 12%, productivity 1,
  average case size 3922.00 MYR, recruits 0. Persistency: CY 100%, Y1 88%, Y2 79%.
- Domain/BFF reporting windows and year labels remain 2025; source watermarks
  remain September 7 or September 18, 2026 as supplied.
- ALL/unsupported lens produces EMPTY; FYC null produces EMPTY; cross-agent/P4
  TEAM requests are forbidden; missing/unlisted development identity is denied.
- BFF responses exclude source personal fields, vault references and database names.
- Private `.env.local` and `data/performance-mocks/agents.json` are ignored;
  10 identities explicitly allowed, two inactive examples not enabled. No aliasing
  to A1001 or cross-source identity substitution.
- Vendored API byte-matches Spec commit `8d01e03dadb4825342a3e1e78690ca4e31abe64f`;
  source-schema SHA-256 matches its Spec evidence. API shapes are unchanged.

## Traceability

| AC | Implementation | Test evidence |
|---|---|---|
| AC-PA-DIRECT-01 | performance-profile.ts, source.ts | Environment/database/country/allowlist guards, removed legacy mode |
| AC-PA-DIRECT-02 | performance-import.ts | BSON/null/date/day normalization, parse restrictions, redaction |
| AC-PA-DIRECT-03 | performance-import.ts, import-performance-mocks.ts | Fingerprint replay/conflict, schema equivalence; live idempotency |
| AC-PA-DIRECT-04 | performance-source.ts, money.ts | PTD selection, zero/null, decimal cents and repricing |
| AC-PA-DIRECT-05 | performance-source.ts | MAPA Group units and missing cross-source fields |
| AC-PA-DIRECT-06 | performance-source.ts | YTD fractions ×100, bonus/MTD non-substitution |
| AC-PA-DIRECT-07 | performance-source.ts | Identity isolation and unsupported-lens EMPTY |
| AC-PA-DIRECT-08 | performance-source.ts, BFF composers | Reporting-period selection/year vs refresh date |
| AC-PA-DIRECT-09 | app.ts, bff.ts | Explicit own identity, tenant and tier guards |
| AC-PA-DIRECT-10 | performance-source.ts | No support/history fabrication; memory-only preferences |
| AC-PA-DIRECT-11 | Mongo projection, BFF composers | No source personal/storage data in payloads |

All AC tests are in `test/performance-source.test.ts`, with AC IDs in test names.
Source files in the table are under `src/data`, `src/lib` or `src/bff` as applicable.

## Remaining limitations

The follow-up frontend development sample selector supplies the configured
identity and supported lens; API clients send `x-agent-id` explicitly.
The sample files have disjoint agents, not a complete combined
dashboard per agent. Preferences are volatile; missing history, milestones and
recommendations remain empty. Production auth/mapping/UX approvals are outstanding.
The backend receipt remains IN_PROGRESS until immutable Spec/backend commits and
the publication protocol exist. Contest runtime/data and old database contents
were not modified; only its obsolete cross-domain synthetic seed command is retired.

## 0.3.0 resident-data hardening — latest verification

This round performed no import, seed, validator/index modification or database
write. Read-only inspection confirmed the expected collection-specific identity,
aggregation, period, watermark and measure types. Existing stored records were
then compared with live HTTP results for every explicitly allowed identity.

| Check | Result |
|---|---|
| Full backend suite | PASS — 159 tests, 0 failures |
| Targeted source/connection/value tests | PASS — 30 tests |
| Strict TypeScript and build | PASS |
| Live read-only Mongo/API comparison | PASS — 10 authorized identities, 30 requests, 87 scalar values compared |
| Collection counts before/after | Unchanged: production 5, MAPA 1, persistency 6 |
| Live mobile/desktop sample browser tests | PASS — all 6 |
| Spec source evidence tests | PASS — all 10 |
| Handoff validation | PASS for the draft artifacts; no readiness promotion |

The API continues to read only the three collections. `performance-mapping.ts`
contains the authoritative runtime paths, each verified against the BSON schema.
`performance-values.ts` preserves Decimal128/Long money spelling and rejects
invalid/unsafe counts. `performance-record.ts` validates UTC dates and period
metadata and provides a sanitized no-record 404. `config/performance.ts` fixes
the database default; optional `MONGODB_PERFORMANCE_URI` uses an independent
client. Tests use mocked clients, not credentials, to prove Contest isolation.

| New AC | Test evidence |
|---|---|
| AC-PA-DIRECT-18 | performance-read.test.ts schema-path coverage; performance-source.test.ts exact lookup keys/projection/read timeout |
| AC-PA-DIRECT-19 | performance-read.test.ts exact Decimal128/Long money; performance-source.test.ts scalar mapping |
| AC-PA-DIRECT-20 | performance-read.test.ts invalid, fractional, unsafe and nonfinite measures; sibling-card survival |
| AC-PA-DIRECT-21 | performance-source.test.ts domain and BFF no-row 404 responses |
| AC-PA-DIRECT-22 | performance-read.test.ts date/period validation; performance-source.test.ts sanitized metadata/driver errors |
| AC-PA-DIRECT-23 | performance-connection.test.ts separate clients, empty URI rejection and retry; fixed database configuration tests |
| AC-PA-DIRECT-24 | performance-source.test.ts changed resident document reflected on a subsequent read without restart/import |

Earlier 145-test/16-source-test counts above are the initial-import baseline.
Production identity integration and unsupported business-lens mappings remain
unapproved. Reading resident data does not bypass the development allowlist or
authorize all agents merely because their rows exist.