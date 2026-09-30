#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
SPEC="${SPEC_DIR:-../pa-spec-dev}"
git -C "$SPEC" rev-parse --git-dir >/dev/null 2>&1 || { echo "PruactionSpec Git repo not found at $SPEC (set SPEC_DIR)"; exit 1; }
COMMIT="$(git -C "$SPEC" rev-parse HEAD)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
extract() { cp "$SPEC/$1" "$2"; }
mkdir -p "$TMP/vendor"
extract domains/insights/api/insights.v1.yaml "$TMP/vendor/insights.v1.yaml"
if [ -f "$SPEC/domains/contests/api/contests.v1.yaml" ]; then
  extract domains/contests/api/contests.v1.yaml "$TMP/vendor/contests.v1.yaml"
  if [ -f "$SPEC/domains/contests/import/brochure-extraction-candidate.schema.json" ]; then
    extract domains/contests/import/brochure-extraction-candidate.schema.json "$TMP/vendor/brochure-extraction-candidate.schema.json"
  fi
  grep -m1 "version:" "$TMP/vendor/contests.v1.yaml" | awk '{print $2}' > "$TMP/vendor/CONTEST_SPEC_VERSION"
fi
grep -m1 "version:" "$TMP/vendor/insights.v1.yaml" | awk '{print $2}' > "$TMP/vendor/SPEC_VERSION"
printf '%s\n' "$COMMIT" > "$TMP/vendor/SPEC_COMMIT"
cp -R "$TMP/vendor/." vendor/spec/
echo "Synced spec artifacts from $SPEC ($(cat vendor/spec/SPEC_VERSION)); review the diff and run the relevant application checks."
