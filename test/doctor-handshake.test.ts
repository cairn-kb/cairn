import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnHandshake } from "../src/doctor"
import { EXPECTED_TOOLS } from "../src/doctor"
import { newConfig, writeConfig } from "../src/config"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-hs-"))
  // `cairn mcp` in team mode refuses to start without an account — an
  // agent whose team_knowledge_map returns [] concludes the team knows
  // nothing. The handshake never touches the service, so a token that would
  // not work is enough to reach the point this test is about.
  await writeConfig(root, {
    ...newConfig(false, "abc"),
    auth: {
      token: "cairn_tok_1", orgId: "org-1", orgSlug: "acme",
      apiUrl: "https://cairn.invalid", user: "r",
    },
  })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test("spawns cairn mcp for real and lists its tools", async () => {
  const tools = await spawnHandshake({
    command: process.execPath,               // bun, in a source checkout
    args: [join(import.meta.dir, "..", "src", "cli.ts"), "mcp"],
    env: { CAIRN_ROOT: root },
  })
  for (const t of EXPECTED_TOOLS) expect(tools).toContain(t)
}, 30_000)

test("a command that does not exist rejects rather than hanging", async () => {
  await expect(
    spawnHandshake({ command: "/nonexistent/cairn", args: ["mcp"] }, 5_000),
  ).rejects.toThrow()
}, 15_000)

test("a command that dies at startup carries its stderr into the error", async () => {
  // Why a server failed is almost always in what it printed on the way out.
  // "Connection closed" alone sends a tester nowhere, and the alternative —
  // letting the child's stderr inherit ours — dumps a raw crash banner into
  // the middle of doctor's report, where it reads as doctor crashing.
  await expect(
    spawnHandshake(
      { command: "/bin/sh", args: ["-c", "echo 'kaboom: no such database' >&2; exit 1"] },
      5_000,
    ),
  ).rejects.toThrow(/kaboom: no such database/)
}, 15_000)

test("a command that never speaks MCP times out", async () => {
  // `sleep` starts fine and says nothing. Without a timeout doctor would hang
  // forever on a misconfigured command, which is the failure it exists to find.
  await expect(
    spawnHandshake({ command: "/bin/sleep", args: ["30"] }, 2_000),
  ).rejects.toThrow(/timed out/i)
}, 15_000)

test("the handshake does not make the server it spawns send a ping", async () => {
  // `doctor` spawns `cairn mcp` with the AGENT's CAIRN_ROOT, and that
  // child is an ordinary CLI run — so when its session ended it fired the
  // telemetry piggyback for a root the doctor invocation never named: a ping
  // nobody consented to in that root, sent from a `doctor` run.
  //
  // The fixture endpoint is the assertion. Pointing the child at a dead port
  // instead would pass whether or not the fix is there, because a refused
  // connection and a suppressed send look identical from the config file.
  const seen: unknown[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push(await req.json())
      return new Response("{}", { status: 202 })
    },
  })
  try {
    await writeConfig(root, {
      ...newConfig(true, "abc"),
      auth: {
        token: "cairn_tok_1", orgId: "org-1", orgSlug: "acme",
        apiUrl: "https://cairn.invalid", user: "r",
      },
      mode: "local" as const,
    })
    await spawnHandshake({
      command: process.execPath,
      args: [join(import.meta.dir, "..", "src", "cli.ts"), "mcp"],
      env: {
        CAIRN_ROOT: root,
        CAIRN_TELEMETRY_URL: `http://127.0.0.1:${server.port}/v1/ping`,
      },
    })
    // The child pings after its session ends, so give it room to do the wrong
    // thing before concluding it did not.
    await new Promise((r) => setTimeout(r, 1500))
    expect(seen).toEqual([])
  } finally {
    server.stop(true)
  }
}, 20000)
