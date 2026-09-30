# Cross-layer bug localization

Do not assume a bug belongs to the repository where the command starts. Use all
accessible Spec, Web and Backend folders and compare expected versus actual data
at each boundary:

`Spec -> UI interaction/render -> UI state/request -> BFF VM composition ->
Backend API -> service/calculation -> data source/Mongo -> runtime config`.

Start from the spec traceability path (as reference), operation IDs, AC IDs,
route, visible labels, fields and supplied evidence. Reproduce with the smallest
existing test, endpoint call or browser journey. The first boundary where actual
output differs from expected behavior is the likely owner. Never patch a
downstream layer to conceal an upstream defect.

Classify for traceability (the spec is reference material, not a gate):

- `IMPLEMENTATION_DEFECT`: code violates clear intended behavior; fix directly.
- `TEST_DEFECT`: implementation matches the spec and the test is wrong.
- `DATA_DEFECT`: persisted/source data violates the expected contract.
- `CONFIGURATION_DEFECT`: runtime/deployment configuration is wrong.
- `SPEC_DEFECT`: the spec is incomplete, contradictory or incorrect.
- `NEW_REQUIREMENT`: requested behavior differs from the spec.
- `UNKNOWN`: evidence is insufficient.

For `SPEC_DEFECT` or `NEW_REQUIREMENT`, decide on the merits and fix in code;
optionally update the spec afterwards (e.g. `/update-spec <SPEC-ID>`) if it helps
others. For `UNKNOWN`, request the smallest useful evidence and recommend how to
obtain it. For an urgent security, availability or data-corruption incident,
separate reversible containment from the permanent correction.

Before editing, report bug Jira, related Spec/version/AC, classification, owning
repository/layer, confidence, evidence and proposed correction. If ownership is
frontend, provide `/fix-frontend-bug <BUG-JIRA> <SPEC-ID>` instead of changing
backend code.