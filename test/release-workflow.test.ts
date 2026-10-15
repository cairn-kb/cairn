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

test("the workflow test reads the real file rather than passing on an empty string", async () => {
  // A readFile that silently returned "" would make both tests above pass by
  // vacuous truth in reverse — toContain on "" fails, but a future rewrite to
  // `not.toContain` would not. Pin something unrelated and known-present.
  const yml = await workflow()
  expect(yml).toContain("bun build --compile")
  expect(yml.length).toBeGreaterThan(500)
})
