import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { COMPILED } from "./version"

export type Agent = "claude" | "cursor"
export type Scope = "global" | "project"

const START = "<!-- cairn:start -->"
const END = "<!-- cairn:end -->"

/** What an agent is told to do. This is prompt surface, not documentation. */
export const RULES_BLOCK = `At the start of a session, call team_knowledge_map to see what the team already
knows, passing your agent name and a stable session id.

When you learn something durable — a decision and why it was made, a gotcha that
cost someone an hour, a convention the team follows — call
team_knowledge_propose. A human reviews every proposal before other agents see
it, so propose rarely and well.`

export interface InitOptions {
  home: string
  cwd: string
  cliPath: string
  scope: Scope
  dryRun: boolean
  /** Absolute path to the bun binary — see mergeMcpConfig for why. */
  bunPath: string
  /** Absolute path to the running cairn binary — used when COMPILED. */
  execPath: string
  /** Store root to bake into the agent's environment. */
  cairnRoot: string
  /**
   * Write a project config even when no agent is detected, because the
   * operator asked for one by name with `--project`. See planInit for why
   * detection is the wrong thing to gate that on.
   */
  writeWithoutAgent?: boolean
}

export interface InitResult {
  agents: Agent[]
  scope: Scope
  /** Files written, or that would be written under a dry run. */
  written: string[]
  /** Steps the teammate still has to do by hand, and why. */
  printOnly: string[]
  /** Things that are probably not what the operator meant. */
  warnings: string[]
  /** What is left for the operator, including what cairn cannot verify. */
  nextSteps: string[]
  instructions: string
}

export interface McpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

/**
 * How the agent should launch cairn.
 *
 * A compiled binary is invoked directly, which removes bun from the picture
 * entirely — editors launched from the Dock get a minimal PATH that excludes
 * /opt/homebrew/bin, and a bun that cannot be spawned produces no error
 * anywhere, just tools that never appear.
 *
 * CAIRN_ROOT is written in rather than inherited: the agent does not see your
 * shell's environment, so a store set only by `export` is silently ignored.
 */
export function cairnServerEntry(opts: {
  compiled: boolean
  execPath: string
  cliPath: string
  bunPath: string
  cairnRoot: string
}): McpServerEntry {
  const { compiled, execPath, cliPath, bunPath, cairnRoot } = opts
  const env = { CAIRN_ROOT: cairnRoot }
  return compiled
    ? { command: execPath, args: ["mcp"], env }
    : { command: bunPath, args: [cliPath, "mcp"], env }
}

/**
 * Add the cairn server to an MCP config without disturbing anything else in it.
 * Throws rather than overwriting a file it cannot parse — a config we do not
 * understand may hold servers we would silently destroy.
 */
export function mergeMcpConfig(existing: string, entry: McpServerEntry): string {
  let config: Record<string, unknown>
  const text = existing.trim()
  if (text === "") {
    config = {}
  } else {
    try {
      config = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error("could not parse existing MCP config as JSON")
    }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  config.mcpServers = { ...servers, cairn: entry }
  return JSON.stringify(config, null, 2) + "\n"
}

/**
 * Insert or replace our block between sentinels, leaving everything the
 * teammate wrote untouched. Re-running updates in place instead of appending a
 * second copy.
 */
export function upsertBlock(text: string, block: string): string {
  const wrapped = `${START}\n${block}\n${END}`
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start !== -1 && end !== -1) {
    return text.slice(0, start) + wrapped + text.slice(end + END.length)
  }
  return text.trim() === "" ? wrapped + "\n" : `${text.trimEnd()}\n\n${wrapped}\n`
}

/** Append only the paths not already ignored, so re-running is a no-op. */
export function upsertGitignore(existing: string, paths: string[]): string {
  const lines = existing.split("\n").map((l) => l.trim())
  const missing = paths.filter((p) => !lines.includes(p))
  if (missing.length === 0) return existing
  const head = existing.trim() === "" ? "" : existing.trimEnd() + "\n"
  return `${head}\n# cairn: machine-specific, do not commit\n${missing.join("\n")}\n`
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}

/**
 * Where a project's agent instructions live. AGENTS.md is the cross-tool
 * convention and wins when present; an existing CLAUDE.md is honoured rather
 * than orphaned; otherwise a new repo gets AGENTS.md. Never both — the same
 * instructions in two files means an agent reads them twice.
 */
