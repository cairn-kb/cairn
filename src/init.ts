import { lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { COMPILED } from "./version"
import { SEARCH_GUIDANCE } from "./guidance"
import { ALL_AGENTS, desktopConfigPath, detectAgents, INIT_AGENTS } from "./agents"
import { codexBlock, mergeCodexConfig } from "./codex-config"
import type { Agent } from "./agents"

export type { Agent } from "./agents"
export { detectAgents } from "./agents"
export type Scope = "global" | "project"

const START = "<!-- cairn:start -->"
const END = "<!-- cairn:end -->"

/** What an agent is told to do. This is prompt surface, not documentation. */
export const RULES_BLOCK = `${SEARCH_GUIDANCE}

At the start of a session, call team_knowledge_map to see what the team already
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
  /** Which platform's Claude Desktop config path to use. Defaults to this one. */
  platform?: NodeJS.Platform
  /** `%APPDATA%`, which Claude Desktop's config path is under on Windows. */
  appData?: string
  /**
   * Whether a person is at a terminal running this (no `--yes`). Without one,
   * project scope leaves the machine-wide Codex config alone: a script asked
   * to set up one project must not edit files in the home directory.
   * Defaults to false.
   */
  interactive?: boolean
  /**
   * The agents to configure, chosen by the person — in the picker or with
   * `--agents`. Configured exactly as given: nothing is left out for being
   * machine-wide and nothing is assumed, and an agent that is not installed
   * is configured anyway, because it was asked for by name. Absent, init
   * configures whichever of `INIT_AGENTS` it detects.
   */
  agents?: Agent[]
  /**
   * The "Other MCP client" choice: write the shared instructions and print
   * the server config to paste into a client cairn does not know.
   */
  otherClient?: boolean
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

/** Take our block out, leaving everything around it. */
function removeBlock(text: string): string {
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start === -1 || end === -1) return text
  const rest = (text.slice(0, start).trimEnd() + "\n\n" + text.slice(end + END.length).trimStart()).trim()
  return rest === "" ? "" : rest + "\n"
}

/**
 * The line that makes Claude Code read a project's AGENTS.md from CLAUDE.md.
 * <https://code.claude.com/docs/en/memory#agents-md>
 */
const AGENTS_IMPORT = "@AGENTS.md"

/**
 * Whether CLAUDE.md already imports AGENTS.md: a line that is exactly
 * `@AGENTS.md`, or the `./` spelling of the same relative path. An import
 * mentioned mid-sentence or in backticks is not counted, so a line of our own
 * gets added rather than relying on one that may not be read as an import.
 */
export function importsAgentsMd(text: string): boolean {
  return text.split("\n").some((l) => l.trim() === AGENTS_IMPORT || l.trim() === "@./AGENTS.md")
}

/** Where a symlink points, resolved against its directory; null for anything else. */
async function linkTarget(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return null
    return resolve(dirname(path), await readlink(path))
  } catch {
    return null
  }
}

/** Whether two paths, after following links, are one file. False if either is missing. */
export async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return false
  }
}

/** Add the import to a CLAUDE.md, keeping what the teammate wrote. */
export function addAgentsImport(text: string): string {
  return text.trim() === "" ? `${AGENTS_IMPORT}\n` : `${text.trimEnd()}\n\n${AGENTS_IMPORT}\n`
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
 * instructions in two files means an agent reads them twice. When the block
 * goes in AGENTS.md, Claude Code is pointed at it by an import line in
 * CLAUDE.md, not by a second copy (see planInit).
 */
export async function resolveInstructionFile(cwd: string): Promise<string> {
  if (await exists(join(cwd, "AGENTS.md"))) return join(cwd, "AGENTS.md")
  if (await exists(join(cwd, "CLAUDE.md"))) return join(cwd, "CLAUDE.md")
  return join(cwd, "AGENTS.md")
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
  /** Each configured agent's MCP config file, among `changes` — where its
   *  cairn entry is read back from to prove it. */
  configs: { agent: Agent; path: string }[]
  printOnly: string[]
  warnings: string[]
  /**
   * Agents that were found but deliberately left unconfigured: Codex on a
   * non-interactive project-scope run, whose config is machine-wide.
   */
  notConfigured: Agent[]
  /** Whether the "Other MCP client" was chosen. It has no config to prove,
   *  so it adds nothing to `configs`, and a plan of it alone is still a plan. */
  otherClient: boolean
  /**
   * Whether a `printOnly` note tells the person to paste "the block below" —
   * true only where no file cairn writes carries the rules. Not the same as
   * having notes: a note that only hands over a config would otherwise sit
   * right above the rules, which then read as part of what to paste.
   */
  pasteRules: boolean
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

/** Agents with one config for the whole machine rather than one per project. */
const MACHINE_WIDE: readonly Agent[] = ["codex", "claude-desktop"]

/** Told to the person when cairn cannot safely edit an agent's config itself. */
function handEdit(path: string, block: string): string {
  return (
    `cairn couldn't edit ${path} (it may use syntax cairn can't safely edit) — add the cairn server by hand:\n\n` +
    block.replace(/^/gm, "    ")
  )
}

export async function planInit(opts: InitOptions): Promise<InitPlan> {
  const { home, cwd, cliPath, scope, bunPath } = opts
  const platform = opts.platform ?? process.platform
  const chosen = opts.agents
  const otherClient = opts.otherClient === true
  // Detected Claude Desktop is not configured by default; see INIT_AGENTS.
  const found = chosen
    ? []
    : (await detectAgents(home, platform, opts.appData)).filter((a) => INIT_AGENTS.includes(a))
  const printOnly: string[] = []
  const warnings: string[] = []
  const nextSteps: string[] = []

  // Project scope from a script edits the project and nothing else. Codex
  // keeps one config for every project, in the home directory, so it is
  // configured by a person at a terminal, by --global, or by naming it.
  const notConfigured =
    scope === "project" && opts.interactive !== true ? found.filter((a) => MACHINE_WIDE.includes(a)) : []
  const detected = chosen
    ? ALL_AGENTS.filter((a) => chosen.includes(a))
    : found.filter((a) => !notConfigured.includes(a))

  // Detection looks at the home directory, but project scope writes
  // <cwd>/.mcp.json and the instructions file — paths whose correctness has
  // nothing to do with the home directory. Gating them on a bare home refused
  // setups that would have worked: a Claude Code install that has not created
  // ~/.claude yet, a container, a checkout whose agent config lives elsewhere.
  // Global scope keeps the gate, because the files it writes ARE the agent's
  // own and inventing one there configures software that is not installed.
  const assumed = !chosen && detected.length === 0 && scope === "project" && opts.writeWithoutAgent === true
  let agents: Agent[] = assumed ? ["claude"] : detected
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
  // aborts the whole run rather than leaving half of it applied. Codex and
  // Claude Desktop are the exception: a config of theirs cairn cannot edit
  // skips that agent, with the entry to add by hand, and the rest goes ahead.
  const pending: { path: string; content: string }[] = []
  const configs: { agent: Agent; path: string }[] = []
  const gitignore: string[] = []
  let pasteRules = false

  if (agents.includes("claude")) {
    const cfg = scope === "global" ? join(home, ".claude.json") : join(cwd, ".mcp.json")
    pending.push({ path: cfg, content: mergeMcpConfig(await read(cfg), entry) })
    configs.push({ agent: "claude", path: cfg })
    if (scope === "project") gitignore.push(".mcp.json")
  }

  if (agents.includes("cursor")) {
    const cfg = join(scope === "global" ? home : cwd, ".cursor", "mcp.json")
    pending.push({ path: cfg, content: mergeMcpConfig(await read(cfg), entry) })
    configs.push({ agent: "cursor", path: cfg })
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
      pasteRules = true
    }
    // Printed only when Cursor is actually present: a Claude-Code-only machine
    // cannot open a `cursor://` URL and should not be handed one.
    nextSteps.push(`One-click install for Cursor: ${cursorInstallLink(entry)}`)
  }

  // Codex has one config for every project, so it is written at either scope —
  // except by a script at project scope (see `notConfigured` above).
  if (agents.includes("codex")) {
    const cfg = join(home, ".codex", "config.toml")
    const text = await read(cfg)
    let content: string | null = null
    try {
      content = mergeCodexConfig(text, entry)
    } catch {
      warnings.push(handEdit(cfg, codexBlock(entry)))
      agents = agents.filter((a) => a !== "codex")
    }
    if (content !== null) {
      pending.push({ path: cfg, content })
      configs.push({ agent: "codex", path: cfg })
    }
  }

  // Claude Desktop likewise has only an app-wide config. It is only here when
  // asked for by name, so the platform may give it no known path at all.
  const desktopCfg = desktopConfigPath(home, platform, opts.appData)
  if (agents.includes("claude-desktop") && !desktopCfg) {
    warnings.push("Claude Desktop has no known config location on this machine — skipped it.")
    agents = agents.filter((a) => a !== "claude-desktop")
  }
  let desktopContent: string | null = null
  if (agents.includes("claude-desktop") && desktopCfg) {
    try {
      desktopContent = mergeMcpConfig(await read(desktopCfg), entry)
    } catch {
      warnings.push(handEdit(desktopCfg, JSON.stringify({ mcpServers: { cairn: entry } }, null, 2)))
      agents = agents.filter((a) => a !== "claude-desktop")
    }
  }
  if (desktopContent !== null && desktopCfg) {
    pending.push({ path: desktopCfg, content: desktopContent })
    configs.push({ agent: "claude-desktop", path: desktopCfg })
    printOnly.push(
      "Claude Desktop has no instructions file — paste the block below into a Claude project's " +
        "instructions (Projects → your project → Instructions).",
    )
    pasteRules = true
    // Closing the window leaves the app running, and it reads its MCP config
    // only at launch — so the new server does not appear until a real restart.
    nextSteps.push("Quit Claude Desktop completely (Cmd+Q, or Quit from its tray icon) and reopen it to load cairn.")
  }

  // The other MCP client is told where cairn is, and nothing more: cairn
  // knows nothing about its config, so there is nothing to write or prove.
  if (otherClient) {
    printOnly.push(
      "For another MCP client, add this server to its MCP config:\n\n" +
        JSON.stringify({ mcpServers: { cairn: entry } }, null, 2),
    )
    // Project scope gives it the shared instructions file below; global scope
    // has none, so it gets the block to paste.
    if (scope === "global") {
      printOnly.push(
        "Another MCP client has no shared instructions file at global scope — paste the block below " +
          "into its instructions.",
      )
      pasteRules = true
    }
  }

  if (agents.length > 0 || otherClient) {
    const instructions =
      scope === "global" ? join(home, ".claude", "CLAUDE.md") : await resolveInstructionFile(cwd)
    // Global scope has no shared instructions file for Cursor, so only write
    // one when Claude Code is present; project scope shares AGENTS.md.
    if (scope === "project" || agents.includes("claude")) {
      pending.push({ path: instructions, content: upsertBlock(await read(instructions), RULES_BLOCK) })
    }
    // Claude Code reads a project's AGENTS.md only when no CLAUDE.md exists in
    // the project or any folder above it — a CLAUDE.md in a parent directory is
    // enough to hide it. An import from the project's own CLAUDE.md makes it
    // read AGENTS.md either way. The block stays in AGENTS.md alone: a copy in
    // CLAUDE.md as well would be the same instructions read twice, so one an
    // older run left there comes out.
    //
    // CLAUDE.md and AGENTS.md linked to each other, in either direction, are
    // one file and need nothing. Otherwise a CLAUDE.md that is a symlink is
    // never written through: it is a file shared on purpose, so the person
    // adds the import to it themselves.
    if (scope === "project" && agents.includes("claude") && basename(instructions) === "AGENTS.md") {
      const claudeMd = join(dirname(instructions), "CLAUDE.md")
      const link = await linkTarget(claudeMd)
      const text = await read(claudeMd)
      const linked = await sameFile(claudeMd, instructions)
      if (!linked && link !== null && !importsAgentsMd(text)) {
        nextSteps.push(
          (await exists(claudeMd))
            ? `${claudeMd} is a symlink to ${link}, so cairn left it alone. Add a line reading ` +
                `${AGENTS_IMPORT} to ${link} so Claude Code reads ${instructions}.`
            : `${claudeMd} is a broken link to ${link}; fix it, then add ${AGENTS_IMPORT} ` +
                `so Claude Code reads ${instructions}.`,
        )
      }
      if (!linked && link === null) {
        const cleaned = removeBlock(text)
        const content = importsAgentsMd(cleaned) ? cleaned : addAgentsImport(cleaned)
        if (content !== text) pending.push({ path: claudeMd, content })
      }
    }
    // Codex reads ~/.codex/AGENTS.md everywhere and a project's AGENTS.md, but
    // not CLAUDE.md. So the global file carries the rules at global scope, and
    // at project scope only when the project's file is one Codex never reads —
    // otherwise Codex would read the same rules twice.
    // <https://developers.openai.com/codex/guides/agents-md>
    if (agents.includes("codex") && (scope === "global" || basename(instructions) !== "AGENTS.md")) {
      const codexMd = join(home, ".codex", "AGENTS.md")
      pending.push({ path: codexMd, content: upsertBlock(await read(codexMd), RULES_BLOCK) })
    }
  }

  if (gitignore.length > 0) {
    const gi = join(cwd, ".gitignore")
    const merged = upsertGitignore(await read(gi), gitignore)
    if (merged !== (await read(gi))) pending.push({ path: gi, content: merged })
  }

  return {
    agents, scope, changes: pending, configs, printOnly, warnings, notConfigured, otherClient, pasteRules, nextSteps,
    instructions: RULES_BLOCK,
  }
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
  // A symlinked file — `CLAUDE.md -> AGENTS.md`, a dotfiles-managed
  // ~/.claude/CLAUDE.md — is written at its target. Renaming over the link
  // itself would replace it with a copy and quietly unshare the file.
  if ((await linkTarget(path)) !== null) {
    path = await realpath(path).catch(() => path)
  }
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
