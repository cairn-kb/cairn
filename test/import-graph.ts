import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * A static-import graph walker, shared by the guards that assert what a given
 * entry point is allowed to reach.
 *
 * Extracted from `cli.test.ts`, where it was written for the mcp stdout purity
 * guard, when more callers appeared — the protocol boundary among them. One
 * walker, so a fix to the parser fixes every guard at once.
 */

// `.` does not cross newlines without the `s` flag, so a lazy `.*` would miss a
// formatter-wrapped multi-line import. The character class below spans newlines
// (`\s` includes them) but excludes `(`, `"` and `:` — the characters that show
// up once the line has moved past an import clause into a dynamic `import(...)`
// call or unrelated code — so it cannot accidentally cross into those. Dynamic
// `await import(...)` is deliberately NOT an edge: that is exactly how init,
// doctor and doctor-render are allowed to reach clack.
// `export { x } from "y"` and `require("y")` load y exactly as an import does,
// and an import can be indented. All three are edges; only a dynamic
// `await import(...)` is not.
const STATIC_IMPORT =
  /^[ \t]*(?:import|export)\s+(?:[\w\s{}*,]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/gm

/**
 * `import type` is included as an edge even though it is erased at runtime.
 * Over-inclusion is the safe direction for a defence-in-depth guard, and no
 * first-party module here has any business type-importing from one that pulls
 * clack.
 */
export function staticSpecifiers(src: string): string[] {
  return [...src.matchAll(STATIC_IMPORT)].map((m) => (m[1] ?? m[2])!)
}

/**
 * A tsconfig path alias, as prefix -> absolute directory.
 *
 * Without this, a tree wired through an alias such as `@/*` is invisible: a
 * specifier that does not start with `.` would be treated as a bare leaf and
 * checked by name, so a walk would follow only the relative edges and never
 * enter the modules the alias reaches — and a guard built on the walk would
 * stay green over exactly the files it exists to see.
 */
export type Aliases = Record<string, string>

/** Relative specifiers, plus any alias prefix the caller declares. Anything
 *  else is a leaf, checked by name. */
function resolveLocal(fromFile: string, spec: string, aliases: Aliases): string | null {
  let base: string
  if (spec.startsWith(".")) {
    base = resolve(dirname(fromFile), spec)
  } else {
    const prefix = Object.keys(aliases).find((p) => spec.startsWith(p))
    if (!prefix) return null
    base = resolve(aliases[prefix]!, spec.slice(prefix.length))
  }
  // `.tsx` as well as `.ts`: a walker that only tried `.ts` would stop at the
  // first `.tsx` module even with the alias resolved.
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Every first-party module reachable from `entry` by static import. */
export function importGraph(
  entry: string,
  aliases: Aliases = {},
): { files: Set<string>; bare: Map<string, string[]> } {
  const files = new Set<string>()
  const bare = new Map<string, string[]>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    for (const spec of staticSpecifiers(readFileSync(file, "utf-8"))) {
      const local = resolveLocal(file, spec, aliases)
      if (local) {
        queue.push(local)
      } else if (!spec.startsWith(".")) {
        bare.set(spec, [...(bare.get(spec) ?? []), file])
      }
    }
  }
  return { files, bare }
}
