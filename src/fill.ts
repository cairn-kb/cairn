/**
 * The first import `cairn init` offers: the repository's own documentation,
 * tagged with its repo label, or — when there is too little of it — a
 * `cairn-import` skill that lets the user's agent map the code instead.
 * Planning writes nothing; `applyFill` does the work.
 */

import { join, relative, sep } from "node:path"
import type { Agent } from "./agents"
import type { Mode } from "./config"
import { finishTally, importFile, newTally, tally, type ImportSummary } from "./import-file"
import { IMPORT_SKILL, IMPORT_SKILL_DESCRIPTION } from "./import-skill"
import { writeAtomic, type Scope } from "./init"
import type { RepoInfo } from "./repo"
import type { Store } from "@cairn-kb/protocol/types"

/** Fewer importable files than this, and a code scan is offered instead. */
export const CODE_SCAN_THRESHOLD = 3

export interface FillPlan {
  repo: RepoInfo
  /** Absolute paths, imported in this order. */
  files: string[]
  /** Skill files to write: empty unless `codeScan` is true. */
  skills: { path: string; content: string }[]
  /**
   * Whether the user's agent should map the code. True in local mode when
   * there are too few files; false in team mode (agents cannot write
   * documents to a team space) or when there are enough files; null when too
   * few were found but the mode is not chosen yet, which only a dry run sees.
   */
  codeScan: boolean | null
}

/** `<label>:<path relative to the repository root>`, POSIX-separated, so two
 *  repositories' `README.md` never collide in one space. */
export function importSource(repo: RepoInfo, path: string): string {
  return `${repo.label}:${relative(repo.root, path).split(sep).join("/")}`
}

/** Claude Code and Codex read a `SKILL.md` with a name and a description. */
function skillMd(): string {
  return `---\nname: cairn-import\ndescription: ${JSON.stringify(IMPORT_SKILL_DESCRIPTION)}\n---\n\n${IMPORT_SKILL}`
}

/** A Cursor rule with a description and no globs, not always applied: the
 *  agent pulls it in when the description matches the request.
 *  <https://cursor.com/docs/context/rules> */
function cursorRule(): string {
  return `---\ndescription: ${JSON.stringify(IMPORT_SKILL_DESCRIPTION)}\nalwaysApply: false\n---\n\n${IMPORT_SKILL}`
}

function skillFor(agent: Agent, root: string, scope: Scope, home: string): { path: string; content: string } | null {
  switch (agent) {
    case "claude":
      return {
        path: join(scope === "project" ? root : home, ".claude", "skills", "cairn-import", "SKILL.md"),
        content: skillMd(),
      }
    case "codex":
      // Codex's documented user skill location
      // <https://learn.chatgpt.com/docs/build-skills> (formerly
      // developers.openai.com/codex/skills). Global at either scope: Codex's
      // MCP config is global, so one global skill matches it.
      return { path: join(home, ".agents", "skills", "cairn-import", "SKILL.md"), content: skillMd() }
    case "cursor":
      // Cursor rules are per project; there is no global rule file to write.
      return scope === "project"
        ? { path: join(root, ".cursor", "rules", "cairn-import.mdc"), content: cursorRule() }
        : null
    case "claude-desktop":
      // Not a coding agent with the repository open: nothing to map from.
      return null
  }
}

export async function planFill(
  repo: RepoInfo,
  files: string[],
  agents: Agent[],
  scope: Scope,
  home: string,
  mode: Mode | null,
): Promise<FillPlan> {
  const tooFew = files.length < CODE_SCAN_THRESHOLD
  const codeScan = !tooFew ? false : mode === null ? null : mode === "local"
  const skills =
    codeScan === true
      ? agents.flatMap((agent) => {
          const skill = skillFor(agent, repo.root, scope, home)
          return skill ? [skill] : []
        })
      : []
  return { repo, files: [...files], skills, codeScan }
}

/** A file the fill could not import, and why. */
export interface FillFailure {
  path: string
  error: string
}

/**
 * Import the fill plan's files, tagged with its repo, then write its skills.
 * A file that cannot be read or stored is recorded in `failed` and the rest
 * carry on: one unreadable file must not cost the person every other one,
 * or the first answer that follows.
 */
export async function applyFill(
  store: Store,
  plan: FillPlan,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportSummary & { titles: string[]; failed: FillFailure[] }> {
  const t = newTally()
  const titles: string[] = []
  const failed: FillFailure[] = []
  let done = 0
  for (const path of plan.files) {
    try {
      const result = await importFile(store, path, importSource(plan.repo, path), plan.repo.label)
      tally(t, path, result)
      if (result.outcome !== "empty") titles.push(result.document.title)
    } catch (err) {
      failed.push({ path, error: err instanceof Error ? err.message : String(err) })
    }
    onProgress?.(++done, plan.files.length)
  }
  const summary = await finishTally(store, t)
  for (const { path, content } of plan.skills) await writeAtomic(path, content)
  return { ...summary, titles, failed }
}
