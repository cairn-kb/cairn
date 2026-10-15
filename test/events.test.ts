import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog } from "../src/events"
import type { EventSink } from "../src/events"
import { statsFromEvents } from "@cairn-kb/protocol/stats"
import type { KbEvent } from "@cairn-kb/protocol/stats"
import { APPROVE_KINDS, RESOLVE_KINDS, UNADOPTABLE_KINDS, adoptionRefusal } from "@cairn-kb/protocol/event-kinds"

let root: string
let log: EventLog
let logPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-ev-"))
  log = new EventLog(root)
  logPath = join(root, "events.jsonl")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// Timestamps are stamped by `append` via `new Date()`, so tests that need
// deterministic ages write raw JSONL lines directly and read them back
// through EventLog — this exercises the real parse path with fixed `at`
// values instead of adding a clock-injection parameter to `append`.
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

function rawLine(event: Record<string, unknown>): string {
  return JSON.stringify(event) + "\n"
}

test("appended events come back in order", async () => {
  await log.append("propose", "a")
  await log.append("approve", "a")
  const all = await log.all()
  expect(all.map((e) => e.kind)).toEqual(["propose", "approve"])
  expect(all[0]!.id).toBe("a")
})

test("all returns empty when no log exists yet", async () => {
  expect(await log.all()).toEqual([])
})

test("stats compute the approve rate", async () => {
  await log.append("propose", "a")
  await log.append("propose", "b")
  await log.append("propose", "c")
  await log.append("propose", "d")
  await log.append("approve", "a")
  await log.append("approve", "b")
  await log.append("approve", "c")
  await log.append("reject", "d")
  const s = await log.stats()
  expect(s.proposed).toBe(4)
  expect(s.approved).toBe(3)
  expect(s.rejected).toBe(1)
  expect(s.approveRate).toBeCloseTo(0.75)
})

test("approveRate is null before any review happens", async () => {
  await log.append("propose", "a")
  expect((await log.stats()).approveRate).toBeNull()
})

test("reads are counted from map and read events", async () => {
  await log.append("map")
  await log.append("read", "a")
  expect((await log.stats()).reads).toBe(2)
})

test("an edit counts as an approval and stays distinguishable from one", async () => {
  await log.append("propose", "a")
  await log.append("propose", "b")
  await log.append("propose", "c")
  await log.append("approve", "a")
  await log.append("reject", "b")
  await log.append("edit", "c")
  const s = await log.stats()
  expect(s.approved).toBe(2)
  expect(s.edited).toBe(1)
  expect(s.rejected).toBe(1)
  expect(s.approveRate).toBeCloseTo(2 / 3)
})

test("an edit resolves its proposal, so no pending residue is left behind", async () => {
  await writeFile(
    logPath,
    rawLine({ kind: "propose", id: "a", at: daysAgo(9) }) +
      rawLine({ kind: "edit", id: "a", at: daysAgo(8) }),
  )
  expect((await log.stats()).pendingAgeDays).toBeNull()
})

test("searches are counted separately and do not inflate reads", async () => {
  await log.append("map")
  await log.append("read", "a")
  await log.append("search", undefined, { query: "postgres" })
  const s = await log.stats()
  expect(s.reads).toBe(2)
  expect(s.searches).toBe(1)
})

test("denied reads are counted, so silence means nobody asked", async () => {
  await log.append("read", "a")
  await log.append("read", "b", { denied: true })
  const s = await log.stats()
  expect(s.reads).toBe(2)
  expect(s.deniedReads).toBe(1)
})

test("sessions are counted from distinct team_knowledge_map sessions", async () => {
  await log.append("map", undefined, { agent: "cursor", session: "s1" })
  await log.append("map", undefined, { agent: "cursor", session: "s1" })
  await log.append("map", undefined, { agent: "claude", session: "s2" })
  await log.append("map", undefined, { agent: "claude", session: null })
  expect((await log.stats()).sessions).toBe(2)
})

test("an unresolved propose yields a non-null pendingAgeDays", async () => {
  await writeFile(logPath, rawLine({ kind: "propose", id: "a", at: daysAgo(5) }))
  const { pendingAgeDays } = await log.stats()
  expect(pendingAgeDays).not.toBeNull()
  expect(pendingAgeDays!).toBeCloseTo(5, 2)
})

test("with several unresolved proposals, the oldest determines the age", async () => {
  await writeFile(
    logPath,
    rawLine({ kind: "propose", id: "a", at: daysAgo(10) }) +
      rawLine({ kind: "propose", id: "b", at: daysAgo(3) }),
  )
  const { pendingAgeDays } = await log.stats()
  expect(pendingAgeDays!).toBeCloseTo(10, 2)
})

