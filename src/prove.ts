/**
 * For each agent `cairn init` configured, read the cairn entry back from
 * that agent's own config file on disk and run doctor's MCP handshake
 * against exactly that entry.
 *
 * Reading the entry from disk rather than trusting what `init` just wrote is
 * the point: it proves the file `init` produced is the file the agent will
 * actually read, including anything a parser round-trip could have changed —
 * not a second description of the options `init` was called with.
 */

import { readFile } from "node:fs/promises"
import type { Agent } from "./agents"
import { readCodexEntry } from "./codex-config"
import { EXPECTED_TOOLS } from "./doctor"
import type { McpServerEntry } from "./init"

export interface AgentProof {
  agent: Agent
  path: string
  ok: boolean
  tools: number
  detail: string
  fix?: string
}

/**
 * The per-agent step cairn cannot see at all — not something a handshake
 * could ever catch, because the config and the handshake are both fine;
 * the agent just has not acted on the config yet.
 */
export const UNOBSERVABLE: Partial<Record<Agent, string>> = {
  cursor: "approve the project server in Cursor before its tools will load",
  "claude-desktop": "quit Claude Desktop fully (Cmd+Q, or Quit from its tray icon) and reopen it",
}

/** Printed once after the proofs, regardless of which agents were checked. */
export const RESTART_NOTE =
  "A running agent will not see cairn until you restart it."

/**
 * The cairn entry in an agent's config file, read back from disk exactly as
 * that agent would read it: JSON `mcpServers.cairn` for every agent except
 * Codex, whose config is TOML.
 */
export async function writtenEntry(agent: Agent, path: string): Promise<McpServerEntry | null> {
  let text: string
  try {
    text = await readFile(path, "utf-8")
  } catch {
    return null
  }
  if (agent === "codex") return readCodexEntry(text)
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, McpServerEntry> }
    return parsed.mcpServers?.cairn ?? null
  } catch {
    return null
  }
}

/**
 * Prove every configured agent can actually start cairn: read its entry back
 * from disk, then hand that exact entry to the handshake.
 *
 * Sequential, not parallel — each handshake spawns a process, and running
 * several at once would make a failure's stderr (captured per-command in
 * `spawnHandshake`) hard to attribute to the agent that caused it.
 */
export async function proveAgents(
  targets: { agent: Agent; path: string }[],
  handshake: (entry: McpServerEntry) => Promise<string[]>,
): Promise<AgentProof[]> {
  const proofs: AgentProof[] = []
  for (const { agent, path } of targets) {
    const entry = await writtenEntry(agent, path)
    if (!entry) {
      proofs.push({
        agent, path, ok: false, tools: 0,
        detail: `the cairn entry was not found in ${path}`,
        fix: "cairn init",
      })
      continue
    }
    let tools: string[]
    try {
      tools = await handshake(entry)
    } catch (err) {
      proofs.push({
        agent, path, ok: false, tools: 0,
        detail: `${entry.command} did not complete an MCP handshake: ${(err as Error).message}`,
        fix: "run the configured command yourself and read what it prints",
      })
      continue
    }
    const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t))
    if (missing.length > 0) {
      proofs.push({
        agent, path, ok: false, tools: tools.length,
        detail: `handshake succeeded but tools are missing: ${missing.join(", ")}`,
      })
      continue
    }
    proofs.push({
      agent, path, ok: true, tools: tools.length,
      detail: `cairn runs here and answers MCP: ${tools.length} tools listed`,
    })
  }
  return proofs
}
