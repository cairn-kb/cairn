import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkAuth, checkCairnRoot, checkCommandMatches, checkConfig, checkGeneration, checkInstructions, checkSourceLaunch, checkStore, checkTelemetry, findMcpConfig, runDoctor } from "../src/doctor"
import type { DoctorDeps } from "../src/doctor"
import { newConfig, writeConfig } from "../src/config"
import type { AuthConfig } from "../src/config"
import { exitCode } from "../src/doctor-render"

let home: string, cwd: string, root: string, agentRoot: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-home-"))
  cwd = await mkdtemp(join(tmpdir(), "cairn-cwd-"))
  root = await mkdtemp(join(tmpdir(), "cairn-root-"))
  // The store the MCP config points the agent at, deliberately not the ambient
  // one — the two diverge on any machine where the shell exports a different
  // CAIRN_ROOT than `cairn init` wrote.
  agentRoot = await mkdtemp(join(tmpdir(), "cairn-agentroot-"))
})
afterEach(async () => {
  for (const d of [home, cwd, root, agentRoot]) await rm(d, { recursive: true, force: true })
})

const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  home, cwd, root,
  // The CLAUDE.md walk stops here, so nothing above the temp project — the
  // real home directory included — can change a result.
  ceiling: cwd,
  execPath: "/bin/cairn",
  handshake: async () => ["team_knowledge_map", "team_knowledge_propose", "team_knowledge_read", "team_knowledge_search", "team_knowledge_write_document"],
  env: {},
  ...over,
})

async function writeMcp(entry: unknown) {
  await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { cairn: entry } }), "utf-8")
}

test("a missing MCP config fails with the command that fixes it", async () => {
  // The agent has to exist for `cairn init` to be the right advice — without
  // this the test was silently covering the no-agent branch below instead.
  await mkdir(join(home, ".claude"), { recursive: true })
  const r = await checkConfig(deps())
  expect(r.status).toBe("fail")
  expect(r.fix).toContain("cairn init")
})

test("a missing MCP config on a machine with no agent names the real problem", async () => {
  // Prescribing a bare `cairn init` here sent the user round a loop,
  // because init writes nothing on a machine with no agent either. The two
  // states need different advice, so doctor has to tell them apart.
  const r = await checkConfig(deps())
  expect(r.status).toBe("fail")
  expect(r.detail).toContain("no supported agent")
  expect(r.detail).toContain("~/.claude, ~/.cursor and ~/.codex")
  expect(r.detail).not.toContain("Claude Desktop")
  expect(r.fix).toContain("--project")
  expect(r.fix).toContain("Claude Code, Cursor or Codex")
})

test("a machine with only Claude Desktop is told to name it, not sent round to a bare cairn init", async () => {
  // init no longer configures Claude Desktop unless asked, so `cairn init`
  // alone would find no agent here.
  await mkdir(join(home, ".config", "Claude"), { recursive: true })
  const config = await checkConfig(deps({ platform: "linux" }))
  expect(config.status).toBe("fail")
  expect(config.detail).not.toContain("no supported agent")
  expect(config.fix).toBe("cairn init --agents claude-desktop")
  const telemetry = await checkTelemetry(deps({ platform: "linux" }))
  expect(telemetry.fix).toBe("cairn init --agents claude-desktop")
})

test("a config whose command does not exist fails", async () => {
  // Branch 1 of checkCommandMatches: access(X_OK) throws before the
  // command is ever compared to deps.execPath. Assertion is pinned to
  // this branch's own wording so it can't silently collapse onto branch 2.
  await writeMcp({ command: "/somewhere/else/cairn", args: ["mcp"] })
  const found = await findMcpConfig(deps())
  const r = await checkCommandMatches(deps(), found!.entry)
  expect(r.status).toBe("fail")
  expect(r.detail).toContain("/somewhere/else/cairn")
  expect(r.detail).toMatch(/does not exist|not executable/)
})

test("a config whose command exists but is not this binary fails", async () => {
  // Branch 2 of checkCommandMatches: the single most common setup break,
  // and invisible to the person hitting it. Uses two distinct REAL
  // executables so access(X_OK) succeeds for both and the failure can only
  // come from the equality comparison, not the existence check.
  await writeMcp({ command: "/bin/sh", args: ["mcp"] })
  const found = await findMcpConfig(deps())
  const r = await checkCommandMatches(deps({ execPath: process.execPath }), found!.entry)
  expect(r.status).toBe("fail")
  expect(r.detail).toContain("/bin/sh")
  // Only branch 2's message contains this; branch 1's never does.
  expect(r.detail).toContain("but this is")
})

test("a config pointing at this binary passes", async () => {
  // Uses the real running executable rather than the literal "/bin/cairn":
  // checkCommandMatches does a genuine access(X_OK) against entry.command
  // before comparing it to deps.execPath, and a fictitious path fails that
  // check regardless of the equality it's meant to test.
  await writeMcp({ command: process.execPath, args: ["mcp"], env: { CAIRN_ROOT: root } })
  const found = await findMcpConfig(deps())
  const result = await checkCommandMatches(deps({ execPath: process.execPath }), found!.entry)
  expect(result.status).toBe("ok")
})

test("a config with no CAIRN_ROOT fails", async () => {
  await writeMcp({ command: "/bin/cairn", args: ["mcp"] })
  const found = await findMcpConfig(deps())
  const r = await checkCairnRoot(deps(), found!.entry)
  expect(r.status).toBe("fail")
  expect(r.detail).toContain("CAIRN_ROOT")
})

