import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newConfig, readConfig, writeConfig } from "../src/config"
import { firstAnswerBucket, recordSearchHit } from "../src/first-answer-metric"

const MIN = 60_000
const T = Date.parse("2026-10-19T12:00:00.000Z")

// --- firstAnswerBucket -------------------------------------------------

test("a hit just under five minutes after init buckets as <5m", () => {
  const cfg = {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 4 * MIN + 59_000).toISOString(),
  }
  expect(firstAnswerBucket(cfg, T)).toBe("<5m")
})

test("a hit at exactly five minutes buckets as 5–10m, not <5m", () => {
  const cfg = {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 5 * MIN).toISOString(),
  }
  expect(firstAnswerBucket(cfg, T)).toBe("5–10m")
})

test("a hit at exactly ten minutes buckets as 10–30m, not 5–10m", () => {
  const cfg = {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 10 * MIN).toISOString(),
  }
  expect(firstAnswerBucket(cfg, T)).toBe("10–30m")
})

test("a hit at exactly thirty minutes buckets as >30m, not 10–30m", () => {
  const cfg = {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 30 * MIN).toISOString(),
  }
  expect(firstAnswerBucket(cfg, T)).toBe(">30m")
})

test("no hit yet, less than 24 hours since init, reports nothing", () => {
  const cfg = { ...newConfig(true), initCompletedAt: new Date(T).toISOString(), firstAnswerAt: null }
  expect(firstAnswerBucket(cfg, T + 23 * 60 * MIN)).toBeNull()
})

test("no hit after at least 24 hours since init buckets as never", () => {
  const cfg = { ...newConfig(true), initCompletedAt: new Date(T).toISOString(), firstAnswerAt: null }
  expect(firstAnswerBucket(cfg, T + 24 * 60 * MIN)).toBe("never")
})

test("already reported — nothing more to say, even with a fresh hit", () => {
  const cfg = {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 2 * MIN).toISOString(),
    firstAnswerReported: true,
  }
  expect(firstAnswerBucket(cfg, T)).toBeNull()
})

test("init has not completed — nothing to measure from", () => {
  const cfg = { ...newConfig(true), initCompletedAt: null, firstAnswerAt: null }
  expect(firstAnswerBucket(cfg, T + 24 * 60 * MIN)).toBeNull()
})

// --- recordSearchHit -----------------------------------------------------

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cairn-first-answer-metric-")) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test("a hit records firstAnswerAt when telemetry is on and init has completed", async () => {
  await writeConfig(root, { ...newConfig(true), initCompletedAt: new Date(T).toISOString() })
  await recordSearchHit(root, 1, T + 7 * MIN)
  const cfg = await readConfig(root)
  expect(cfg?.firstAnswerAt).toBe(new Date(T + 7 * MIN).toISOString())
})

test("a second hit does not move firstAnswerAt", async () => {
  await writeConfig(root, {
    ...newConfig(true),
    initCompletedAt: new Date(T).toISOString(),
    firstAnswerAt: new Date(T + 7 * MIN).toISOString(),
  })
  await recordSearchHit(root, 1, T + 20 * MIN)
  const cfg = await readConfig(root)
  expect(cfg?.firstAnswerAt).toBe(new Date(T + 7 * MIN).toISOString())
})

test("zero hits records nothing", async () => {
  await writeConfig(root, { ...newConfig(true), initCompletedAt: new Date(T).toISOString() })
  await recordSearchHit(root, 0, T + 7 * MIN)
  const cfg = await readConfig(root)
  expect(cfg?.firstAnswerAt).toBeNull()
})

test("telemetry off records nothing", async () => {
  await writeConfig(root, { ...newConfig(false), initCompletedAt: new Date(T).toISOString() })
  await recordSearchHit(root, 1, T + 7 * MIN)
  const cfg = await readConfig(root)
  expect(cfg?.firstAnswerAt).toBeNull()
})

test("an unreadable config does not throw", async () => {
  await writeFile(join(root, "config.json"), "{ not json", "utf-8")
  await expect(recordSearchHit(root, 1, T + 7 * MIN)).resolves.toBeUndefined()
})
