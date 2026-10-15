#!/bin/sh
# cairn installer. POSIX sh on purpose — it runs before anything is installed.
set -eu

REPO="${CAIRN_REPO:-cairn-kb/cairn}"
INSTALL_DIR="${CAIRN_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CAIRN_VERSION:-latest}"
# Where the assets are fetched from. Overridable so the test suite can point it
# at a local file:// fixture and actually RUN this script — it is the only
# artifact that executes on a stranger's machine, it is not covered by tsc, and
# it is the curl-pipe-sh trust boundary. Unset in every real install.
BASE_URL="${CAIRN_BASE_URL:-}"

die() { printf '%s\n' "$1" >&2; exit 1; }

os=$(uname -s)
arch=$(uname -m)
case "$os-$arch" in
  Darwin-arm64)  asset="cairn-darwin-arm64" ;;
  Darwin-x86_64) asset="cairn-darwin-x64" ;;
  Linux-x86_64)  asset="cairn-linux-x64" ;;
  *) die "No cairn build for $os-$arch. Supported: darwin-arm64, darwin-x64, linux-x64." ;;
esac

if [ -n "$BASE_URL" ]; then
  base="$BASE_URL"
elif [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
# Any exit removes the partial download: a half-fetched binary on PATH is
# worse than no binary.
trap 'rm -rf "$tmp"' EXIT INT TERM

# Name the source. CAIRN_BASE_URL and CAIRN_REPO exist so the tests can point
# at a local fixture, which means the download source is no longer a
# compile-time constant: either variable already present in the environment
# silently redirects a real install, and the checksum cannot catch it because
# checksums.txt comes from the same base. Printing it makes a redirect visible.
printf 'Downloading %s from %s…\n' "$asset" "$base"
curl -fsSL "$base/$asset" -o "$tmp/cairn" || die "Download failed: $base/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || die "Could not fetch checksums.txt"

expected=$(grep " $asset\$" "$tmp/checksums.txt" | awk '{print $1}')
[ -n "$expected" ] || die "No checksum listed for $asset"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/cairn" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/cairn" | awk '{print $1}')
fi

[ "$actual" = "$expected" ] || die "Checksum mismatch for $asset. Refusing to install."

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/cairn"
mv "$tmp/cairn" "$INSTALL_DIR/cairn"

printf 'Installed cairn to %s\n' "$INSTALL_DIR/cairn"

# The $PATH in the printf below is deliberately literal: it prints the line for
# the user to paste into their shell config, and expanding it would splice their
# whole current PATH into the suggestion. SC2016 flags that, and the suppression
# must sit in front of the entire case statement rather than a single branch.
# shellcheck disable=SC2016
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf '\n%s is not on your PATH. Add it:\n\n    export PATH="%s:$PATH"\n\n' \
       "$INSTALL_DIR" "$INSTALL_DIR" ;;
esac

printf 'Next: cairn init   (local needs no account; see the README for team spaces)\n'
