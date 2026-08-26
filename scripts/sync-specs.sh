#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
SPEC="${SPEC_DIR:-../PruactionSpec}"
REF="${SPEC_REF:-HEAD}"
HANDOFF_REF="${HANDOFF_REF:-$REF}"
git -C "$SPEC" rev-parse --git-dir >/dev/null 2>&1 || { echo "PruactionSpec Git repo not found at $SPEC (set SPEC_DIR)"; exit 1; }
COMMIT="$(git -C "$SPEC" rev-parse "${REF}^{commit}")"
HANDOFF_COMMIT="$(git -C "$SPEC" rev-parse "${HANDOFF_REF}^{commit}")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
extract() { git -C "$SPEC" show "$COMMIT:$1" > "$2"; }
mkdir -p "$TMP/vendor" "$TMP/inbox"
extract domains/insights/api/insights.v1.yaml "$TMP/vendor/insights.v1.yaml"
if git -C "$SPEC" cat-file -e "$COMMIT:domains/contests/api/contests.v1.yaml" 2>/dev/null; then
  extract domains/contests/api/contests.v1.yaml "$TMP/vendor/contests.v1.yaml"
  if git -C "$SPEC" cat-file -e "$COMMIT:domains/contests/import/brochure-extraction-candidate.schema.json" 2>/dev/null; then
    extract domains/contests/import/brochure-extraction-candidate.schema.json "$TMP/vendor/brochure-extraction-candidate.schema.json"
  fi
  grep -m1 "version:" "$TMP/vendor/contests.v1.yaml" | awk '{print $2}' > "$TMP/vendor/CONTEST_SPEC_VERSION"
fi
grep -m1 "version:" "$TMP/vendor/insights.v1.yaml" | awk '{print $2}' > "$TMP/vendor/SPEC_VERSION"
printf '%s\n' "$COMMIT" > "$TMP/vendor/SPEC_COMMIT"
printf '%s\n' "$HANDOFF_COMMIT" > "$TMP/vendor/HANDOFF_COMMIT"
if git -C "$SPEC" cat-file -e "$HANDOFF_COMMIT:handoffs/outbound" 2>/dev/null; then
  git -C "$SPEC" archive "$HANDOFF_COMMIT" handoffs/outbound | tar -x -C "$TMP/inbox"
fi
cp -R "$TMP/vendor/." vendor/spec/
rm -rf handoffs/inbox/spec
mkdir -p handoffs/inbox/spec
if [ -d "$TMP/inbox/handoffs/outbound" ]; then cp -R "$TMP/inbox/handoffs/outbound/." handoffs/inbox/spec/; fi
echo "Synced contract $COMMIT and handoff publication $HANDOFF_COMMIT ($(cat vendor/spec/SPEC_VERSION)); review the diff and run npm run handoff:validate."
