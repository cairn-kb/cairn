import { expect, test } from "bun:test"
import { mergeCodexConfig, readCodexEntry } from "../src/codex-config"
import type { McpServerEntry } from "../src/init"

const e: McpServerEntry = {
  command: "/usr/local/bin/cairn",
  args: ["mcp"],
  env: { CAIRN_ROOT: "/Users/me/.cairn" },
}

function cairnOf(text: string): unknown {
  return (Bun.TOML.parse(text) as { mcp_servers?: Record<string, unknown> }).mcp_servers?.cairn
}

test("an empty config gains a parseable cairn server", () => {
  const out = mergeCodexConfig("", e)
  expect(cairnOf(out)).toEqual({
    command: "/usr/local/bin/cairn",
    args: ["mcp"],
    env: { CAIRN_ROOT: "/Users/me/.cairn" },
  })
})

test("other servers, top-level keys and comments are preserved byte for byte", () => {
  const existing = [
    "# my Codex settings",
    'model = "x"',
    "",
    "# the docs server",
    "[mcp_servers.other]",
    'command = "node"',
    'args = ["server.js"] # trailing comment',
    "",
  ].join("\n")
  const out = mergeCodexConfig(existing, e)
  expect(out.startsWith(existing.trimEnd())).toBe(true)
  const parsed = Bun.TOML.parse(out) as Record<string, any>
  expect(parsed.model).toBe("x")
  expect(parsed.mcp_servers.other).toEqual({ command: "node", args: ["server.js"] })
  expect(parsed.mcp_servers.cairn.command).toBe(e.command)
})

test("a previous cairn table and its env subtable are replaced, not duplicated", () => {
  const existing = [
    'model = "x"',
    "",
    "[mcp_servers.cairn]",
    'command = "/old/cairn"',
    'args = ["old"]',
    "",
    "[mcp_servers.cairn.env]",
    'CAIRN_ROOT = "/old/root"',
    "",
    "# kept: belongs to the next table",
    "[mcp_servers.after]",
    'command = "after"',
    "",
    "[profiles.work]",
    'model = "y"',
    "",
  ].join("\n")
  const out = mergeCodexConfig(existing, e)
  expect(out.match(/^\[mcp_servers\.cairn\]/gm)).toHaveLength(1)
  expect(out.match(/^\[mcp_servers\.cairn\.env\]/gm)).toHaveLength(1)
  expect(out).not.toContain("/old/")
  expect(out).toContain("# kept: belongs to the next table\n[mcp_servers.after]")
  const parsed = Bun.TOML.parse(out) as Record<string, any>
  expect(parsed.mcp_servers.cairn).toEqual(e)
  expect(parsed.mcp_servers.after).toEqual({ command: "after" })
  expect(parsed.profiles.work).toEqual({ model: "y" })
})

test("merging twice is idempotent", () => {
  const once = mergeCodexConfig('model = "x"\n', e)
  expect(mergeCodexConfig(once, e)).toBe(once)
})

test('a path containing " or \\ round-trips through the TOML parser', () => {
  const odd: McpServerEntry = {
    command: 'C:\\Program Files\\cairn "beta"\\cairn.exe',
    args: ['say "hi"', "back\\slash", "mcp"],
    env: { CAIRN_ROOT: 'D:\\roots\\"q"' },
  }
  expect(cairnOf(mergeCodexConfig("", odd))).toEqual(odd)
})

test("invalid TOML is refused", () => {
  expect(() => mergeCodexConfig("[mcp_servers.other\ncommand = ", e)).toThrow(
    "could not parse existing Codex config as TOML",
  )
})

test("a cairn server defined some other way is refused rather than clobbered", () => {
  // An inline table cannot be removed line by line; appending a second
  // definition would produce a file Codex cannot load.
  const existing = '[mcp_servers]\ncairn = { command = "/old/cairn", args = ["mcp"] }\n'
  expect(() => mergeCodexConfig(existing, e)).toThrow("edit it by hand")
})

test("readCodexEntry reads back exactly what mergeCodexConfig wrote", () => {
  expect(readCodexEntry(mergeCodexConfig("", e))).toEqual(e)
})

test("readCodexEntry returns null with no cairn server or unparseable text", () => {
  expect(readCodexEntry("")).toBeNull()
  expect(readCodexEntry('[mcp_servers.other]\ncommand = "x"\n')).toBeNull()
  expect(readCodexEntry("[broken")).toBeNull()
})
