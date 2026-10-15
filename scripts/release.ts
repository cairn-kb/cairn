#!/usr/bin/env bun
/**
 * Cut a release.
 *
 * A feature PR does not name a version. It adds its entry under
 * `## [Unreleased]`, and this script is the one place a version number is ever
 * chosen — which is why concurrent pull requests cannot collide on it: the
 * merge order does not decide who owns a number, because a merge names none.
 *
 * It also means a release is a DECISION rather than a side effect of merging.
 * Group what makes sense to install together.
 *
 * Usage:
 *   bun run release 0.7.0            # promote, bump, branch, push, open the PR
 *   bun run release 0.7.0 --dry-run  # print what it would write, touch nothing
 *
 * After the PR merges: `git tag v0.7.0 && git push origin v0.7.0`. release.yml
 * refuses to publish a tag whose version disagrees with package.json or whose
 * changelog section is missing, so those two checks are the positive control on
 * this script rather than a second copy of its rules.
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

export class ReleaseError extends Error {}

/** `x.y.z`, nothing else. A tag is derived from this and must not be guessed at. */
export function parseVersion(raw: string | undefined): string {
  if (!raw || !/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new ReleaseError(`usage: bun run release <x.y.z> [--dry-run] (got ${raw ?? "nothing"})`)
  }
  return raw
}

/**
 * Move everything under `## [Unreleased]` into a section of its own, and leave a
 * fresh empty `## [Unreleased]` above it.
 *
 * Refuses an empty Unreleased section: a release with no entry ships notes that
 * say nothing to the person installing the binary, and this file's own header
 * says those notes ARE the release notes.
 */
export function promote(changelog: string, version: string, date: string): string {
  const heading = "## [Unreleased]"
  const start = changelog.indexOf(`${heading}\n`)
  if (start === -1) throw new ReleaseError(`CHANGELOG.md has no "${heading}" section`)
  const rest = changelog.slice(start + heading.length + 1)
  const nextIndex = rest.indexOf("\n## [")
  const body = nextIndex === -1 ? rest : rest.slice(0, nextIndex + 1)
  const after = nextIndex === -1 ? "" : rest.slice(nextIndex + 1)
  if (body.trim() === "") {
    throw new ReleaseError(
      `nothing to release: "${heading}" is empty. A release describes what changed for ` +
        "the person installing the binary.",
    )
  }
  if (changelog.includes(`## [${version}]`)) {
    throw new ReleaseError(`CHANGELOG.md already has a "## [${version}]" section`)
  }
  return (
    changelog.slice(0, start) +
    `${heading}\n\n## [${version}] — ${date}\n` +
    body.replace(/^\n+/, "\n") +
    after
  )
}

/** The version `package.json` declares, with the file's own formatting kept. */
export function bump(packageJson: string, version: string): string {
  const replaced = packageJson.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`)
  if (replaced === packageJson) throw new ReleaseError("package.json has no version to set")
  return replaced
}

async function run(cmd: string[], allowFail = false): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0 && !allowFail) throw new ReleaseError(`${cmd.join(" ")} failed: ${err.trim()}`)
  return out.trim()
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run")
  const version = parseVersion(argv.find((a) => !a.startsWith("--")))
  const date = new Date().toISOString().slice(0, 10)

  const changelogPath = join(ROOT, "CHANGELOG.md")
  const packagePath = join(ROOT, "package.json")
  const changelog = promote(await readFile(changelogPath, "utf-8"), version, date)
  const packageJson = bump(await readFile(packagePath, "utf-8"), version)

  if (dryRun) {
    const section = changelog.slice(
      changelog.indexOf(`## [${version}]`),
      changelog.indexOf("\n## [", changelog.indexOf(`## [${version}]`) + 1),
    )
    console.log(`would release ${version} on ${date}, with these notes:\n`)
    console.log(section)
    return
  }

  // Refusals before any write. A release cut from a dirty or stale tree ships
  // something nobody reviewed, and the tag would name a commit that is not what
  // was tested.
  if (await run(["git", "status", "--porcelain"])) {
    throw new ReleaseError("the working tree is dirty — commit or stash first")
  }
  if ((await run(["git", "branch", "--show-current"])) !== "main") {
    throw new ReleaseError("releases are cut from main")
  }
  await run(["git", "fetch", "--quiet", "origin", "main"])
  if ((await run(["git", "rev-parse", "HEAD"])) !== (await run(["git", "rev-parse", "origin/main"]))) {
    throw new ReleaseError("main is not level with origin/main — pull first")
  }

  const branch = `release-${version}`
  await run(["git", "switch", "-c", branch])
  await writeFile(changelogPath, changelog)
  await writeFile(packagePath, packageJson)
  await run(["git", "add", "CHANGELOG.md", "package.json"])
  // Signed off: the release branch's pull request runs the DCO check too.
  await run(["git", "commit", "-s", "-m", `Release ${version}`])
  await run(["git", "push", "--quiet", "-u", "origin", branch])
  console.log(`${branch} pushed. Open the PR, and after it merges:`)
  console.log(`  git switch main && git pull && git tag v${version} && git push origin v${version}`)
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2))
  } catch (err) {
    console.error(err instanceof ReleaseError ? err.message : err)
    process.exit(1)
  }
}