// --- a config that keeps launching servers built from code that moved -----
//
// An editor starts an MCP server once and keeps it alive; the operator
// found five `bun …/src/cli.ts mcp` processes, the oldest three days old, all
// pinned to a checkout whose contents had changed underneath them. Claims
// landed on disk while the index write failed and no propose event was
// recorded. The config is the durable signal, so that is what doctor reads.

test("a compiled cairn whose config still launches a source checkout fails", async () => {
  await writeMcp({
    command: "/opt/homebrew/bin/bun",
    args: ["/Users/you/projects/cairn/src/cli.ts", "mcp"],
    env: { CAIRN_ROOT: root },
  })
  const found = await findMcpConfig(deps())
  const r = checkSourceLaunch(found!.entry, true)
  expect(r.status).toBe("fail")
  // The checkout is named: "your config is wrong" with no path is not
  // something anyone can act on.
  expect(r.detail).toContain("/Users/you/projects/cairn/src/cli.ts")
  expect(r.fix).toContain("cairn init")
})

test("a checkout config is one problem, not two", async () => {
  // On a machine with exactly this config, `command-matches` also failed —
  // "the path is wrong" beside "your servers will drift", two sentences and an
  // inflated problem count for the single `cairn init` that fixes both. The
  // more specific check owns the diagnosis.
  await writeMcp({
    command: "/bin/sh",
    args: ["/Users/you/projects/cairn/src/cli.ts", "mcp"],
    env: { CAIRN_ROOT: root },
  })
  const found = await findMcpConfig(deps())
  const matches = await checkCommandMatches(deps({ execPath: process.execPath }), found!.entry)
  expect(matches.status).toBe("ok")
  expect(matches.detail).toContain("source-launch")
  // …and the one that does fail is the one that explains the damage.
  expect(checkSourceLaunch(found!.entry, true).status).toBe("fail")
})

test("a config whose command does not exist still fails, checkout or not", async () => {
  // The deferral above must not swallow the existence check: a `bun` that is
  // not there launches nothing at all, and source-launch cannot see that.
  await writeMcp({ command: "/nonexistent/bun", args: ["/somewhere/src/cli.ts", "mcp"] })
  const found = await findMcpConfig(deps())
  const r = await checkCommandMatches(deps(), found!.entry)
  expect(r.status).toBe("fail")
  expect(r.detail).toContain("/nonexistent/bun")
})

