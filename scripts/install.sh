#!/usr/bin/env bash
# One-shot installer for the Zavu CLI — downloads the right binary for your
# platform from a published GitHub release and drops it on your PATH.
#
# Usage:
#   ./install.sh                 # installs the latest cli-v* release
#   ./install.sh 0.2.0           # pins a specific version
#   VERSION=0.2.0 ./install.sh   # same
#
# After Homebrew/npm publishing exists, this script is the bridge. Until then
# it's the closest thing to `brew install zavu` we can offer the team.

set -euo pipefail

REPO="zavudev/zavu-cli"
INSTALL_DIR="${ZAVU_INSTALL_DIR:-/usr/local/bin}"
VERSION="${VERSION:-${1:-}}"

# --- detect platform -------------------------------------------------------
uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s-$uname_m" in
  Darwin-arm64)     BIN="zavu-macos-arm64" ;;
  Darwin-x86_64)    BIN="zavu-macos-x64" ;;
  Linux-x86_64)     BIN="zavu-linux-x64" ;;
  Linux-aarch64)    BIN="zavu-linux-arm64" ;;
  Linux-arm64)      BIN="zavu-linux-arm64" ;;
  MINGW*-*|MSYS*-*) BIN="zavu-windows-x64.exe" ;;
  *)
    echo "Unsupported platform: $uname_s $uname_m" >&2
    echo "No prebuilt binary for this platform. Build from source — the CLI source lives in the Zavu monorepo (private). Contact your Zavu admin for access." >&2
    exit 1
    ;;
esac

# --- pick the release tag --------------------------------------------------
if [[ -z "$VERSION" ]]; then
  # Resolve latest cli-v* tag from the GH API. Doesn't require auth.
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required. Install it or pass VERSION explicitly." >&2
    exit 1
  fi
  TAG="$(
    curl -fsSL "https://api.github.com/repos/$REPO/releases" \
      | grep -oE '"tag_name": *"cli-v[0-9]+\.[0-9]+\.[0-9]+"' \
      | head -n 1 \
      | sed -E 's/.*"(cli-v[0-9]+\.[0-9]+\.[0-9]+)"/\1/'
  )"
  if [[ -z "$TAG" ]]; then
    echo "Could not resolve latest release. Pass VERSION explicitly." >&2
    exit 1
  fi
else
  TAG="cli-v${VERSION}"
fi

URL="https://github.com/$REPO/releases/download/$TAG/$BIN"
SUMS_URL="https://github.com/$REPO/releases/download/$TAG/SHA256SUMS"

# --- download --------------------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[install] Downloading $BIN from $TAG..."
if ! curl -fsSL -o "$TMP/$BIN" "$URL"; then
  echo "Failed to download $URL. The version may not exist." >&2
  exit 1
fi

# --- verify checksum -------------------------------------------------------
# Best-effort: if SHA256SUMS exists on the release we compare against it.
# Old releases without the file skip this step rather than failing.
if curl -fsSL -o "$TMP/SHA256SUMS" "$SUMS_URL" 2>/dev/null; then
  echo "[install] Verifying SHA256..."
  expected=$(grep " $BIN\$" "$TMP/SHA256SUMS" | awk '{print $1}')
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$TMP/$BIN" | awk '{print $1}')
  else
    actual=$(sha256sum "$TMP/$BIN" | awk '{print $1}')
  fi
  if [[ "$expected" != "$actual" ]]; then
    echo "Checksum mismatch!"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
fi

# --- install ---------------------------------------------------------------
chmod +x "$TMP/$BIN"

# Pick the destination: respect ZAVU_INSTALL_DIR, fall back to /usr/local/bin
# (sudo if needed) or ~/.local/bin (no sudo) when /usr/local isn't writable.
DEST=""
if [[ -w "$INSTALL_DIR" ]]; then
  DEST="$INSTALL_DIR/zavu"
elif command -v sudo >/dev/null 2>&1; then
  echo "[install] $INSTALL_DIR needs sudo; you may be prompted."
  DEST="$INSTALL_DIR/zavu"
  sudo install -m 0755 "$TMP/$BIN" "$DEST"
  echo "[install] ✓ installed to $DEST"
  echo
  "$DEST" --version || true
  exit 0
else
  mkdir -p "$HOME/.local/bin"
  DEST="$HOME/.local/bin/zavu"
  echo "[install] Installing to $DEST (no sudo). Make sure ~/.local/bin is in PATH."
fi

install -m 0755 "$TMP/$BIN" "$DEST"
echo "[install] ✓ installed to $DEST"
echo
"$DEST" --version || true
