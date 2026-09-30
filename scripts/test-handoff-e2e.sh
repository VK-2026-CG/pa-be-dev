#!/usr/bin/env bash
# Retired: handoff/receipt validation is no longer a development gate; kept for history.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone -q "$ROOT/../PruactionSpec" "$tmp/spec"
cd "$tmp/spec"
mkdir -p handoffs/outbound handoffs/schemas scripts
cp "$ROOT/../PruactionSpec/scripts/promote-spec-handoff.mjs" "$ROOT/../PruactionSpec/scripts/validate-handoffs.mjs" scripts/
cp "$ROOT/../PruactionSpec/handoffs/schemas/"*.json handoffs/schemas/
cat > handoffs/outbound/e2e.draft.json <<'JSON'
{
  "schemaVersion": "1.0",
  "handoffId": "insights-my-e2e-handoff",
  "status": "DRAFT",
  "domain": "insights",
  "country": "MY",
  "compatibility": "NONE",
  "spec": { "repository": "PruactionSpec", "commit": null, "dirty": true, "version": "1.3.0" },
  "changedArtifacts": ["domains/insights/api/insights.v1.yaml"],
  "acceptanceCriteria": [],
  "consumers": {
    "backend": { "required": true, "requiredActions": ["Verify immutable sync"] },
    "frontend": { "required": false, "requiredActions": [] }
  },
  "openQuestions": [],
  "createdAt": "2026-08-25T00:00:00.000Z"
}
JSON
git add handoffs scripts
git -c user.name=test -c user.email=test@example.com commit -qm 'Contract and draft'
contract="$(git rev-parse HEAD)"
node scripts/promote-spec-handoff.mjs handoffs/outbound/e2e.draft.json >/dev/null
git add handoffs
git -c user.name=test -c user.email=test@example.com commit -qm 'Publish ready handoff'
publication="$(git rev-parse HEAD)"
mkdir -p "$tmp/backend/scripts" "$tmp/backend/vendor/spec" "$tmp/backend/handoffs/inbox/spec" "$tmp/backend/handoffs/schemas"
cp "$ROOT/scripts/sync-specs.sh" "$ROOT/scripts/validate-handoffs.mjs" "$tmp/backend/scripts/"
cp "$ROOT/handoffs/schemas/"*.json "$tmp/backend/handoffs/schemas/"
SPEC_DIR="$tmp/spec" SPEC_REF="$contract" HANDOFF_REF="$publication" bash "$tmp/backend/scripts/sync-specs.sh"
cd "$tmp/backend"
node scripts/validate-handoffs.mjs
recorded="$(cat vendor/spec/SPEC_COMMIT)"
published="$(cat vendor/spec/HANDOFF_COMMIT)"
inbound="$(node -p 'require("./handoffs/inbox/spec/e2e.ready.json").spec.commit')"
test "$contract" = "$recorded"
test "$contract" = "$inbound"
test "$publication" = "$published"
echo "contract=$contract publication=$publication validated=true"