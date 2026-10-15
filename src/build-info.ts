/**
 * Generated build stamp. CI overwrites this entire file immediately before
 * `bun build --compile` (see .github/workflows/release.yml), so the values
 * in git are the dev defaults and the values in a released binary describe
 * that release.
 *
 * This file must contain nothing but these four generated constants — the
 * release workflow does a destructive `cat > src/build-info.ts <<EOF`, so
 * anything else defined here would be silently deleted on every release.
 * Hand-written logic that depends on these values (e.g. versionLine())
 * belongs in ./version, which re-exports them.
 *
 * BUILT_AT is stamped for the same reason COMMIT is: a bug report that names
 * a version but not when that version was built cannot be matched to a commit
 * once a tag has been moved. `cairn --version` prints all three.
 */
export const VERSION = "0.0.0-dev"
export const COMMIT = "source"
export const BUILT_AT = "1970-01-01T00:00:00.000Z"

/**
 * The release workflow's stamp for a compiled binary. Read COMPILED from
 * ./version, which also detects a binary compiled without this stamp.
 */
export const COMPILED = false
