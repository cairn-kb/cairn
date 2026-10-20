# sqlite-vec from the compiled binary: gate result

Does each compiled release target load sqlite-vec 0.1.9 and still run FTS5
`bm25` on the same connection? Checked with the hidden `cairn __selftest vec`,
from a fresh directory with `PATH=/usr/bin:/bin`, an empty `env`, and a fresh
`CAIRN_ROOT`.

Run on 2026-10-20, locally, on an Apple silicon Mac (macOS 26.3.1) with Bun
1.3.6, from commit 59a4e81 plus this branch's changes. The darwin SQLite is
3.54.1, built universal by `scripts/build-sqlite.sh`.

## Result

| target | how it ran | sqlite | vec loaded | nearest-two | fts5 bm25 | exit |
|---|---|---|---|---|---|---|
| darwin-arm64 | native | 3.54.1 (custom, embedded) | **yes**, v0.1.9 | ok | ok | 0 |
| darwin-x64 | Rosetta (`arch -x86_64`) | 3.54.1 (custom, embedded) | **yes**, v0.1.9 | ok | ok | 0 |
| linux-x64 | `debian:bookworm-slim`, amd64 under emulation | 3.51.2 (Bun's own) | **yes**, v0.1.9 | ok | ok | 0 |

**PASS on all three targets.** Every target can use `vec0`; none needs the JS
scan fallback.

Positive control: the same darwin binaries with only their own SQLite blocked
(a file sitting where the extracted library would go) fall back to Apple's
3.51.0 and report `vec unavailable: This build of sqlite3 does not support
dynamic extension loading` — the failure the embedded library exists to fix —
while FTS5 still passes and the exit stays 0. So the pass above comes from the
embedded library, and a target without it degrades rather than breaks.

## Caveats

- **This local run is not the authoritative one.** The `native-selftest`
  workflow on GitHub is: it runs per target on every pull request touching
  the native loader and on every release, and its step summary records each
  target's `sqlite`, `vec` and `fts5` result. Read that summary, not this
  file, for the per-target gate result. Here linux-x64 ran under QEMU
  emulation on arm64 rather than on an x64 host, and darwin-x64 ran under
  Rosetta, not on Intel hardware — the workflow instead runs darwin-x64
  natively on `macos-15-intel`, because Rosetta on macOS 14 lacks the AVX
  support Bun's darwin-x64 runtime needs.
- **Rosetta warns about AVX.** The darwin-x64 binary prints `warn: CPU lacks
  AVX support, strange crashes may occur` under Rosetta (Bun suggests its
  `-baseline` build). The self-test still passed. This is why `native-selftest.yml`
  runs darwin-x64 on an Intel runner rather than under Rosetta.
- **Interpreted macOS gets Apple's SQLite too** on this machine (3.51.0, no
  extension loading). So `prepareSqlite` applies the embedded library on darwin
  whenever it exists, compiled or not, rather than only in a compiled binary;
  `bun run` and the binary then agree. The vec unit tests run in a fresh
  process (the library is chosen once per process) and are skipped on macOS
  until `scripts/build-sqlite.sh` has run; CI runs them on Linux.
- **The embedded files** are imported dynamically with literal paths, so the
  bundler still embeds all of them, and a release build missing one fails to
  compile; a source checkout with only its own platform's package installed
  still runs.
- **Size:** `vec0` is 160 KB (arm64), 128 KB (x64 darwin), 160 KB (linux);
  the universal `libsqlite3.dylib` is 2.8 MB. Binaries built here: darwin-arm64
  73 MB, darwin-x64 79 MB, linux-x64 136 MB, each carrying every target's files.
- `actionlint` was not available, so the two workflows are checked only by
  `test/release-workflow.test.ts`.

## Commands and output

`$SCRATCH` is a temporary directory. The script that produced this:

