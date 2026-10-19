import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { darwinSqlite } from "../src/native/assets"
import { loadVec, runSelftestVec } from "../src/native/sqlite-runtime"

const roots: string[] = []
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cairn-sqlite-runtime-"))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const DIMS = 1024

// These run interpreted, and interpreted is not the binary: which SQLite
// `bun run` finds depends on the machine. The compiled check is
// `cairn __selftest vec`, run per target by .github/workflows/native-selftest.yml.
// These pin the loader's behaviour, not the platform's.

// bun:sqlite picks its library once per process, when the first Database
// opens, and other test files open one first. So the checks that need vec0 run
// in a fresh process, where prepareSqlite is the first thing to touch SQLite.
async function fresh(root: string, body: string): Promise<unknown> {
  const runtime = join(import.meta.dir, "..", "src", "native", "sqlite-runtime.ts")
  const script = `import { Database } from "bun:sqlite"
import { loadVec, prepareSqlite, runSelftestVec } from ${JSON.stringify(runtime)}
const root = ${JSON.stringify(root)}
${body}`
  const proc = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`child exited ${code}: ${err}`)
  return JSON.parse(out)
}

// Interpreted, macOS gets Apple's SQLite, which refuses extensions, so there
// these need the library scripts/build-sqlite.sh builds. CI runs them on Linux.
const needsVec = test.skipIf(process.platform === "darwin" && darwinSqlite === null)

needsVec("loadVec loads vec0 and answers a nearest-two query", async () => {
  const root = await tempRoot()
  const got = (await fresh(
    root,
    `prepareSqlite(root)
const db = new Database(":memory:")
const status = loadVec(db, root)
const unit = (...entries) => { const v = new Float32Array(${DIMS}); for (const [i, x] of entries) v[i] = x; return new Uint8Array(v.buffer) }
let rowids = null
if (status.ok) {
  db.run("CREATE VIRTUAL TABLE v USING vec0(e float[${DIMS}])")
  const insert = db.prepare("INSERT INTO v(rowid, e) VALUES (?, ?)")
  insert.run(1, unit([0, 1]))
  insert.run(2, unit([1, 1]))
  insert.run(3, unit([0, 0.9], [1, 0.1]))
  rowids = db.query("SELECT rowid FROM v WHERE e MATCH ? AND k = 2 ORDER BY distance").all(unit([0, 1])).map((r) => r.rowid)
}
console.log(JSON.stringify({ status, rowids }))`,
  )) as { status: { ok: boolean; version?: string }; rowids: number[] | null }
  expect(got.status).toMatchObject({ ok: true })
  expect(got.status.version).toMatch(/^v0\.1\.9/)
  expect(got.rowids).toEqual([1, 3])
})

test("loadVec reports a reason instead of throwing", async () => {
  const root = await tempRoot()
  // `lib` is a file, so nothing can be extracted under it.
  await writeFile(join(root, "lib"), "not a directory")
  const db = new Database(":memory:")
  const status = loadVec(db, root)
  expect(status.ok).toBe(false)
  if (status.ok) return
  expect(status.reason.length).toBeGreaterThan(0)
})

needsVec("selftest checks FTS5 bm25 on the same connection", async () => {
  const root = await tempRoot()
  const { lines, exitCode } = (await fresh(root, "console.log(JSON.stringify(await runSelftestVec(root)))")) as {
    lines: string[]
    exitCode: number
  }
  expect(exitCode).toBe(0)
  expect(lines.some((l) => l.startsWith("sqlite "))).toBe(true)
  expect(lines.some((l) => l.startsWith("vec v0.1.9"))).toBe(true)
  expect(lines).toContain("vec0 nearest-two ok")
  expect(lines).toContain("fts5 bm25 ok")
})

test("selftest fails when FTS5 is missing", async () => {
  const root = await tempRoot()
  const { lines, exitCode } = await runSelftestVec(root, {
    fts: () => {
      throw new Error("no such module: fts5")
    },
  })
  expect(exitCode).toBe(1)
  expect(lines).toContain("FAIL fts5: no such module: fts5")
})

test("selftest passes without vec0, because that target falls back to the scan", async () => {
  const root = await tempRoot()
  await writeFile(join(root, "lib"), "not a directory")
  const { lines, exitCode } = await runSelftestVec(root)
  expect(exitCode).toBe(0)
  expect(lines.some((l) => l.startsWith("vec unavailable: "))).toBe(true)
  expect(lines).toContain("fts5 bm25 ok")
})
