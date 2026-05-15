#!/usr/bin/env bash
# Build all platforms and publish them as a GitHub release.
#
# Usage:
#   ./scripts/release.sh <version>          # e.g. 0.2.0
#
# Requires:
#   - bun                                   (to compile binaries)
#   - gh                                    (GitHub CLI, authenticated)
#   - clean git working tree                (refuses to publish dirty state)
#
# What it does:
#   1. Reads + bumps version in package.json.
#   2. Builds all 5 platform binaries via `bun build --compile`.
#   3. Computes SHA256 for each binary (downstream Homebrew formula needs this).
#   4. Tags the commit `cli-vX.Y.Z` in this repo (private) for internal audit.
#   5. Creates a GitHub release on the PUBLIC release repo with all binaries
#      attached + generated release notes since the previous tag.
#   6. (Optional) Updates the Homebrew tap to point at the new release.
#
# The split lets the source stay in a private monorepo while the binaries
# remain publicly downloadable via Homebrew / curl.
#
# Override the public release repo via env var:
#   ZAVU_RELEASE_REPO=zavudev/cli ./scripts/release.sh 0.2.0

set -euo pipefail

# Public repo where GH releases (binaries) get published. The private source
# repo can be anywhere — only the artifacts need to be reachable without auth.
RELEASE_REPO="${ZAVU_RELEASE_REPO:-zavudev/zavu-cli}"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>   (e.g. $0 0.2.0)" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must be semver (X.Y.Z), got: $VERSION" >&2
  exit 1
fi

# Resolve script's package dir regardless of where it was invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PKG_DIR"

# Refuse to publish from a dirty tree — the release tags a specific commit
# and we'd ship binaries that don't match what's pushed.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is dirty. Commit or stash before releasing." >&2
  exit 1
fi

TAG="cli-v${VERSION}"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally. Bump the version." >&2
  exit 1
fi
# Also refuse if the public release repo already has this version — that
# release would 409 and we'd ship a half-published version.
if gh release view "$TAG" -R "$RELEASE_REPO" >/dev/null 2>&1; then
  echo "Release $TAG already exists at $RELEASE_REPO. Bump the version." >&2
  exit 1
fi

echo "[release] bumping package.json to $VERSION..."
# Use bun to edit JSON instead of awk/sed to avoid escaping headaches.
bun -e "
  const fs = require('node:fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.version = '$VERSION';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"

echo "[release] building all platforms..."
rm -rf dist
bun run build:all

# Sanity check that every expected artifact exists. bun build does NOT fail
# loudly on cross-compile issues, so verify before tagging.
expected=(
  "dist/zavu-macos-arm64"
  "dist/zavu-macos-x64"
  "dist/zavu-linux-x64"
  "dist/zavu-linux-arm64"
  "dist/zavu-windows-x64.exe"
)
for f in "${expected[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "Missing artifact: $f" >&2
    exit 1
  fi
done

echo "[release] computing checksums..."
(
  cd dist
  : > SHA256SUMS
  for f in zavu-macos-arm64 zavu-macos-x64 zavu-linux-x64 zavu-linux-arm64 zavu-windows-x64.exe; do
    shasum -a 256 "$f" >> SHA256SUMS
  done
  cat SHA256SUMS
)

# Commit the version bump if it produced a diff. If the version was already
# set in package.json (e.g. a previous run got partway through), skip the
# commit and tag whatever HEAD is on — that's the "retry" path.
git add package.json
if git diff --cached --quiet; then
  echo "[release] package.json already at $VERSION; tagging HEAD as-is."
else
  echo "[release] committing version bump..."
  git commit -m "chore(cli): release v${VERSION}"
fi

echo "[release] tagging $TAG in the source repo..."
git tag -a "$TAG" -m "Zavu CLI v${VERSION}"

echo "[release] pushing commit + tag to source repo..."
git push origin HEAD
git push origin "$TAG"

echo "[release] creating GitHub release on $RELEASE_REPO..."
# We don't push our private tag to the public release repo — gh creates the
# tag against the default branch of $RELEASE_REPO when we pass --target. This
# keeps the public repo as a thin shell for artifacts (no source pollution).
PUBLIC_BRANCH="$(gh api repos/${RELEASE_REPO} --jq .default_branch 2>/dev/null || echo main)"

gh release create "$TAG" \
  -R "$RELEASE_REPO" \
  --target "$PUBLIC_BRANCH" \
  --title "Zavu CLI v${VERSION}" \
  --generate-notes \
  dist/zavu-macos-arm64 \
  dist/zavu-macos-x64 \
  dist/zavu-linux-x64 \
  dist/zavu-linux-arm64 \
  dist/zavu-windows-x64.exe \
  dist/SHA256SUMS

echo ""
echo "[release] ✓ Release published"
echo "  https://github.com/${RELEASE_REPO}/releases/tag/${TAG}"

# Auto-update the Homebrew tap if it's reachable. The release is already
# published — if this step fails, the tap is just out of sync but the
# release URL works (users on `install.sh` still get the binary). Re-run
# `update-tap.sh <version>` manually to retry.
TAP_FAILED=0
if [[ "${SKIP_TAP_UPDATE:-}" != "1" ]] && command -v gh >/dev/null 2>&1; then
  echo ""
  echo "[release] Updating Homebrew tap..."
  if "$SCRIPT_DIR/update-tap.sh" "$VERSION"; then
    echo ""
    echo "  Users can now: brew install zavudev/tools/zavu"
  else
    TAP_FAILED=1
    echo "[release] Tap update failed (release is fine). Retry with:"
    echo "  ./scripts/update-tap.sh $VERSION"
    # Surface a GitHub Actions warning if we're running in CI so the run
    # shows a yellow indicator instead of green-with-broken-tap.
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
      echo "::warning::Homebrew tap update failed for v${VERSION}. Re-run ./scripts/update-tap.sh ${VERSION} locally."
    fi
  fi
fi

echo ""
echo "  Or for users without Homebrew:"
echo "    curl -fsSL https://raw.githubusercontent.com/zavudev/zavu/main/packages/zavu-cli/scripts/install.sh | bash"
