import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { staticSpecifiers } from "./import-graph"

// The protocol is what the hosted service is allowed to depend on. It has to
// stay a closed set: a bare import here becomes a runtime dependency of the
// hosted service, and a node: builtin breaks it outright.
const PROTOCOL = resolve(import.meta.dir, "..", "packages", "protocol", "src")

test("the protocol imports nothing but itself", () => {
  const files = readdirSync(PROTOCOL).filter((f) => f.endsWith(".ts"))
  expect(files.sort()).toEqual([
    "absence.ts", "document-title.ts", "event-kinds.ts", "generated.ts", "hash.ts",
    "provenance.ts", "stats.ts", "types.ts",
  ])
  const outside = files.flatMap((f) =>
    staticSpecifiers(readFileSync(join(PROTOCOL, f), "utf-8"))
      .filter((s) => !s.startsWith("./"))
      .map((s) => `${f}: ${s}`),
  )
  expect(outside).toEqual([])
})

test("the published protocol package carries its licence", () => {
  // Apache-2.0 asks redistributors to include the licence and NOTICE, and an
  // npm publish ships only what `files` names.
  const pkgDir = resolve(PROTOCOL, "..")
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as { files: string[]; license: string }
  expect(pkg.license).toBe("Apache-2.0")
  expect(pkg.files).toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]))
  expect(readFileSync(join(pkgDir, "LICENSE"), "utf-8")).toContain("Apache License")
  expect(readFileSync(join(pkgDir, "NOTICE"), "utf-8")).toContain("cairn")
})

test("the root package declares a range that covers the protocol's version", () => {
  // The root dependency has to be a published semver range, not
  // `workspace:*`, so an external consumer resolves it from the registry.
  // If it drifts out of range, `bun install` silently swaps the local
  // workspace link for a stale registry download instead of failing.
  const root = resolve(import.meta.dir, "..")
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
    dependencies: Record<string, string>
  }
  const protocolPkg = JSON.parse(readFileSync(join(root, "packages", "protocol", "package.json"), "utf-8")) as {
    version: string
  }
  const range = rootPkg.dependencies["@cairn-kb/protocol"]
  expect(range).toBeDefined()
  expect(Bun.semver.satisfies(protocolPkg.version, range!)).toBe(true)
})