test("a compiled cairn whose config launches the binary passes", async () => {
  await writeMcp({ command: "/usr/local/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: root } })
  const found = await findMcpConfig(deps())
  expect(checkSourceLaunch(found!.entry, true).status).toBe("ok")
})

test("a source checkout launching itself from source is not a stale server", async () => {
  // A contributor's own machine. There is no binary to point at, so `bun
  // …/src/cli.ts mcp` is the only correct config there — flagging it would
  // make doctor exit 1 on every developer machine in the project.
  await writeMcp({
    command: "/opt/homebrew/bin/bun",
    args: ["/Users/you/projects/cairn/src/cli.ts", "mcp"],
    env: { CAIRN_ROOT: root },
  })
  const found = await findMcpConfig(deps())
  expect(checkSourceLaunch(found!.entry, false).status).toBe("ok")
})

test("runDoctor reports source-launch — the wiring cannot silently disappear", async () => {
  await writeMcp({ command: "/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: root } })
  const results = await runDoctor(deps())
  expect(results.some((r) => r.name === "source-launch")).toBe(true)
})

test("one exploding check does not abort the rest", async () => {
  // Setup matters: a version of this test that never wrote .mcp.json
  // left findMcpConfig returning null, and runDoctor skipped the whole config branch
  // (including handshake) — the assertion below would compare against
  // `undefined` for a reason unrelated to what the test claims to prove.
  // Writing a config here makes runDoctor actually reach the handshake check,
  // so the injected throwing handshake is genuinely exercised.
  await writeMcp({ command: "/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: root } })
  const results = await runDoctor(deps({
    handshake: async () => { throw new Error("boom") },
  }))
  expect(results.find((r) => r.name === "handshake")?.status).toBe("fail")
  // Checks after the failing one still ran.
  expect(results.some((r) => r.name === "telemetry")).toBe(true)
})

// --- where doctor looks for a config -------------------------------------

const cairnEntry = () => ({ command: "/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: root } })

test("doctor finds the Codex config init writes", async () => {
  await mkdir(join(home, ".codex"), { recursive: true })
  const path = join(home, ".codex", "config.toml")
  await writeFile(
    path,
    `model = "x"\n\n[mcp_servers.cairn]\ncommand = "/bin/cairn"\nargs = ["mcp"]\n\n[mcp_servers.cairn.env]\nCAIRN_ROOT = ${JSON.stringify(root)}\n`,
    "utf-8",
  )
  const found = await findMcpConfig(deps())
  expect(found?.path).toBe(path)
  expect(found?.entry).toEqual(cairnEntry())
})

test("doctor finds the Claude Desktop config init writes", async () => {
  const dir = join(home, "Library", "Application Support", "Claude")
  await mkdir(dir, { recursive: true })
  const path = join(dir, "claude_desktop_config.json")
  await writeFile(path, JSON.stringify({ mcpServers: { cairn: cairnEntry() } }), "utf-8")
  const found = await findMcpConfig(deps({ platform: "darwin" }))
  expect(found?.path).toBe(path)
})

test("run from a subfolder, doctor finds the .mcp.json at the git root", async () => {
  // An interactive init writes the project config at the repo's top level,
  // so doctor run from deeper inside the repo has to look there too.
  await writeMcp(cairnEntry())
  const sub = join(cwd, "src", "deep")
  await mkdir(sub, { recursive: true })
  const found = await findMcpConfig(deps({ cwd: sub, git: async () => `${cwd}\n` }))
  expect(found?.path).toBe(join(cwd, ".mcp.json"))
})

test("run from a subfolder, doctor finds a git-root .cursor/mcp.json", async () => {
  await mkdir(join(cwd, ".cursor"), { recursive: true })
  await writeFile(join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { cairn: cairnEntry() } }), "utf-8")
  const sub = join(cwd, "pkg")
  await mkdir(sub, { recursive: true })
  const found = await findMcpConfig(deps({ cwd: sub, git: async () => cwd }))
  expect(found?.path).toBe(join(cwd, ".cursor", "mcp.json"))
})

test("a project config still wins over the machine-wide Codex and Desktop ones", async () => {
  await writeMcp(cairnEntry())
  await mkdir(join(home, ".codex"), { recursive: true })
  await writeFile(join(home, ".codex", "config.toml"), `[mcp_servers.cairn]\ncommand = "/x"\nargs = []\n`, "utf-8")
  const found = await findMcpConfig(deps())
  expect(found?.path).toBe(join(cwd, ".mcp.json"))
})

test("Claude Code's global config still wins over Codex", async () => {
  await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { cairn: cairnEntry() } }), "utf-8")
  await mkdir(join(home, ".codex"), { recursive: true })
  await writeFile(join(home, ".codex", "config.toml"), `[mcp_servers.cairn]\ncommand = "/x"\nargs = []\n`, "utf-8")
  const found = await findMcpConfig(deps())
  expect(found?.path).toBe(join(home, ".claude.json"))
})

// --- instructions ---------------------------------------------------------

test("a Cursor-only global install warns rather than failing", async () => {
  // `cairn init --global` on a Cursor-only machine PRINTS the rules block for
  // the operator to paste, because Cursor keeps user rules in its settings and
  // there is no file to write. Failing that made doctor exit 1 on a setup that
  // had been done correctly.
  await mkdir(join(home, ".cursor"), { recursive: true })
  const configPath = join(home, ".cursor", "mcp.json")
  await writeFile(configPath, JSON.stringify({ mcpServers: { cairn: {} } }), "utf-8")
  const r = await checkInstructions(deps(), configPath)
  expect(r.status).toBe("warn")
  expect(r.detail).toContain("Cursor")
  expect(r.fix).toContain("Settings")
})

test("a Cursor-only PROJECT install still fails — project rules are a real file", async () => {
  await mkdir(join(cwd, ".cursor"), { recursive: true })
  const r = await checkInstructions(deps(), join(cwd, ".cursor", "mcp.json"))
  expect(r.status).toBe("fail")
})

test("a machine with Claude Code still fails on a missing block", async () => {
  // Claude Code present means init would have written ~/.claude/CLAUDE.md, so
  // its absence is a genuine failure and must not be softened.
  await mkdir(join(home, ".claude"), { recursive: true })
  await mkdir(join(home, ".cursor"), { recursive: true })
  const r = await checkInstructions(deps(), join(home, ".cursor", "mcp.json"))
  expect(r.status).toBe("fail")
})

test("an instructions file with the block passes regardless of configuration", async () => {
  await mkdir(join(home, ".cursor"), { recursive: true })
  await writeFile(join(cwd, "AGENTS.md"), "notes\n<!-- cairn:start -->\nrules\n", "utf-8")
  const r = await checkInstructions(deps(), join(home, ".cursor", "mcp.json"))
  expect(r.status).toBe("ok")
})

test("a CLAUDE.md that imports AGENTS.md, which has the block, passes and says so", async () => {
  // Claude Code reads the CLAUDE.md and AGENTS.md through its import, which is
  // how `cairn init` reaches Claude Code when the block lives in AGENTS.md.
  await writeFile(join(cwd, "CLAUDE.md"), "# Claude notes\n@AGENTS.md\n", "utf-8")
  await writeFile(join(cwd, "AGENTS.md"), "notes\n<!-- cairn:start -->\nrules\n<!-- cairn:end -->\n", "utf-8")
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("imports")
  expect(r.detail).toContain(join(cwd, "CLAUDE.md"))
})

test("a CLAUDE.md that imports an AGENTS.md without the block still fails", async () => {
  await writeFile(join(cwd, "CLAUDE.md"), "@AGENTS.md\n", "utf-8")
  await writeFile(join(cwd, "AGENTS.md"), "notes\n", "utf-8")
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("fail")
})

test("a CLAUDE.md that is a symlink to AGENTS.md, which has the block, passes", async () => {
  await writeFile(join(cwd, "AGENTS.md"), "notes\n<!-- cairn:start -->\nrules\n<!-- cairn:end -->\n", "utf-8")
  await symlink("AGENTS.md", join(cwd, "CLAUDE.md"))
  await writeMcp(cairnEntry())
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("same file")
})

// Claude Code reads AGENTS.md only when no CLAUDE.md, .claude/CLAUDE.md or
// CLAUDE.local.md exists in the working directory or above it. A block that
// only AGENTS.md carries is then never read.
const BLOCK = "notes\n<!-- cairn:start -->\nrules\n<!-- cairn:end -->\n"

test("Claude Code with the block only in AGENTS.md and a CLAUDE.md beside it fails", async () => {
  await writeFile(join(cwd, "AGENTS.md"), BLOCK, "utf-8")
  await writeFile(join(cwd, "CLAUDE.md"), "# notes\n", "utf-8")
  await writeMcp(cairnEntry())
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("fail")
  expect(r.detail).toContain(join(cwd, "CLAUDE.md"))
  expect(r.fix).toContain("Claude Code won't read AGENTS.md while a CLAUDE.md exists here or above")
  expect(r.fix).toContain("cairn init")
})

test("a CLAUDE.md in a parent directory hides the project's AGENTS.md too", async () => {
  const outer = await mkdtemp(join(tmpdir(), "cairn-outer-"))
  try {
    const project = join(outer, "work", "project")
    await mkdir(project, { recursive: true })
    await writeFile(join(outer, "CLAUDE.md"), "# everything I work on\n", "utf-8")
    await writeFile(join(project, "AGENTS.md"), BLOCK, "utf-8")
    await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { cairn: cairnEntry() } }), "utf-8")
    const r = await checkInstructions(deps({ cwd: project, ceiling: outer }), join(project, ".mcp.json"))
    expect(r.status).toBe("fail")
    expect(r.detail).toContain(join(outer, "CLAUDE.md"))
  } finally {
    await rm(outer, { recursive: true, force: true })
  }
})

