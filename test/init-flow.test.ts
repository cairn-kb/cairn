import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInitCommand, teamImportMessage, type InitCommandDeps } from "../src/cli"
import { newConfig, readConfig, writeConfig, type AuthConfig } from "../src/config"
import { EXPECTED_TOOLS } from "../src/doctor"
import { EventLog } from "../src/events"
import type { McpServerEntry } from "../src/init"
import type { RepoInfo } from "../src/repo"
import { FileStore } from "../src/store"
import type { Store } from "@cairn-kb/protocol/types"

// The interactive `cairn init` flow, end to end through `runInitCommand`, with
// every prompt, the handshake, the store and the launcher behind injected
// stubs — clack needs a real terminal, and none is available here.

let home: string
let repoRoot: string
let root: string
let lines: string[]

const AUTH: AuthConfig = {
  token: "t", orgId: "org-1", orgSlug: "acme", apiUrl: "https://example.invalid", user: "me",
}

const okHandshake = async (_e: McpServerEntry) => [...EXPECTED_TOOLS]

async function storeAt(r: string): Promise<FileStore> {
  const s = new FileStore(r, new EventLog(r))
  await s.init()
  return s
}

const repo = (): RepoInfo => ({ root: repoRoot, label: "app" })

async function deps(over: Partial<InitCommandDeps> = {}): Promise<InitCommandDeps> {
  return {
    root,
    home,
    cwd: repoRoot,
    cliPath: "/abs/cli.ts",
    execPath: "/opt/homebrew/bin/bun",
    bunPath: "/opt/homebrew/bin/bun",
    dryRun: false,
    writeWithoutAgent: false,
    resolveScope: async () => "project",
    resolveMode: async () => "local",
    interactive: true,
    resolveMigration: async () => false,
    resolveTelemetry: async () => true,
    out: (l) => lines.push(l),
    repo: repo(),
    confirmWrite: async () => true,
    selectFolders: async (folders) => folders.map((f) => f.folder),
    addFolder: async () => null,
    confirmTeamImport: async () => true,
    signIn: async () => AUTH,
    handshake: okHandshake,
    openStore: storeAt,
    launchAgent: async () => {},
    agentOnPath: () => false,
    now: () => Date.parse("2026-10-20T10:00:00.000Z"),
    ...over,
  }
}

async function writeDocs(dir: string, docs: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(docs)) {
    await mkdir(join(dir, rel, ".."), { recursive: true })
    await writeFile(join(dir, rel), text)
  }
}

const FOUR = {
  "README.md": "# app\n\nThe app.\n",
  "docs/deploying.md": "# Deploying the API\n\nShip it with the release script.\n",
  "docs/testing.md": "# Testing strategy\n\nUnit tests first.\n",
  "adr/0001-storage.md": "# Storage decision\n\nWe store files on disk.\n",
}

const said = () => lines.join("\n")

async function docCount(r: string = root): Promise<number> {
  return (await (await storeAt(r)).listDocuments()).length
}

async function footprint(): Promise<string[]> {
  const seen: string[] = []
  for (const dir of [repoRoot, home, root]) {
    for (const name of await readdir(dir)) seen.push(`${dir}/${name}`)
  }
  return seen.sort()
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-flow-home-"))
  repoRoot = await mkdtemp(join(tmpdir(), "cairn-flow-repo-"))
  root = await mkdtemp(join(tmpdir(), "cairn-flow-root-"))
  await mkdir(join(home, ".claude"), { recursive: true })
  lines = []
})

afterEach(async () => {
  for (const d of [home, repoRoot, root]) await rm(d, { recursive: true, force: true })
})

// --- local happy path ---------------------------------------------------------

test("local: config, proofs, four documents tagged with the repo, a first answer", async () => {
  await writeDocs(repoRoot, FOUR)
  const outcome = await runInitCommand(await deps())
  expect(outcome).toBe("written")
  expect(existsSync(join(repoRoot, ".mcp.json"))).toBe(true)
  expect(said()).toContain("✓")
  expect(said()).toContain("Claude Code")
  const docs = await (await storeAt(root)).listDocuments()
  expect(docs.length).toBe(4)
  expect(docs.every((d) => d.repo === "app")).toBe(true)
  // The first answer names a real hit.
  expect(said()).toMatch(/Deploying the API|Testing strategy|Storage decision/)
  expect(said()).toContain(RESTART_FRAGMENT)
  const cfg = await readConfig(root)
  expect(cfg?.initCompletedAt).toBe("2026-10-20T10:00:00.000Z")
})

