/**
 * Which of a claim's terms do not appear in a document it cites.
 *
 * Reports ABSENCES ONLY, and never a coverage score. Presence is not support:
 * a cited document can share its claim's vocabulary while contradicting it,
 * and "5 of 6 terms found" would read as validation of a citation a human
 * rejected on the merits. An absence is a fact; a score is an opinion this
 * cannot hold.
 *
 * How noisy this is in practice is UNKNOWN, and nothing here pretends
 * otherwise. On a claim about one tool citing documents about another, it
 * flags the headline term — exactly the catch it exists for — and also
 * incidental words the documents would never contain, which tell a reader
 * nothing. The floor, the stopword list and the noise level are things to
 * revise from real use, not from more thought.
 *
 * No imports, by construction: the hosted service computes this too, and
 * runs it where a `node:` builtin is not available.
 */

/**
 * How an absence must be introduced wherever one is shown to a person.
 *
 * Both surfaces rendered `absent: []` with a caveat ("short and
 * common words are not checked") and `absent: [...]` with none, so the
 * REASSURING state was qualified and the ACCUSATORY one was bare. That is
 * backwards for a report whose purpose is disclosure and never validation: the
 * line a reader is most likely to take as a verdict was the one line carrying
 * nothing to stop them.
 *
 * It says what this module does, not what a citation is worth — see the note
 * at the top of this file on why a score is an opinion this cannot hold. A
 * claim decided in discussion, whose citations report its headline term
 * missing from every cited document, is the worked example: the correct
 * reading is "this claim never had a document to cite", and no arrangement of
 * word counts can reach it.
 *
 * Exported from here rather than written out at each call site because two
 * surfaces already drifted apart on wording nobody was comparing.
 */
export const ABSENCE_FRAMING = "a word check, not a judgement of whether the document supports it"

/**
 * Words whose absence from a document would mean nothing. Only entries of
 * `MIN_TERM_LENGTH` or more earn a place — anything shorter is dropped by the
 * floor before this set is consulted.
 *
 * Tunable without a code change elsewhere. Deliberately short: every word
 * added here is a term this can no longer report, and the failure that
 * motivated the rule was a proper noun, not a common word.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "about", "after", "again", "against", "already", "also", "although", "always", "among",
  "another", "because", "been", "before", "being", "below", "besides", "between", "both",
  "cannot", "could", "does", "doing", "done", "down", "during", "each", "either", "else",
  "enough", "even", "ever", "every", "from", "further", "have", "having", "here", "however",
  "instead", "into", "itself", "just", "less", "like", "made", "make", "many", "more", "most",
  "much", "must", "need", "never", "only", "other", "others", "over", "past", "perhaps",
  "rather", "same", "should", "since", "some", "still", "such", "than", "that", "their",
  "them", "then", "there", "therefore", "these", "they", "this", "those", "through", "thus",
  "under", "until", "upon", "very", "were", "what", "when", "where", "whether", "which",
  "while", "will", "with", "within", "without", "would", "your",
])

/**
 * Terms shorter than this are dropped without being reported.
 *
 * It is a real limitation, not a tuning detail: `cpu` and `gpu` fall below it,
 * so a claim's ungrounded clause about GPUs goes unreported. The floor is here because three-letter
 * substrings match almost anything, so reporting them would be noise in the
 * other direction. Pinned by test so the limitation stays visible.
 */
export const MIN_TERM_LENGTH = 4

/** The terms of a claim worth checking for: lowercased, split on anything that
 *  is not a letter or a digit, floored, de-stopworded, deduped. Order is first
 *  appearance, so a reader sees them as the sentence reads. */
export function claimTerms(claim: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const term of claim.toLowerCase().split(/[^a-z0-9]+/)) {
    if (term.length < MIN_TERM_LENGTH) continue
    if (STOPWORDS.has(term)) continue
    if (seen.has(term)) continue
    seen.add(term)
    out.push(term)
  }
  return out
}

/**
 * SUBSTRING match, case-insensitive, deliberately: `serve` counts as present
 * inside `server`. That is a bias toward reporting fewer absences, and it is
 * the right direction — a false alarm costs a reader's attention on every
 * citation, while a missed one costs it only on the citations that were going
 * to be wrong anyway.
 */
export function absentTerms(claim: string, documentText: string): string[] {
  const haystack = documentText.toLowerCase()
  return claimTerms(claim).filter((term) => !haystack.includes(term))
}