test("a parent's .claude/CLAUDE.md hides it from a global Claude Code install", async () => {
  const outer = await mkdtemp(join(tmpdir(), "cairn-outer-"))
  try {
    const project = join(outer, "project")
    await mkdir(join(outer, ".claude"), { recursive: true })
    await mkdir(project)
    await writeFile(join(outer, ".claude", "CLAUDE.md"), "# mine\n", "utf-8")
    await writeFile(join(project, "AGENTS.md"), BLOCK, "utf-8")
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { cairn: cairnEntry() } }), "utf-8")
    const r = await checkInstructions(deps({ cwd: project, ceiling: outer }), join(home, ".claude.json"))
    expect(r.status).toBe("fail")
  } finally {
    await rm(outer, { recursive: true, force: true })
  }
})

test("Claude Code with the block in AGENTS.md and no CLAUDE.md anywhere passes", async () => {
  await writeFile(join(cwd, "AGENTS.md"), BLOCK, "utf-8")
  await writeMcp(cairnEntry())
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("ok")
})

test("Claude Code with a CLAUDE.md that imports AGENTS.md passes", async () => {
  await writeFile(join(cwd, "AGENTS.md"), BLOCK, "utf-8")
  await writeFile(join(cwd, "CLAUDE.md"), "# notes\n@./AGENTS.md\n", "utf-8")
  await writeMcp(cairnEntry())
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("ok")
})

test("without Claude Code, a CLAUDE.md beside AGENTS.md does not matter", async () => {
  await mkdir(join(cwd, ".cursor"), { recursive: true })
  await writeFile(join(cwd, "AGENTS.md"), BLOCK, "utf-8")
  await writeFile(join(cwd, "CLAUDE.md"), "# notes\n", "utf-8")
  await writeFile(join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { cairn: cairnEntry() } }), "utf-8")
  const r = await checkInstructions(deps(), join(cwd, ".cursor", "mcp.json"))
  expect(r.status).toBe("ok")
})

// Cursor's rules file carries the block too, but Claude Code never reads it.
async function claudeAndCursorProject(claudeMd: string) {
  await mkdir(join(cwd, ".cursor", "rules"), { recursive: true })
  await writeFile(join(cwd, "AGENTS.md"), BLOCK, "utf-8")
  await writeFile(join(cwd, ".cursor", "rules", "cairn.mdc"), BLOCK, "utf-8")
  await writeFile(join(cwd, "CLAUDE.md"), claudeMd, "utf-8")
  await writeMcp(cairnEntry())
  await writeFile(join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { cairn: cairnEntry() } }), "utf-8")
}

test("Claude Code + Cursor with the block in AGENTS.md and cairn.mdc, and a CLAUDE.md beside them, fails", async () => {
  await claudeAndCursorProject("# notes\n")
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("fail")
  expect(r.fix).toContain("Claude Code won't read AGENTS.md")
})

test("Claude Code + Cursor with a CLAUDE.md that imports AGENTS.md passes", async () => {
  await claudeAndCursorProject("# notes\n@AGENTS.md\n")
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("ok")
})

test("Claude Code with the block only in Cursor's rules fails", async () => {
  await mkdir(join(cwd, ".cursor", "rules"), { recursive: true })
  await writeFile(join(cwd, ".cursor", "rules", "cairn.mdc"), BLOCK, "utf-8")
  await writeMcp(cairnEntry())
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("fail")
  expect(r.detail).toContain("Claude Code")
  expect(r.fix).toContain("cairn init")
})

test("Claude Code with the block in ~/.claude/CLAUDE.md passes whatever the project has", async () => {
  await mkdir(join(home, ".claude"), { recursive: true })
  await writeFile(join(home, ".claude", "CLAUDE.md"), BLOCK, "utf-8")
  await writeFile(join(cwd, "AGENTS.md"), BLOCK, "utf-8")
  await writeFile(join(cwd, "CLAUDE.md"), "# notes\n", "utf-8")
  await writeMcp(cairnEntry())
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("ok")
})

test("Claude Code with the block in the project's CLAUDE.md passes", async () => {
  await writeFile(join(cwd, "CLAUDE.md"), BLOCK, "utf-8")
  await writeMcp(cairnEntry())
  const r = await checkInstructions(deps(), join(cwd, ".mcp.json"))
  expect(r.status).toBe("ok")
})

test("telemetry with no config reports not configured", async () => {
  await mkdir(join(home, ".claude"), { recursive: true })
  const r = await checkTelemetry(deps())
  expect(r.status).toBe("warn")
  expect(r.fix).toContain("cairn init")
})

