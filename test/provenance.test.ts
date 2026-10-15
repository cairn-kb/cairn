import { expect, test } from "bun:test"
import { formatClaim } from "../src/cli"
import { provenanceOf, renderProvenance } from "@cairn-kb/protocol/provenance"
import type { Claim } from "@cairn-kb/protocol/types"

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: "c1", status: "approved", claim: "A thing is true", body: "why",
    source: { author: "alice", agent: "cursor", repo: null, session: null },
    created: "2026-01-02T10:00:00.000Z",
    reviewed: "2026-01-03T12:00:00.000Z",
    reviewer: "7b1e4c2a-9d3f-4e8b-a6c5-2f0d81e93b47",
    retracted: null, overlaps: [], cites: [], abstract: "", abstractBy: null, tags: [],
    ...over,
  } as Claim
}

test("an approved claim carries who approved it and when", () => {
  const e = provenanceOf(claim(), new Map([["7b1e4c2a-9d3f-4e8b-a6c5-2f0d81e93b47", "Alice"]]))
  expect(e).toEqual([
    { kind: "review", by: "7b1e4c2a-9d3f-4e8b-a6c5-2f0d81e93b47", name: "Alice", at: "2026-01-03T12:00:00.000Z" },
  ])
  expect(renderProvenance(e)).toEqual(["approved by Alice on 2026-01-03"])
})

test("the wording is 'approved by', never 'decided by'", () => {
  // Not a style preference. Many claims are derived facts nobody decided.
  // Nothing distinguishes a decision from a derivation yet, so "decided by"
  // would be false of those — true of the record, false of the world.
  const out = renderProvenance(provenanceOf(claim(), new Map())).join("\n")
  expect(out).toContain("approved by")
  expect(out.toLowerCase()).not.toContain("decided by")
})

test("an unresolved reviewer renders the id rather than vanishing", () => {
  // Someone approved it either way. Silence reads as "nobody did", which is a
  // different and false claim.
  const e = provenanceOf(claim(), new Map())
  expect(e[0]!.name).toBeNull()
  expect(renderProvenance(e)).toEqual(["approved by 7b1e4c2a-9d3f-4e8b-a6c5-2f0d81e93b47 on 2026-01-03"])
})

test("a pending claim has no review provenance, which is not a gap", () => {
  expect(provenanceOf(claim({ status: "pending", reviewed: null, reviewer: null }), new Map())).toEqual([])
})

test("half an answer is not rendered as a whole one", () => {
  // `reviewed` without `reviewer` cannot say who; `reviewer` without
  // `reviewed` cannot say when. Either alone is dropped.
  expect(provenanceOf(claim({ reviewer: null }), new Map())).toEqual([])
  expect(provenanceOf(claim({ reviewed: null }), new Map())).toEqual([])
})

test("a retracted claim keeps who approved it", () => {
  // packages/protocol/src/types.ts leaves `reviewer` untouched on retraction on purpose:
  // erasing it would erase the judgement the retraction is correcting.
  const c = claim({ status: "retracted", retracted: { at: "2026-09-05T00:00:00.000Z", by: "someone", reason: "wrong" } })
  expect(provenanceOf(c, new Map())).toHaveLength(1)
})

test("show renders the approver alongside the proposing agent", () => {
  const out = formatClaim(claim(), new Map(), new Map([["7b1e4c2a-9d3f-4e8b-a6c5-2f0d81e93b47", "Alice"]]), new Map())
  // The agent that drafted it AND the person who accepted it: both are
  // recorded, so both are shown.
  expect(out).toContain("proposed by cursor")
  expect(out).toContain("approved by Alice on 2026-01-03")
})

test("a pending claim's rendering gains no approval line", () => {
  const out = formatClaim(claim({ status: "pending", reviewed: null, reviewer: null }), new Map(), new Map(), new Map())
  expect(out).not.toContain("approved by")
})
