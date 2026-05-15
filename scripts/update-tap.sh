#!/usr/bin/env bash
# Update the zavudev/homebrew-tools repo to point at a new CLI release.
#
# Run AFTER `release.sh <version>` has finished — needs the SHA256SUMS file
# from the published GH release. Clones the tap repo to a temp dir, rewrites
# Formula/zavu.rb from the template, commits, pushes.
#
# The tap repo (`zavudev/homebrew-tools`) is shared with the Stainless-
# generated CLI (`Casks/zavudev.rb`, binary `zavudev`). We write to
# `Formula/zavu.rb` (binary `zavu`) — no collision. Stainless's GoReleaser
# auto-commits its own cask; we only touch our formula file.
#
# Usage:
#   ./scripts/update-tap.sh <version>          # e.g. 0.2.0
#
# Requires:
#   - gh (authenticated, with write access to zavudev/homebrew-tools)
#   - git
#   - shasum (macOS) or sha256sum (Linux) — used to verify downloads

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>" >&2
  exit 1
fi

# Mirror release.sh's default. Override with ZAVU_RELEASE_REPO if you've
# changed where binaries are hosted.
RELEASE_REPO="${ZAVU_RELEASE_REPO:-zavudev/zavu-cli}"
TAG="cli-v${VERSION}"
RELEASE_BASE="https://github.com/${RELEASE_REPO}/releases/download/${TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/zavu.rb.template"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "Template not found at $TEMPLATE" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[tap] Downloading SHA256SUMS from $TAG..."
# Use `gh release download` instead of curl. The public CDN (github.com/.../releases/download/...)
# occasionally returns 503/504 for fresh assets while the GH API mirror serves them fine.
# gh also handles auth transparently for private release repos.
if ! gh release download "$TAG" -R "$RELEASE_REPO" -p SHA256SUMS -O "$WORK/SHA256SUMS" --clobber 2>&1; then
  echo "Could not download SHA256SUMS from $TAG. Did release.sh finish?" >&2
  exit 1
fi

# Pull the sums by filename. Each line is "<sha>  <filename>".
sha() {
  grep " $1\$" "$WORK/SHA256SUMS" | awk '{print $1}'
}
SHA_MACOS_ARM64="$(sha zavu-macos-arm64)"
SHA_MACOS_X64="$(sha zavu-macos-x64)"
SHA_LINUX_ARM64="$(sha zavu-linux-arm64)"
SHA_LINUX_X64="$(sha zavu-linux-x64)"

for name in SHA_MACOS_ARM64 SHA_MACOS_X64 SHA_LINUX_ARM64 SHA_LINUX_X64; do
  if [[ -z "${!name}" ]]; then
    echo "Missing checksum for $name in SHA256SUMS." >&2
    exit 1
  fi
done

echo "[tap] Cloning zavudev/homebrew-tools..."
gh repo clone zavudev/homebrew-tools "$WORK/tap"
mkdir -p "$WORK/tap/Formula"

echo "[tap] Rendering Formula/zavu.rb..."
sed \
  -e "s|{{VERSION}}|$VERSION|g" \
  -e "s|{{SHA_MACOS_ARM64}}|$SHA_MACOS_ARM64|g" \
  -e "s|{{SHA_MACOS_X64}}|$SHA_MACOS_X64|g" \
  -e "s|{{SHA_LINUX_ARM64}}|$SHA_LINUX_ARM64|g" \
  -e "s|{{SHA_LINUX_X64}}|$SHA_LINUX_X64|g" \
  "$TEMPLATE" > "$WORK/tap/Formula/zavu.rb"

cd "$WORK/tap"

# Stainless's GoReleaser pushes to this same repo on its own release cadence.
# Rebase before push to avoid stomping over a concurrent zavudev.rb commit.
git pull --rebase origin main 2>&1 | tail -2 || true

git add Formula/zavu.rb
if git diff --cached --quiet; then
  echo "[tap] No changes — formula already at v$VERSION."
  exit 0
fi

git commit -m "zavu $VERSION"
git push

echo ""
echo "[tap] ✓ Tap updated to v${VERSION}"
echo "  Users can now run:"
echo "    brew update && brew upgrade zavu        # if already installed"
echo "    brew install zavudev/tools/zavu         # first install"
echo ""
echo "  (The legacy Stainless CLI 'zavudev' stays available via:"
echo "    brew install zavudev/tools/zavudev      # legacy; redundant with zavu)"
