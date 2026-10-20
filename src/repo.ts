/**
 * Which repository `cairn init` is running in, what to call it, and which of
 * its files are documentation worth importing.
 */

import { readdir, stat } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"

export interface RepoInfo {
  /** The repository's top level, as git reports it. */
  root: string
  /** What its documents are tagged with: safe to use as a `repo` and in a
   *  `<label>:<path>` source. */
  label: string
}

/** Runs git with `args` in `cwd`: its trimmed stdout, or null on any failure. */
export type GitRunner = (args: string[], cwd: string) => Promise<string | null>

const runGit: GitRunner = async (args, cwd) => {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return code === 0 ? out : null
  } catch {
    // git not installed, or `cwd` gone: both mean "no repository here".
    return null
  }
}

/** The repository containing `cwd`, or null when there is none (or no git). */
export async function findRepo(cwd: string, run: GitRunner = runGit): Promise<RepoInfo | null> {
  const top = (await run(["rev-parse", "--show-toplevel"], cwd))?.trim()
  if (!top) return null
  const remote = (await run(["remote", "get-url", "origin"], top))?.trim() ?? null
  return { root: top, label: repoLabel(remote, top) }
}

/** The longest `repo` that `team_knowledge_write_document` accepts. */
const MAX_LABEL = 100

function sanitise(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, MAX_LABEL)
}

/**
 * The origin remote's last path segment without `.git` — the same for
 * `git@host:org/name.git` and `https://host/org/name.git/` — or, with no
 * remote, the root directory's name. Anything outside `[A-Za-z0-9._-]`
 * becomes `-`.
 */
export function repoLabel(remoteUrl: string | null, root: string): string {
  const fromRemote = remoteUrl
    ?.trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop()
  const label = sanitise(fromRemote || basename(root))
  return label === "" ? "repo" : label
}

/** Path segments that hold dependencies, build output, caches or agent
 *  configuration — never a team's own documentation. */
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".venv",
  "venv",
  ".next",
  ".cache",
  ".claude",
  ".cursor",
  ".codex",
  // Where Codex reads skills, cairn's own code-scan skill among them.
  ".agents",
])

/** Instructions for agents, at any level — not documentation of the code. */
const EXCLUDED_FILES = new Set(["AGENTS.md", "CLAUDE.md"])

const MAX_DOC_BYTES = 1024 * 1024

function excluded(rel: string): boolean {
  const segments = rel.split("/")
  if (EXCLUDED_FILES.has(segments[segments.length - 1]!)) return true
  return segments.slice(0, -1).some((s) => EXCLUDED_SEGMENTS.has(s))
}

async function walk(dir: string, rel: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) {
      if (!EXCLUDED_SEGMENTS.has(e.name)) await walk(join(dir, e.name), childRel, out)
    } else if (e.isFile() && e.name.endsWith(".md")) out.push(childRel)
  }
}

/**
 * Lists `.md` files the repository tracks or would track. Untracked-but-not-
 * ignored files count: a doc written yesterday and not committed yet is still
 * the team's. Null when `root` is not inside a git work tree.
 */
async function gitDocs(root: string, run: GitRunner): Promise<string[] | null> {
  const out = await run(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"], root)
  if (out === null) return null
  return [...new Set(out.split("\0").filter((p) => p !== ""))]
}

/**
 * Every importable markdown file under `root`, as absolute paths, sorted.
 *
 * Inside a git repository (the default, `git: true`) the list comes from git,
 * so `.gitignore` is honoured; otherwise, or with `git: false`, it is a
 * recursive walk. Either way, dependency and build folders, agent
 * configuration, `AGENTS.md`/`CLAUDE.md` and files over 1 MiB are left out.
 */
export async function scanDocs(root: string, opts: { git?: boolean } = {}, run: GitRunner = runGit): Promise<string[]> {
  let rels = opts.git === false ? null : await gitDocs(root, run)
  if (rels === null) {
    rels = []
    await walk(root, "", rels)
  }
  const kept: string[] = []
  for (const rel of rels) {
    if (excluded(rel)) continue
    const path = join(root, ...rel.split("/"))
    // A tracked file deleted from the work tree is still listed by git;
    // stat skips it along with anything too large to be a document.
    const s = await stat(path).catch(() => null)
    if (s?.isFile() && s.size <= MAX_DOC_BYTES) kept.push(path)
  }
  return kept.sort()
}

/** How the files spread across the repository's top-level folders — `.` for
 *  files at the root — largest first, ties by name. */
export function topFolders(root: string, files: string[]): { folder: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const segments = relative(root, file).split(sep)
    const folder = segments.length > 1 ? segments[0]! : "."
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  return [...counts]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder))
}
