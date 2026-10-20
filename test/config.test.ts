import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newConfig, readConfig, updateConfig, writeConfig } from "../src/config"

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cairn-cfg-")) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test("a fresh config carries a random install id and no send yet", () => {
  const cfg = newConfig(true, "11111111-2222-3333-4444-555555555555")
  expect(cfg.installId).toBe("11111111-2222-3333-4444-555555555555")
  expect(cfg.telemetry).toBe(true)
  expect(cfg.lastSentAt).toBeNull()
})

test("two fresh configs do not share an install id", () => {
  // Random, never derived from hostname or MAC — an id that identifies the
  // machine rather than the install would be a fingerprint.
  expect(newConfig(false).installId).not.toBe(newConfig(false).installId)
})

test("round trips through disk", async () => {
  const cfg = newConfig(true, "abc")
  await writeConfig(root, cfg)
  expect(await readConfig(root)).toEqual(cfg)
})

test("a missing config is null, not an error", async () => {
  expect(await readConfig(root)).toBeNull()
})

test("an unreadable config is null rather than a crash", async () => {
  // doctor must be able to report a corrupt config, not die on it.
  await writeFile(join(root, "config.json"), "{ not json", "utf-8")
  expect(await readConfig(root)).toBeNull()
})

test("a fresh config has no generation settings", () => {
  expect(newConfig(true, "abc").generation).toBeNull()
})

test("generation settings round trip", async () => {
  const cfg = { ...newConfig(true, "abc"), generation: {
    provider: "anthropic" as const, model: "claude-haiku-4-5", baseUrl: null, apiKey: "sk-x", maxTokens: null }}
  await writeConfig(root, cfg)
  expect((await readConfig(root))?.generation).toEqual(cfg.generation)
})

test("the file is not readable by anyone else", async () => {
  // It can hold an API key. 0600 must be set when the temp file is created,
  // not after the rename — otherwise the key is briefly world-readable.
  await writeConfig(root, { ...newConfig(true, "abc"), generation: {
    provider: "anthropic" as const, model: "m", baseUrl: null, apiKey: "sk-x", maxTokens: null }})
  const mode = (await stat(join(root, "config.json"))).mode & 0o777
  expect(mode).toBe(0o600)
})

test("a generation block missing its model is dropped, not half-loaded", async () => {
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ installId: "a", telemetry: false, generation: { provider: "anthropic" } }),
    "utf-8",
  )
  const cfg = await readConfig(root)
  expect(cfg?.installId).toBe("a")
  expect(cfg?.generation).toBeNull()
})

test("an unknown provider id is dropped rather than trusted", async () => {
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ installId: "a", telemetry: false, generation: { provider: "hal9000", model: "m" } }),
    "utf-8",
  )
  expect((await readConfig(root))?.generation).toBeNull()
})

test("a fresh config has no auth block", () => {
  expect(newConfig(true, "abc").auth).toBeNull()
})

test("the auth block round trips, cairn login's token included", async () => {
  const cfg = {
    ...newConfig(true, "abc"),
    auth: { token: "tok", orgId: "o1", orgSlug: "acme", apiUrl: "https://api.test", user: "alice" },
  }
  await writeConfig(root, cfg)
  expect((await readConfig(root))?.auth).toEqual(cfg.auth)
})

test("a null user in the auth block round trips too", async () => {
  const cfg = {
    ...newConfig(true, "abc"),
    auth: { token: "tok", orgId: "o1", orgSlug: "acme", apiUrl: "https://api.test", user: null },
  }
  await writeConfig(root, cfg)
  expect((await readConfig(root))?.auth).toEqual(cfg.auth)
})

test("a half-written auth block is dropped, not half-loaded", async () => {
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ installId: "a", telemetry: false, auth: { token: "tok" } }),
    "utf-8",
  )
  const cfg = await readConfig(root)
  expect(cfg?.installId).toBe("a")
  expect(cfg?.auth).toBeNull()
})

test("an empty token is dropped rather than trusted", async () => {
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      installId: "a",
      telemetry: false,
      auth: { token: "", orgId: "o1", orgSlug: "acme", apiUrl: "https://api.test", user: null },
    }),
    "utf-8",
  )
  expect((await readConfig(root))?.auth).toBeNull()
})

