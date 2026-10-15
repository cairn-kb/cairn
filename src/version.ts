/**
 * Build stamp, re-exported from ./build-info (the file CI overwrites on
 * release) plus hand-written helpers. Nothing in this file is touched by
 * the release workflow — that's the point of the split.
 */
export { VERSION, COMMIT, BUILT_AT } from "./build-info"
import { VERSION, COMMIT, BUILT_AT, COMPILED as STAMPED_COMPILED } from "./build-info"

/**
 * Whether a module path lives inside a `bun build --compile` binary's
 * embedded filesystem: `/$bunfs/…` on macOS and Linux, `B:\~BUN\…` on
 * Windows.
 */
export function isCompiledPath(path: string): boolean {
  return path.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(path)
}

/**
 * True only in a compiled binary. Decides whether the MCP config invokes cairn
 * directly or through bun — a source checkout has no binary to point at — and
 * lets `cairn doctor` spot a binary install whose config still launches a
 * checkout.
 *
 * Detected at runtime as well as stamped: the release workflow stamps
 * `COMPILED = true`, but a binary built any other way — a contributor's
 * `bun build --compile`, a distro package — keeps the source default. Trusting
 * the stamp alone made such a binary write `bun /$bunfs/root/cairn mcp` into
 * `.mcp.json`, a path that exists only inside the binary.
 */
export const COMPILED: boolean = STAMPED_COMPILED || isCompiledPath(import.meta.path)

export function versionLine(): string {
  return `cairn ${VERSION} (${COMMIT}, built ${BUILT_AT.slice(0, 10)})`
}
