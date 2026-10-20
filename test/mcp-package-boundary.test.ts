import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { staticSpecifiers } from "./import-graph"

// The MCP tool surface is what the hosted service serves over HTTP as well as
// what `cairn mcp` serves over stdio. Whatever this package imports becomes a
// runtime dependency of the hosted service too, and a node: builtin breaks it
// outright — so its imports are a closed set, the same way the protocol's are.
const MCP = resolve(import.meta.dir, "..", "packages", "mcp", "src")

const ALLOWED = (s: string) =>
  s.startsWith("./") ||
  s.startsWith("@cairn-kb/protocol/") ||
  s.startsWith("@modelcontextprotocol/sdk/") ||
  s === "zod"

test("the mcp package imports only itself, the protocol, the MCP SDK and zod", () => {
  const files = readdirSync(MCP).filter((f) => f.endsWith(".ts"))
  // A populated walk, not a trivially empty one.
  expect(files).toEqual(expect.arrayContaining(["index.ts", "server.ts", "tools.ts"]))
  const specifiers = files.flatMap((f) =>
    staticSpecifiers(readFileSync(join(MCP, f), "utf-8")).map((s) => ({ f, s })),
  )
  expect(specifiers.length).toBeGreaterThan(0)
  expect(specifiers.filter(({ s }) => s.startsWith("node:")).map(({ f, s }) => `${f}: ${s}`)).toEqual([])
  expect(specifiers.filter(({ s }) => !ALLOWED(s)).map(({ f, s }) => `${f}: ${s}`)).toEqual([])
})

test("the published mcp package carries its licence", () => {
  const pkgDir = resolve(MCP, "..")
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
    files: string[]
    license: string
    peerDependencies?: Record<string, string>
  }
  expect(pkg.license).toBe("Apache-2.0")
  expect(pkg.files).toEqual(expect.arrayContaining(["LICENSE", "NOTICE"]))
  expect(readFileSync(join(pkgDir, "LICENSE"), "utf-8")).toContain("Apache License")
  expect(readFileSync(join(pkgDir, "NOTICE"), "utf-8")).toContain("cairn")
  // A peer, so a consumer that already has zod never gets a second copy whose
  // schemas the SDK would not recognise.
  expect(pkg.peerDependencies?.zod).toBeDefined()
})

test("the root package declares a range that covers the mcp package's version", () => {
  // Same reason as the protocol's: a published semver range, not
  // `workspace:*`, and one that keeps resolving to the local workspace.
  const root = resolve(import.meta.dir, "..")
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
    dependencies: Record<string, string>
  }
  const mcpPkg = JSON.parse(readFileSync(join(root, "packages", "mcp", "package.json"), "utf-8")) as {
    version: string
  }
  const range = rootPkg.dependencies["@cairn-kb/mcp"]
  expect(range).toBeDefined()
  expect(Bun.semver.satisfies(mcpPkg.version, range!)).toBe(true)
})
