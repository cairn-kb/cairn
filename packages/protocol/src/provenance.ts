import type { Claim } from "./types"

/**
 * Where a claim came from, as data rather than as a sentence.
 *
 * A LIST OF TYPED ENTRIES, deliberately, and today the union has one member.
 * The shape is the point: a claim's grounding will
 * eventually include documents, external URLs and people — a dev approving a
 * claim by citing a teammate and a Slack thread — and whether that is additive
 * or a rewrite is decided here, before there is anything to add. A renderer
 * that builds one hardcoded string has to be taken apart to grow; a renderer
 * that walks a list does not.
 *
 * So a second `kind` is expected, and adding one must not require touching
 * `formatClaim`. That is the whole reason this file exists rather than two
 * more lines in cli.ts.
 */
export type ProvenanceEntry = {
  kind: "review"
  /** The reviewer's id as stored. Kept even when a name resolves, because the
   *  id is what every other surface and the event log refer to. */
  by: string
  /** The display name, or null when nothing resolved it. NOT the id as a
   *  fallback: null and "the id spelled out" are different facts, and the
   *  renderer is what decides how an unresolved principal reads. */
  name: string | null
  at: string
}

/**
 * What is known about how this claim got here.
 *
 * `people` is REQUIRED and takes the rule `formatClaim`'s document map already
 * sets: a caller that has not looked yet must say so by passing an empty map,
 * rather than an omitted argument silently reading as "nobody could be
 * resolved". The two are different facts about the world and collapsing them
 * is the failure `absent: null` vs `absent: []` exists to prevent for terms.
 *
 * Returns `[]` for a pending claim, which is correct rather than a gap: a
 * claim nobody has reviewed has no review provenance, and `reviewed`/
 * `reviewer` are both null until approval. A retracted claim KEEPS its entry —
 * `Claim.reviewer` is left untouched by retraction on purpose (packages/protocol/src/types.ts),
 * because erasing who approved it would erase the judgement the retraction is
 * correcting.
 */
export function provenanceOf(
  claim: Claim,
  people: ReadonlyMap<string, string>,
): ProvenanceEntry[] {
  const entries: ProvenanceEntry[] = []
  // Both, not either: `reviewed` without `reviewer` cannot say who, and
  // `reviewer` without `reviewed` cannot say when. Half an answer rendered as
  // a whole one is the defect this whole line exists to avoid.
  if (claim.reviewer !== null && claim.reviewed !== null) {
    entries.push({
      kind: "review",
      by: claim.reviewer,
      name: people.get(claim.reviewer) ?? null,
      at: claim.reviewed,
    })
  }
  return entries
}

/**
 * One line per entry.
 *
 * **"approved by", never "decided by"** — settled, and not a
 * wording preference. Many claims are derived facts nobody decided; they were
 * approved. Nothing in the model distinguishes a decision from a derivation
 * yet, so "decided by" would be false on many of them — a sentence true of
 * the record and false of the world. The stronger word has to be
 * earned by a marker that does not exist, not assumed by a renderer.
 *
 * An unresolved reviewer prints the raw id rather than being dropped. Someone
 * approved this claim either way, and a line saying so with an id a reader
 * cannot expand is worth more than silence, which reads as "nobody did".
 */
export function renderProvenance(entries: readonly ProvenanceEntry[]): string[] {
  return entries.map((e) => `approved by ${e.name ?? e.by} on ${day(e.at)}`)
}

/** The date alone. The time of an approval has never been the interesting part
 *  and a full ISO stamp crowds the line it shares. */
function day(iso: string): string {
  return iso.slice(0, 10)
}