```bash
run() { echo "\$ $*"; "$@" 2>&1; echo "[exit $?]"; echo; }
# build: scripts/build-sqlite.sh, then for each target
bun build --compile --minify --define 'process.env.OPENTUI_LIBC="glibc"' \
  --target="bun-$target" src/cli.ts --outfile "$SCRATCH/dist/cairn-$target"
# each run copies the binary alone into a fresh directory and cds into it
```

### Build, the three targets, and the first control

Bun's download progress lines for the darwin-x64 runtime are omitted.

```
## build
$ bun --version
1.3.6
[exit 0]

$ git rev-parse --short HEAD
59a4e81
[exit 0]

$ lipo -info src/native/darwin/libsqlite3.dylib
Architectures in the fat file: src/native/darwin/libsqlite3.dylib are: x86_64 arm64 
[exit 0]

$ bun build --compile --minify --define process.env.OPENTUI_LIBC="glibc" --target=bun-darwin-arm64 src/cli.ts --outfile $SCRATCH/dist/cairn-darwin-arm64
  [69ms]  minify  -17.18 MB (estimate)
  [20ms]  bundle  731 modules
 [212ms] compile  $SCRATCH/dist/cairn-darwin-arm64
[exit 0]

$ bun build --compile --minify --define process.env.OPENTUI_LIBC="glibc" --target=bun-darwin-x64 src/cli.ts --outfile $SCRATCH/dist/cairn-darwin-x64
  [58ms]  minify  -17.28 MB (estimate)
  [20ms]  bundle  731 modules
[2.961s] compile  $SCRATCH/dist/cairn-darwin-x64 bun-darwin-x64-v1.3.6
[exit 0]

$ bun build --compile --minify --define process.env.OPENTUI_LIBC="glibc" --target=bun-linux-x64 src/cli.ts --outfile $SCRATCH/dist/cairn-linux-x64
  [95ms]  minify  -37.18 MB (estimate)
  [20ms]  bundle  731 modules
  [56ms] compile  $SCRATCH/dist/cairn-linux-x64 bun-linux-x64-v1.3.6
[exit 0]

$ file $SCRATCH/dist/cairn-darwin-arm64 $SCRATCH/dist/cairn-darwin-x64 $SCRATCH/dist/cairn-linux-x64
$SCRATCH/dist/cairn-darwin-arm64: Mach-O 64-bit executable arm64
$SCRATCH/dist/cairn-darwin-x64:   Mach-O 64-bit executable x86_64
$SCRATCH/dist/cairn-linux-x64:    ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, for GNU/Linux 3.2.0, BuildID[sha1]=109a021c1b3405d73bd0e95dcad52ec5857f4ed9, not stripped
[exit 0]

## darwin-arm64
$ env -i HOME=$SCRATCH/run.KrIG PATH=/usr/bin:/bin CAIRN_ROOT=$SCRATCH/run.KrIG/root ./cairn __selftest vec
sqlite 3.54.1 (custom)
vec v0.1.9
vec0 nearest-two ok
fts5 bm25 ok
[exit 0]

$ find root/lib -type f
root/lib/537452e934d662fdae0b89db2d454e4ee89d540fee6faaf7642522e8dd8aa4e9/libsqlite3.dylib
root/lib/193e480c50b59a55977d166f4aaf0e1bc8832d6963516e5950f39e4d2ce0b793/vec0.dylib
[exit 0]

## darwin-x64 (Rosetta)
$ env -i HOME=$SCRATCH/run.nj1k PATH=/usr/bin:/bin CAIRN_ROOT=$SCRATCH/run.nj1k/root arch -x86_64 ./cairn __selftest vec
warn: CPU lacks AVX support, strange crashes may occur. Reinstall Bun or use *-baseline build:
  https://github.com/oven-sh/bun/releases/download/bun-v1.3.6/bun-darwin-x64-baseline.zip
sqlite 3.54.1 (custom)
vec v0.1.9
vec0 nearest-two ok
fts5 bm25 ok
[exit 0]

## linux-x64 (debian:bookworm-slim, amd64 under emulation)
$ docker run --rm --platform linux/amd64 -v $SCRATCH/run.Rd1P:/w -w /w -e CAIRN_ROOT=/w/root debian:bookworm-slim ./cairn __selftest vec
sqlite 3.51.2 (bundled)
vec v0.1.9
vec0 nearest-two ok
fts5 bm25 ok
[exit 0]

## positive control: darwin-arm64 with its own SQLite blocked (root/lib is a file)
$ env -i HOME=$SCRATCH/run.OJju PATH=/usr/bin:/bin CAIRN_ROOT=$SCRATCH/run.OJju/root ./cairn __selftest vec
sqlite 3.51.0 (bundled; custom unavailable: ENOTDIR: not a directory, mkdir '$SCRATCH/run.OJju/root/lib/537452e934d662fdae0b89db2d454e4ee89d540fee6faaf7642522e8dd8aa4e9')
vec unavailable: ENOTDIR: not a directory, mkdir '$SCRATCH/run.OJju/root/lib/193e480c50b59a55977d166f4aaf0e1bc8832d6963516e5950f39e4d2ce0b793'
fts5 bm25 ok
[exit 0]

## positive control: darwin-x64 with its own SQLite blocked
$ env -i HOME=$SCRATCH/run.EEqm PATH=/usr/bin:/bin CAIRN_ROOT=$SCRATCH/run.EEqm/root arch -x86_64 ./cairn __selftest vec
warn: CPU lacks AVX support, strange crashes may occur. Reinstall Bun or use *-baseline build:
  https://github.com/oven-sh/bun/releases/download/bun-v1.3.6/bun-darwin-x64-baseline.zip
sqlite 3.51.0 (bundled; custom unavailable: ENOTDIR: not a directory, mkdir '$SCRATCH/run.EEqm/root/lib/537452e934d662fdae0b89db2d454e4ee89d540fee6faaf7642522e8dd8aa4e9')
vec unavailable: ENOTDIR: not a directory, mkdir '$SCRATCH/run.EEqm/root/lib/d39d33d16d302d57440d9a9cdbe3cc095e8324aa96b979b5171f545a6346996d'
fts5 bm25 ok
[exit 0]
```

