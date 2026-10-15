import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO = join(import.meta.dir, "..")
const script = () => readFile(join(REPO, "install.sh"), "utf-8")

const hasShellcheck = await Bun.$`command -v shellcheck`.quiet().then(
  () => true,
  () => false,
)

test.skipIf(!hasShellcheck)("passes shellcheck", async () => {
  const p = Bun.spawn(["shellcheck", "-s", "sh", "install.sh"], {
    cwd: REPO, stdout: "pipe", stderr: "pipe",
  })
  expect(await p.exited).toBe(0)
})

if (!hasShellcheck) {
  console.warn(
    "install.test.ts: shellcheck is not installed — skipping the shellcheck test. " +
      "CI runs it instead.",
  )
}

test("never uses sudo", async () => {
  expect(await script()).not.toContain("sudo")
})

test("names the next command exactly once", async () => {
  expect(await script()).toContain("cairn init")
})

// --- running the real script against a local fixture -----------------------
//
// Greps over the source text prove nothing about behaviour: the old
// `toContain("checksums.txt")` assertion would still pass with the comparison
// inverted to `!=`. These run install.sh for real. `CAIRN_BASE_URL` points it
// at a file:// fixture and `CAIRN_INSTALL_DIR` at a temp directory, so nothing
// ever touches the real $HOME/.local/bin.

let root: string
let work: string, fixture: string, installDir: string, shims: string

/**
 * A load guard, not a specification.
 *
 * These hooks make and remove temp directories and assert nothing about how
 * long that takes. On bun's default 5s budget one of them timed out during a
 * run with several test suites going at once -- reported as `(fail) the installer says where it is downloading from`,
 * a test that measures no timing at all, with `a beforeEach/afterEach hook
 * timed out`. The name in that output is whichever test straddled the budget,
 * so it is not evidence about that test.
 *
 * The number is deliberately far past anything filesystem contention plausibly
 * costs. It exists so that a loaded machine produces a slow suite rather than a
 * red one; an actual hang still fails, just later.
 */
const HOOK_TIMEOUT_MS = 30_000

/** A fake `uname` so the platform under test is the one we chose, not the host's. */
async function fakeUname(os: string, arch: string): Promise<void> {
  const path = join(shims, "uname")
  await writeFile(
    path,
    `#!/bin/sh\ncase "$1" in\n  -s) echo "${os}" ;;\n  -m) echo "${arch}" ;;\nesac\n`,
    "utf-8",
  )
  await chmod(path, 0o755)
}

const FAKE_BINARY = "#!/bin/sh\necho 'i am a cairn binary'\n"

/** Publish an asset plus a checksums.txt, optionally a wrong one. */
async function publish(asset: string, checksum: "good" | "bad"): Promise<void> {
  await writeFile(join(fixture, asset), FAKE_BINARY, "utf-8")
  const real = new Bun.CryptoHasher("sha256").update(FAKE_BINARY).digest("hex")
  const listed = checksum === "good" ? real : "0".repeat(64)
  // Two spaces before the name: the format sha256sum emits and the script greps.
  await writeFile(join(fixture, "checksums.txt"), `${listed}  ${asset}\n`, "utf-8")
}

