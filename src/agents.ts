/**
 * The coding agents `cairn init` knows how to configure, and how to tell
 * whether each one is installed.
 */

import { stat } from "node:fs/promises"
import { join, posix, win32 } from "node:path"
import type { Ui } from "./ui"

export type Agent = "claude" | "cursor" | "codex" | "claude-desktop"

/** Fixed display order — detection and `formatAgents` both follow this. */
export const ALL_AGENTS: readonly Agent[] = ["claude", "cursor", "codex", "claude-desktop"]

export const AGENT_LABEL: Record<Agent, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
}

/**
 * Claude Desktop's MCP config file, one per platform.
 * <https://modelcontextprotocol.io/quickstart/user> documents macOS and
 * Windows directly. Claude Desktop has no official Linux build; the path
 * below follows the XDG convention other MCP clients on Linux use for it
 * (`~/.config/Claude/...`) — community docs agree on it more often than on
 * any alternative, but it is not covered by the page above.
 */
export function desktopConfigPath(
  home: string,
  platform: NodeJS.Platform,
  appData?: string,
): string | null {
  // Built with posix/win32 explicitly, not the ambient `join` — that follows
  // the HOST running this code, not the `platform` argument, and the two
  // differ in tests (and would differ for real if cairn is ever cross-built).
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
  }
  if (platform === "win32") {
    return appData ? win32.join(appData, "Claude", "claude_desktop_config.json") : null
  }
  if (platform === "linux") {
    return posix.join(home, ".config", "Claude", "claude_desktop_config.json")
  }
  return null
}

async function isDir(path: string): Promise<boolean> {
  // stat, not Bun.file().exists() — the latter reports false for directories.
  return stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false)
}

/**
 * Only touch agents that are actually installed.
 *
 * Codex keeps its config at `~/.codex/config.toml`
 * <https://developers.openai.com/codex/config-basic>, so the directory check
 * that already works for Claude Code and Cursor covers it too. Claude
 * Desktop has no single marker directory across platforms, so it is detected
 * from the directory containing its config file instead.
 */
export async function detectAgents(
  home: string,
  platform: NodeJS.Platform = process.platform,
  appData?: string,
): Promise<Agent[]> {
  const found: Agent[] = []
  for (const [dir, agent] of [
    [".claude", "claude"],
    [".cursor", "cursor"],
    [".codex", "codex"],
  ] as const) {
    if (await isDir(join(home, dir))) found.push(agent)
  }
  const desktopConfig = desktopConfigPath(home, platform, appData)
  const dirOf = platform === "win32" ? win32.dirname : posix.dirname
  if (desktopConfig && (await isDir(dirOf(desktopConfig)))) found.push("claude-desktop")
  return found
}

/**
 * One line per agent, in `ALL_AGENTS` order — found ones ticked, missing ones
 * dimmed. Only meaningful in a terminal; callers gate this on `interactive`.
 */
export function formatAgents(found: readonly Agent[], ui: Ui): string[] {
  return ALL_AGENTS.map((agent) => {
    const label = AGENT_LABEL[agent]
    return found.includes(agent) ? ui.ok(label) : ui.dim(`  ${label} — not found`)
  })
}
