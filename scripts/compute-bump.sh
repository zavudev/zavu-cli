#!/usr/bin/env bash
# Inspect commits since the last cli-v* tag and decide the semver bump.
# Outputs one of: major | minor | patch | none
#
# Conventional-commits convention used:
#   feat!: …   → major
#   fix!:  …   → major
#   "BREAKING CHANGE:" anywhere in a commit body → major
#   feat: …    → minor
#   fix:  …    → patch
#   anything else (chore:, docs:, refactor:, test:, style:, ci:, build:, perf:) → no release
#
# Only commits that touched `packages/zavu-cli/**` count (override via $1).
#
# Usage:
#   ./scripts/compute-bump.sh                       # defaults to packages/zavu-cli
#   ./scripts/compute-bump.sh packages/zavu-cli     # explicit
#
# Designed to be invoked from CI but also runnable locally to preview the next release.

set -euo pipefail

PATH_FILTER="${1:-packages/zavu-cli}"

# Find the highest existing cli-v* tag. Empty if this is the first release.
LAST_TAG="$(git tag -l 'cli-v*' --sort=-v:refname | head -n 1 || true)"
if [[ -z "$LAST_TAG" ]]; then
  RANGE="HEAD"
else
  RANGE="${LAST_TAG}..HEAD"
fi

# Get commit subjects + bodies for commits that touched the path filter.
COMMITS="$(git log --format='%s%n%b%n---SEP---' "$RANGE" -- "$PATH_FILTER" 2>/dev/null || true)"

if [[ -z "$COMMITS" ]]; then
  echo "none"
  exit 0
fi

# Regex patterns kept in vars to avoid `[[ =~ ]]` parsing quirks across bash versions.
BREAKING_RE='^(feat|fix|refactor|perf|chore)(\([^)]+\))?!:'
FEAT_RE='^feat(\([^)]+\))?:'
FIX_RE='^fix(\([^)]+\))?:'

bump="none"
while IFS= read -r line; do
  [[ "$line" == "---SEP---" ]] && continue
  [[ -z "$line" ]] && continue

  # Major: breaking change (! after type, or "BREAKING CHANGE" anywhere in body).
  if [[ "$line" =~ $BREAKING_RE ]] || [[ "$line" == *"BREAKING CHANGE"* ]]; then
    echo "major"
    exit 0
  fi

  # Minor: feat:
  if [[ "$line" =~ $FEAT_RE ]]; then
    if [[ "$bump" != "major" ]]; then bump="minor"; fi
    continue
  fi

  # Patch: fix: (only if we haven't already decided on something bigger)
  if [[ "$line" =~ $FIX_RE ]]; then
    if [[ "$bump" == "none" ]]; then bump="patch"; fi
  fi
done <<< "$COMMITS"

echo "$bump"
