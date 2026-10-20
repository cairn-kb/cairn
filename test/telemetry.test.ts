import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newConfig, readConfig, writeConfig } from "../src/config"
import type { Stats } from "@cairn-kb/protocol/stats"
import {
  buildPayload,
  consentPreview,
  dueToSend,
  sendTelemetry,
  trackingDisabled,
  TELEMETRY_URL,
  WRITE_KEY,
} from "../src/telemetry"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-telemetry-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const stats = (over: Partial<Stats> = {}): Stats => ({
  proposed: 12, approved: 9, edited: 1, rejected: 3, approveRate: 0.75,
  reads: 47, deniedReads: 0, searches: 5, sessions: 6,
  pendingAgeDays: 2.4, generatedAbstracts: 2, ...over,
})

test("the payload is counts and a version string, and nothing else", async () => {
  // This assertion is field-for-field on purpose: the risk this
  // feature carries is not a wrong number, it is a field nobody meant to send.
  // Anything added to `Stats` must fail here before it can reach the wire.
  const cfg = { ...newConfig(true), installId: "11111111-2222-3333-4444-555555555555" }
  expect(buildPayload(cfg, stats(), "0.4.3", "darwin-arm64")).toEqual({
    install: "11111111-2222-3333-4444-555555555555",
    version: "0.4.3",
    platform: "darwin-arm64",
    proposed: 12,
    approved: 9,
    rejected: 3,
    reads: 47,
    sessions: 6,
    pendingAgeDays: 2.4,
    generatedAbstracts: 2,
  })
})

test("nothing is due while consent has not been given", () => {
  // Off until someone says yes, including across upgrades.
  expect(dueToSend({ ...newConfig(false) }, Date.now())).toBe(false)
})

test("at most once every 24 hours", () => {
  const now = Date.parse("2026-09-02T12:00:00.000Z")
  const on = newConfig(true)
  expect(dueToSend({ ...on, lastSentAt: null }, now)).toBe(true)
  expect(dueToSend({ ...on, lastSentAt: "2026-09-02T11:00:00.000Z" }, now)).toBe(false)
  expect(dueToSend({ ...on, lastSentAt: "2026-09-01T11:00:00.000Z" }, now)).toBe(true)
})

test("opting out sends nothing at all", async () => {
  // The property that matters most in the whole feature: not "it sends less",
  // it makes no request.
  let calls = 0
  await writeConfig(root, { ...newConfig(false) })
  const outcome = await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64", stats: async () => stats(),
    fetchImpl: async () => {
      calls++
      return new Response("{}", { status: 200 })
    },
  })
  expect(outcome).toBe("skipped")
  expect(calls).toBe(0)
})

test("a successful send advances lastSentAt, and carries the write key", async () => {
  await writeConfig(root, { ...newConfig(true) })
  let seen: { url: string; key: string | null; body: unknown } | null = null
  const outcome = await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64", stats: async () => stats(),
    now: Date.parse("2026-09-02T12:00:00.000Z"),
    fetchImpl: async (url, init) => {
      seen = {
        url: String(url),
        key: new Headers(init?.headers).get("x-cairn-key"),
        body: JSON.parse(String(init?.body)),
      }
      return new Response("{}", { status: 202 })
    },
  })
  expect(outcome).toBe("sent")
  expect(seen!.url).toBe(TELEMETRY_URL)
  expect(seen!.key).toBe(WRITE_KEY)
  expect((seen!.body as { proposed: number }).proposed).toBe(12)
  expect((await readConfig(root))!.lastSentAt).toBe("2026-09-02T12:00:00.000Z")
})

test("the default telemetry endpoint is the custom domain", () => {
  expect(TELEMETRY_URL).toBe("https://telemetry.cairn-kb.dev/v1/ping")
})

test("a refusal leaves lastSentAt alone, so the next run tries again", async () => {
  // Advancing it on a 500 would turn one bad day into a silent 24-hour hole.
  await writeConfig(root, { ...newConfig(true) })
  const outcome = await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64", stats: async () => stats(),
    fetchImpl: async () => new Response("nope", { status: 500 }),
  })
  expect(outcome).toBe("failed")
  expect((await readConfig(root))!.lastSentAt).toBeNull()
})

test("a network that throws is swallowed, never surfaced to the command", async () => {
  await writeConfig(root, { ...newConfig(true) })
  const outcome = await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64", stats: async () => stats(),
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND")
    },
  })
  expect(outcome).toBe("failed")
})

test("a hanging endpoint does not hang the command", async () => {
  // The property most likely to regress silently. The abort has to come from
  // cairn, because a server that accepts the connection and never answers
  // will otherwise wait for ever.
  await writeConfig(root, { ...newConfig(true) })
  const started = Date.now()
  const outcome = await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64", stats: async () => stats(),
    timeoutMs: 50,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      }),
  })
  expect(outcome).toBe("failed")
  expect(Date.now() - started).toBeLessThan(2000)
  expect((await readConfig(root))!.lastSentAt).toBeNull()
})

test("CAIRN_TELEMETRY_URL points the send somewhere else", async () => {
  // How the integration tests reach a fixture rather than the real endpoint.
  await writeConfig(root, { ...newConfig(true) })
  let url = ""
  await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64", stats: async () => stats(),
    env: { CAIRN_TELEMETRY_URL: "http://127.0.0.1:9/v1/ping" },
    fetchImpl: async (u) => {
      url = String(u)
      return new Response("{}", { status: 200 })
    },
  })
  expect(url).toBe("http://127.0.0.1:9/v1/ping")
})

