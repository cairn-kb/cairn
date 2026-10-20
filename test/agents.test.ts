import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createUi } from "../src/ui"
import { ALL_AGENTS, detectAgents, desktopConfigPath, formatAgents } from "../src/agents"

const plainUi = createUi(false)

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-agents-"))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

// --- desktopConfigPath ------------------------------------------------------

test("desktopConfigPath on darwin", () => {
  expect(desktopConfigPath("/Users/pat", "darwin")).toBe(
    "/Users/pat/Library/Application Support/Claude/claude_desktop_config.json",
  )
})

test("desktopConfigPath on win32 with appData", () => {
  expect(desktopConfigPath("C:\\Users\\pat", "win32", "C:\\Users\\pat\\AppData\\Roaming")).toBe(
    "C:\\Users\\pat\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  )
})

test("desktopConfigPath on win32 with no appData is null", () => {
  expect(desktopConfigPath("C:\\Users\\pat", "win32")).toBeNull()
})

test("desktopConfigPath on linux", () => {
  expect(desktopConfigPath("/home/pat", "linux")).toBe("/home/pat/.config/Claude/claude_desktop_config.json")
})

test("desktopConfigPath on a platform with no Claude Desktop build is null", () => {
  expect(desktopConfigPath("/home/pat", "aix")).toBeNull()
})

// --- detectAgents ------------------------------------------------------------

test("detects nothing in an empty home", async () => {
  expect(await detectAgents(home, "linux")).toEqual([])
})

test("detects claude code alone", async () => {
  await mkdir(join(home, ".claude"))
  expect(await detectAgents(home, "linux")).toEqual(["claude"])
})

test("detects cursor alone", async () => {
  await mkdir(join(home, ".cursor"))
  expect(await detectAgents(home, "linux")).toEqual(["cursor"])
})

test("detects codex alone", async () => {
  await mkdir(join(home, ".codex"))
  expect(await detectAgents(home, "linux")).toEqual(["codex"])
})

test("detects claude desktop alone, by the directory holding its config", async () => {
  await mkdir(join(home, ".config", "Claude"), { recursive: true })
  expect(await detectAgents(home, "linux")).toEqual(["claude-desktop"])
})

test("detects all four together, in Agent order", async () => {
  await mkdir(join(home, ".claude"))
  await mkdir(join(home, ".cursor"))
  await mkdir(join(home, ".codex"))
  await mkdir(join(home, ".config", "Claude"), { recursive: true })
  expect(await detectAgents(home, "linux")).toEqual(["claude", "cursor", "codex", "claude-desktop"])
})

test("claude desktop is not reported on win32 with no appData, even with the directory present", async () => {
  // There is nowhere for win32 to look without appData, so nothing can match.
  await mkdir(join(home, ".claude"))
  expect(await detectAgents(home, "win32")).toEqual(["claude"])
})

// --- formatAgents ------------------------------------------------------------

test("formatAgents prints one line per agent, in ALL_AGENTS order", () => {
  const lines = formatAgents(["claude", "codex"], plainUi)
  expect(lines).toHaveLength(ALL_AGENTS.length)
  expect(lines[0]).toBe("✓ Claude Code")
  expect(lines[1]).toBe("  Cursor — not found")
  expect(lines[2]).toBe("✓ Codex")
  expect(lines[3]).toBe("  Claude Desktop — not found")
})

test("formatAgents with nothing found dims every line", () => {
  const lines = formatAgents([], plainUi)
  for (const line of lines) expect(line).toContain("not found")
})

test("formatAgents with everything found ticks every line", () => {
  const lines = formatAgents(ALL_AGENTS, plainUi)
  for (const line of lines) expect(line.startsWith("✓")).toBe(true)
})
