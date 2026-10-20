import { expect, test } from "bun:test"
import { APPROVE_KINDS, RESOLVE_KINDS, statesImpossibleHash, RECORDED_HASH } from "@cairn-kb/protocol/event-kinds"
import { hashText } from "@cairn-kb/protocol/hash"
import type { EventKind } from "@cairn-kb/protocol/stats"
import type { CiteInput } from "@cairn-kb/protocol/types"

/** A citation input carrying exactly the provenance under test. */
function withHash(hash: string | null): CiteInput {
  return { doc: "doc-1", supports: "the detail", provenance: { hash, absent: null, by: "someone" } }
}

test("what hashText actually produces is accepted", async () => {
  // The rule is only as good as its agreement with the thing it describes, and
  // that agreement is the part a hand-written regex gets wrong. Derived from
  // `hashText` rather than from a literal, so a change to the digest or its
  // encoding fails here rather than at a migration.
  const real = await hashText("some document text")
  expect(RECORDED_HASH.test(real)).toBe(true)
  expect(statesImpossibleHash(withHash(real))).toBe(false)
})

test("a hash is refused for being the wrong shape, in each way it can be", () => {
  // Each case is a different way the regex could be written slightly wrong:
  // no anchors, a case-insensitive flag, a `+` instead of `{64}`.
  const sixtyFour = "a".repeat(64)
  expect(statesImpossibleHash(withHash("deadbeef"))).toBe(true) // too short
  expect(statesImpossibleHash(withHash(sixtyFour + "a"))).toBe(true) // too long
  expect(statesImpossibleHash(withHash(sixtyFour.slice(1)))).toBe(true) // 63
  expect(statesImpossibleHash(withHash(sixtyFour.toUpperCase()))).toBe(true) // hashText is lowercase
  expect(statesImpossibleHash(withHash("g".repeat(64)))).toBe(true) // not hex
  expect(statesImpossibleHash(withHash(" " + sixtyFour))).toBe(true) // unanchored would pass
  expect(statesImpossibleHash(withHash(sixtyFour + " "))).toBe(true)
  expect(statesImpossibleHash(withHash(""))).toBe(true)
})

test("no hash and no provenance at all are both legal, and are different facts", () => {
  // `null` is "no hash was recorded" — older citations carry it, and they
  // are the pre-0.6.4 ones a migration exists to move. `undefined` is a citation that is not a copy at all, which the store
  // derives from the document it just read. Refusing either would refuse
  // `cairn init --team` or every ordinary citation respectively.
  expect(statesImpossibleHash(withHash(null))).toBe(false)
  expect(statesImpossibleHash({ doc: "doc-1", supports: "the detail" })).toBe(false)
})

test("connect and generate_document are observational — neither an approval nor a resolution", () => {
  // `connect` (a remote MCP session starting) and `generate_document` (a
  // machine writing a generated document) are both things that happen with no
  // human review attached, the same reason `import`, `generate` and `curate`
  // are silent in both lists: counting either here would credit a human
  // decision nobody made.
  const kinds: EventKind[] = ["connect", "generate_document"]
  for (const kind of kinds) {
    expect(APPROVE_KINDS.includes(kind)).toBe(false)
    expect(RESOLVE_KINDS.includes(kind)).toBe(false)
  }
})
