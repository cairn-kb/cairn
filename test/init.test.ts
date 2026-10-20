import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addAgentsImport,
  cairnServerEntry,
  detectAgents,
  importsAgentsMd,
  mergeMcpConfig,
  planInit,
  resolveInstructionFile,
  RULES_BLOCK,
  runInit,
  upsertBlock,
  upsertGitignore,
  writeAtomic,
} from "../src/init"
import { readCodexEntry } from "../src/codex-config"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-init-"))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function entry(cliPath: string, bunPath = "/opt/homebrew/bin/bun") {
  return cairnServerEntry({
    compiled: false,
    execPath: "/opt/homebrew/bin/bun",
    cliPath,
    bunPath,
    cairnRoot: "/tmp/cairn-root",
  })
}

// --- mergeMcpConfig -------------------------------------------------------

test("adds the cairn server to an empty config", () => {
  const out = mergeMcpConfig("", entry("/abs/path/cli.ts"))
  expect(JSON.parse(out).mcpServers.cairn).toEqual({
    command: "/opt/homebrew/bin/bun",
    args: ["/abs/path/cli.ts", "mcp"],
    env: { CAIRN_ROOT: "/tmp/cairn-root" },
  })
})

test("preserves other mcp servers untouched", () => {
  const existing = JSON.stringify({
    mcpServers: { other: { command: "node", args: ["x.js"] } },
  })
  const parsed = JSON.parse(mergeMcpConfig(existing, entry("/abs/cli.ts")))
  expect(parsed.mcpServers.other).toEqual({ command: "node", args: ["x.js"] })
  expect(parsed.mcpServers.cairn).toBeDefined()
})

test("preserves unrelated top-level keys", () => {
  const existing = JSON.stringify({ theme: "dark", mcpServers: {} })
  expect(JSON.parse(mergeMcpConfig(existing, entry("/abs/cli.ts"))).theme).toBe("dark")
})

test("merging twice is idempotent", () => {
  const once = mergeMcpConfig("", entry("/abs/cli.ts"))
  expect(mergeMcpConfig(once, entry("/abs/cli.ts"))).toBe(once)
})

test("re-running with a new path updates the existing entry", () => {
  const once = mergeMcpConfig("", entry("/old/cli.ts"))
  const twice = JSON.parse(mergeMcpConfig(once, entry("/new/cli.ts")))
  expect(twice.mcpServers.cairn.args[0]).toBe("/new/cli.ts")
})

test("refuses to overwrite a config it cannot parse", () => {
  expect(() => mergeMcpConfig("{ this is not json", entry("/abs/cli.ts"))).toThrow("could not parse")
})

// --- upsertBlock ----------------------------------------------------------

test("appends the block when absent, preserving existing content", () => {
  const out = upsertBlock("# My notes\n\nSomething I wrote.", "NEW RULES")
  expect(out).toContain("# My notes")
  expect(out).toContain("Something I wrote.")
  expect(out).toContain("NEW RULES")
  expect(out).toContain("<!-- cairn:start -->")
  expect(out).toContain("<!-- cairn:end -->")
})

test("replaces the block in place on re-run rather than duplicating", () => {
  const once = upsertBlock("# My notes", "OLD RULES")
  const twice = upsertBlock(once, "NEW RULES")
  expect(twice).toContain("NEW RULES")
  expect(twice).not.toContain("OLD RULES")
  expect(twice.match(/<!-- cairn:start -->/g)).toHaveLength(1)
})

test("leaves content outside the sentinels alone when replacing", () => {
  const original = upsertBlock("# Mine\n\nBefore.", "OLD")
  const updated = upsertBlock(original + "\n\nAfter.", "NEW")
  expect(updated).toContain("Before.")
  expect(updated).toContain("After.")
})

test("creates the file content from nothing", () => {
  expect(upsertBlock("", "RULES")).toContain("RULES")
})

// --- detectAgents ---------------------------------------------------------

test("detects nothing in an empty home", async () => {
  expect(await detectAgents(home)).toEqual([])
})

test("detects claude code by its config directory", async () => {
  await mkdir(join(home, ".claude"))
  expect(await detectAgents(home)).toEqual(["claude"])
})

