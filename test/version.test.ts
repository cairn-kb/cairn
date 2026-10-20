import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { BUILT_AT, COMMIT, COMPILED, isCompiledPath, VERSION, versionLine } from "../src/version"

const ROOT = resolve(import.meta.dir, "..")

test("a source checkout is stamped as a dev build", () => {
  // CI overwrites this module before compiling. The committed default must
  // make a source checkout obvious rather than impersonate a release.
  expect(VERSION).toBe("0.0.0-dev")
  expect(COMPILED).toBe(false)
})

test("a compiled binary's embedded paths are recognised, a checkout's are not", () => {
  expect(isCompiledPath("/$bunfs/root/cairn")).toBe(true)
  expect(isCompiledPath("B:\\~BUN\\root\\cairn.exe")).toBe(true)
  expect(isCompiledPath(join(ROOT, "src", "version.ts"))).toBe(false)
  expect(isCompiledPath("/home/you/bunfs/src/version.ts")).toBe(false)
})

// The release workflow stamps COMPILED = true before compiling; anybody else's
// `bun build --compile` does not. Such a binary must still know it is one, or
// `init` writes `bun /$bunfs/root/cairn mcp` into .mcp.json — a path that only
// exists inside the binary. Compiled for real, without the stamp.
test("a binary compiled without the release stamp still knows it is compiled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-compiled-"))
  try {
    const entry = join(dir, "entry.ts")
    await writeFile(entry, `import { COMPILED } from ${JSON.stringify(join(ROOT, "src", "version.ts"))}\nconsole.log(String(COMPILED))\n`)
    const bin = join(dir, "probe")
    // Compile from the temp dir. Bun 1.3.6 writes a binary with a zeroed
    // header, and still exits 0, when --outfile is on a different filesystem
    // from the cwd — which it is on runners that mount /tmp as tmpfs.
    const build = Bun.spawnSync(["bun", "build", "--compile", "--outfile", bin, entry], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    expect(build.exitCode).toBe(0)
    const run = Bun.spawnSync([bin], { stdout: "pipe", stderr: "pipe" })
    expect(run.stdout.toString().trim()).toBe("true")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)

test("BUILT_AT is an ISO timestamp", () => {
  expect(Number.isNaN(Date.parse(BUILT_AT))).toBe(false)
})

test("the version line names version, commit and build date", () => {
  const line = versionLine()
  expect(line).toContain(VERSION)
  expect(line).toContain(COMMIT)
  expect(line).toContain(BUILT_AT.slice(0, 10))
})

// --- the shipped version and the notes that describe it ---

test("package.json's version has a section in CHANGELOG.md describing it", () => {
  // This pairing was guarded ONLY by `.github/workflows/ci.yml`
  // (jq + awk) and again at tag time by `release.yml`, so `bun test` could not
  // catch a bump with no notes -- you found out from CI, on the pull request,
  // one push after the mistake.
  //
  // `test/ci-workflow.test.ts` executes the version job's own script, but
  // against SYNTHETIC diffs and changelogs. Nothing read this repository's
  // actual two files and asked whether they agree, which is the state a person
  // can actually get wrong.
  const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { version: string }).version
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8")

  // The real heading shape, dated: `## [0.6.7] — 2026-09-07`. Matching a bare
  // `## [x.y.z]` would also accept `## [Unreleased]`-style placeholders and,
  // worse, would pass on the section `bun run release` creates before it fills
  // the date in.
  const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] — \\d{4}-\\d{2}-\\d{2}$`, "m")
  expect(changelog).toMatch(heading)

  // Two controls. The first proves the file was read and parsed rather than
  // returning something that satisfies any regex; the second proves the regex
  // discriminates, since a pattern that matched everything would satisfy the
  // assertion above no matter what either file said.
  expect(changelog).toContain("## [Unreleased]")
  expect(changelog).not.toMatch(/^## \[0\.0\.0-nope\] — \d{4}-\d{2}-\d{2}$/m)
})
