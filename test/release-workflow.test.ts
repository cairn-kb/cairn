import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const workflow = () =>
  readFile(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf-8")

// OpenTUI picks its native library from eight per-platform optionalDependencies
// via process.platform/process.arch. `bun install` fetches only the HOST's, and
// Bun resolves that dispatch statically — so without these wildcards the two
// darwin targets fail to build on the linux runner. The failure is loud rather
// than silent, but it fails the release, so it is worth a test.
test("the release job installs every platform's native package", async () => {
  const yml = await workflow()
  expect(yml).toContain("--os '*'")
  expect(yml).toContain("--cpu '*'")
})

// Both glibc and musl copies of libopentui.so get embedded otherwise, because
// the loader branches on OPENTUI_LIBC at runtime. 158 MB against 132 MB.
test("the linux build folds away the musl branch", async () => {
  const yml = await workflow()
  expect(yml).toContain(`--define 'process.env.OPENTUI_LIBC="glibc"'`)
})

const selftestWorkflow = () =>
  readFile(join(import.meta.dir, "..", ".github", "workflows", "native-selftest.yml"), "utf-8")

type Job = {
  uses?: string
  needs?: string | string[]
  strategy?: { matrix?: { include?: { target?: string }[] } }
  steps?: { run?: string }[]
}
const needsOf = (job: Job | undefined): string[] =>
  job?.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]

// `bun test` runs interpreted, and interpreted is not the binary: on macOS it
// found an SQLite that loads extensions while the compiled binary got Apple's,
// which does not. So only the compiled binary on each target can say whether
// vec0 loads and FTS5 still works, and it has to say so before anything ships.
test("release calls the native self-test for every target before publishing", async () => {
  const release = Bun.YAML.parse(await workflow()) as { jobs: Record<string, Job> }
  const [name, selftest] =
    Object.entries(release.jobs).find(([, job]) => job.uses === "./.github/workflows/native-selftest.yml") ?? []
  expect(name).toBeDefined()
  expect(needsOf(selftest)).toContain("build")
  expect(needsOf(release.jobs.publish)).toContain(name!)

  const native = Bun.YAML.parse(await selftestWorkflow()) as { jobs: Record<string, Job> }
  const targets = Object.values(native.jobs).flatMap((job) =>
    (job.strategy?.matrix?.include ?? []).map((entry) => entry.target),
  )
  expect(targets).toEqual(expect.arrayContaining(["darwin-arm64", "darwin-x64", "linux-x64"]))
})

// A `gh release create` step added to the wrong job would publish from
// unreviewed binaries, or publish twice. Only `publish` runs after both
// `build` and `selftest`, so it is the only job allowed to call it.
test("gh release create appears only in the publish job", async () => {
  const release = Bun.YAML.parse(await workflow()) as { jobs: Record<string, Job> }
  for (const [name, job] of Object.entries(release.jobs)) {
    const calls = (job.steps ?? []).some((step) => (step.run ?? "").includes("gh release create"))
    expect(calls).toBe(name === "publish")
  }
})

test("the workflow test reads the real file rather than passing on an empty string", async () => {
  // A readFile that silently returned "" would make both tests above pass by
  // vacuous truth in reverse — toContain on "" fails, but a future rewrite to
  // `not.toContain` would not. Pin something unrelated and known-present.
  const yml = await workflow()
  expect(yml).toContain("bun build --compile")
  expect(yml.length).toBeGreaterThan(500)
})