test("a maxTokens override round-trips, and a nonsensical one is dropped", async () => {
  // Reasoning models bound thinking PLUS the answer with max_tokens, so a cap
  // sized for a 40-word abstract truncates them. The override existed on
  // ProviderConfig from the start and was reachable only from a test — every
  // free text model on OpenRouter reasons, so there was no configuration a
  // person could write that made them work.
  const root = await mkdtemp(join(tmpdir(), "cairn-maxtokens-"))
  try {
    const base = newConfig(false)
    await writeConfig(root, {
      ...base,
      generation: { provider: "compatible", model: "m", baseUrl: null, apiKey: null, maxTokens: 4096 },
    })
    expect((await readConfig(root))?.generation?.maxTokens).toBe(4096)

    // Not a positive integer: fall back to the provider default rather than
    // sending a cap that makes every call fail in a way nobody can act on.
    for (const bad of [0, -1, 1.5, "512"]) {
      await writeFile(
        join(root, "config.json"),
        JSON.stringify({ ...base, generation: { provider: "compatible", model: "m", maxTokens: bad } }),
      )
      expect((await readConfig(root))?.generation?.maxTokens).toBeNull()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- the store mode ---------------------------------------------------------

test("a config written before local mode existed reads as team", async () => {
  // THE compatibility rule. Every install before local mode was hosted, and a
  // missing field must never silently relocate somebody's knowledge.
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ installId: "i1", telemetry: false, lastSentAt: null, generation: null, auth: null }),
  )
  expect((await readConfig(root))?.mode).toBe("team")
})

test("an explicit local mode round trips", async () => {
  await writeConfig(root, { ...newConfig(false), mode: "local" })
  expect((await readConfig(root))?.mode).toBe("local")
})

test("a mode that is not one of the two reads as team", async () => {
  // Same rule as `generation` and `auth`: a value that is not recognisable is
  // dropped rather than trusted. Trusting it here would pick a store from
  // garbage.
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      installId: "i1", telemetry: false, lastSentAt: null,
      generation: null, auth: null, mode: "hosted",
    }),
  )
  expect((await readConfig(root))?.mode).toBe("team")
})

test("newConfig defaults to team when no mode is given", () => {
  expect(newConfig(false).mode).toBe("team")
})

// --- the first-answer metric -------------------------------------------

test("a fresh config has no first-answer metric yet", () => {
  const cfg = newConfig(true, "abc")
  expect(cfg.initCompletedAt).toBeNull()
  expect(cfg.firstAnswerAt).toBeNull()
  expect(cfg.firstAnswerReported).toBe(false)
})

test("the first-answer metric round trips through disk", async () => {
  const cfg = {
    ...newConfig(true, "abc"),
    initCompletedAt: "2026-10-19T12:00:00.000Z",
    firstAnswerAt: "2026-10-19T12:07:00.000Z",
    firstAnswerReported: true,
  }
  await writeConfig(root, cfg)
  expect(await readConfig(root)).toEqual(cfg)
})

test("unparseable first-answer metric values read as defaults", async () => {
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      installId: "a",
      telemetry: false,
      initCompletedAt: 1234,
      firstAnswerAt: {},
      firstAnswerReported: "yes",
    }),
    "utf-8",
  )
  const cfg = await readConfig(root)
  expect(cfg?.initCompletedAt).toBeNull()
  expect(cfg?.firstAnswerAt).toBeNull()
  expect(cfg?.firstAnswerReported).toBe(false)
})

// --- updateConfig: patch a field without clobbering a concurrent write ----

test("updateConfig re-reads before writing, so it carries through a field it does not own", async () => {
  await writeConfig(root, { ...newConfig(true), firstAnswerAt: "2026-01-01T00:00:00.000Z" })
  await updateConfig(root, () => ({ lastSentAt: "2026-01-02T00:00:00.000Z" }))
  const cfg = await readConfig(root)
  expect(cfg?.lastSentAt).toBe("2026-01-02T00:00:00.000Z")
  // Untouched, because the patch never named it and updateConfig read a
  // fresh copy to merge onto rather than a snapshot taken earlier.
  expect(cfg?.firstAnswerAt).toBe("2026-01-01T00:00:00.000Z")
})

test("updateConfig sees a write that landed after its caller's own earlier read", async () => {
  await writeConfig(root, newConfig(true))
  // Simulates the exact hazard this exists for: a caller holding an old
  // snapshot (`stale`, read before the line below) must never reach this
  // helper with it — `updateConfig` ignores any snapshot and re-reads.
  const stale = await readConfig(root)
  await writeConfig(root, { ...stale!, firstAnswerAt: "2026-01-01T00:00:00.000Z" })
  await updateConfig(root, () => ({ lastSentAt: "2026-01-02T00:00:00.000Z" }))
  const cfg = await readConfig(root)
  expect(cfg?.firstAnswerAt).toBe("2026-01-01T00:00:00.000Z")
  expect(cfg?.lastSentAt).toBe("2026-01-02T00:00:00.000Z")
})

test("updateConfig skips the write when the patch declines", async () => {
  await writeConfig(root, { ...newConfig(true), lastSentAt: "2026-01-01T00:00:00.000Z" })
  await updateConfig(root, () => null)
  expect((await readConfig(root))?.lastSentAt).toBe("2026-01-01T00:00:00.000Z")
})

test("updateConfig on a missing config is a no-op, not a crash", async () => {
  await expect(updateConfig(root, () => ({ lastSentAt: "x" }))).resolves.toBeUndefined()
  expect(await readConfig(root)).toBeNull()
})
