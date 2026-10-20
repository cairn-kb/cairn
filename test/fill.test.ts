import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog } from "../src/events"
import { applyFill, CODE_SCAN_THRESHOLD, importSource, planFill } from "../src/fill"
import { codeScanPrompt, IMPORT_SKILL } from "../src/import-skill"
import { FileStore } from "../src/store"

let tmp: string
let store: FileStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cairn-fill-"))
  await mkdir(join(tmp, "store"))
  store = new FileStore(join(tmp, "store"), new EventLog(join(tmp, "store")))
  await store.init()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const repo = { root: "/work/app", label: "app" }
const home = "/home/me"

test("the threshold is three files", () => {
  expect(CODE_SCAN_THRESHOLD).toBe(3)
})

test("importSource tags a path with the repo label, relative and POSIX", () => {
  expect(importSource(repo, "/work/app/docs/adr/0001.md")).toBe("app:docs/adr/0001.md")
})

test("too few files in local mode plans a code scan with a skill per agent, project scope", async () => {
  const plan = await planFill(repo, ["/work/app/README.md", "/work/app/a.md"], ["claude", "cursor", "codex", "claude-desktop"], "project", home, "local")
  expect(plan.codeScan).toBe(true)
  expect(plan.files).toEqual(["/work/app/README.md", "/work/app/a.md"])
  expect(plan.repo).toEqual(repo)
  expect(plan.skills.map((s) => s.path)).toEqual([
    "/work/app/.claude/skills/cairn-import/SKILL.md",
    "/work/app/.cursor/rules/cairn-import.mdc",
    "/home/me/.agents/skills/cairn-import/SKILL.md",
  ])
})

test("global scope puts Claude Code's skill in home and leaves Cursor out", async () => {
  const plan = await planFill(repo, [], ["claude", "cursor", "codex"], "global", home, "local")
  expect(plan.skills.map((s) => s.path)).toEqual([
    "/home/me/.claude/skills/cairn-import/SKILL.md",
    "/home/me/.agents/skills/cairn-import/SKILL.md",
  ])
})

test("only detected agents get a skill", async () => {
  const plan = await planFill(repo, [], ["codex"], "project", home, "local")
  expect(plan.skills.map((s) => s.path)).toEqual(["/home/me/.agents/skills/cairn-import/SKILL.md"])
})

test("skill files carry the frontmatter each agent reads", async () => {
  const plan = await planFill(repo, [], ["claude", "cursor", "codex"], "project", home, "local")
  const [claude, cursor, codex] = plan.skills.map((s) => s.content)
  for (const md of [claude!, codex!]) {
    expect(md.startsWith("---\nname: cairn-import\ndescription: ")).toBe(true)
    expect(md).toContain(IMPORT_SKILL)
  }
  expect(cursor!.startsWith("---\ndescription: ")).toBe(true)
  expect(cursor).toContain("\nalwaysApply: false\n")
  expect(cursor).not.toContain("globs:")
  expect(cursor).toContain(IMPORT_SKILL)
})

test("team mode never plans a code scan", async () => {
  const plan = await planFill(repo, ["/work/app/a.md"], ["claude"], "project", home, "team")
  expect(plan.codeScan).toBe(false)
  expect(plan.skills).toEqual([])
})

test("an unchosen mode leaves the code scan undecided", async () => {
  const plan = await planFill(repo, ["/work/app/a.md"], ["claude"], "project", home, null)
  expect(plan.codeScan).toBeNull()
  expect(plan.skills).toEqual([])
})

test("enough files means no code scan", async () => {
  const files = ["a", "b", "c"].map((f) => `/work/app/${f}.md`)
  const plan = await planFill(repo, files, ["claude"], "project", home, "local")
  expect(plan.codeScan).toBe(false)
  expect(plan.skills).toEqual([])
})

test("the skill writes the four overview documents through the write tool with the given repo label", () => {
  expect(IMPORT_SKILL).toContain("team_knowledge_write_document")
  for (const slug of ["architecture", "modules", "conventions", "build-and-run"]) {
    expect(IMPORT_SKILL).toContain(`\`${slug}\``)
  }
  expect(IMPORT_SKILL).toContain("(repo: <label>)")
  expect(IMPORT_SKILL).toMatch(/pass that label as `repo`/i)
  expect(IMPORT_SKILL).toMatch(/only what the code shows/i)
  expect(IMPORT_SKILL).toMatch(/inferring/i)
  expect(IMPORT_SKILL).toContain("map this repo for cairn")
})

test("codeScanPrompt names the repo", () => {
  expect(codeScanPrompt("app")).toBe("map this repo for cairn (repo: app)")
})

async function makeRepo(name: string, readme: string): Promise<{ root: string; label: string }> {
  const root = join(tmp, name)
  await mkdir(root)
  await writeFile(join(root, "README.md"), readme)
  return { root, label: name }
}

test("two repositories' READMEs fill one space without colliding", async () => {
  const a = await makeRepo("a", "# A\n\nRepo a.\n")
  const b = await makeRepo("b", "# B\n\nRepo b.\n")
  const planA = await planFill(a, [join(a.root, "README.md")], [], "project", home, "team")
  const planB = await planFill(b, [join(b.root, "README.md")], [], "project", home, "team")
  const ra = await applyFill(store, planA)
  const rb = await applyFill(store, planB)
  expect(ra.created).toBe(1)
  expect(rb.created).toBe(1)
  expect(ra.titles).toEqual(["A"])
  const docs = (await store.listDocuments()).sort((x, y) => (x.source ?? "").localeCompare(y.source ?? ""))
  expect(docs.map((d) => [d.source, d.repo])).toEqual([
    ["a:README.md", "a"],
    ["b:README.md", "b"],
  ])
  const bBefore = docs[1]!

  await writeFile(join(a.root, "README.md"), "# A\n\nRepo a, edited.\n")
  const again = await applyFill(store, planA)
  expect(again).toMatchObject({ created: 0, updated: 1, unchanged: 0 })
  const after = await store.listDocuments()
  expect(after).toHaveLength(2)
  expect(after.find((d) => d.source === "b:README.md")).toEqual(bBefore)
})

test("applyFill reports progress, skips empty files, and writes the planned skills", async () => {
  const r = await makeRepo("c", "# C\n\nBody.\n")
  await writeFile(join(r.root, "empty.md"), "---\nx: 1\n---\n")
  const files = [join(r.root, "README.md"), join(r.root, "empty.md")]
  const plan = await planFill(r, files, ["claude"], "project", home, "local")
  const seen: [number, number][] = []
  const result = await applyFill(store, plan, (done, total) => seen.push([done, total]))
  expect(seen).toEqual([
    [1, 2],
    [2, 2],
  ])
  expect(result.empty).toEqual([join(r.root, "empty.md")])
  expect(result.titles).toEqual(["C"])
  const skill = await readFile(join(r.root, ".claude/skills/cairn-import/SKILL.md"), "utf-8")
  expect(skill).toBe(plan.skills[0]!.content)
})
