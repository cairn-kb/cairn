import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const CI = join(import.meta.dir, "..", ".github", "workflows", "ci.yml")

async function ci(): Promise<any> {
  return Bun.YAML.parse(await readFile(CI, "utf-8"))
}

test("the workflow test reads the real file rather than passing on an empty document", async () => {
  // The positive control release-workflow.test.ts already keeps: an assertion
  // about a document that failed to parse is an assertion about nothing.
  const doc = await ci()
  expect(doc.name).toBe("ci")
  expect(Object.keys(doc.jobs)).toContain("version")
})

// `on: pull_request` with no `types:` defaults to
// [opened, synchronize, reopened]. `labeled` is not in that set, so adding
// `no-release` fired no run, and the run already on the PR carried a payload
// from before the label existed — empty `labels`, the `case` falls through,
// and the job fails on the check it was labelled to skip. Re-running replays
// the ORIGINAL payload, so it fails identically however many times you try.
//
// The label is the documented escape hatch for the judgement calls a rule
// cannot make, and it shipped non-functional. Nobody found out until a release
// needed it, which is when such a call comes up.
test("labelling or unlabelling a pull request fires a run, so the escape hatch is reachable", async () => {
  const types = (await ci()).on.pull_request?.types
  expect(types).toBeDefined()
  expect(types).toContain("labeled")
  // The mirror, and the more dangerous half: without `unlabeled`, REMOVING
  // `no-release` leaves the green run it produced standing. The check would
  // then say "no release needed" about a pull request that no longer claims
  // it — a stale pass, where the missing `labeled` was only a stuck failure.
  expect(types).toContain("unlabeled")
  // The default set has to be restated once `types` is named at all, or the
  // normal path stops running entirely.
  expect(types).toContain("opened")
  expect(types).toContain("synchronize")
  expect(types).toContain("reopened")
})

/**
 * The version job's script, executed against real git repositories.
 *
 * Extracted from `ci.yml` itself rather than copied here: a copy would drift,
 * and the whole finding is that a condition nobody exercises
 * is a condition nobody knows the behaviour of. This runs the same characters
 * GitHub runs.
 *
 * Two of the branches below had NEVER executed anywhere when they were
 * written. The `no-release` hatch could not be reached at all. And the
 * `release-x.y.z` leg has never run in CI either: releases are cut by
 * `bun run release`, whose git half had not been run at the time, so no
 * release branch has ever opened a pull request. Both are release-time paths,
 * which is exactly when nobody can afford to debug them.
 */
async function versionScript(): Promise<string> {
  const step = (await ci()).jobs.version.steps.find((s: any) => typeof s.run === "string")
  if (!step) throw new Error("ci.yml has no version step with a `run:` script")
  return step.run
}

const BASE_CHANGELOG = `# Changelog

## [Unreleased]

### Added

- something already described

## [0.6.6] — 2026-09-05

### Added

- the previous release
`

type Fixture = {
  /** The pull request's head branch, which the release-branch case matches on. */
  headRef: string
  /** Comma-joined, exactly as `join(…labels.*.name, ',')` produces. */
  labels?: string
  /** Applied on the head branch before the script runs. */
  change: (dir: string, write: (p: string, body: string) => Promise<void>) => Promise<void>
  /** Defaults to the base version, i.e. no bump. */
  version?: string
}

