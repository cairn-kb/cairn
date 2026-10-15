import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog, type EventKind } from "../src/events"
import { statsFromEvents } from "@cairn-kb/protocol/stats"

// The approve rate computed by the hosted store must equal the local store's
// for the same event sequence.
//
// The hosted store's storage cannot run here, so this compares through the
// one function both sides share: EventLog.stats() is exercised through its
// real file-backed implementation, and `statsFromEvents` is the exact pure
// function the hosted service delegates ALL of its counting to (storage-free
// by construction).
//
// What this now guards is narrower than it once was, and better: the two used
// to be separate implementations sharing two constants, and this compared their
// arithmetic. They are one function, so what is left to guard is that
// EventLog.stats() still calls it rather than growing its own copy — which is
// precisely how the drift would come back.

let root: string
let log: EventLog

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-stats-parity-"))
  log = new EventLog(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test("approve rate from the local EventLog matches the hosted computation for a mixed sequence", async () => {
  const sequence: { kind: EventKind; id: string }[] = [
    { kind: "propose", id: "c1" },
    { kind: "propose", id: "c2" },
    { kind: "propose", id: "c3" },
    { kind: "propose", id: "c4" },
    { kind: "propose", id: "c5" },
    { kind: "approve", id: "c1" },
    { kind: "approve", id: "c2" },
    { kind: "edit", id: "c3" },
    { kind: "reject", id: "c4" },
    { kind: "reject", id: "c5" },
  ]

  for (const { kind, id } of sequence) {
    await log.append(kind, id)
  }
  const local = await log.stats()
  const hosted = statsFromEvents(sequence.map((e) => ({ kind: e.kind, at: "2026-08-28T00:00:00.000Z", id: e.id })))

  expect(hosted.approveRate).toBe(local.approveRate)
  expect(hosted.approved).toBe(local.approved)
  expect(hosted.edited).toBe(local.edited)
  expect(hosted.rejected).toBe(local.rejected)
  // Not a fixed constant either way — pins the test against a future change
  // that makes both sides agree by both being wrong the same way.
  expect(local.approveRate).toBe(0.6)
})

test("an all-rejected sequence agrees at rate 0", async () => {
  const sequence: { kind: EventKind; id: string }[] = [
    { kind: "propose", id: "c1" },
    { kind: "propose", id: "c2" },
    { kind: "reject", id: "c1" },
    { kind: "reject", id: "c2" },
  ]
  for (const { kind, id } of sequence) await log.append(kind, id)
  const local = await log.stats()
  const hosted = statsFromEvents(sequence.map((e) => ({ kind: e.kind, at: "2026-08-28T00:00:00.000Z", id: e.id })))
  expect(hosted.approveRate).toBe(local.approveRate)
  expect(local.approveRate).toBe(0)
})

test("no reviews at all agrees at null", async () => {
  await log.append("propose", "c1")
  const local = await log.stats()
  const hosted = statsFromEvents([{ kind: "propose", at: "2026-08-28T00:00:00.000Z", id: "c1" }])
  expect(hosted.approveRate).toBe(local.approveRate)
  expect(local.approveRate).toBeNull()
})