const RESTART_FRAGMENT = "restart"

test("local without telemetry consent leaves initCompletedAt null", async () => {
  await writeDocs(repoRoot, FOUR)
  expect(await runInitCommand(await deps({ resolveTelemetry: async () => false }))).toBe("written")
  expect((await readConfig(root))?.initCompletedAt).toBeNull()
})

test("an initCompletedAt already set is kept", async () => {
  await writeConfig(root, { ...newConfig(true), mode: "local", initCompletedAt: "2026-01-01T00:00:00.000Z" })
  await writeDocs(repoRoot, FOUR)
  await runInitCommand(await deps())
  expect((await readConfig(root))?.initCompletedAt).toBe("2026-01-01T00:00:00.000Z")
})

test("the agents to configure are named by label, and the rules block prints once", async () => {
  await writeDocs(repoRoot, FOUR)
  await mkdir(join(home, ".cursor"), { recursive: true })
  // Cursor's global rules and Claude Desktop each print a paste-this note.
  const desktop = process.platform === "darwin"
  if (desktop) await mkdir(join(home, "Library", "Application Support", "Claude"), { recursive: true })
  await runInitCommand(await deps({ resolveScope: async () => "global", repo: null }))
  expect(said()).toContain(desktop ? "Claude Code, Cursor and Claude Desktop" : "Claude Code and Cursor")
  expect(said()).not.toContain("claude and cursor")
  expect(said().split("call team_knowledge_map").length - 1).toBe(1)
})

test("declining the config preview cancels with nothing written", async () => {
  await writeDocs(repoRoot, FOUR)
  const before = await footprint()
  const outcome = await runInitCommand(await deps({ confirmWrite: async () => false }))
  expect(outcome).toBe("cancelled")
  expect(await footprint()).toEqual(before)
  expect(existsSync(join(root, "config.json"))).toBe(false)
})

test("declining the fill preview keeps the config and imports nothing", async () => {
  await writeDocs(repoRoot, FOUR)
  let asked = 0
  const outcome = await runInitCommand(
    await deps({
      confirmWrite: async () => {
        asked++
        return asked === 1
      },
    }),
  )
  expect(outcome).toBe("written")
  expect(asked).toBe(2)
  expect(existsSync(join(repoRoot, ".mcp.json"))).toBe(true)
  expect(existsSync(join(root, "config.json"))).toBe(true)
  expect(await docCount()).toBe(0)
  expect(said()).toContain("Nothing was imported")
})

test("the fill preview lists the file count, top folders and skill paths", async () => {
  await writeDocs(repoRoot, { "README.md": "# app\n\nhi\n" })
  let preview = ""
  await runInitCommand(
    await deps({
      confirmWrite: async () => {
        preview = said()
        return true
      },
    }),
  )
  expect(preview).toContain("1 document")
  expect(preview).toContain(join(repoRoot, ".claude", "skills", "cairn-import", "SKILL.md"))
})

// --- code scan ----------------------------------------------------------------

test("one doc, local: skills written, the prompt printed, the agent launched when on PATH", async () => {
  await writeDocs(repoRoot, { "README.md": "# app\n\nhi\n" })
  const launched: [string, string][] = []
  const outcome = await runInitCommand(
    await deps({
      agentOnPath: () => true,
      launchAgent: async (p, c) => {
        launched.push([p, c])
      },
    }),
  )
  expect(outcome).toBe("written")
  expect(existsSync(join(repoRoot, ".claude", "skills", "cairn-import", "SKILL.md"))).toBe(true)
  expect(said()).toContain("map this repo for cairn (repo: app)")
  expect(launched).toEqual([["map this repo for cairn (repo: app)", repoRoot]])
})