test("a stats read that throws cannot break the command either", async () => {
  // Telemetry opens the store. A corrupt log must not turn every command into
  // a crash on the way out.
  await writeConfig(root, { ...newConfig(true) })
  const outcome = await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64",
    stats: async () => {
      throw new Error("unreadable event log")
    },
    fetchImpl: async () => new Response("{}", { status: 200 }),
  })
  expect(outcome).toBe("failed")
})

test("CAIRN_TELEMETRY=0 silences one run without touching consent", async () => {
  // Consent stays exactly as the operator left it — this is a per-run
  // override, not a way to opt someone out behind their back.
  let calls = 0
  await writeConfig(root, { ...newConfig(true) })
  const outcome = await sendTelemetry({
    root, version: "0.4.4", platform: "darwin-arm64", stats: async () => stats(),
    env: { CAIRN_TELEMETRY: "0" },
    fetchImpl: async () => {
      calls++
      return new Response("{}", { status: 200 })
    },
  })
  expect(outcome).toBe("skipped")
  expect(calls).toBe(0)
  const cfg = (await readConfig(root))!
  expect(cfg.telemetry).toBe(true)
  expect(cfg.lastSentAt).toBeNull()
})

test.each([
  [{ DO_NOT_TRACK: "1" }, true],
  [{ DO_NOT_TRACK: "true" }, true],
  [{ DO_NOT_TRACK: "yes" }, true],
  [{ DO_NOT_TRACK: "0" }, false],
  [{ DO_NOT_TRACK: "" }, false],
  [{ DO_NOT_TRACK: "false" }, false],
  [{ CAIRN_TELEMETRY: "0" }, true],
  [{}, false],
])("trackingDisabled(%p) is %p", (env, expected) => {
  expect(trackingDisabled(env)).toBe(expected)
})

test("DO_NOT_TRACK=1 silences a consented install without touching consent", async () => {
  let calls = 0
  await writeConfig(root, { ...newConfig(true) })
  const outcome = await sendTelemetry({
    root, version: "0.7.0", platform: "darwin-arm64", stats: async () => stats(),
    env: { DO_NOT_TRACK: "1" },
    fetchImpl: async () => { calls++; return new Response("{}", { status: 200 }) },
  })
  expect(outcome).toBe("skipped")
  expect(calls).toBe(0)
  expect((await readConfig(root))!.telemetry).toBe(true)
})

// --- the first-answer bucket on the wire --------------------------------

const MIN = 60_000
const T = Date.parse("2026-09-02T00:00:00.000Z")

test("buildPayload carries firstAnswer only when a bucket applies", () => {
  const withBucket = {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 7 * MIN).toISOString(),
  }
  expect(buildPayload(withBucket, stats(), "0.4.3", "darwin-arm64").firstAnswer).toBe("5–10m")

  const withoutBucket = { ...newConfig(true), initCompletedAt: null, firstAnswerAt: null }
  const payload = buildPayload(withoutBucket, stats(), "0.4.3", "darwin-arm64")
  expect("firstAnswer" in payload).toBe(false)
})

test("a successful send with a bucket marks firstAnswerReported, once", async () => {
  await writeConfig(root, {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 7 * MIN).toISOString(),
  })
  const outcome = await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64", stats: async () => stats(),
    now: T,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  })
  expect(outcome).toBe("sent")
  expect((await readConfig(root))!.firstAnswerReported).toBe(true)
})

test("a successful send with no bucket leaves firstAnswerReported false", async () => {
  await writeConfig(root, { ...newConfig(true), initCompletedAt: null, firstAnswerAt: null })
  const outcome = await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64", stats: async () => stats(),
    fetchImpl: async () => new Response("{}", { status: 200 }),
  })
  expect(outcome).toBe("sent")
  expect((await readConfig(root))!.firstAnswerReported).toBe(false)
})

test("a failed send never marks firstAnswerReported", async () => {
  await writeConfig(root, {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 7 * MIN).toISOString(),
  })
  const outcome = await sendTelemetry({
    root, version: "0.4.3", platform: "darwin-arm64", stats: async () => stats(),
    fetchImpl: async () => new Response("nope", { status: 500 }),
  })
  expect(outcome).toBe("failed")
  expect((await readConfig(root))!.firstAnswerReported).toBe(false)
})

// --- the consent screen renders the real payload -------------------------

test("consentPreview carries exactly the keys buildPayload would send, firstAnswer included", () => {
  const preview = consentPreview()
  const [json] = preview.split("\n")
  const parsed = JSON.parse(json!) as Record<string, unknown>

  const sample = {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 7 * MIN).toISOString(),
  }
  const wire = buildPayload(sample, stats({ proposed: 0, approved: 0, rejected: 0, reads: 0, sessions: 0, pendingAgeDays: null, generatedAbstracts: 0 }), "x", "y")

  expect(Object.keys(parsed).sort()).toEqual(Object.keys(wire).sort())
  expect(parsed.firstAnswer).toBe("5–10m")
})

test("consentPreview states plainly what is never collected", () => {
  expect(consentPreview()).toContain("No claim text, no repo names, no paths.")
})
