import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// --- the capability inventory ---------------------------------------------
//
// A local web UI was once deleted, and one of its pages was the only path by
// which a human could replace a generated abstract and mark it
// `abstractBy: "human"`. After the deletion NO code in the repository could
// write one of that field's three values, while the README went on counting
// generated abstracts nobody had reviewed.
//
// Nothing failed: the suite was green. A capability with no caller looks
// exactly like dead code, and the only defence is an inventory taken before
// the delete, not after.
//
// This is that inventory, taken automatically. `cairn curate` restored the
// "human" writer and it is again a single line (`review-tui.ts`), so the same
// deletion is available to be made again by someone with equally good reasons.

const SRC = resolve(import.meta.dir, "..", "src")
const PROTOCOL = resolve(import.meta.dir, "..", "packages", "protocol", "src")

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return tsFiles(path)
    return e.name.endsWith(".ts") ? [path] : []
  })
}

/**
 * Comments are stripped before matching, and this is the point rather than a
 * detail: `review-tui.ts` carries a doc comment reading ``abstractBy:
 * "human"`` directly above the only line that writes it. A guard that matched
 * raw text would stay green if the code were deleted and the comment left
 * behind — which is precisely the failure being guarded against.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
}

// Both spellings the codebase uses: an object literal (`store.ts`) and an
// assignment to an existing claim (`cli.ts`).
const WRITE = /abstractBy\s*[:=]\s*"(agent|generated|human)"/g

test("every abstractBy value has a writer in src/", () => {
  const written = new Set<string>()
  for (const file of tsFiles(SRC)) {
    // types.ts declares the union; it does not write it. Left in the walk and
    // filtered by name so that adding a fourth value there is still visible
    // here as a value with no writer.
    if (file.endsWith("/types.ts")) continue
    for (const m of stripComments(readFileSync(file, "utf-8")).matchAll(WRITE)) written.add(m[1]!)
  }
  expect([...written].sort()).toEqual(["agent", "generated", "human"])
})

test("the inventory reads the field's declared values rather than a hardcoded list", () => {
  // If someone adds a fourth abstractBy value to the union, the assertion
  // above must start failing until something writes it. That only works if the
  // expected set is derived from types.ts, so pin the two together here.
  const types = readFileSync(join(PROTOCOL, "types.ts"), "utf-8")
  const declared = types.match(/abstractBy:\s*([^\n]+)/)?.[1] ?? ""
  const values = [...declared.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!).sort()
  expect(values).toEqual(["agent", "generated", "human"])
})

test("the comment stripper defeats the shape that would fake a pass", () => {
  // The exact shape in review-tui.ts, and the block form.
  expect(stripComments('  /** now `abstractBy: "human"`. */\n').match(WRITE)).toBeNull()
  expect(stripComments('// abstractBy: "human"\n').match(WRITE)).toBeNull()
  expect(stripComments('  abstractBy: "human",\n')).toContain('abstractBy: "human"')
})
