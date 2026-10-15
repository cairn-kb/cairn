import { expect, test } from "bun:test"
import { makeId, parseClaim, serializeClaim } from "../src/claims"
// Aliased: this file's own `sample` above is a `Claim` literal, not the
// `store-contract` factory of the same name — the two are unrelated and
// `sample` is already taken at module scope.
import { sample as sampleClaim } from "./store-contract"
import type { Claim } from "@cairn-kb/protocol/types"

const sample: Claim = {
  id: "2026-08-26-billing-uses-postgres",
  status: "pending",
  claim: "Billing uses Postgres, not Mongo — ACID on invoice writes",
  body: "We hit a partial-write bug on invoices under Mongo.",
  source: { author: "alice", agent: "cursor", repo: "acme-api", session: "0f3c" },
  created: "2026-08-26T09:00:00.000Z",
  reviewed: null,
  reviewer: null,
  retracted: null,
  overlaps: ["2026-07-02-datastore-choice"],
  cites: [],
  abstract: null,
  abstractBy: null,
  tags: ["architecture", "billing"],
}

test("serialize then parse returns an equivalent claim", () => {
  const round = parseClaim(serializeClaim(sample))
  expect(round).toEqual(sample)
})

test("body survives markdown formatting", () => {
  const withMarkdown = { ...sample, body: "# Heading\n\n- a\n- b\n\n---\n\ntail" }
  expect(parseClaim(serializeClaim(withMarkdown)).body).toBe(withMarkdown.body)
})

// makeId carries a random uniqueness suffix, so these assert its shape rather
// than an exact string: date prefix, slug, then the suffix.
test("makeId is a dated slug of the claim sentence plus a uniqueness suffix", () => {
  const id = makeId("Billing uses Postgres, not Mongo!", new Date("2026-08-26T09:00:00Z"))
  expect(id).toMatch(/^2026-08-26-billing-uses-postgres-not-mongo-[a-z0-9]+$/)
})

test("makeId truncates long claims to eight words", () => {
  const id = makeId("one two three four five six seven eight nine ten", new Date("2026-08-26T09:00:00Z"))
  expect(id).toMatch(/^2026-08-26-one-two-three-four-five-six-seven-eight-[a-z0-9]+$/)
})

test("makeId gives different ids to identical text at an identical time", () => {
  const now = new Date("2026-08-26T09:00:00Z")
  const a = makeId("Billing uses Postgres, not Mongo", now)
  const b = makeId("Billing uses Postgres, not Mongo", now)
  expect(a).not.toBe(b)
})

test("a claim written before cites existed reads back with an empty cites array", () => {
  // Every file on disk predates this field. `undefined` here would break
  // `.length` and `.includes` at every call site.
  const onDisk = `---
id: 2026-08-30-a-claim-abc123
status: approved
claim: a claim
created: 2026-08-30T09:00:00.000Z
---
body`
  expect(parseClaim(onDisk).cites).toEqual([])
})

test("a retracted claim round-trips through frontmatter", () => {
  const claim = {
    ...sampleClaim("c1", "a sentence"),
    status: "retracted" as const,
    retracted: { at: "2026-09-04T10:00:00.000Z", by: "alice", reason: "cited docs do not support it" },
  }
  const parsed = parseClaim(serializeClaim(claim))
  expect(parsed.retracted).toEqual({
    at: "2026-09-04T10:00:00.000Z",
    by: "alice",
    reason: "cited docs do not support it",
  })
})

test("a claim written before retraction existed still parses", () => {
  // The defaulting rule `cites` already follows: every claim file on disk
  // predates this field, and a required one would throw on the first read of
  // an existing space.
  const legacy = ["---", "id: c1", "status: approved", "claim: a sentence", "created: 2026-09-01T00:00:00.000Z", "---", "body"].join("\n")
  expect(parseClaim(legacy).retracted).toBeNull()
})

const LEGACY = `---
id: 2026-09-03-a-claim-abc123
status: approved
claim: Docling Serve is the production default
created: 2026-09-03T00:00:00.000Z
cites:
  - doc-one
  - doc-two
---
detail`

test("a claim whose cites are bare document ids still parses", () => {
  // Older spaces hold such citations. Refusing a stored claim
  // bricks an existing space, which is a different question from refusing a
  // malformed wire call — the wire breaks, the storage does not.
  const claim = parseClaim(LEGACY)
  expect(claim.cites.map((c) => c.doc)).toEqual(["doc-one", "doc-two"])
})

test("a legacy citation is scope-less and unchecked, not clean", () => {
  // `absent: null` is "nobody ever ran the check". `absent: []` would say
  // "checked, every term present" about a citation nobody checked —
  // verifying presence is not verifying absence.
  const [first] = parseClaim(LEGACY).cites
  expect(first!.supports).toBe("")
  expect(first!.hash).toBeNull()
  expect(first!.absent).toBeNull()
  expect(first!.by).toBe("unknown")
})

test("a citation round-trips through serialize and parse", () => {
  const claim = parseClaim(LEGACY)
  claim.cites = [
    { doc: "doc-one", supports: "the CPU default", hash: "abc123", absent: ["docling"], by: "cursor" },
    { doc: "doc-two", supports: "the fallback", hash: "def456", absent: [], by: "cursor" },
  ]
  const round = parseClaim(serializeClaim(claim))
  expect(round.cites).toEqual(claim.cites)
  // The distinction survives the round trip, which is the only reason it is
  // worth having: [] and null must not converge in YAML.
  expect(round.cites[1]!.absent).toEqual([])
})