That last pair blocks the whole `lib/` directory, so both extractions fail.
The control below blocks only the SQLite library, which leaves `vec0` to be
loaded into Apple's SQLite.

### The positive control

```
## positive control: darwin-arm64 with only its own SQLite blocked (root/lib/<sqlite sha256> is a file)
$ env -i HOME=$SCRATCH/run.5S4l PATH=/usr/bin:/bin CAIRN_ROOT=$SCRATCH/run.5S4l/root ./cairn __selftest vec
sqlite 3.51.0 (bundled; custom unavailable: EEXIST: file already exists, mkdir '$SCRATCH/run.5S4l/root/lib/537452e934d662fdae0b89db2d454e4ee89d540fee6faaf7642522e8dd8aa4e9')
vec unavailable: This build of sqlite3 does not support dynamic extension loading
fts5 bm25 ok
[exit 0]

## positive control: darwin-x64 with only its own SQLite blocked (root/lib/<sqlite sha256> is a file)
$ env -i HOME=$SCRATCH/run.faMo PATH=/usr/bin:/bin CAIRN_ROOT=$SCRATCH/run.faMo/root arch -x86_64 ./cairn __selftest vec
warn: CPU lacks AVX support, strange crashes may occur. Reinstall Bun or use *-baseline build:
  https://github.com/oven-sh/bun/releases/download/bun-v1.3.6/bun-darwin-x64-baseline.zip
sqlite 3.51.0 (bundled; custom unavailable: EEXIST: file already exists, mkdir '$SCRATCH/run.faMo/root/lib/537452e934d662fdae0b89db2d454e4ee89d540fee6faaf7642522e8dd8aa4e9')
vec unavailable: This build of sqlite3 does not support dynamic extension loading
fts5 bm25 ok
[exit 0]
```

### The suite

```
$ bun test
 1212 pass
 2 skip
 0 fail
Ran 1214 tests across 55 files.
$ bunx tsc --noEmit
[exit 0]
```