test("telemetry consent on a machine with no agent points at a command that writes", async () => {
  // Same loop as the config check: consent is only ever recorded by a run of
  // init that gets as far as writing, and on a bare machine only --project does.
  const r = await checkTelemetry(deps())
  expect(r.status).toBe("warn")
  expect(r.fix).toContain("--project")
})

test("telemetry off is reported as off, not as a problem", async () => {
  await writeConfig(root, newConfig(false, "abc"))
  const r = await checkTelemetry(deps())
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("off")
})

test("a store missing abstracts warns without failing", async () => {
  // A degraded map is worth saying; it is not a broken install.
  const r = await checkStore(deps())
  expect(r.status).not.toBe("fail")
})

test("doctor inspects the store the MCP config names, not the ambient one", async () => {
  // The whole report must describe ONE store: the one the agent will use.
  // Reading deps.root here made doctor validate the configured root and then
  // report on a different one, calling both fine in the same output. The two
  // roots are deliberately in different states — the agent's is signed in and
  // the ambient one is not — so reading the wrong one is visible.
  await writeMcp({ command: "/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: agentRoot } })
  await writeConfig(agentRoot, { ...newConfig(false, "abc"), auth: AUTH })
  const results = await runDoctor(
    deps({ fetchImpl: hostedFetch({ approved: [{ abstract: "a" }], pending: [] }) }),
  )
  const store = results.find((r) => r.name === "store")
  expect(store?.detail).toContain("acme")
  expect(store?.detail).not.toContain("not connected")
})

test("a configured root with consent already recorded is not reported as never asked", async () => {
  // The false negative that motivated this: `cairn init` had written
  // config.json correctly into the configured root, and doctor — reading the
  // ambient root instead — warned that consent had never been asked.
  await writeMcp({ command: "/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: agentRoot } })
  await writeConfig(agentRoot, newConfig(false, "abc"))
  const results = await runDoctor(deps())
  const telemetry = results.find((r) => r.name === "telemetry")
  expect(telemetry?.status).toBe("ok")
  expect(telemetry?.detail).toContain("off")
})

test("with no MCP config at all, doctor falls back to the ambient root", async () => {
  await writeConfig(root, { ...newConfig(true, "abc"), auth: AUTH })
  const results = await runDoctor(
    deps({ fetchImpl: hostedFetch({ approved: [{ abstract: "a" }], pending: [] }) }),
  )
  // Both of these come from config.json in the ambient root, which is the one
  // thing this test is about: nothing else told doctor where to look.
  expect(results.find((r) => r.name === "store")?.detail).toContain("acme")
  expect(results.find((r) => r.name === "telemetry")?.detail).toContain("enabled")
})

test("runDoctor actually reports the store — wiring cannot silently disappear", async () => {
  // checkStore existing as an exported function proves nothing about the
  // real `cairn doctor` output; only runDoctor calling it does. This guards
  // the wiring itself, not the check's own logic (covered above).
  const results = await runDoctor(deps())
  const store = results.find((r) => r.name === "store")
  expect(store).toBeDefined()
  expect(store?.group).toBe("Store")
})

// --- generation -------------------------------------------------------------

test("no model configured is a warning naming the fix", async () => {
  await writeConfig(root, newConfig(false, "abc"))
  const r = await checkGeneration(deps())
  expect(r.status).toBe("warn")
  expect(r.fix).toContain("cairn model")
})

test("a configured model is reported with its provider", async () => {
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "compatible", model: "ornith:9b", baseUrl: null, apiKey: null, maxTokens: null }})
  const r = await checkGeneration(deps())
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("ornith:9b")
})

test("the key is NEVER printed, only where it came from", async () => {
  const secret = "sk-super-secret-value"
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "anthropic", model: "claude-haiku-4-5", baseUrl: null, apiKey: secret, maxTokens: null }})
  const r = await checkGeneration(deps())
  expect(JSON.stringify(r)).not.toContain(secret)
  expect(r.detail).toContain("stored")
})

test("an environment key is reported by the variable it came from", async () => {
  // A stored key silently shadowed is otherwise a long debugging session, and
  // "the environment" is not enough to go looking with — the variable name is.
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "anthropic", model: "claude-haiku-4-5", baseUrl: null, apiKey: "sk-stored", maxTokens: null }})
  const r = await checkGeneration(deps({ env: { CAIRN_MODEL_KEY: "sk-env" } }))
  expect(r.detail).toContain("set (from CAIRN_MODEL_KEY)")
  expect(JSON.stringify(r)).not.toContain("sk-stored")
})

test("a key from the provider's own variable is named, not called 'no key needed'", async () => {
  // This said "no key needed" — the same words Ollama gets — for a provider
  // that very much needs one and happened to have it.
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "anthropic", model: "claude-haiku-4-5", baseUrl: null, apiKey: null, maxTokens: null }})
  const r = await checkGeneration(deps({ env: { ANTHROPIC_API_KEY: "sk-env" } }))
  expect(r.detail).toContain("set (from ANTHROPIC_API_KEY)")
  expect(r.detail).not.toContain("no key needed")
  expect(r.status).toBe("ok")
  expect(JSON.stringify(r)).not.toContain("sk-env")
})

test("nothing stored means nothing can be shadowed", async () => {
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "anthropic", model: "claude-haiku-4-5", baseUrl: null, apiKey: null, maxTokens: null }})
  const r = await checkGeneration(deps({ env: { CAIRN_MODEL_KEY: "sk-env" } }))
  expect(r.detail).not.toMatch(/shadow/i)
})

