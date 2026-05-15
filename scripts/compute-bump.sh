#!/usr/bin/env bash
# Inspect commits since the last cli-v* tag and decide the semver bump.
# Outputs one of: major | minor | patch | none
#
# Policy (intentionally permissive — every CLI change ships):
#   any commit subject contains "BREAKING CHANGE" or "<type>!:"  → major
#   any commit starts with `feat:` (or `feat(scope):`)            → minor
#   any other commit touching the path filter                    → patch
#   nothing touched the path filter                              → none
#   every relevant commit contains "[skip release]"              → none
#
# Conventional Commits is encouraged for clarity but not enforced as a release
# gate. Reasoning: for an iterating CLI, "refactor:" or "chore: bump dep" still
# change the binary the user installs, so they deserve a version bump. If you
# explicitly do NOT want a release for a commit, add "[skip release]" to its
# subject or body.
#
# Only commits that touched `packages/zavu-cli/**` count (override via $1).
#
# Usage:
#   ./scripts/compute-bump.sh                       # defaults to packages/zavu-cli
#   ./scripts/compute-bump.sh packages/zavu-cli     # explicit

set -euo pipefail

PATH_FILTER="${1:-packages/zavu-cli}"

# Find the highest existing cli-v* tag. Empty if this is the first release.
LAST_TAG="$(git tag -l 'cli-v*' --sort=-v:refname | head -n 1 || true)"
if [[ -z "$LAST_TAG" ]]; then
  RANGE="HEAD"
else
  RANGE="${LAST_TAG}..HEAD"
fi

# Count commits that touch the path filter. If zero, nothing to release.
RELEVANT_COUNT="$(git log "$RANGE" --oneline -- "$PATH_FILTER" 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$RELEVANT_COUNT" == "0" ]]; then
  echo "none"
  exit 0
fi

# Per-commit scan for breaking-change / feat / [skip release] markers.
COMMITS="$(git log --format='%s%n%b%n---SEP---' "$RANGE" -- "$PATH_FILTER" 2>/dev/null || true)"

BREAKING_RE='^(feat|fix|refactor|perf|chore)(\([^)]+\))?!:'
FEAT_RE='^feat(\([^)]+\))?:'

# Track per-commit "skip release" flags. We default to patch but allow a single
# escape hatch: if EVERY relevant commit is tagged [skip release], we emit none.
total_commits=0
skipped_commits=0
current_skip=0
bump="patch"

# Helper: when a commit boundary is reached, count whether it was skipped.
flush_commit() {
  total_commits=$((total_commits + 1))
  if [[ "$current_skip" == "1" ]]; then
    skipped_commits=$((skipped_commits + 1))
  fi
  current_skip=0
}

while IFS= read -r line; do
  if [[ "$line" == "---SEP---" ]]; then
    flush_commit
    continue
  fi
  [[ -z "$line" ]] && continue

  if [[ "$line" == *"[skip release]"* ]]; then
    current_skip=1
  fi

  # Major beats everything — short-circuit after this loop completes.
  if [[ "$line" =~ $BREAKING_RE ]] || [[ "$line" == *"BREAKING CHANGE"* ]]; then
    bump="major"
    continue
  fi

  if [[ "$line" =~ $FEAT_RE ]]; then
    if [[ "$bump" != "major" ]]; then bump="minor"; fi
  fi
done <<< "$COMMITS"
# No trailing flush: `git log --format='…%n---SEP---'` always emits a SEP after
# the last commit, so flush_commit already ran for every commit inside the loop.

# If every relevant commit asked to skip the release, honor that.
if [[ "$total_commits" -gt 0 && "$skipped_commits" -eq "$total_commits" ]]; then
  echo "none"
  exit 0
fi

echo "$bump"