test("one doc, local: the agent is not launched when it is not on PATH", async () => {
  await writeDocs(repoRoot, { "README.md": "# app\n\nhi\n" })
  const launched: string[] = []
  await runInitCommand(
    await deps({
      agentOnPath: () => false,
      launchAgent: async (p) => {
        launched.push(p)
      },
    }),
  )
  expect(said()).toContain("map this repo for cairn (repo: app)")
  expect(launched).toEqual([])
})

// --- team mode ----------------------------------------------------------------

test("team, no auth: sign in after the mode and before any write, carried into config and prove", async () => {
  await writeDocs(repoRoot, FOUR)
  let modeResolved = false
  let signInSawModeFirst = false
  let agentConfigAtSignIn = true
  let rootHadAuth = false
  const outcome = await runInitCommand(
    await deps({
      resolveMode: async () => {
        modeResolved = true
        return "team"
      },
      signIn: async () => {
        signInSawModeFirst = modeResolved
        agentConfigAtSignIn = existsSync(join(repoRoot, ".mcp.json"))
        return AUTH
      },
      handshake: async (e) => {
        const cfg = await readConfig(e.env!.CAIRN_ROOT!)
        rootHadAuth = cfg?.auth?.token === "t"
        return [...EXPECTED_TOOLS]
      },
    }),
  )
  expect(outcome).toBe("written")
  expect(signInSawModeFirst).toBe(true)
  expect(agentConfigAtSignIn).toBe(false)
  expect(rootHadAuth).toBe(true)
  const cfg = await readConfig(root)
  expect(cfg?.mode).toBe("team")
  expect(cfg?.auth).toEqual(AUTH)
})

test("team: a sign-in failure cancels with nothing written", async () => {
  await writeDocs(repoRoot, FOUR)
  const before = await footprint()
  const outcome = await runInitCommand(
    await deps({
      resolveMode: async () => "team",
      signIn: async () => {
        throw new Error("login cancelled")
      },
    }),
  )
  expect(outcome).toBe("cancelled")
  expect(await footprint()).toEqual(before)
})

test("team: the import is confirmed with the document count and space", async () => {
  await writeDocs(repoRoot, FOUR)
  const asked: [number, string][] = []
  await runInitCommand(
    await deps({
      resolveMode: async () => "team",
      confirmTeamImport: async (n, space) => {
        asked.push([n, space])
        return true
      },
    }),
  )
  expect(asked).toEqual([[4, "acme"]])
  expect(await docCount()).toBe(4)
  expect(teamImportMessage(4, "acme")).toBe("these 4 documents will be visible to everyone in acme")
})

test("team: declining the team import imports nothing", async () => {
  await writeDocs(repoRoot, FOUR)
  const outcome = await runInitCommand(
    await deps({ resolveMode: async () => "team", confirmTeamImport: async () => false }),
  )
  expect(outcome).toBe("written")
  expect(await docCount()).toBe(0)
  expect(said()).toContain("Nothing was imported")
})

test("team, one doc: no skills, and a pointer at the console's Import", async () => {
  await writeDocs(repoRoot, { "README.md": "# app\n\nhi\n" })
  await runInitCommand(await deps({ resolveMode: async () => "team" }))
  expect(existsSync(join(repoRoot, ".claude", "skills"))).toBe(false)
  expect(said()).not.toContain("map this repo for cairn")
  expect(said()).toContain("console's Import")
})

// --- first answer ------------------------------------------------------------

test("a first-answer search with no hits says so, and the run still completes", async () => {
  await writeDocs(repoRoot, FOUR)
  const blind = async (r: string): Promise<Store> => {
    const s = await storeAt(r)
    return new Proxy(s, {
      get(target, prop, receiver) {
        if (prop === "search" || prop === "searchDocuments") return async () => []
        const v = Reflect.get(target, prop, receiver)
        return typeof v === "function" ? v.bind(target) : v
      },
    }) as Store
  }
  const outcome = await runInitCommand(await deps({ openStore: blind }))
  expect(outcome).toBe("written")
  expect(said()).toContain("The search found nothing")
})

// --- prove -------------------------------------------------------------------

