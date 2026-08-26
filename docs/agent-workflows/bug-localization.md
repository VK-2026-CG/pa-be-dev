# Cross-layer bug localization

Do not assume a bug belongs to the repository where the command starts. Use all
accessible Spec, Web and Backend folders and compare expected versus actual data
at each boundary:

`Spec -> UI interaction/render -> UI state/request -> BFF VM composition ->
Backend API -> service/calculation -> data source/Mongo -> runtime config`.

Start from the approved traceability path, operation IDs, AC IDs, route, visible
labels, fields and supplied evidence. Reproduce with the smallest existing test,
endpoint call or browser journey. The first boundary where actual output differs
from the approved contract is the likely owner. Never patch a downstream layer
to conceal an upstream defect.

Classify before editing:

- `IMPLEMENTATION_DEFECT`: code violates clear approved behavior; fix directly.
- `TEST_DEFECT`: implementation matches the spec and the test is wrong.
- `DATA_DEFECT`: persisted/source data violates an approved contract.
- `CONFIGURATION_DEFECT`: runtime/deployment configuration is wrong.
- `SPEC_DEFECT`: approved behavior is incomplete, contradictory or incorrect.
- `NEW_REQUIREMENT`: requested behavior differs from the approved behavior.
- `UNKNOWN`: evidence is insufficient.

For `SPEC_DEFECT` or `NEW_REQUIREMENT`, stop the behavioral code change and
recommend `/update-spec <SPEC-ID>`. For `UNKNOWN`, request the smallest useful
evidence and recommend how to obtain it. For an urgent security, availability or
data-corruption incident, separate reversible containment from the permanent
spec-governed correction.

Before editing, report bug Jira, related Spec/version/AC, classification, owning
repository/layer, confidence, evidence and proposed correction. If ownership is
frontend, provide `/fix-frontend-bug <BUG-JIRA> <SPEC-ID>` instead of changing
backend code.