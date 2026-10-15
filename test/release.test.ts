import { expect, test } from "bun:test"
import { ReleaseError, bump, parseVersion, promote } from "../scripts/release"

const CHANGELOG = `# Changelog

Preamble.

## [Unreleased]

### Added
- A thing somebody will notice.

## [0.6.6] — 2026-09-05

### Added
- The previous thing.
`

test("promote moves the Unreleased entries into a numbered section", () => {
  const out = promote(CHANGELOG, "0.7.0", "2026-09-06")
  expect(out).toContain("## [0.7.0] — 2026-09-06")
  expect(out).toContain("- A thing somebody will notice.")
  // The entry moved rather than being copied: it must not still sit under
  // Unreleased, or the next release ships it a second time.
  const unreleased = out.slice(out.indexOf("## [Unreleased]"), out.indexOf("## [0.7.0]"))
  expect(unreleased.trim()).toBe("## [Unreleased]")
  // And the section it displaced is untouched, in order, below the new one.
  expect(out.indexOf("## [0.7.0]")).toBeLessThan(out.indexOf("## [0.6.6]"))
  expect(out).toContain("- The previous thing.")
})

test("promote refuses an empty Unreleased section", () => {
  // A release with no notes is release notes that say nothing, and this file's
  // own header says those notes ARE the release notes.
  const empty = CHANGELOG.replace("### Added\n- A thing somebody will notice.\n", "")
  expect(() => promote(empty, "0.7.0", "2026-09-06")).toThrow(ReleaseError)
})

test("promote refuses a version the changelog already describes", () => {
  expect(() => promote(CHANGELOG, "0.6.6", "2026-09-06")).toThrow(/already has/)
})

test("promote refuses a changelog with no Unreleased section", () => {
  expect(() => promote(CHANGELOG.replace("## [Unreleased]\n", ""), "0.7.0", "2026-09-06")).toThrow(
    /Unreleased/,
  )
})

test("a version must be x.y.z, because the tag is derived from it", () => {
  expect(parseVersion("0.7.0")).toBe("0.7.0")
  for (const bad of [undefined, "", "v0.7.0", "0.7", "0.7.0-rc1", "latest"]) {
    expect(() => parseVersion(bad)).toThrow(ReleaseError)
  }
})

test("bump sets the version and leaves the rest of package.json alone", () => {
  const pkg = `{\n  "name": "@acme/app",\n  "version": "0.6.6",\n  "type": "module"\n}\n`
  const out = bump(pkg, "0.7.0")
  expect(out).toContain(`"version": "0.7.0"`)
  expect(out).toContain(`"name": "@acme/app"`)
  expect(out).toContain(`"type": "module"`)
})

test("bump refuses a package.json with no version", () => {
  expect(() => bump(`{"name":"x"}`, "0.7.0")).toThrow(ReleaseError)
})

test("the release commit is signed off, so its pull request passes the DCO check", async () => {
  // The git half is not run here (it pushes); this pins the one argument a
  // DCO-gated repository cannot do without.
  const src = await Bun.file(new URL("../scripts/release.ts", import.meta.url)).text()
  expect(src).toContain('["git", "commit", "-s", "-m", `Release ${version}`]')
})