test("a handshake that throws marks the agent ✗ with its fix, and the flow continues", async () => {
  await writeDocs(repoRoot, FOUR)
  const outcome = await runInitCommand(
    await deps({
      handshake: async () => {
        throw new Error("spawn failed")
      },
    }),
  )
  expect(outcome).toBe("written")
  expect(said()).toContain("✗")
  expect(said()).toContain("spawn failed")
  expect(said()).toContain("run the configured command yourself")
  expect(await docCount()).toBe(4)
})

// --- project root -------------------------------------------------------------

test("interactive from <repo>/src writes the project config at the repo root", async () => {
  await mkdir(join(repoRoot, "src"))
  await runInitCommand(await deps({ cwd: join(repoRoot, "src") }))
  expect(existsSync(join(repoRoot, ".mcp.json"))).toBe(true)
  expect(existsSync(join(repoRoot, "AGENTS.md"))).toBe(true)
  expect(existsSync(join(repoRoot, "src", ".mcp.json"))).toBe(false)
})

test("--yes from <repo>/src keeps writing at the current directory", async () => {
  await mkdir(join(repoRoot, "src"))
  await runInitCommand(await deps({ cwd: join(repoRoot, "src"), interactive: false, repo: null }))
  expect(existsSync(join(repoRoot, "src", ".mcp.json"))).toBe(true)
  expect(existsSync(join(repoRoot, "src", "AGENTS.md"))).toBe(true)
  expect(existsSync(join(repoRoot, ".mcp.json"))).toBe(false)
})

test("a non-interactive run proves, fills and asks nothing", async () => {
  await writeDocs(repoRoot, FOUR)
  let touched = false
  const flag = async () => {
    touched = true
    return true
  }
  const outcome = await runInitCommand(
    await deps({
      interactive: false,
      repo: null,
      confirmWrite: flag,
      confirmTeamImport: async () => flag(),
      handshake: async () => {
        touched = true
        return []
      },
    }),
  )
  expect(outcome).toBe("written")
  expect(touched).toBe(false)
  expect(await docCount()).toBe(0)
  expect(said()).not.toContain("✗")
  expect((await readConfig(root))?.initCompletedAt).toBeNull()
})

// --- dry run ------------------------------------------------------------------

test("--dry-run prints both plans and writes nothing", async () => {
  await writeDocs(repoRoot, FOUR)
  const before = await footprint()
  let asked = false
  const outcome = await runInitCommand(
    await deps({
      dryRun: true,
      resolveMode: async () => {
        asked = true
        return "local"
      },
    }),
  )
  expect(outcome).toBe("planned")
  expect(asked).toBe(false)
  expect(await footprint()).toEqual(before)
  expect(said()).toContain("Would configure")
  expect(said()).toContain("Would import 4 documents")
  expect(said()).toContain("docs")
})

test("--dry-run with one doc and --local says the code scan would be offered", async () => {
  await writeDocs(repoRoot, { "README.md": "# app\n\nhi\n" })
  let asked = false
  await runInitCommand(
    await deps({
      dryRun: true,
      modeFlag: "local",
      resolveMode: async () => {
        asked = true
        return "local"
      },
    }),
  )
  expect(asked).toBe(false)
  expect(said()).toContain("would offer a code scan")
  expect(said()).toContain(join(repoRoot, ".claude", "skills", "cairn-import", "SKILL.md"))
  expect(existsSync(join(repoRoot, ".claude"))).toBe(false)
})

test("--dry-run with one doc and an existing local config offers the code scan too", async () => {
  await writeConfig(root, { ...newConfig(false), mode: "local" })
  await writeDocs(repoRoot, { "README.md": "# app\n\nhi\n" })
  await runInitCommand(await deps({ dryRun: true, modeFlag: null }))
  expect(said()).toContain("would offer a code scan")
})

test("--dry-run with one doc, no flag and no config says the mode is not chosen yet", async () => {
  await writeDocs(repoRoot, { "README.md": "# app\n\nhi\n" })
  let asked = false
  await runInitCommand(
    await deps({
      dryRun: true,
      modeFlag: null,
      resolveMode: async () => {
        asked = true
        return "local"
      },
    }),
  )
  expect(asked).toBe(false)
  expect(said()).toContain("mode not chosen yet")
})

