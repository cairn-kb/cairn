import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXPECTED_TOOLS } from "../src/doctor"
import { proveAgents, writtenEntry } from "../src/prove"
import type { McpServerEntry } from "../src/init"

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cairn-prove-")) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const entry: McpServerEntry = {
  command: "/opt/cairn/bin/cairn",
  args: ["mcp"],
  env: { CAIRN_ROOT: "/Users/me/.cairn-test-root" },
}

async function writeJsonConfig(path: string, e: McpServerEntry | null): Promise<void> {
  const body = e ? { mcpServers: { cairn: e } } : { mcpServers: {} }
  await writeFile(path, JSON.stringify(body, null, 2))
}

test("writtenEntry reads a JSON agent's cairn entry back from disk", async () => {
  const path = join(dir, ".mcp.json")
  await writeJsonConfig(path, entry)
  expect(await writtenEntry("claude", path)).toEqual(entry)
})

test("writtenEntry reads a Codex (TOML) agent's cairn entry back from disk", async () => {
  const path = join(dir, "config.toml")
  await writeFile(
    path,
    [
      "[mcp_servers.cairn]",
      'command = "/opt/cairn/bin/cairn"',
      'args = ["mcp"]',
      "",
      "[mcp_servers.cairn.env]",
      'CAIRN_ROOT = "/Users/me/.cairn-test-root"',
      "",
    ].join("\n"),
  )
  expect(await writtenEntry("codex", path)).toEqual(entry)
})

test("writtenEntry returns null when the file has no cairn entry", async () => {
  const path = join(dir, ".mcp.json")
  await writeJsonConfig(path, null)
  expect(await writtenEntry("claude", path)).toBeNull()
})

test("writtenEntry returns null when the file does not exist at all", async () => {
  expect(await writtenEntry("claude", join(dir, "nope.json"))).toBeNull()
})

test("a handshake listing every expected tool proves the agent, with the tool count", async () => {
  const path = join(dir, ".mcp.json")
  await writeJsonConfig(path, entry)
  const proofs = await proveAgents(
    [{ agent: "claude", path }],
    async () => [...EXPECTED_TOOLS],
  )
  expect(proofs).toEqual([
    {
      agent: "claude",
      path,
      ok: true,
      tools: EXPECTED_TOOLS.length,
      detail: expect.stringContaining(String(EXPECTED_TOOLS.length)),
    },
  ])
})

test("a handshake missing tools fails and names them in the detail", async () => {
  const path = join(dir, ".mcp.json")
  await writeJsonConfig(path, entry)
  const partial = EXPECTED_TOOLS.slice(1)
  const proofs = await proveAgents([{ agent: "cursor", path }], async () => partial)
  expect(proofs).toHaveLength(1)
  expect(proofs[0]!.ok).toBe(false)
  expect(proofs[0]!.tools).toBe(partial.length)
  expect(proofs[0]!.detail).toContain(EXPECTED_TOOLS[0]!)
})

test("a handshake that throws fails with a fix that says to run the command and read its output", async () => {
  const path = join(dir, ".mcp.json")
  await writeJsonConfig(path, entry)
  const proofs = await proveAgents([{ agent: "claude", path }], async () => {
    throw new Error("spawn failed: no such file")
  })
  expect(proofs).toHaveLength(1)
  expect(proofs[0]!.ok).toBe(false)
  expect(proofs[0]!.tools).toBe(0)
  expect(proofs[0]!.detail).toContain("spawn failed: no such file")
  expect(proofs[0]!.fix).toMatch(/run the configured command/i)
  expect(proofs[0]!.fix).toMatch(/read what it prints/i)
})

test("a config file with no cairn entry fails and says the entry was not found", async () => {
  const path = join(dir, ".mcp.json")
  await writeJsonConfig(path, null)
  const proofs = await proveAgents([{ agent: "claude", path }], async () => [...EXPECTED_TOOLS])
  expect(proofs).toHaveLength(1)
  expect(proofs[0]!.ok).toBe(false)
  expect(proofs[0]!.tools).toBe(0)
  expect(proofs[0]!.detail).toMatch(/not found/i)
})

test("the handshake receives the entry exactly as read from the file, not one rebuilt from options", async () => {
  const path = join(dir, ".mcp.json")
  await writeJsonConfig(path, entry)
  let received: McpServerEntry | undefined
  await proveAgents([{ agent: "claude", path }], async (e) => {
    received = e
    return [...EXPECTED_TOOLS]
  })
  expect(received?.command).toBe(entry.command)
  expect(received?.env?.CAIRN_ROOT).toBe(entry.env!.CAIRN_ROOT)
})

test("proveAgents runs handshakes sequentially, one at a time", async () => {
  const pathA = join(dir, "a.json")
  const pathB = join(dir, "b.json")
  await writeJsonConfig(pathA, entry)
  await writeJsonConfig(pathB, entry)
  let concurrent = 0
  let maxConcurrent = 0
  const proofs = await proveAgents(
    [{ agent: "claude", path: pathA }, { agent: "cursor", path: pathB }],
    async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 10))
      concurrent--
      return [...EXPECTED_TOOLS]
    },
  )
  expect(maxConcurrent).toBe(1)
  expect(proofs).toHaveLength(2)
})