export async function resolveInstructionFile(cwd: string): Promise<string> {
  if (await exists(join(cwd, "AGENTS.md"))) return join(cwd, "AGENTS.md")
  if (await exists(join(cwd, "CLAUDE.md"))) return join(cwd, "CLAUDE.md")
  return join(cwd, "AGENTS.md")
}

/** Only touch agents that are actually installed. */
export async function detectAgents(home: string): Promise<Agent[]> {
  const found: Agent[] = []
  for (const [dir, agent] of [
    [".claude", "claude"],
    [".cursor", "cursor"],
  ] as const) {
    // stat, not Bun.file().exists() — the latter reports false for directories.
    const isDir = await stat(join(home, dir))
      .then((s) => s.isDirectory())
      .catch(() => false)
    if (isDir) found.push(agent)
  }
  return found
}

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8")
  } catch {
    return ""
  }
}

/**
 * Everything `init` would change, computed but not applied.
 *
 * Separating the plan from the write is what lets the CLI show the "Will
 * write:" preview and take telemetry consent BEFORE anything lands on disk.
 * Ctrl-C at either prompt then genuinely leaves nothing written — previously, cancelling at the telemetry
 * prompt left `.mcp.json`, `AGENTS.md` and `.gitignore` behind with no
 * `config.json`, and doctor went on to report that consent had never been asked.
 */
export interface InitPlan {
  agents: Agent[]
  scope: Scope
  /** Every file to write, with its full final content. */
  changes: { path: string; content: string }[]
  printOnly: string[]
  warnings: string[]
  /**
   * What the operator still has to do themselves, printed after the write.
   * Distinct from `warnings`, which are about what cairn did: these are the
   * steps cairn cannot take and — for Cursor's per-project approval — cannot
   * even observe.
   */
  nextSteps: string[]
  instructions: string
}

/**
 * Cursor's documented one-click install link.
 * <https://cursor.com/docs/mcp/install-links>
 *
 * `config` is the SINGLE server object — no `mcpServers` wrapper — as JSON,
 * base64, then percent-encoded. The encoding is not optional: base64's
 * alphabet includes `+` and `/`, both of which mean something else in a URL,
 * and whether a given config produces one is a property of the path it
 * contains rather than of anything cairn controls.
 */
