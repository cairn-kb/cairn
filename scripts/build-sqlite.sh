#!/bin/sh
# Builds the SQLite library the macOS binaries carry.
#
# Apple's system SQLite refuses loadExtension, and a compiled binary uses it
# rather than whatever `bun run` happens to find. So the darwin binaries embed
# this one, extract it on first run and point bun:sqlite at it with
# Database.setCustomSQLite (src/native/sqlite-runtime.ts).
#
# One universal file (arm64 + x86_64) serves both darwin targets. It has to be
# built on macOS: the release job cross-compiles the binaries from Linux, but
# this library needs Apple's toolchain and SDK.
#
# Usage: scripts/build-sqlite.sh [out]   (default: src/native/darwin/libsqlite3.dylib)
set -eu

VERSION=3540100 # 3.54.1
YEAR=2026
SHA256=0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9

out=${1:-src/native/darwin/libsqlite3.dylib}

if [ "$(uname -s)" != Darwin ]; then
  echo "build-sqlite.sh needs macOS (Apple's clang and SDK)" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

zip="$work/sqlite.zip"
curl -fsSL -o "$zip" "https://www.sqlite.org/$YEAR/sqlite-amalgamation-$VERSION.zip"
got=$(shasum -a 256 "$zip" | cut -d' ' -f1)
if [ "$got" != "$SHA256" ]; then
  echo "sqlite-amalgamation-$VERSION.zip: sha256 $got, expected $SHA256" >&2
  exit 1
fi
unzip -q "$zip" -d "$work"
src="$work/sqlite-amalgamation-$VERSION"

# FTS5 because every search runs on it: a library without it would pass the
# vec0 check and break search. COLUMN_METADATA because bun:sqlite looks up
# sqlite3_column_table_name. Extension loading is on by default; the point of
# this library is that nothing here turns it off.
mkdir -p "$(dirname "$out")"
clang -O2 -dynamiclib \
  -arch arm64 -arch x86_64 \
  -mmacosx-version-min=11.0 \
  -install_name @rpath/libsqlite3.dylib \
  -DSQLITE_ENABLE_FTS5 \
  -DSQLITE_ENABLE_COLUMN_METADATA \
  -DSQLITE_THREADSAFE=1 \
  -o "$out" "$src/sqlite3.c"

lipo -info "$out"
shasum -a 256 "$out"