// --- adding folders -----------------------------------------------------------

test("an added folder outside the repo is refused with a pointer at cairn import", async () => {
  await writeDocs(repoRoot, FOUR)
  const outside = await mkdtemp(join(tmpdir(), "cairn-flow-outside-"))
  try {
    await writeDocs(outside, { "x.md": "# Outside doc\n\nnope\n" })
    let n = 0
    await runInitCommand(await deps({ addFolder: async () => (n++ === 0 ? outside : null) }))
    expect(said()).toContain(`cairn import ${outside}`)
    const docs = await (await storeAt(root)).listDocuments()
    expect(docs.some((d) => d.title === "Outside doc")).toBe(false)
    expect(docs.length).toBe(4)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test("global with no repo: the first added folder becomes the repo, labelled by its name", async () => {
  const notes = join(repoRoot, "notes")
  await writeDocs(notes, {
    "a.md": "# Alpha notes\n\none\n",
    "b.md": "# Beta notes\n\ntwo\n",
    "c.md": "# Gamma notes\n\nthree\n",
  })
  let n = 0
  const outcome = await runInitCommand(
    await deps({
      resolveScope: async () => "global",
      repo: null,
      addFolder: async () => (n++ === 0 ? notes : null),
    }),
  )
  expect(outcome).toBe("written")
  const docs = await (await storeAt(root)).listDocuments()
  expect(docs.length).toBe(3)
  expect(docs.every((d) => d.repo === "notes")).toBe(true)
})

test("an added folder may start with ~ for the home directory", async () => {
  await writeDocs(join(home, "notes"), {
    "a.md": "# Alpha notes\n\none\n",
    "b.md": "# Beta notes\n\ntwo\n",
    "c.md": "# Gamma notes\n\nthree\n",
  })
  let n = 0
  await runInitCommand(
    await deps({ resolveScope: async () => "global", repo: null, addFolder: async () => (n++ === 0 ? "~/notes" : null) }),
  )
  expect(await docCount()).toBe(3)
})

// --- fix round 1 --------------------------------------------------------------

test("a non-interactive dry run from a subdirectory: config at cwd, fill labelled and at the repo root", async () => {
  await writeDocs(repoRoot, FOUR)
  await mkdir(join(repoRoot, "src"))
  const before = await footprint()
  let asked = false
  const ask = async () => {
    asked = true
    return true
  }
  const outcome = await runInitCommand(
    await deps({
      dryRun: true,
      interactive: false,
      cwd: join(repoRoot, "src"),
      resolveMode: async () => {
        asked = true
        return "local"
      },
      confirmWrite: ask,
      selectFolders: async () => {
        asked = true
        return []
      },
    }),
  )
  expect(outcome).toBe("planned")
  expect(asked).toBe(false)
  expect(await footprint()).toEqual(before)
  const out = said()
  expect(out).toContain(join(repoRoot, "src", ".mcp.json"))
  expect(out).not.toContain(`${join(repoRoot, ".mcp.json")}\n`)
  const heading = out.indexOf("In a terminal, init would also import:")
  expect(heading).toBeGreaterThan(out.indexOf("Would configure"))
  expect(out.slice(heading)).toContain(`4 documents from app — ${repoRoot}`)
})

test("an interactive dry run keeps its fill plan unlabelled", async () => {
  await writeDocs(repoRoot, FOUR)
  await runInitCommand(await deps({ dryRun: true }))
  expect(said()).not.toContain("In a terminal, init would also import")
  expect(said()).toContain("Would import 4 documents")
})

test("Claude Code's failed proof still prints the code-scan prompt but offers no launch", async () => {
  await writeDocs(repoRoot, { "README.md": "# app\n\nhi\n" })
  const launched: string[] = []
  const outcome = await runInitCommand(
    await deps({
      agentOnPath: () => true,
      handshake: async () => {
        throw new Error("spawn failed")
      },
      launchAgent: async (p) => {
        launched.push(p)
      },
    }),
  )
  expect(outcome).toBe("written")
  expect(said()).toContain("map this repo for cairn (repo: app)")
  expect(launched).toEqual([])
})