test("a provider that needs a key and has none is a warning, not ok", async () => {
  // Every abstract this config writes would 401. Reporting it green is the
  // silent-lie failure doctor exists to end.
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "anthropic", model: "claude-haiku-4-5", baseUrl: null, apiKey: null, maxTokens: null }})
  const r = await checkGeneration(deps())
  expect(r.status).toBe("warn")
  expect(r.detail).toContain("not set")
  expect(r.fix).toContain("cairn model")
})

test("only a provider that genuinely needs no key reports 'no key needed'", async () => {
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "compatible", model: "ornith:9b", baseUrl: null, apiKey: null, maxTokens: null }})
  const r = await checkGeneration(deps())
  expect(r.detail).toContain("no key needed")
  expect(r.status).toBe("ok")
})

test("doctor names the model abstracts will actually send, not the stored one", async () => {
  // With CAIRN_MODEL exported, doctor printed the stored model while
  // `cairn abstracts` sent the overriding one to the same provider and failed
  // every claim. The override has to be visible where the model is reported.
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "anthropic", model: "claude-haiku-4-5", baseUrl: null, apiKey: "sk-stored", maxTokens: null }})
  const r = await checkGeneration(deps({ env: { CAIRN_MODEL: "llama3.2" } }))
  expect(r.detail).toContain("llama3.2")
  expect(r.detail).toContain("CAIRN_MODEL")
  expect(r.detail).toContain("claude-haiku-4-5")
})

test("an overridden endpoint is reported too", async () => {
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "compatible", model: "ornith:9b", baseUrl: "http://stored.local/v1", apiKey: null, maxTokens: null }})
  const r = await checkGeneration(deps({ env: { CAIRN_MODEL_URL: "http://other.local/v1" } }))
  expect(r.detail).toContain("CAIRN_MODEL_URL")
  expect(r.detail).toContain("http://other.local/v1")
})

test("an empty stored endpoint is not reported as an override", async () => {
  // readConfig keeps "" verbatim while resolveBaseUrl drops it, so comparing
  // the two raw values invented an override nobody had set:
  // "CAIRN_MODEL_URL overrides the stored endpoint with undefined". A check
  // whose whole job is accurate provenance must not make provenance up.
  await writeConfig(root, { ...newConfig(false, "abc"), generation: {
    provider: "compatible", model: "ornith:9b", baseUrl: "", apiKey: null, maxTokens: null }})
  const r = await checkGeneration(deps())
  expect(r.detail).not.toContain("CAIRN_MODEL_URL")
  expect(r.detail).not.toContain("undefined")
})

test("runDoctor reports generation — the wiring cannot silently disappear", async () => {
  const results = await runDoctor(deps())
  expect(results.find((r) => r.name === "generation")).toBeDefined()
})

// --- the hosted account ---------------------------------------------------

const AUTH: AuthConfig = {
  token: "cairn_tok_1", orgId: "org-1", orgSlug: "acme",
  apiUrl: "https://cairn.example", user: "alice",
}

async function signIn(over: Partial<AuthConfig> = {}) {
  await writeConfig(root, { ...newConfig(false, "abc"), auth: { ...AUTH, ...over } })
}

test("doctor reports being signed out with the command that fixes it", async () => {
  const r = await checkAuth(deps())
  // A FAILURE. It was a warning while `makeStore` fell back
  // to the local files, because doctor must not call a supported install
  // broken — but nothing works signed out now, and a warning would let
  // `cairn doctor` exit 0 on a machine where every command exits 1.
  expect(r.status).toBe("fail")
  expect(r.fix).toContain("cairn login")
})

test("signed out, doctor's exit code says so", async () => {
  // The property that matters is the exit code, not the status string: this is
  // what a scripted "is this install working" reads, and answering 0 here is
  // the same lie as `cairn status` printing an empty queue.
  expect(exitCode(await runDoctor(deps()))).toBe(1)
})

test("a revoked token is reported as revoked, not as an unreachable service", async () => {
  // The four failures need four different answers. Collapsing 401 into the
  // catch-all would send someone to check their network over a token they
  // could have replaced in one command.
  await signIn()
  const r = await checkAuth(deps({ fetchImpl: async () => new Response("{}", { status: 401 }) }))
  expect(r.status).toBe("fail")
  expect(r.detail).toMatch(/revoked|expired/)
  expect(r.fix).toContain("cairn login")
})

test("a service answering something else names the status and the endpoint", async () => {
  await signIn()
  const r = await checkAuth(deps({ fetchImpl: async () => new Response("{}", { status: 503 }) }))
  expect(r.status).toBe("fail")
  expect(r.detail).toContain("503")
  expect(r.detail).toContain("https://cairn.example")
  // Signing in again cannot fix a service that is up and answering 503.
  expect(r.fix).toBeDefined()
  expect(r.fix).not.toContain("cairn login")
})

