import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findRepo, repoLabel, scanDocs, topFolders } from "../src/repo"

let dir: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "cairn-repo-")))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(rel: string, content = "# x\n\nbody\n"): Promise<void> {
  const path = join(dir, rel)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content)
}

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`)
}

test("repoLabel takes the remote's last path segment without .git", () => {
  expect(repoLabel("git@github.com:acme/app.git", "/x/y")).toBe("app")
  expect(repoLabel("https://github.com/acme/app", "/x/y")).toBe("app")
  expect(repoLabel("https://github.com/acme/app.git/", "/x/y")).toBe("app")
})

test("repoLabel falls back to the root's basename, sanitised", () => {
  expect(repoLabel(null, "/x/My App")).toBe("My-App")
  expect(repoLabel("", "/x/web.site")).toBe("web.site")
})

test("repoLabel sanitises a remote's name too", () => {
  expect(repoLabel("https://host/org/my%20app+v2.git", "/x/y")).toBe("my-20app-v2")
})

test("repoLabel ignores a query or fragment on the remote", () => {
  expect(repoLabel("https://host/org/app.git?ref=main", "/x/y")).toBe("app")
  expect(repoLabel("https://host/org/app#readme", "/x/y")).toBe("app")
  expect(repoLabel("https://host/org/app.git/?a=1#b", "/x/y")).toBe("app")
})

test("repoLabel treats a remote naming '.', '..' or nothing as missing", () => {
  expect(repoLabel("https://host/org/..", "/x/My App")).toBe("My-App")
  expect(repoLabel("https://host/org/.", "/x/My App")).toBe("My-App")
  expect(repoLabel("../", "/x/My App")).toBe("My-App")
  expect(repoLabel("?x=1#y", "/x/My App")).toBe("My-App")
  expect(repoLabel(null, "/")).toBe("repo")
})

test("findRepo returns null when git finds nothing", async () => {
  expect(await findRepo(dir, async () => null)).toBeNull()
})

test("findRepo reads the top level and the origin remote", async () => {
  const calls: string[][] = []
  const run = async (args: string[]): Promise<string | null> => {
    calls.push(args)
    if (args[0] === "rev-parse") return "/work/thing\n"
    if (args[0] === "remote") return "git@github.com:acme/widgets.git\n"
    return null
  }
  expect(await findRepo(dir, run)).toEqual({ root: "/work/thing", label: "widgets" })
  expect(calls).toContainEqual(["rev-parse", "--show-toplevel"])
  expect(calls).toContainEqual(["remote", "get-url", "origin"])
})

test("findRepo with no remote labels by directory name", async () => {
  const run = async (args: string[]): Promise<string | null> =>
    args[0] === "rev-parse" ? "/work/Side Project" : null
  expect(await findRepo(dir, run)).toEqual({ root: "/work/Side Project", label: "Side-Project" })
})

test("findRepo against a real git repository", async () => {
  await git(["init", "-q"], dir)
  await mkdir(join(dir, "sub"))
  const found = await findRepo(join(dir, "sub"))
  expect(found?.root).toBe(dir)
  expect(found?.label).toBe(dir.split("/").pop()!.replace(/[^A-Za-z0-9._-]/g, "-"))
})

test("scanDocs keeps docs and drops build output, agent files and oversized files", async () => {
  await put("README.md")
  await put("docs/a.md")
  await put("docs/adr/0001.md")
  await put("node_modules/x/README.md")
  await put("dist/y.md")
  await put(".claude/skills/z/SKILL.md")
  await put(".agents/skills/z/SKILL.md")
  await put("AGENTS.md")
  await put("sub/CLAUDE.md")
  await put("big.md", "x".repeat(2 * 1024 * 1024))
  await put("notes.txt")
  expect(await scanDocs(dir, { git: false })).toEqual([
    join(dir, "README.md"),
    join(dir, "docs/a.md"),
    join(dir, "docs/adr/0001.md"),
  ])
})

test("scanDocs in a git repository honours .gitignore and still sees untracked docs", async () => {
  await git(["init", "-q"], dir)
  await put(".gitignore", "private/\n")
  await put("README.md")
  await put("private/p.md")
  await put("docs/new.md")
  await put("dist/y.md")
  expect(await scanDocs(dir)).toEqual([join(dir, "README.md"), join(dir, "docs/new.md")])
})

test("scanDocs falls back to a walk outside a git repository", async () => {
  await put("README.md")
  expect(await scanDocs(dir)).toEqual([join(dir, "README.md")])
})

async function symlinkedDoc(): Promise<string> {
  // A secret outside the scanned tree, reachable through a `.md` symlink inside it.
  const outside = await realpath(await mkdtemp(join(tmpdir(), "cairn-outside-")))
  await writeFile(join(outside, "id_rsa"), "PRIVATE KEY\n")
  await symlink(join(outside, "id_rsa"), join(dir, "notes.md"))
  await mkdir(join(dir, "docs"), { recursive: true })
  await symlink(join(outside, "id_rsa"), join(dir, "docs", "key.md"))
  return outside
}

test("scanDocs never follows a symlinked .md out of the tree (walk)", async () => {
  await put("README.md")
  const outside = await symlinkedDoc()
  try {
    expect(await scanDocs(dir, { git: false })).toEqual([join(dir, "README.md")])
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test("scanDocs never follows a symlinked .md out of the tree (git, tracked and untracked)", async () => {
  await git(["init", "-q"], dir)
  await put("README.md")
  const outside = await symlinkedDoc()
  try {
    // notes.md tracked, docs/key.md left untracked: both must be skipped.
    await git(["add", "notes.md"], dir)
    expect(await scanDocs(dir)).toEqual([join(dir, "README.md")])
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test("topFolders groups by first segment, root files as '.', largest first", () => {
  const files = ["README.md", "docs/a.md", "docs/b/c.md", "adr/1.md", "CHANGES.md", "docs/d.md"].map((f) =>
    join("/r", f),
  )
  expect(topFolders("/r", files)).toEqual([
    { folder: "docs", count: 3 },
    { folder: ".", count: 2 },
    { folder: "adr", count: 1 },
  ])
})