async function runVersionJob(f: Fixture): Promise<{ code: number; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ci-version-"))
  try {
    const git = (...args: string[]) =>
      Bun.spawn(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited
    const write = async (p: string, body: string) => {
      await mkdir(dirname(join(dir, p)), { recursive: true })
      await writeFile(join(dir, p), body, "utf-8")
    }

    await git("init", "-b", "main")
    await write("package.json", JSON.stringify({ version: "0.6.6" }, null, 2) + "\n")
    await write("CHANGELOG.md", BASE_CHANGELOG)
    await write("src/cli.ts", "export const a = 1\n")
    await git("add", "-A")
    await git("commit", "-m", "base")
    // `origin` is the fixture itself: the script fetches `origin/$BASE`, and a
    // repository can serve as its own remote.
    await git("remote", "add", "origin", dir)
    await git("fetch", "--no-tags", "origin", "main")

    await git("checkout", "-b", f.headRef)
    if (f.version) await write("package.json", JSON.stringify({ version: f.version }, null, 2) + "\n")
    await f.change(dir, write)
    await git("add", "-A")
    await git("commit", "--allow-empty", "-m", "change")

    const proc = Bun.spawn(["sh", "-c", await versionScript()], {
      cwd: dir,
      env: { ...process.env, BASE: "main", HEAD_REF: f.headRef, LABELS: f.labels ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, out: out + err }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Touch the shipped CLI without describing it — the common failing shape. */
const touchCli: Fixture["change"] = (_dir, write) => write("src/cli.ts", "export const a = 2\n")
const describeIt: Fixture["change"] = async (_dir, write) => {
  await write("src/cli.ts", "export const a = 2\n")
  await write("CHANGELOG.md", BASE_CHANGELOG.replace("- something already described", "- something already described\n- and this change"))
}

test("the no-release label takes the escape hatch, which the labeling fix made reachable", async () => {
  // A version that must not move, on a branch that
  // is not a release branch. Without the label this is a failure (the next
  // test); with it the job exits 0 before any check runs.
  const { code, out } = await runVersionJob({
    headRef: "some-feature",
    labels: "no-release",
    version: "0.6.7",
    change: touchCli,
  })
  expect(code).toBe(0)
  expect(out).toContain("no-release label set")
})

test("the label is matched as a whole entry among others, not as a substring", async () => {
  // `case ",$LABELS,"` with commas on both sides. A label list is joined
  // without spaces by `join(…, ',')`, and a bare `*no-release*` would also
  // match a label like `needs-no-release-note`.
  const both = await runVersionJob({
    headRef: "some-feature", labels: "ready:agent,no-release,bug", version: "0.6.7", change: touchCli,
  })
  expect(both.code).toBe(0)
  const lookalike = await runVersionJob({
    headRef: "some-feature", labels: "needs-no-release-note", version: "0.6.7", change: touchCli,
  })
  expect(lookalike.code).toBe(1)
})

test("without the label, a feature branch may not move the version", async () => {
  const { code, out } = await runVersionJob({
    headRef: "some-feature", version: "0.6.7", change: touchCli,
  })
  expect(code).toBe(1)
  expect(out).toContain("outside a release branch")
})

test("a release branch must move the version, and must describe it", async () => {
  // This whole leg has never run in CI: releases are cut by `bun run release`,
  // whose git half had not been run when this was written, so no release
  // branch has ever opened a pull request.
  const good = await runVersionJob({
    headRef: "release-0.6.7",
    version: "0.6.7",
    change: (_d, write) => write("CHANGELOG.md", BASE_CHANGELOG.replace("## [Unreleased]", "## [Unreleased]\n\n## [0.6.7] — 2026-09-06\n\n### Added\n\n- the new release")),
  })
  expect(good.code).toBe(0)
  expect(good.out).toContain("0.6.6 -> 0.6.7")

  const noBump = await runVersionJob({ headRef: "release-0.6.7", change: touchCli })
  expect(noBump.code).toBe(1)
  expect(noBump.out).toContain("must set a new version")

  const undescribed = await runVersionJob({ headRef: "release-0.6.7", version: "0.6.7", change: touchCli })
  expect(undescribed.code).toBe(1)
  expect(undescribed.out).toContain("no '## [0.6.7]' section")
})

test("a branch merely ABOUT releases is not granted the right to bump", async () => {
  // The pattern is the exact shape `bun run release` creates. `release-ritual`
  // and `release-docs` are branches about releases, not releases.
  const { code, out } = await runVersionJob({
    headRef: "release-ritual", version: "0.6.7", change: touchCli,
  })
  expect(code).toBe(1)
  expect(out).toContain("outside a release branch")
})

test("a CLI change needs a changelog entry, and one that is not already released", async () => {
  const undescribed = await runVersionJob({ headRef: "some-feature", change: touchCli })
  expect(undescribed.code).toBe(1)
  expect(undescribed.out).toContain("adds nothing under '## [Unreleased]'")

  const described = await runVersionJob({ headRef: "some-feature", change: describeIt })
  expect(described.code).toBe(0)
  expect(described.out).toContain("describes this change under [Unreleased]")

  // Editing an ALREADY-RELEASED section is not describing your own change —
  // the reason the check compares the section rather than grepping the diff.
  const wrongSection = await runVersionJob({
    headRef: "some-feature",
    change: async (_d, write) => {
      await write("src/cli.ts", "export const a = 2\n")
      await write("CHANGELOG.md", BASE_CHANGELOG.replace("- the previous release", "- the previous release, reworded"))
    },
  })
  expect(wrongSection.code).toBe(1)
})

test("a change that touches no CLI source needs no entry", async () => {
  // Only ROOT `src/` counts. A nested `src/` elsewhere (another workspace
  // package) is deliberately outside the check, so this writes exactly that:
  // a pathspec that matched `src/` anywhere would fail here.
  const { code, out } = await runVersionJob({
    headRef: "some-feature",
    change: (_d, write) => write("packages/protocol/src/x.ts", "export const b = 2\n"),
  })
  expect(code).toBe(0)
  expect(out).toContain("No CLI source changed")
})