test("a service nothing can reach is distinguished from one that refuses", async () => {
  await signIn()
  const r = await checkAuth(
    deps({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED") } }),
  )
  expect(r.status).toBe("fail")
  expect(r.detail).toContain("not reachable")
  expect(r.detail).toContain("https://cairn.example")
  // The cause, not just the verdict: a refused connection and a timeout want
  // different next steps and are otherwise indistinguishable in a paste.
  expect(r.detail).toContain("ECONNREFUSED")
  expect(r.fix).toBeDefined()
  expect(r.fix).not.toContain("cairn login")
})

test("a bug inside the check is not reported as a network problem", async () => {
  // Only the fetch is inside the try. A response this code then mishandles
  // must not come back as "cairn is not reachable" — that sends someone to
  // check a network that is fine, and hides the defect.
  await signIn()
  const r = await checkAuth(
    deps({
      fetchImpl: async () =>
        ({ get status() { throw new TypeError("exploded while reading status") } }) as unknown as Response,
    }),
  ).catch((e: unknown) => e)
  expect(r).toBeInstanceOf(TypeError)
})

test("a working token reports who is signed in and which space", async () => {
  await signIn()
  const r = await checkAuth(deps({ fetchImpl: async () => Response.json({ user: {} }) }))
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("alice")
  expect(r.detail).toContain("acme")
})

test("checkAuth asks the endpoint the stored token is for, carrying that token", async () => {
  // A hardcoded default URL here would report a healthy production account to
  // someone whose config points at a different service.
  await signIn({ apiUrl: "https://other.example" })
  const calls: { url: string; authorization: string | null }[] = []
  await checkAuth(
    deps({
      fetchImpl: async (input, init) => {
        calls.push({ url: input, authorization: new Headers(init?.headers).get("authorization") })
        return Response.json({ user: {} })
      },
    }),
  )
  expect(calls).toEqual([
    { url: "https://other.example/v1/me", authorization: "Bearer cairn_tok_1" },
  ])
})

// --- the store check must describe the store the CLI actually uses ---------
//
// `checkStore` used to build a FileStore unconditionally, so a machine signed
// into a space holding dozens of approved claims read "…/.cairn readable and writable —
// 0 approved, 0 pending" directly under a failing Account line. It also
// CREATED ~/.cairn/{inbox,approved,rejected} and index.db on a machine that
// will never read them, and its "run cairn abstracts" warning could never
// clear, because `cairn abstracts` runs against the hosted store.

/** A fake hosted space: claims by status, served the way the real routes do. */
const hostedFetch =
  (byStatus: Record<string, { abstract: string | null }[]>) =>
  async (input: string): Promise<Response> => {
    const url = new URL(input)
    const status = url.searchParams.get("status") ?? "pending"
    const claims = (byStatus[status] ?? []).map((c, i) => ({
      id: `${status}-${i}`,
      status,
      claim: `claim ${i}`,
      body: "detail",
      source: { author: "r", agent: "cursor", repo: null, session: null },
      created: "2026-08-28T00:00:00.000Z",
      reviewed: null,
      reviewer: null,
      overlaps: [],
      abstract: c.abstract,
      abstractBy: c.abstract ? "human" : null,
      tags: [],
    }))
    return Response.json({ claims, cursor: null })
  }

test("signed in, the store check reports the hosted space, not a directory nothing reads", async () => {
  await signIn()
  const r = await checkStore(
    deps({
      fetchImpl: hostedFetch({
        approved: [{ abstract: "Settles A." }, { abstract: "Settles B." }],
        pending: [{ abstract: null }],
      }),
    }),
  )
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("acme")
  expect(r.detail).toContain("2 approved")
  expect(r.detail).toContain("1 pending")
  // The abandoned local directory must not appear: one report, one store.
  expect(r.detail).not.toContain(root)
})

test("signed in, the store check creates no local store on a machine that will never use one", async () => {
  await signIn()
  await checkStore(deps({ fetchImpl: hostedFetch({}) }))
  for (const dir of ["inbox", "approved", "rejected", "index.db"]) {
    expect(existsSync(join(root, dir))).toBe(false)
  }
})

test("a hosted space that cannot be read is not reported as a healthy local one", async () => {
  // The observed pair: "Account ✘ cairn is not reachable at …" immediately
  // followed by "Store ✔ … 0 approved, 0 pending". The second line is the
  // dangerous one — it reads as an empty space rather than an unread one.
  await signIn()
  const r = await checkStore(
    deps({
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED")
      },
    }),
  )
  expect(r.status).not.toBe("ok")
  // "unknown", never "0 approved": an unread space and an empty one are
  // completely different news and read identically as a count.
  expect(r.detail).not.toContain("0 approved")
  expect(r.detail).toContain("unknown")
  // And it does not diagnose the network a second time — the Account check one
  // group above already did, with the fix.
  expect(r.fix).toContain("Account")
})

test("missing abstracts in the hosted space still warn, and the advice can actually clear it", async () => {
  // The warning used to be raised against the local directory while
  // `cairn abstracts` ran against the hosted store — so following the advice
  // correctly reported nothing to do and the warning never cleared.
  await signIn()
  const r = await checkStore(
    deps({ fetchImpl: hostedFetch({ approved: [{ abstract: null }], pending: [] }) }),
  )
  expect(r.status).toBe("warn")
  expect(r.fix).toContain("cairn abstracts")
})

test("signed out, the store check describes no store rather than a directory nothing reads", async () => {
  // ~/.cairn may well still hold claims from an earlier local setup. Counting
  // them here would report a healthy store for files no command will open.
  const r = await checkStore(deps())
  expect(r.detail).not.toContain(root)
  expect(r.detail).toContain("not connected")
  // The diagnosis lives one group up, with the fix; repeating it here would
  // read as two problems.
  expect(r.fix).toContain("Account check")
})

test("signed out, the store check creates nothing on disk", async () => {
  await checkStore(deps())
  expect(existsSync(join(root, "approved"))).toBe(false)
  expect(existsSync(join(root, "index.db"))).toBe(false)
})

test("runDoctor reports auth — the wiring cannot silently disappear", async () => {
  const results = await runDoctor(deps())
  expect(results.find((r) => r.name === "auth")).toBeDefined()
})

test("doctor reads the account from the store the MCP config names", async () => {
  // Same rule the store and telemetry checks already follow: one report must
  // describe one install, not the ambient shell's and the agent's at once.
  await writeMcp({ command: "/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: agentRoot } })
  await writeConfig(agentRoot, { ...newConfig(false, "abc"), auth: AUTH })
  const results = await runDoctor(
    deps({ execPath: "/bin/cairn", fetchImpl: async () => Response.json({ user: {} }) }),
  )
  const r = results.find((x) => x.name === "auth")!
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("acme")
})

// --- local mode: doctor must name which space it is describing -------------
//
// `cairn init --local` keeps an existing `auth` block rather than clearing
// it, so a stale token is possible by design. The mitigation lives here: a
// leftover credential must be visible, not hidden, and the checks must never
// build against the hosted space when `mode` is local.

test("the account check passes in local mode and says why", async () => {
  await writeConfig(root, { ...newConfig(false), mode: "local" as const })
  const r = await checkAuth(deps())
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("local space")
  expect(r.detail).toContain(root)
})

test("a token left over from a team space is reported, not hidden", async () => {
  // The visibility half of keeping `auth` at `init --local`. A credential the
  // CLI will never use is fine; a credential nobody knows is there is not.
  await writeConfig(root, { ...newConfig(false), mode: "local" as const, auth: AUTH })
  const r = await checkAuth(deps())
  expect(r.detail).toContain("this space is local")
})

test("the store check reads the local store rather than building an HttpStore", async () => {
  // It used to construct an HttpStore whenever `auth` was present, which in
  // local mode would report on a space the CLI will never read.
  await writeConfig(root, {
    ...newConfig(false), mode: "local" as const,
    auth: { ...AUTH, apiUrl: "https://unreachable.invalid" },
  })
  const r = await checkStore(deps({ fetchImpl: async () => { throw new Error("must not be called") } }))
  // Unreachable.invalid would fail a network check. Passing proves it never went.
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("local")
})


// --- doctor reports what it can see, and names what it cannot --------------
//
// `checkHandshake` spawns the configured command ITSELF. That proves cairn is
// installed, runnable and speaking MCP — it says nothing about whether the
// host chose to load it. Labelled `Connection`, a green line read as "the
// agent is connected"; twice in one day it was not.

test("the handshake check is labelled for what it actually verifies", async () => {
  await writeMcp({ command: "/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: agentRoot } })
  const results = await runDoctor(deps({ execPath: "/bin/cairn" }))
  const r = results.find((x) => x.name === "handshake")!
  expect(r.status).toBe("ok")
  expect(r.group).toBe("Server")
  expect(results.some((x) => x.group === "Connection")).toBe(false)
})

test("a project-scoped Cursor config gets the approval step doctor cannot check", async () => {
  // Not a failure: cairn cannot know, and reading Cursor's SQLite to find out
  // would be a new way to be wrong. A named unknown beats passing in silence.
  await mkdir(join(cwd, ".cursor"), { recursive: true })
  await writeFile(
    join(cwd, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { cairn: { command: "/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: agentRoot } } } }),
    "utf-8",
  )
  const results = await runDoctor(deps({ execPath: "/bin/cairn" }))
  const r = results.find((x) => x.name === "approval")!
  expect(r.group).toBe("Server")
  expect(r.status).toBe("warn")
  expect(r.detail).toContain("approve")
  // A named unknown must not turn a working install into "1 problem" — warnings
  // deliberately do not affect the exit code.
  expect(results.filter((x) => x.status === "fail").map((x) => x.name)).not.toContain("approval")
})

test("a config Cursor does not gate gets no approval line", async () => {
  // Only a PROJECT-scoped Cursor server is gated — a global one was observed
  // not to be, and a Claude Code config is not Cursor's business at all.
  await writeMcp({ command: "/bin/cairn", args: ["mcp"], env: { CAIRN_ROOT: agentRoot } })
  const results = await runDoctor(deps({ execPath: "/bin/cairn" }))
  expect(results.some((x) => x.name === "approval")).toBe(false)
})

// --- telemetry that is on but going nowhere ---------------------------------
//
// The check used to read config and probe nothing, so the failure it exists to
// catch — consent given, nothing arriving — was exactly the one it could not
// see. Silent signal loss looks identical to a quiet week.

test("telemetry that is on and reaching its endpoint says so", async () => {
  await writeConfig(root, { ...newConfig(true) })
  const r = await checkTelemetry(deps({ fetchImpl: async () => new Response("{}", { status: 200 }) }))
  expect(r.status).toBe("ok")
  expect(r.detail).toContain("enabled")
})

test("telemetry that is on and cannot reach its endpoint is reported, not hidden", async () => {
  await writeConfig(root, { ...newConfig(true) })
  const r = await checkTelemetry(
    deps({
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND")
      },
    }),
  )
  // A warning, not a failure: a telemetry outage does not break this install,
  // and `doctor`'s exit code answers "is this install broken".
  expect(r.status).toBe("warn")
  expect(r.detail).toContain("unreachable")
})

test("telemetry that is off probes nothing at all", async () => {
  // Consent covers the ping AND the reachability probe: an opted-out install
  // must make no request to the telemetry endpoint for any reason.
  let calls = 0
  await writeConfig(root, { ...newConfig(false) })
  const r = await checkTelemetry(
    deps({
      fetchImpl: async () => {
        calls++
        return new Response("{}", { status: 200 })
      },
    }),
  )
  expect(r.detail).toBe("off")
  expect(calls).toBe(0)
})
