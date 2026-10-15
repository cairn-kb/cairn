import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_API_URL, makeSink, makeStore } from "../src/cli"
import { newConfig, writeConfig } from "../src/config"
import { EventLog } from "../src/events"
import { HttpStore } from "../src/http-store"
import { FileStore } from "../src/store"

const root = async () => mkdtemp(join(tmpdir(), "cairn-sel-"))

test("the default API is the custom domain", () => {
  expect(DEFAULT_API_URL).toBe("https://api.cairn-kb.dev")
})

test("local mode gets the file store even when a token is present", async () => {
  // The guard against the silent fallback coming back. A config can carry a
  // valid auth block for a team space the operator still has, and local mode
  // must not consult it.
  const r = await root()
  await writeConfig(r, {
    ...newConfig(false), mode: "local" as const,
    auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "u" },
  })
  expect(await makeStore(r)).toBeInstanceOf(FileStore)
  expect(await makeSink(r)).toBeInstanceOf(EventLog)
})

test("team mode gets the hosted store", async () => {
  const r = await root()
  await writeConfig(r, {
    ...newConfig(false), mode: "team" as const,
    auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "u" },
  })
  expect(await makeStore(r)).toBeInstanceOf(HttpStore)
})

test("a saved apiUrl is used as-is, even one that differs from the default", async () => {
  // A config saved by an older build may carry a different apiUrl in
  // `auth.apiUrl` -- requireAuth must return exactly that, never
  // DEFAULT_API_URL, or that install gets silently redirected to a host it
  // never logged into.
  const r = await root()
  const savedApiUrl = "https://old-host.example"
  await writeConfig(r, {
    ...newConfig(false), mode: "team" as const,
    auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: savedApiUrl, user: "u" },
  })
  const store = await makeStore(r)
  let seenUrl: string | undefined
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) => {
    seenUrl = String(url)
    return new Response(JSON.stringify({ claims: [], cursor: null }), { status: 200 })
  }) as typeof fetch
  try {
    await store.list("pending")
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(seenUrl).toStartWith(savedApiUrl)
})

test("the file store comes back with its event log attached", async () => {
  // FileStore throws rather than silently dropping an event, so a store built
  // without a sink fails on the first propose — after the claim is written.
  const r = await root()
  await writeConfig(r, { ...newConfig(false), mode: "local" as const })
  const store = (await makeStore(r)) as FileStore
  await expect(
    store.propose({
      claim: "a", body: "b", abstract: "", overlaps: [], cites: [], tags: [],
      source: { author: "a", agent: "a", repo: null, session: null },
    }),
  ).resolves.toBeDefined()
})
