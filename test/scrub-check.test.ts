import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { loadPatterns, parseArgs, parsePatterns, scan } from "../scripts/scrub-check"

const SCRIPT = resolve(import.meta.dir, "..", "scripts", "scrub-check.ts")

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cairn-scrub-")) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel: string, body: string) => {
  await mkdir(join(root, rel, ".."), { recursive: true })
  await writeFile(join(root, rel), body)
}

// A neutral sample: the mechanism is what is under test, not any real list.
const SAMPLE = "# words that must not ship\n\n/\\bwidget-\\d+\\b/i\nsecret-project\n"
const rules = () => parsePatterns(SAMPLE)

test("a pattern file yields one rule per non-comment line, flags honoured", () => {
  const r = rules()
  expect(r.map((x) => x.name)).toEqual(["/\\bwidget-\\d+\\b/i", "secret-project"])
  expect(r[0]!.re.test("see WIDGET-12")).toBe(true)
  expect(r[1]!.re.test("the secret-project plan")).toBe(true)
})

test("an invalid pattern fails loudly instead of being skipped", () => {
  expect(() => parsePatterns("ok\n/(unclosed/\n")).toThrow(/line 2/)
})

test("a clean tree has no findings", async () => {
  await put("src/a.ts", "export const a = 1 // plain comment\n")
  expect(scan(root, rules())).toEqual([])
})

// Positive control: a planted match is reported, with file, line and rule.
test("a finding names file, line and rule", async () => {
  await put("src/a.ts", "ok\n// widget-7 is broken\n")
  expect(scan(root, rules())).toEqual([
    { file: "src/a.ts", line: 2, rule: "/\\bwidget-\\d+\\b/i", text: "// widget-7 is broken" },
  ])
})

test("with no patterns the scan reports nothing", async () => {
  await put("src/a.ts", "// widget-7 is broken\n")
  expect(scan(root, [])).toEqual([])
})

test("a line marked scrub-allow is skipped", async () => {
  await put("src/a.ts", "// widget-7 is the upstream name // scrub-allow\n")
  expect(scan(root, rules())).toEqual([])
})

test("binaries, node_modules and .git are not read", async () => {
  await put("assets/x.png", "widget-1")
  await put("node_modules/x/index.js", "widget-1")
  await put(".git/config", "widget-1")
  expect(scan(root, rules())).toEqual([])
})

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SCRUB_PATTERNS: "", ...env },
  })
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
  return { code: await proc.exited, out }
}

test("the CLI reads --patterns and the SCRUB_PATTERNS variable alike", async () => {
  const tree = join(root, "tree")
  await mkdir(tree)
  await writeFile(join(tree, "a.ts"), "// widget-7\n")
  const file = join(root, "patterns.txt")
  await writeFile(file, SAMPLE)
  expect(loadPatterns(file)).toHaveLength(2)

  const viaFlag = await run([tree, "--patterns", file])
  expect(viaFlag.code).toBe(1)
  expect(viaFlag.out).toContain("a.ts:1:")

  const viaEnv = await run([tree], { SCRUB_PATTERNS: file })
  expect(viaEnv.code).toBe(1)
  expect(viaEnv.out).toContain("a.ts:1:")

  const none = await run([tree])
  expect(none.code).toBe(0)
  expect(none.out).toContain("scrub-check: clean")
})

// Fail closed: anything the CLI does not understand must refuse, never run
// with fewer patterns than asked for and report clean.
test("unknown flags, the `=` form and stray arguments are refused", () => {
  expect(parseArgs([".", "--patterns=p.txt"], {})).toBeNull()
  expect(parseArgs([".", "--gitleak"], {})).toBeNull()
  expect(parseArgs([".", "--patterns"], {})).toBeNull()
  expect(parseArgs([".", "--patterns", "--gitleaks"], {})).toBeNull()
  expect(parseArgs([".", "extra"], {})).toBeNull()
  expect(parseArgs([], {})).toBeNull()
  // The control: what it does understand still parses.
  expect(parseArgs([".", "--patterns", "p.txt", "--gitleaks"], {})).toEqual({ root: ".", patternFile: "p.txt", gitleaks: true })
  expect(parseArgs(["."], { SCRUB_PATTERNS: "e.txt" })).toEqual({ root: ".", patternFile: "e.txt", gitleaks: false })
})

test("a pattern file with no patterns is an error, not a pass", async () => {
  const file = join(root, "empty.txt")
  await writeFile(file, "# only a comment\n\n")
  expect(() => loadPatterns(file)).toThrow(/no patterns/)
})

test("the CLI exits 2 on an unknown flag and on an empty pattern file", async () => {
  const tree = join(root, "tree")
  await mkdir(tree)
  await writeFile(join(tree, "a.ts"), "// widget-7\n")
  const file = join(root, "patterns.txt")
  await writeFile(file, SAMPLE)
  const eqForm = await run([tree, `--patterns=${file}`])
  expect(eqForm.code).toBe(2)
  expect(eqForm.out).toContain("usage:")

  const empty = join(root, "empty.txt")
  await writeFile(empty, "# nothing\n")
  const viaFlag = await run([tree, "--patterns", empty])
  expect(viaFlag.code).toBe(2)
  expect(viaFlag.out).toContain("no patterns")
  const viaEnv = await run([tree], { SCRUB_PATTERNS: empty })
  expect(viaEnv.code).toBe(2)
})
