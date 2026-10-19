/**
 * The native files a compiled binary carries, as paths.
 *
 * Every target's files are embedded in every binary (a few MB), so the release
 * keeps building all three targets from one Linux runner. Each import names a
 * literal path, which `bun build --compile` resolves and embeds statically —
 * so a release built without one of them fails to compile rather than
 * shipping without it.
 *
 * They are dynamic imports so a source checkout without them still runs: a
 * plain `bun install` fetches only the host's sqlite-vec package, and the
 * darwin SQLite exists only once scripts/build-sqlite.sh has run. A missing
 * file is null, and the loader reports why it has nothing to load.
 */

export type NativeTarget = "darwin-arm64" | "darwin-x64" | "linux-x64"

async function optional(load: () => Promise<{ default: string }>): Promise<string | null> {
  try {
    return (await load()).default
  } catch {
    return null
  }
}

export const vec0: Record<NativeTarget, string | null> = {
  "darwin-arm64": await optional(() => import("sqlite-vec-darwin-arm64/vec0.dylib", { with: { type: "file" } })),
  "darwin-x64": await optional(() => import("sqlite-vec-darwin-x64/vec0.dylib", { with: { type: "file" } })),
  "linux-x64": await optional(() => import("sqlite-vec-linux-x64/vec0.so", { with: { type: "file" } })),
}

/** Universal (arm64 + x86_64), built by scripts/build-sqlite.sh. */
export const darwinSqlite: string | null = await optional(() =>
  import("./darwin/libsqlite3.dylib", { with: { type: "file" } }),
)
