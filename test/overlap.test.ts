import { expect, test } from "bun:test"
import { findOverlaps, similarity } from "../src/claims"
import type { Claim } from "@cairn-kb/protocol/types"

const existing: Claim[] = [
  {
    id: "2026-07-02-datastore-choice",
    status: "approved",
    claim: "Billing uses Postgres for invoice writes",
    body: "",
    source: { author: "a", agent: "b", repo: null, session: null },
    created: "2026-07-02T00:00:00.000Z",
    reviewed: null,
    reviewer: null,
    retracted: null,
    overlaps: [],
    cites: [],
    abstract: null,
    abstractBy: null,
    tags: ["billing"],
  },
  {
    id: "2026-07-03-frontend",
    status: "approved",
    claim: "Frontend is Vue with Vite",
    body: "",
    source: { author: "a", agent: "b", repo: null, session: null },
    created: "2026-07-03T00:00:00.000Z",
    reviewed: null,
    reviewer: null,
    retracted: null,
    overlaps: [],
    cites: [],
    abstract: null,
    abstractBy: null,
    tags: ["frontend"],
  },
]

test("identical strings score 1", () => {
  expect(similarity("postgres", "postgres")).toBe(1)
})

test("unrelated strings score near 0", () => {
  expect(similarity("postgres", "kubernetes")).toBeLessThan(0.3)
})

test("finds the overlapping claim and not the unrelated one", () => {
  const hits = findOverlaps("Billing uses Postgres, not Mongo, for invoices", ["billing"], existing)
  expect(hits).toEqual(["2026-07-02-datastore-choice"])
})

test("returns empty when nothing is similar", () => {
  expect(findOverlaps("Deploys run on Tuesdays", ["ops"], existing)).toEqual([])
})

// "Invoices are stored in a Postgres database" scores 0.3590 (measured via
// similarity()) against existing[0]'s claim ("Billing uses Postgres for
// invoice writes") — strictly between the lowered bar (threshold * 0.75 =
// 0.3) and the unlowered bar (threshold = 0.4). It scores 0.0308 against
// existing[1] ("Frontend is Vue with Vite"), far below either bar, so that
// claim never enters into it. This one pair, called both ways below, pins
// two things at once: the *0.75 multiplier is load-bearing (dropping or
// shrinking it would make the tag case fail to clear 0.3), and the 0.4
// default itself matters (a materially lower threshold would wrongly include
// the no-tag case).
const borderline = "Invoices are stored in a Postgres database"

test("a shared tag lowers the bar enough to include a borderline claim", () => {
  expect(findOverlaps(borderline, ["billing"], existing)).toEqual(["2026-07-02-datastore-choice"])
})

test("without a shared tag the same borderline claim misses the threshold", () => {
  expect(findOverlaps(borderline, ["ops"], existing)).toEqual([])
})