test("detects cursor by its config directory", async () => {
  await mkdir(join(home, ".cursor"))
  expect(await detectAgents(home)).toEqual(["cursor"])
})

test("detects both when both are present", async () => {
  await mkdir(join(home, ".claude"))
  await mkdir(join(home, ".cursor"))
  expect((await detectAgents(home)).sort()).toEqual(["claude", "cursor"])
})

// detectAgents is re-exported from ./agents — these confirm the two extra
// agents it added are reachable through init.ts, not just agents.ts directly.

test("detects codex by its config directory, through init's re-export", async () => {
  await mkdir(join(home, ".codex"))
  expect(await detectAgents(home, "linux")).toEqual(["codex"])
})

test("detects claude desktop by the directory holding its config, through init's re-export", async () => {
  await mkdir(join(home, ".config", "Claude"), { recursive: true })
  expect(await detectAgents(home, "linux")).toEqual(["claude-desktop"])
})

test("detects all four together, in fixed order, through init's re-export", async () => {
  await mkdir(join(home, ".claude"))
  await mkdir(join(home, ".cursor"))
  await mkdir(join(home, ".codex"))
  await mkdir(join(home, ".config", "Claude"), { recursive: true })
  expect(await detectAgents(home, "linux")).toEqual(["claude", "cursor", "codex", "claude-desktop"])
})

// --- runInit --------------------------------------------------------------

test("writes mcp config and instructions for claude code", async () => {
  await mkdir(join(home, ".claude"))
  const result = await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })

  const cfg = JSON.parse(await readFile(join(home, ".claude.json"), "utf-8"))
  expect(cfg.mcpServers.cairn.args).toEqual(["/abs/cli.ts", "mcp"])

  const md = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8")
  expect(md).toContain("team_knowledge_map")
  expect(md).toContain("<!-- cairn:start -->")

  expect(result.written).toContain(join(home, ".claude.json"))
  expect(result.printOnly).toEqual([])
})

test("writes cursor mcp config but only prints its rules", async () => {
  await mkdir(join(home, ".cursor"))
  const result = await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })

  const cfg = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf-8"))
  expect(cfg.mcpServers.cairn).toBeDefined()

  expect(result.printOnly.join(" ")).toContain("Cursor")
  expect(result.instructions).toBe(RULES_BLOCK)
})

test("preserves a teammate's existing CLAUDE.md content", async () => {
  await mkdir(join(home, ".claude"))
  await writeFile(join(home, ".claude", "CLAUDE.md"), "# Mine\n\nDo not lose this.", "utf-8")
  await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
  const md = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8")
  expect(md).toContain("Do not lose this.")
})

test("running twice does not duplicate anything", async () => {
  await mkdir(join(home, ".claude"))
  await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
  await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
  const md = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8")
  expect(md.match(/<!-- cairn:start -->/g)).toHaveLength(1)
  const cfg = JSON.parse(await readFile(join(home, ".claude.json"), "utf-8"))
  expect(Object.keys(cfg.mcpServers)).toEqual(["cairn"])
})

test("dry run reports what it would do without writing anything", async () => {
  await mkdir(join(home, ".claude"))
  const result = await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: true, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })

  expect(result.written.length).toBeGreaterThan(0)
  expect(await Bun.file(join(home, ".claude.json")).exists()).toBe(false)
  expect(await Bun.file(join(home, ".claude", "CLAUDE.md")).exists()).toBe(false)
})

test("reports when no supported agent is installed", async () => {
  const result = await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
  expect(result.written).toEqual([])
  expect(result.agents).toEqual([])
})

test("a malformed existing config aborts without writing", async () => {
  await mkdir(join(home, ".claude"))
  await writeFile(join(home, ".claude.json"), "{ broken", "utf-8")
  await expect(runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })).rejects.toThrow("could not parse")
  expect(await readFile(join(home, ".claude.json"), "utf-8")).toBe("{ broken")
})

// --- instruction file resolution ------------------------------------------

test("prefers an existing AGENTS.md", async () => {
  await writeFile(join(home, "AGENTS.md"), "# agents", "utf-8")
  await writeFile(join(home, "CLAUDE.md"), "# claude", "utf-8")
  expect(await resolveInstructionFile(home)).toBe(join(home, "AGENTS.md"))
})