test("a resolved proposal is excluded even when older than an unresolved one", async () => {
  await writeFile(
    logPath,
    rawLine({ kind: "propose", id: "a", at: daysAgo(10) }) +
      rawLine({ kind: "approve", id: "a", at: daysAgo(9) }) +
      rawLine({ kind: "propose", id: "b", at: daysAgo(3) }),
  )
  const { pendingAgeDays } = await log.stats()
  expect(pendingAgeDays!).toBeCloseTo(3, 2)
})

test("a propose appended with no id is never counted as pending", async () => {
  await writeFile(logPath, rawLine({ kind: "propose", at: daysAgo(50) }))
  const { pendingAgeDays } = await log.stats()
  expect(pendingAgeDays).toBeNull()
})

test("all skips a malformed line instead of throwing", async () => {
  await writeFile(
    logPath,
    rawLine({ kind: "propose", id: "a", at: daysAgo(1) }) +
      '{"kind":"propose","id":"b","at":"broken\n' +
      rawLine({ kind: "propose", id: "c", at: daysAgo(1) }),
  )
  const events = await log.all()
  expect(events.map((e) => e.id)).toEqual(["a", "c"])
})

test("allStrict refuses rather than silently dropping a malformed line", async () => {
  // The opposite trade from `all()`, for `adoptImport`: a line that will not
  // parse must stop the read, not fall out of the result unremarked, because
  // this read decides whether a claim is safe to delete.
  await writeFile(
    logPath,
    rawLine({ kind: "propose", id: "a", at: daysAgo(1) }) +
      '{"kind":"propose","id":"b","at":"broken\n' +
      rawLine({ kind: "propose", id: "c", at: daysAgo(1) }),
  )
  const err = await log.allStrict().then(
    () => null,
    (e: unknown) => e as Error,
  )
  expect(err).not.toBeNull()
  // Names the file AND the line, so an operator can go look at exactly what
  // broke instead of guessing across the whole log.
  expect(err!.message).toContain(logPath)
  expect(err!.message).toContain("line 2")
})

test("a fake sink satisfies the interface the product depends on", async () => {
  // The point of the interface: the MCP server and review app must be
  // constructible without touching the filesystem.
  const seen: string[] = []
  const fake: EventSink = {
    async append(kind) { seen.push(kind) },
    async appendMany(events) { for (const e of events) seen.push(e.kind) },
    async all() { return [] },
    async allStrict() { return [] },
    async stats() {
      return {
        proposed: 0, approved: 0, edited: 0, rejected: 0, approveRate: null,
        reads: 0, deniedReads: 0, searches: 0, sessions: 0, pendingAgeDays: null,
        generatedAbstracts: 0,
      }
    },
  }
  await fake.append("propose", "x")
  expect(seen).toEqual(["propose"])
})

test("an import counts as neither an approval nor a resolution", async () => {
  // The constants are the metric. `import` in APPROVE_KINDS would let a seeded
  // document count as a human approval; in RESOLVE_KINDS it would let one count
  // as a review that happened. Both are the padding the kind exists to avoid,
  // and both are one careless array edit away.
  expect(APPROVE_KINDS).not.toContain("import")
  expect(RESOLVE_KINDS).not.toContain("import")
})

test("importing a document moves no part of the approve rate", async () => {
  await log.append("import", "doc-1")
  await log.append("import", "doc-2")
  const s = await log.stats()
  expect(s.proposed).toBe(0)
  expect(s.approved).toBe(0)
  expect(s.rejected).toBe(0)
  expect(s.approveRate).toBeNull()
  // Nor does it leave anything looking unresolved.
  expect(s.pendingAgeDays).toBeNull()
})

test("adopting counts as neither an approval nor a resolution", () => {
  const s = statsFromEvents([
    { kind: "import", at: "2026-09-01T09:00:00.000Z", id: "c1" },
    { kind: "adopt", at: "2026-09-01T10:00:00.000Z", id: "c1" },
  ])
  expect(s.approved).toBe(0)
  expect(s.rejected).toBe(0)
  expect(s.proposed).toBe(0)
  expect(s.approveRate).toBeNull()
})

test("abstracts written by a model are counted, and curated ones are not", () => {
  // The telemetry payload reports `generatedAbstracts`, and the question it
  // answers is how much of a space a model wrote. A human rewriting one with
  // `cairn curate` is the opposite of that, so the two kinds are counted
  // apart even though both are PATCH_KINDS.
  const s = statsFromEvents([
    { kind: "generate", at: "2026-09-01T09:00:00.000Z", id: "c1" },
    { kind: "generate", at: "2026-09-01T10:00:00.000Z", id: "c2" },
    { kind: "curate", at: "2026-09-01T11:00:00.000Z", id: "c1" },
  ])
  expect(s.generatedAbstracts).toBe(2)
})

