# Vendored spec artifacts

Copied from `PruactionSpec` at the immutable revision in `SPEC_COMMIT`; API
versions remain in `SPEC_VERSION`/`CONTEST_SPEC_VERSION`. Never edit here.
Run `SPEC_REF=<handoff.spec.commit> HANDOFF_REF=<commit-containing-ready-handoff>
npm run sync:specs`, review the diff, validate the inbound handoff, implement it,
and publish a receipt under `handoffs/outbox`. `HANDOFF_COMMIT` records the
instruction-publication revision separately from the contract revision.