test("falls back to an existing CLAUDE.md", async () => {
  await writeFile(join(home, "CLAUDE.md"), "# claude", "utf-8")
  expect(await resolveInstructionFile(home)).toBe(join(home, "CLAUDE.md"))
})

test("creates AGENTS.md when neither exists", async () => {
  expect(await resolveInstructionFile(home)).toBe(join(home, "AGENTS.md"))
})

// --- gitignore ------------------------------------------------------------

test("adds missing paths to gitignore, preserving what is there", () => {
  const out = upsertGitignore("node_modules\n", [".mcp.json", ".cursor/mcp.json"])
  expect(out).toContain("node_modules")
  expect(out).toContain(".mcp.json")
  expect(out).toContain(".cursor/mcp.json")
})

test("does not duplicate a path already ignored", () => {
  const once = upsertGitignore("", [".mcp.json"])
  const twice = upsertGitignore(once, [".mcp.json"])
  expect(twice.match(/\.mcp\.json/g)).toHaveLength(1)
})

test("leaves gitignore untouched when every path is already listed", () => {
  const existing = "node_modules\n.mcp.json\n"
  expect(upsertGitignore(existing, [".mcp.json"])).toBe(existing)
})

// --- project scope --------------------------------------------------------

test("project scope writes config into the repo, not the home directory", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".claude"))
  try {
    const r = await runInit({ home, cwd: repo, cliPath: "/abs/cli.ts", scope: "project", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
    expect(await Bun.file(join(repo, ".mcp.json")).exists()).toBe(true)
    expect(await Bun.file(join(home, ".claude.json")).exists()).toBe(false)
    const md = await readFile(join(repo, "AGENTS.md"), "utf-8")
    expect(md).toContain("team_knowledge_map")
    expect(r.scope).toBe("project")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("project scope gitignores the machine-specific config", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".claude"))
  try {
    await runInit({ home, cwd: repo, cliPath: "/abs/cli.ts", scope: "project", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
    const gi = await readFile(join(repo, ".gitignore"), "utf-8")
    expect(gi).toContain(".mcp.json")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("project scope writes cursor rules to a real file", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".cursor"))
  try {
    const r = await runInit({ home, cwd: repo, cliPath: "/abs/cli.ts", scope: "project", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
    expect(await Bun.file(join(repo, ".cursor", "rules", "cairn.mdc")).exists()).toBe(true)
    // Project rules ARE a file, unlike user-level rules — nothing to paste.
    expect(r.printOnly).toEqual([])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("a project-scoped Cursor install is told about the approval step it has to do itself", async () => {
  // Cursor will not run a project MCP server until the user approves it,
  // and records that approval in its own state — not in any file cairn writes.
  // Until then the tools are simply absent, with no error anywhere, even with a
  // correct config and `doctor` reporting no problems.
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".cursor"))
  try {
    const r = await runInit({ home, cwd: repo, cliPath: "/abs/cli.ts", scope: "project", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
    expect(r.nextSteps.join("\n")).toContain("approve")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("a Cursor install is handed the documented one-click install link", async () => {
  // The deeplink is Cursor's own documented install route, and cairn
  // already holds every value it needs. `config` is the single server object
  // — no mcpServers wrapper — JSON, base64, then URL-encoded, because a
  // base64 payload can contain `+` and `/`.
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".cursor"))
  try {
    const r = await runInit({ home, cwd: repo, cliPath: "/abs/cli.ts", scope: "project", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
    const link = r.nextSteps.find((l) => l.includes("cursor://"))!
    expect(link).toContain("cursor://anysphere.cursor-deeplink/mcp/install?name=cairn&config=")
    const encoded = link.slice(link.indexOf("config=") + "config=".length).trim()
    const decoded = JSON.parse(Buffer.from(decodeURIComponent(encoded), "base64").toString("utf-8"))
    // The link must install the same server the file does, or the two routes
    // configure different things and only one of them is tested.
    const written = JSON.parse(await readFile(join(repo, ".cursor", "mcp.json"), "utf-8"))
    expect(decoded).toEqual(written.mcpServers.cairn)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("a machine with no Cursor is never shown a cursor:// link", async () => {
  // detectAgents already distinguishes the two; a Claude-Code-only machine
  // cannot open the URL and should not be told to.
  await mkdir(join(home, ".claude"))
  const r = await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
  expect(r.nextSteps.join("\n")).not.toContain("cursor://")
})

test("global scope still writes to the home directory", async () => {
  await mkdir(join(home, ".claude"))
  const r = await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
  expect(await Bun.file(join(home, ".claude.json")).exists()).toBe(true)
  expect(r.scope).toBe("global")
})

// --- launch command ------------------------------------------------------

test("the config uses an absolute bun path, not a bare command", () => {
  const cfg = JSON.parse(mergeMcpConfig("", entry("/abs/cli.ts")))
  expect(cfg.mcpServers.cairn.command).toBe("/opt/homebrew/bin/bun")
})

test("a bare bun command would not resolve for a GUI-launched editor", () => {
  // Editors started from the Dock get a minimal PATH that excludes
  // /opt/homebrew/bin, so `command: "bun"` fails to spawn with no visible error.
  const cfg = JSON.parse(mergeMcpConfig("", entry("/abs/cli.ts")))
  expect(cfg.mcpServers.cairn.command).not.toBe("bun")
})

// --- running from the wrong directory ------------------------------------

test("project scope warns when run inside cairn's own repo", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cairn-self-"))
  await mkdir(join(home, ".claude"))
  await Bun.write(join(repo, "package.json"), JSON.stringify({ name: "@acme/app" }))
  try {
    const r = await runInit({
      home, cwd: repo, cliPath: join(repo, "src/cli.ts"),
      scope: "project", dryRun: true, bunPath: "/opt/homebrew/bin/bun",
      execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root",
    })
    expect(r.warnings.join(" ")).toContain("cairn's own repo")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("no such warning when connecting a normal project", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cairn-other-"))
  await mkdir(join(home, ".claude"))
  try {
    const r = await runInit({
      home, cwd: repo, cliPath: "/elsewhere/cairn/src/cli.ts",
      scope: "project", dryRun: true, bunPath: "/opt/homebrew/bin/bun",
      execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root",
    })
    expect(r.warnings).toEqual([])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// --- cairnServerEntry ------------------------------------------------------

test("a compiled binary is invoked directly, with no bun in the config", () => {
  const entry = cairnServerEntry({
    compiled: true,
    execPath: "/Users/you/.local/bin/cairn",
    cliPath: "/irrelevant/src/cli.ts",
    bunPath: "/opt/homebrew/bin/bun",
    cairnRoot: "/Users/you/.cairn",
  })
  expect(entry.command).toBe("/Users/you/.local/bin/cairn")
  expect(entry.args).toEqual(["mcp"])
  expect(entry.env).toEqual({ CAIRN_ROOT: "/Users/you/.cairn" })
})

test("a source checkout still goes through bun", () => {
  const entry = cairnServerEntry({
    compiled: false,
    execPath: "/opt/homebrew/bin/bun",
    cliPath: "/Users/you/cairn/src/cli.ts",
    bunPath: "/opt/homebrew/bin/bun",
    cairnRoot: "/Users/you/.cairn",
  })
  expect(entry.command).toBe("/opt/homebrew/bin/bun")
  expect(entry.args).toEqual(["/Users/you/cairn/src/cli.ts", "mcp"])
})

test("the store root is written into the config, not left to the shell", () => {
  // The agent does not inherit your terminal's environment. Without this the
  // MCP server silently uses ~/.cairn whatever CAIRN_ROOT says.
  const entry = cairnServerEntry({
    compiled: true, execPath: "/bin/cairn", cliPath: "", bunPath: "",
    cairnRoot: "/tmp/store",
  })
  const out = JSON.parse(mergeMcpConfig("", entry))
  expect(out.mcpServers.cairn.env.CAIRN_ROOT).toBe("/tmp/store")
})

test("merging still preserves other servers", () => {
  const existing = JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } })
  const entry = cairnServerEntry({
    compiled: true, execPath: "/bin/cairn", cliPath: "", bunPath: "",
    cairnRoot: "/tmp/store",
  })
  const out = JSON.parse(mergeMcpConfig(existing, entry))
  expect(out.mcpServers.other).toEqual({ command: "x", args: [] })
  expect(out.mcpServers.cairn.command).toBe("/bin/cairn")
})

test("a config is replaced by rename, so an interrupted write cannot truncate it", async () => {
  // Global scope rewrites ~/.claude.json — Claude Code's entire configuration.
  // Truncate-and-write means a crash between the two leaves it empty and the
  // user loses everything. Rename is atomic on one filesystem: a reader sees
  // the old file or the new one, never a half.
  const target = join(home, "config.json")
  await writeFile(target, '{"existing":true}', "utf-8")
  await writeAtomic(target, '{"replaced":true}')
  expect(JSON.parse(await readFile(target, "utf-8"))).toEqual({ replaced: true })
  expect((await readdir(home)).filter((f) => f.includes("tmp"))).toEqual([])
})

test("a failed replacement leaves the original alone and cleans up after itself", async () => {
  // The target is a directory, so the rename fails after the temp file was
  // already written. The original must survive and no scratch may be left.
  const target = join(home, "adirectory")
  await mkdir(target, { recursive: true })
  await expect(writeAtomic(target, "nope")).rejects.toThrow()
  expect((await stat(target)).isDirectory()).toBe(true)
  expect((await readdir(home)).filter((f) => f.includes("tmp"))).toEqual([])
})

// --- Codex and Claude Desktop ---------------------------------------------

function opts(cwd: string, scope: "global" | "project", interactive = true) {
  return {
    home, cwd, cliPath: "/abs/cli.ts", scope, dryRun: true,
    bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun",
    cairnRoot: "/tmp/cairn-root", platform: "linux" as const, interactive,
  }
}

const desktopCfg = () => join(home, ".config", "Claude", "claude_desktop_config.json")

test("project scope with Codex plans ~/.codex/config.toml, not a project file", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".codex"))
  try {
    const plan = await planInit(opts(repo, "project"))
    const cfg = plan.changes.find((c) => c.path === join(home, ".codex", "config.toml"))
    expect(cfg).toBeDefined()
    expect(readCodexEntry(cfg!.content)?.env?.CAIRN_ROOT).toBe("/tmp/cairn-root")
    expect(plan.changes.some((c) => c.path.startsWith(repo) && c.path.endsWith(".toml"))).toBe(false)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("global scope with Codex plans its config and its global AGENTS.md", async () => {
  await mkdir(join(home, ".codex"))
  const plan = await planInit(opts(home, "global"))
  const paths = plan.changes.map((c) => c.path)
  expect(paths).toContain(join(home, ".codex", "config.toml"))
  const agentsMd = plan.changes.find((c) => c.path === join(home, ".codex", "AGENTS.md"))
  expect(agentsMd?.content).toContain("team_knowledge_map")
})

test("Codex at project scope gets the rules in ~/.codex/AGENTS.md when the project uses CLAUDE.md", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".codex"))
  await writeFile(join(repo, "CLAUDE.md"), "# mine\n", "utf-8")
  try {
    const plan = await planInit(opts(repo, "project"))
    const paths = plan.changes.map((c) => c.path)
    expect(paths).toContain(join(repo, "CLAUDE.md"))
    expect(paths).toContain(join(home, ".codex", "AGENTS.md"))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("Codex at project scope does not touch ~/.codex/AGENTS.md when the project uses AGENTS.md", async () => {
  // Codex already reads the project's AGENTS.md; a second copy means reading it twice.
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".codex"))
  try {
    const plan = await planInit(opts(repo, "project"))
    const paths = plan.changes.map((c) => c.path)
    expect(paths).toContain(join(repo, "AGENTS.md"))
    expect(paths).not.toContain(join(home, ".codex", "AGENTS.md"))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

const HAND_EDIT = (path: string) =>
  `cairn couldn't edit ${path} (it may use syntax cairn can't safely edit) — add the cairn server by hand:`

/** A global run on a machine with Claude Code and Codex, against `toml`. */
async function codexRefused(toml: string) {
  await mkdir(join(home, ".claude"))
  await mkdir(join(home, ".codex"))
  const cfg = join(home, ".codex", "config.toml")
  await writeFile(cfg, toml, "utf-8")
  const plan = await planInit({ ...opts(home, "global"), dryRun: false })
  const result = await runInit({ ...opts(home, "global"), dryRun: false })
  expect(await readFile(cfg, "utf-8")).toBe(toml)
  const warning = result.warnings.find((w) => w.includes(HAND_EDIT(cfg)))
  expect(warning).toBeDefined()
  expect(warning).toContain("[mcp_servers.cairn]")
  expect(warning).toContain('CAIRN_ROOT = "/tmp/cairn-root"')
  // Codex is skipped — not configured, not proved — and nothing else is.
  expect(plan.agents).toEqual(["claude"])
  expect(plan.configs.map((c) => c.agent)).toEqual(["claude"])
  expect(plan.changes.some((c) => c.path.startsWith(join(home, ".codex")))).toBe(false)
  expect(JSON.parse(await readFile(join(home, ".claude.json"), "utf-8")).mcpServers.cairn).toBeDefined()
  expect(await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8")).toContain("team_knowledge_map")
}

test("an invalid Codex config is left untouched, with the server to add by hand, and the rest written", async () => {
  await codexRefused("[mcp_servers.other]\ncommand = \n")
})

test("a valid Codex config Bun's TOML parser rejects is skipped the same way", async () => {
  // Datetimes are valid TOML; Bun's parser does not accept them.
  await codexRefused('model = "o4"\nlast_seen = 1979-05-27T07:32:00Z\n')
})

test("a cairn server written as an inline table is skipped the same way", async () => {
  await codexRefused('[mcp_servers]\ncairn = { command = "/old/cairn", args = ["mcp"] }\n')
})

for (const scope of ["global", "project"] as const) {
  test(`Claude Desktop at ${scope} scope plans its config, the paste step and the restart`, async () => {
    const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
    await mkdir(join(home, ".config", "Claude"), { recursive: true })
    await writeFile(desktopCfg(), JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8")
    try {
      const plan = await planInit(opts(repo, scope))
      const cfg = plan.changes.find((c) => c.path === desktopCfg())
      expect(cfg).toBeDefined()
      const parsed = JSON.parse(cfg!.content)
      expect(parsed.mcpServers.other).toEqual({ command: "x" })
      expect(parsed.mcpServers.cairn.env.CAIRN_ROOT).toBe("/tmp/cairn-root")
      expect(plan.printOnly.join(" ")).toMatch(/Claude Desktop.*Claude project/)
      expect(plan.nextSteps.join(" ")).toMatch(/[Qq]uit Claude Desktop completely.*reopen/)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
}

test("a malformed Claude Desktop config is left untouched, with the server to add by hand", async () => {
  await mkdir(join(home, ".claude"))
  await mkdir(join(home, ".config", "Claude"), { recursive: true })
  await writeFile(desktopCfg(), "{ broken", "utf-8")
  const plan = await planInit({ ...opts(home, "global"), dryRun: false })
  const result = await runInit({ ...opts(home, "global"), dryRun: false })
  expect(await readFile(desktopCfg(), "utf-8")).toBe("{ broken")
  const warning = result.warnings.find((w) => w.includes(HAND_EDIT(desktopCfg())))
  expect(warning).toBeDefined()
  expect(warning).toContain('"mcpServers"')
  expect(warning).toContain('"CAIRN_ROOT": "/tmp/cairn-root"')
  expect(plan.agents).toEqual(["claude"])
  expect(plan.configs.map((c) => c.agent)).toEqual(["claude"])
  // Its paste and restart steps go with it.
  expect(plan.printOnly.join(" ")).not.toContain("Claude Desktop")
  expect(plan.nextSteps.join(" ")).not.toContain("Claude Desktop")
  expect(await Bun.file(join(home, ".claude.json")).exists()).toBe(true)
})

// --- machine-wide config and non-interactive project scope -----------------

test("a non-interactive project run leaves Codex and Claude Desktop alone", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".claude"))
  await mkdir(join(home, ".codex"))
  await mkdir(join(home, ".config", "Claude"), { recursive: true })
  // CLAUDE.md is the case that would otherwise add ~/.codex/AGENTS.md.
  await writeFile(join(repo, "CLAUDE.md"), "# mine\n", "utf-8")
  try {
    const plan = await planInit(opts(repo, "project", false))
    expect(plan.agents).toEqual(["claude"])
    expect(plan.notConfigured).toEqual(["codex", "claude-desktop"])
    expect(plan.changes.every((c) => c.path.startsWith(repo))).toBe(true)
    expect(plan.configs.map((c) => c.agent)).toEqual(["claude"])
    expect(plan.printOnly).toEqual([])
    expect(plan.nextSteps).toEqual([])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("a non-interactive global run still configures Codex and Claude Desktop", async () => {
  await mkdir(join(home, ".codex"))
  await mkdir(join(home, ".config", "Claude"), { recursive: true })
  const plan = await planInit(opts(home, "global", false))
  expect(plan.agents).toEqual(["codex", "claude-desktop"])
  expect(plan.notConfigured).toEqual([])
})

test("an interactive project run configures them and leaves nothing out", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  await mkdir(join(home, ".codex"))
  try {
    const plan = await planInit(opts(repo, "project", true))
    expect(plan.agents).toEqual(["codex"])
    expect(plan.notConfigured).toEqual([])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// --- Claude Code and a project's AGENTS.md ----------------------------------
//
// Claude Code reads AGENTS.md only when no CLAUDE.md exists in the working
// directory or any folder above it. Its documented way to read AGENTS.md
// anyway is an `@AGENTS.md` import in CLAUDE.md, so project scope puts one
// next to the AGENTS.md that holds the block.

test("an import line is @AGENTS.md or @./AGENTS.md on a line of its own", () => {
  expect(importsAgentsMd("@AGENTS.md")).toBe(true)
  expect(importsAgentsMd("# Mine\n\n  @./AGENTS.md  \n")).toBe(true)
  expect(importsAgentsMd("# Mine\n\nSee @AGENTS.md for more.\n")).toBe(false)
  expect(importsAgentsMd("`@AGENTS.md`\n")).toBe(false)
  expect(importsAgentsMd("@AGENTS.md.bak\n")).toBe(false)
  expect(importsAgentsMd("")).toBe(false)
})

test("adding the import keeps what the teammate wrote", () => {
  expect(addAgentsImport("")).toBe("@AGENTS.md\n")
  const out = addAgentsImport("# Mine\n\nDo not lose this.")
  expect(out).toContain("Do not lose this.")
  expect(importsAgentsMd(out)).toBe(true)
  expect(out.endsWith("\n")).toBe(true)
})

async function inRepo(fn: (repo: string) => Promise<void>) {
  const repo = await mkdtemp(join(tmpdir(), "cairn-repo-"))
  try {
    await fn(repo)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

const projectRun = (repo: string, over: { dryRun?: boolean; interactive?: boolean } = {}) =>
  runInit({
    home, cwd: repo, cliPath: "/abs/cli.ts", scope: "project", dryRun: over.dryRun ?? false,
    bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root",
    interactive: over.interactive,
  })

test("a new repo gets AGENTS.md with the block and a CLAUDE.md that imports it", async () => {
  await mkdir(join(home, ".claude"))
  await inRepo(async (repo) => {
    const r = await projectRun(repo, { interactive: false })
    expect(await readFile(join(repo, "AGENTS.md"), "utf-8")).toContain("<!-- cairn:start -->")
    expect(await readFile(join(repo, "CLAUDE.md"), "utf-8")).toBe("@AGENTS.md\n")
    expect(r.written).toContain(join(repo, "CLAUDE.md"))
  })
})

test("an existing AGENTS.md with no CLAUDE.md gets a CLAUDE.md that imports it", async () => {
  await mkdir(join(home, ".claude"))
  await inRepo(async (repo) => {
    await writeFile(join(repo, "AGENTS.md"), "# Ours\n", "utf-8")
    await projectRun(repo)
    expect(await readFile(join(repo, "CLAUDE.md"), "utf-8")).toBe("@AGENTS.md\n")
  })
})

test("an existing CLAUDE.md without the import gets one, and never the block itself", async () => {
  await mkdir(join(home, ".claude"))
  await inRepo(async (repo) => {
    await writeFile(join(repo, "AGENTS.md"), "# Ours\n", "utf-8")
    await writeFile(join(repo, "CLAUDE.md"), "# Claude notes\n\nDo not lose this.\n", "utf-8")
    await projectRun(repo)
    const claude = await readFile(join(repo, "CLAUDE.md"), "utf-8")
    expect(claude).toContain("Do not lose this.")
    expect(importsAgentsMd(claude)).toBe(true)
    expect(claude).not.toContain("<!-- cairn:start -->")
    expect(await readFile(join(repo, "AGENTS.md"), "utf-8")).toContain("<!-- cairn:start -->")
  })
})

test("a CLAUDE.md that gains the import loses a block an older run left in it", async () => {
  // With the import, a block in both files is the same instructions read twice.
  await mkdir(join(home, ".claude"))
  await inRepo(async (repo) => {
    await writeFile(join(repo, "AGENTS.md"), "# Ours\n", "utf-8")
    await writeFile(join(repo, "CLAUDE.md"), upsertBlock("# Claude notes\n", "OLD RULES"), "utf-8")
    await projectRun(repo)
    const claude = await readFile(join(repo, "CLAUDE.md"), "utf-8")
    expect(claude).toContain("# Claude notes")
    expect(claude).not.toContain("OLD RULES")
    expect(claude).not.toContain("<!-- cairn:start -->")
    expect(importsAgentsMd(claude)).toBe(true)
  })
})

for (const line of ["@AGENTS.md", "  @./AGENTS.md  "]) {
  test(`a CLAUDE.md that already imports AGENTS.md (${line.trim()}) is left alone`, async () => {
    await mkdir(join(home, ".claude"))
    await inRepo(async (repo) => {
      const original = `# Claude notes\n${line}\n`
      await writeFile(join(repo, "AGENTS.md"), "# Ours\n", "utf-8")
      await writeFile(join(repo, "CLAUDE.md"), original, "utf-8")
      const r = await projectRun(repo)
      expect(r.written).not.toContain(join(repo, "CLAUDE.md"))
      expect(await readFile(join(repo, "CLAUDE.md"), "utf-8")).toBe(original)
    })
  })
}

test("re-running init writes nothing more to CLAUDE.md", async () => {
  await mkdir(join(home, ".claude"))
  await inRepo(async (repo) => {
    await projectRun(repo)
    const r = await projectRun(repo)
    expect(r.written).not.toContain(join(repo, "CLAUDE.md"))
    expect(await readFile(join(repo, "CLAUDE.md"), "utf-8")).toBe("@AGENTS.md\n")
  })
})

test("a dry run lists the CLAUDE.md it would create, and writes nothing", async () => {
  await mkdir(join(home, ".claude"))
  await inRepo(async (repo) => {
    const r = await projectRun(repo, { dryRun: true })
    expect(r.written).toContain(join(repo, "CLAUDE.md"))
    expect(await Bun.file(join(repo, "CLAUDE.md")).exists()).toBe(false)
  })
})

test("a repo whose instructions live in CLAUDE.md keeps the block there and gains no import", async () => {
  await mkdir(join(home, ".claude"))
  await inRepo(async (repo) => {
    await writeFile(join(repo, "CLAUDE.md"), "# Claude notes\n", "utf-8")
    await projectRun(repo)
    const claude = await readFile(join(repo, "CLAUDE.md"), "utf-8")
    expect(claude).toContain("<!-- cairn:start -->")
    expect(importsAgentsMd(claude)).toBe(false)
    expect(await Bun.file(join(repo, "AGENTS.md")).exists()).toBe(false)
  })
})

test("without Claude Code, project scope writes no CLAUDE.md", async () => {
  await mkdir(join(home, ".cursor"))
  await inRepo(async (repo) => {
    const r = await projectRun(repo)
    expect(r.written).not.toContain(join(repo, "CLAUDE.md"))
    expect(await Bun.file(join(repo, "CLAUDE.md")).exists()).toBe(false)
  })
})

test("global scope writes the block into ~/.claude/CLAUDE.md and no import anywhere", async () => {
  await mkdir(join(home, ".claude"))
  const r = await runInit({ home, cwd: home, cliPath: "/abs/cli.ts", scope: "global", dryRun: false, bunPath: "/opt/homebrew/bin/bun", execPath: "/opt/homebrew/bin/bun", cairnRoot: "/tmp/cairn-root" })
  expect(r.written).not.toContain(join(home, "CLAUDE.md"))
  const md = await readFile(join(home, ".claude", "CLAUDE.md"), "utf-8")
  expect(md).toContain("<!-- cairn:start -->")
  expect(importsAgentsMd(md)).toBe(false)
})