test("a retraction moves no reported number", () => {
  const base = [
    { kind: "propose", at: "2026-09-01T00:00:00.000Z", id: "c1" },
    { kind: "approve", at: "2026-09-01T01:00:00.000Z", id: "c1" },
  ] as const
  const before = statsFromEvents([...base])
  const after = statsFromEvents([
    ...base,
    { kind: "retract", at: "2026-09-04T00:00:00.000Z", id: "c1" },
  ])
  expect(after.approved).toBe(before.approved)
  expect(after.rejected).toBe(before.rejected)
  expect(after.approveRate).toBe(before.approveRate)
  expect(after.proposed).toBe(before.proposed)
})

test("retract is neither an approval nor a resolution", () => {
  expect(APPROVE_KINDS.includes("retract")).toBe(false)
  expect(RESOLVE_KINDS.includes("retract")).toBe(false)
})

test("a retraction does not resurrect a claim into pendingAgeDays", () => {
  // RESOLVE_KINDS decides what counts as answered, and `oldestPending`
  // (packages/protocol/src/stats.ts) skips any proposal whose id carries one. A retracted claim
  // must not read as an unresolved proposal and accumulate a day per day in
  // the queue-age line.
  //
  // What actually holds that invariant is the log being APPEND-ONLY: the
  // `approve` is still there after the retraction, and `approve` is the
  // resolving event. `retract`'s own classification is pinned directly by the
  // sibling test above.
  // Annotated, because pulling the fixture out of the call site loses the
  // contextual typing that made `kind` an `EventKind` rather than a `string`.
  const retracted: KbEvent[] = [
    { kind: "propose", at: "2026-09-01T00:00:00.000Z", id: "c1" },
    { kind: "approve", at: "2026-09-01T01:00:00.000Z", id: "c1" },
    { kind: "retract", at: "2026-09-04T00:00:00.000Z", id: "c1" },
  ]
  expect(statsFromEvents(retracted).pendingAgeDays).toBeNull()

  // The control: without it this test
  // passes whether or not `retract` is in RESOLVE_KINDS, because the `approve`
  // alone satisfies the skip. Strip the approve and the SAME retraction no
  // longer answers the proposal — which is what makes the assertion above a
  // statement about the surviving approve rather than one that cannot fail.
  const withoutTheApprove = retracted.filter((e) => e.kind !== "approve")
  expect(statsFromEvents(withoutTheApprove).pendingAgeDays).not.toBeNull()
})

test("a retracted claim is not adoptable", () => {
  expect(adoptionRefusal(["import", "retract"])).toBe("judged")
  expect(UNADOPTABLE_KINDS.includes("retract")).toBe(true)
})

test("citing and unciting are neither approvals nor resolutions", () => {
  // The constants are the metric. A grounding pass must move `approved`,
  // `rejected` and `approveRate` by nothing at all, or a non-empty `cites`
  // stops being evidence of anything.
  for (const kind of ["cite", "uncite"] as const) {
    expect(APPROVE_KINDS.includes(kind)).toBe(false)
    expect(RESOLVE_KINDS.includes(kind)).toBe(false)
  }
})

test("a grounding pass moves no reported number", () => {
  const base = [
    { kind: "propose", at: "2026-09-01T00:00:00.000Z", id: "c1" },
    { kind: "approve", at: "2026-09-01T01:00:00.000Z", id: "c1" },
  ] as const
  const before = statsFromEvents([...base])
  const after = statsFromEvents([
    ...base,
    { kind: "cite", at: "2026-09-04T00:00:00.000Z", id: "c1" },
    { kind: "uncite", at: "2026-09-04T01:00:00.000Z", id: "c1" },
  ])
  expect(after.approved).toBe(before.approved)
  expect(after.rejected).toBe(before.rejected)
  expect(after.proposed).toBe(before.proposed)
  expect(after.approveRate).toBe(before.approveRate)
  expect(after.pendingAgeDays).toBe(before.pendingAgeDays)
})

test("unciting makes a claim unadoptable but citing does not", () => {
  // The list means "a human was involved", and adoption DELETES the claim.
  // `uncite` is human-only, so its presence is proof of curation. `cite` is
  // observational — an agent attaching evidence says nothing about a human,
  // and a deny list exists precisely so observational kinds stay silent.
  expect(UNADOPTABLE_KINDS.includes("uncite")).toBe(true)
  expect(UNADOPTABLE_KINDS.includes("cite")).toBe(false)
  expect(adoptionRefusal(["import", "cite"])).toBeNull()
  expect(adoptionRefusal(["import", "uncite"])).toBe("judged")
})
