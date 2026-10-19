/**
 * Turn a person's or an agent's question into an FTS5 query expression that
 * finds it.
 *
 * `cairn search` and `team_knowledge_search` both pass a question in plain
 * words — "how do we deploy with wrangler?" — not a query expression. Quoting
 * the whole thing as one phrase, as this used to, asked FTS5 for that exact
 * sequence of words and found nothing unless a claim happened to contain it
 * verbatim. Quoting each term on its own and OR-ing them together asks
 * instead for anything sharing vocabulary with the question, and `ORDER BY
 * bm25(...)` then ranks the claim or document matching the most terms first.
 *
 * Each term is wrapped in its own quotes so that an FTS5 operator spelled out
 * in the question — `NOT`, `*`, a hyphenated word read as column-minus, an
 * unbalanced paren — is just a literal word to match rather than a piece of
 * query syntax. A `"` inside a term is doubled, which is the query syntax's
 * own escape for a quote that must not end the term early.
 */
export function ftsQuery(text: string): string | null {
  const terms = text.split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ")
}