async function runInstall() {
  const proc = Bun.spawn(["sh", join(REPO, "install.sh")], {
    cwd: work,
    env: {
      ...process.env,
      PATH: `${shims}:${process.env.PATH}`,
      HOME: work,
      CAIRN_BASE_URL: `file://${fixture}`,
      CAIRN_INSTALL_DIR: installDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

const installed = () => stat(join(installDir, "cairn")).then(() => true, () => false)

beforeEach(async () => {
  // One `mkdtemp` and three `mkdir`s rather than three `mkdtemp`s, and one `rm`
  // rather than three: siblings under a single root are removed by removing it.
  // Halving the syscalls does not make the timeout above unnecessary -- it
  // lowers the exposure that made it necessary.
  root = await mkdtemp(join(tmpdir(), "cairn-install-"))
  work = join(root, "work")
  fixture = join(root, "fixture")
  shims = join(root, "shims")
  for (const d of [work, fixture, shims]) await mkdir(d)
  installDir = join(work, "bin")
}, HOOK_TIMEOUT_MS)

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
}, HOOK_TIMEOUT_MS)

test("a matching checksum installs the binary", async () => {
  // The control for the mismatch test below: without it, a script that
  // refused to install anything at all would pass that test for free.
  await fakeUname("Darwin", "arm64")
  await publish("cairn-darwin-arm64", "good")
  const { out, code } = await runInstall()
  expect(code).toBe(0)
  expect(await installed()).toBe(true)
  expect(await readFile(join(installDir, "cairn"), "utf-8")).toBe(FAKE_BINARY)
  expect((await stat(join(installDir, "cairn"))).mode & 0o111).toBeGreaterThan(0)
  expect(out).toContain("Installed cairn to")
  // Local first: the next step must not send a newcomer to sign in for an
  // account `cairn init --local` does not need.
  expect(out).toContain("Next: cairn init")
  expect(out).not.toContain("cairn login")
})

test("a checksum mismatch aborts and installs nothing", async () => {
  await fakeUname("Darwin", "arm64")
  await publish("cairn-darwin-arm64", "bad")
  const { err, code } = await runInstall()
  expect(code).not.toBe(0)
  expect(err).toContain("Checksum mismatch")
  expect(err).toContain("Refusing to install")
  // Nothing on PATH, not even a partial download.
  expect(await installed()).toBe(false)
})

test("an asset with no checksum listed aborts", async () => {
  await fakeUname("Darwin", "arm64")
  await writeFile(join(fixture, "cairn-darwin-arm64"), FAKE_BINARY, "utf-8")
  await writeFile(join(fixture, "checksums.txt"), "deadbeef  cairn-linux-x64\n", "utf-8")
  const { err, code } = await runInstall()
  expect(code).not.toBe(0)
  expect(err).toContain("No checksum listed")
  expect(await installed()).toBe(false)
})

test("an unsupported platform exits naming the ones that are supported", async () => {
  await fakeUname("Plan9", "sparc")
  const { err, code } = await runInstall()
  expect(code).not.toBe(0)
  expect(err).toContain("No cairn build for Plan9-sparc")
  expect(err).toContain("darwin-arm64")
  expect(err).toContain("darwin-x64")
  expect(err).toContain("linux-x64")
  expect(await installed()).toBe(false)
})

test("each supported platform maps to its own asset name", async () => {
  // The mapping is otherwise only exercised for darwin-arm64 above, and a
  // wrong asset name is a 404 on a stranger's machine.
  for (const [os, arch, asset] of [
    ["Darwin", "arm64", "cairn-darwin-arm64"],
    ["Darwin", "x86_64", "cairn-darwin-x64"],
    ["Linux", "x86_64", "cairn-linux-x64"],
  ] as const) {
    await fakeUname(os, arch)
    await publish(asset, "good")
    const { code } = await runInstall()
    expect(code).toBe(0)
    expect(await installed()).toBe(true)
    await rm(installDir, { recursive: true, force: true })
  }
})

test("a missing asset aborts naming the URL it tried", async () => {
  await fakeUname("Darwin", "arm64")
  const { err, code } = await runInstall()
  expect(code).not.toBe(0)
  expect(err).toContain("Download failed")
  expect(await installed()).toBe(false)
})

test("the installer says where it is downloading from", async () => {
  // CAIRN_BASE_URL exists so the tests can point at a local fixture, which
  // means the download source is no longer a compile-time constant. An
  // installer that silently obeys an inherited variable, on the one code path
  // that runs before anything else exists, must at least say what it is doing.
  await fakeUname("Darwin", "arm64")
  await publish("cairn-darwin-arm64", "good")
  const { out, code } = await runInstall()
  expect(code).toBe(0)
  expect(out).toContain(`file://${fixture}`)
})