export function cursorInstallLink(entry: McpServerEntry, name = "cairn"): string {
  const config = Buffer.from(JSON.stringify(entry), "utf-8").toString("base64")
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${name}&config=${encodeURIComponent(config)}`
}

export async function planInit(opts: InitOptions): Promise<InitPlan> {
  const { home, cwd, cliPath, scope, bunPath } = opts
  const detected = await detectAgents(home)
  const printOnly: string[] = []
  const warnings: string[] = []
  const nextSteps: string[] = []

  // Detection looks at ~/.claude and ~/.cursor, but project scope writes
  // <cwd>/.mcp.json and the instructions file — paths whose correctness has
  // nothing to do with the home directory. Gating them on a bare home refused
  // setups that would have worked: a Claude Code install that has not created
  // ~/.claude yet, a container, a checkout whose agent config lives elsewhere.
  // Global scope keeps the gate, because the files it writes ARE the agent's
  // own and inventing one there configures software that is not installed.
  const assumed = detected.length === 0 && scope === "project" && opts.writeWithoutAgent === true
  const agents: Agent[] = assumed ? ["claude"] : detected
  if (assumed) {
    warnings.push(
      `No supported agent found in ${home} — writing a project config anyway, as --project asked. ` +
        "Point your agent at .mcp.json, or re-run once it is installed.",
    )
  }
  const entry = cairnServerEntry({
    compiled: COMPILED,
    execPath: opts.execPath,
    cliPath,
    bunPath,
    cairnRoot: opts.cairnRoot,
  })

  // Project scope means "the repo you want connected", but the obvious place to
  // run the command is where the command lives — cairn's own checkout. That
  // writes config into a workspace the editor never opens, and the tools never
  // appear.
  if (scope === "project" && cliPath.startsWith(cwd)) {
    warnings.push(
      "This looks like cairn's own repo. Project scope configures the repo you run it FROM — " +
        "run it from the project you want connected, or pass --global.",
    )
  }
  // Compute every change before writing any of it, so a config we cannot parse
  // aborts the whole run rather than leaving half of it applied.
  const pending: { path: string; content: string }[] = []
  const gitignore: string[] = []

  if (agents.includes("claude")) {
    const cfg = scope === "global" ? join(home, ".claude.json") : join(cwd, ".mcp.json")
    pending.push({ path: cfg, content: mergeMcpConfig(await read(cfg), entry) })
    if (scope === "project") gitignore.push(".mcp.json")
  }

  if (agents.includes("cursor")) {
    const cfg = join(scope === "global" ? home : cwd, ".cursor", "mcp.json")
    pending.push({ path: cfg, content: mergeMcpConfig(await read(cfg), entry) })
    if (scope === "project") {
      // Project rules ARE a file, unlike user-level rules — nothing to paste.
      const rules = join(cwd, ".cursor", "rules", "cairn.mdc")
      pending.push({ path: rules, content: upsertBlock(await read(rules), RULES_BLOCK) })
      gitignore.push(".cursor/mcp.json")
      // Writing the file is necessary and not sufficient. Cursor requires the
      // user to approve a project-scoped MCP server before it will run it,
      // and records that approval in its own state — so cairn cannot do it,
      // and `cairn doctor` cannot see whether it has been done. Until it is,
      // the tools are simply absent from the session with no error anywhere.
      nextSteps.push(
        "Cursor asks you to approve a project MCP server before it will run one. If cairn's " +
          "tools do not appear, approve it in Cursor's Customize panel — disabled servers do " +
          "not load or appear in chat — and check Cmd+Shift+U → MCP Logs.",
      )
    } else {
      printOnly.push(
        "Cursor keeps user rules in its settings, not a file — paste the block below into Cursor → Settings → Rules.",
      )
    }
    // Printed only when Cursor is actually present: a Claude-Code-only machine
    // cannot open a `cursor://` URL and should not be handed one.
    nextSteps.push(`One-click install for Cursor: ${cursorInstallLink(entry)}`)
  }

  if (agents.length > 0) {
    const instructions =
      scope === "global" ? join(home, ".claude", "CLAUDE.md") : await resolveInstructionFile(cwd)
    // Global scope has no shared instructions file for Cursor, so only write
    // one when Claude Code is present; project scope shares AGENTS.md.
    if (scope === "project" || agents.includes("claude")) {
      pending.push({ path: instructions, content: upsertBlock(await read(instructions), RULES_BLOCK) })
    }
  }

  if (gitignore.length > 0) {
    const gi = join(cwd, ".gitignore")
    const merged = upsertGitignore(await read(gi), gitignore)
    if (merged !== (await read(gi))) pending.push({ path: gi, content: merged })
  }

  return { agents, scope, changes: pending, printOnly, warnings, nextSteps, instructions: RULES_BLOCK }
}

/**
 * Replace a file's contents atomically.
 *
 * `writeFile` truncates and then writes, so an interrupt, a full disk or a
 * crash between the two leaves the target empty or half-written. At global
 * scope `init` rewrites ~/.claude.json — Claude Code's whole configuration —
 * and losing it is a bad trade for a config edit. Writing a sibling temp file
 * and renaming keeps the swap atomic on one filesystem: a reader sees either
 * the old file or the new one. The temp file is a sibling deliberately;
 * renaming across filesystems is not atomic and can fail outright.
 */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.cairn-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(tmp, content, "utf-8")
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

/** Apply a plan. Nothing is written before this is called. */
export async function applyInit(plan: InitPlan): Promise<InitResult> {
  for (const { path, content } of plan.changes) {
    await writeAtomic(path, content)
  }
  return planResult(plan)
}

/** The same report a plan produces when nothing is applied — the dry run. */
export function planResult(plan: InitPlan): InitResult {
  const { agents, scope, printOnly, warnings, nextSteps, instructions } = plan
  return { agents, scope, written: plan.changes.map((c) => c.path), printOnly, warnings, nextSteps, instructions }
}

/**
 * Plan and apply in one call, honouring `dryRun`.
 *
 * The CLI deliberately does NOT use this — it needs to interpose the preview
 * and the consent prompt between the two halves. This is the single-shot form
 * for callers with nothing to ask, and the surface `test/init.test.ts` exercises
 * end to end.
 */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const plan = await planInit(opts)
  return opts.dryRun ? planResult(plan) : applyInit(plan)
}
