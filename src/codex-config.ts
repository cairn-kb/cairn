/**
 * Codex's MCP config: `[mcp_servers.<name>]` tables in `~/.codex/config.toml`,
 * with `command`, `args` and an `[mcp_servers.<name>.env]` subtable.
 * <https://developers.openai.com/codex/mcp>
 *
 * The file is edited as text rather than parsed and re-serialised, because a
 * round trip through a TOML parser drops every comment and reorders what the
 * person wrote. The parser is only used to check the text before and after.
 */

import type { McpServerEntry } from "./init"

const NAME = "cairn"

type Table = Record<string, unknown>

function parse(text: string): Table {
  return Bun.TOML.parse(text) as Table
}

/**
 * A TOML basic string. JSON's escapes (`\"`, `\\`, `\n`, `\t`, `\uXXXX`, …)
 * are all valid TOML basic-string escapes, so JSON.stringify produces one.
 */
function str(value: string): string {
  return JSON.stringify(value)
}

function key(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : str(k)
}

/**
 * The dotted key of a `[table]` or `[[array]]` header line, as segments, or
 * null when the line is not a header.
 */
function headerKey(line: string): string[] | null {
  const m = /^\s*\[\[?(.*?)\]\]?\s*(#.*)?$/.exec(line.replace(/\r$/, ""))
  if (!m) return null
  const segments: string[] = []
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y
  const body = m[1]!
  let pos = 0
  while (pos < body.length) {
    re.lastIndex = pos
    const s = re.exec(body)
    if (!s) return null
    segments.push(s[1] !== undefined ? (JSON.parse(`"${s[1]}"`) as string) : (s[2] ?? s[3])!)
    pos = re.lastIndex
  }
  return segments
}

function isCairnTable(segments: string[]): boolean {
  return segments[0] === "mcp_servers" && segments[1] === NAME
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim()
  return t === "" || t.startsWith("#")
}

/** The lines of `text` with every `[mcp_servers.cairn]` / `[mcp_servers.cairn.*]` table removed. */
function withoutCairn(text: string): string[] {
  const lines = text.split("\n")
  const kept: string[] = []
  let i = 0
  while (i < lines.length) {
    const seg = headerKey(lines[i]!)
    if (!seg || !isCairnTable(seg)) {
      kept.push(lines[i]!)
      i++
      continue
    }
    // Run to the next header that is not ours.
    let end = i + 1
    while (end < lines.length) {
      const next = headerKey(lines[end]!)
      if (next && !isCairnTable(next)) break
      end++
    }
    // Comments and blank lines just above the next header introduce THAT
    // table, so they stay; only blank lines are dropped with ours.
    let last = end - 1
    while (last > i && isBlankOrComment(lines[last]!)) last--
    const trailing = lines.slice(last + 1, end)
    const firstComment = trailing.findIndex((l) => l.trim() !== "")
    if (firstComment !== -1) kept.push(...trailing.slice(firstComment))
    i = end
  }
  return kept
}

/** The cairn server as Codex config text — also what a person pastes by hand. */
export function codexBlock(entry: McpServerEntry): string {
  const lines = [
    `[mcp_servers.${NAME}]`,
    `command = ${str(entry.command)}`,
    `args = [${entry.args.map(str).join(", ")}]`,
  ]
  if (entry.env) {
    lines.push("", `[mcp_servers.${NAME}.env]`)
    for (const [k, v] of Object.entries(entry.env)) lines.push(`${key(k)} = ${str(v)}`)
  }
  return lines.join("\n")
}

function withoutCairnKey(config: Table): Table {
  const servers = config.mcp_servers
  if (!servers || typeof servers !== "object") return config
  const { [NAME]: _drop, ...rest } = servers as Table
  const { mcp_servers: _servers, ...others } = config
  // Appending `[mcp_servers.cairn]` to a file with no servers also creates
  // an empty `mcp_servers` — that is not a change to anything the person had.
  return Object.keys(rest).length === 0 ? others : { ...others, mcp_servers: rest }
}

/**
 * Add or replace the cairn server in a Codex config without disturbing
 * anything else in it. Throws rather than writing a config it cannot parse —
 * one we do not understand may hold servers we would silently destroy.
 */
export function mergeCodexConfig(existing: string, entry: McpServerEntry): string {
  let before: Table
  try {
    before = parse(existing)
  } catch {
    throw new Error("could not parse existing Codex config as TOML")
  }

  const rest = withoutCairn(existing).join("\n").replace(/\s+$/, "")
  const out = (rest === "" ? "" : `${rest}\n\n`) + codexBlock(entry) + "\n"

  // The edit is textual, so check its result as data: cairn exactly as
  // given, and everything else exactly as it was. Anything else — a cairn
  // server written as an inline table or dotted keys, a header-like line
  // inside a multi-line string — is refused rather than written.
  let after: Table
  try {
    after = parse(out)
  } catch {
    throw new Error("could not update the cairn server in the Codex config — edit it by hand")
  }
  const servers = (after.mcp_servers ?? {}) as Table
  if (!Bun.deepEquals(servers[NAME], entry) || !Bun.deepEquals(withoutCairnKey(after), withoutCairnKey(before))) {
    throw new Error("could not update the cairn server in the Codex config — edit it by hand")
  }
  return out
}

/** The cairn server in a Codex config, or null if there is none or the text does not parse. */
export function readCodexEntry(text: string): McpServerEntry | null {
  let config: Table
  try {
    config = parse(text)
  } catch {
    return null
  }
  const servers = config.mcp_servers as Table | undefined
  const raw = servers?.[NAME] as Table | undefined
  if (!raw || typeof raw.command !== "string") return null
  const args = raw.args ?? []
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null
  const entry: McpServerEntry = { command: raw.command, args: args as string[] }
  if (raw.env !== undefined) {
    const env = raw.env as Table
    if (typeof env !== "object" || env === null || !Object.values(env).every((v) => typeof v === "string")) {
      return null
    }
    entry.env = env as Record<string, string>
  }
  return entry
}
