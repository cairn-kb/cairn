/**
 * The one per-file import path. `cairn import <dir>` and the first-run fill
 * both go through `importFile`, and each tallies the outcomes into its own
 * `ImportSummary`, so the two can never disagree on what an empty file, a
 * changed file or a cited update is.
 */

import { readFile } from "node:fs/promises"
import type { Document, ImportOutcome, Store } from "@cairn-kb/protocol/types"
import { STATUSES } from "@cairn-kb/protocol/types"
import { parseImport } from "./documents"

/**
 * This used to write each imported file as a CLAIM —
 * approved on arrival, keyed on its first heading. A heading is a noun
 * phrase, not "one assertive sentence a reviewer judges", so the result was
 * material that was approved, agent-visible, and never judged by anyone. It
 * now writes each file as a `Document` through `store.importDocument`
 * instead: searchable and readable, but never proposed, never approved, and
 * never counted in `team_knowledge_map` — because nobody reviewed it. An
 * agent that reads one and learns something proposes a claim citing it, the
 * same as it would for anything else it read.
 *
 * Takes no author: `DocumentInput` carries none. A claim's `source.author` is
 * who is answerable for an assertion a human is about to judge; a document
 * is neither, so there is nothing here for an author to be attached to.
 */
export interface ImportSummary {
  /** Files with no document at this source path before this run. */
  created: number
  /** Files whose text changed since the last import — updated in place,
   *  same id, same citations. Never a second document: `importDocument`
   *  matches on `source` first, so a changed file replaces what it was
   *  imported as rather than shadowing it the way a claim-based import had
   *  to. */
  updated: number
  /** Files whose text is byte-identical to what is already stored there. */
  unchanged: number
  /**
   * Of the updated documents, those some claim cites.
   *
   * A citation records the document's hash at the moment it was attached, and
   * an update in place keeps the document's id, so an ordinary edit to a cited
   * file changes the text every citation on it points at. `cairn show` and the
   * review screen both warn about that afterwards; this is the same fact at
   * the moment it is caused, which was the one moment nobody was told about
   * it. Empty on a run that updated nothing, and empty when nothing updated is
   * cited — the common case, and no news.
   */
  cited: CitedUpdate[]
  /**
   * Documents with nothing in them. Skipped rather than sent: the hosted store
   * refuses an empty body with a 400 whose sentence names no file, so one
   * stray empty document used to abort the whole directory with advice that
   * could not be followed.
   */
  empty: string[]
}

/**
 * One updated document that carries citations, and which claims those are.
 * Named rather than counted: "1 cited document changed" cannot be acted on, and
 * the operator's next move is to go and read the claims.
 */
export interface CitedUpdate {
  id: string
  title: string
  /** The path this document was imported from — what the operator just edited,
   *  and the only field here they will recognise without a lookup. */
  source: string | null
  /** Every claim citing it, in ANY status. Not narrowed to approved: the
   *  warning `cairn show` gives renders for a claim in any status, and a
   *  narrower rule here would report drift the terminal then shows on a claim
   *  this never mentioned. */
  claims: string[]
}

/**
 * Which of these documents are cited, and by what.
 *
 * Four `list` calls, and they are why this is skipped entirely when a run
 * updated nothing: against the hosted store each one is a round trip, and an
 * import over an unchanged directory is the common case. There is no
 * document-to-claims lookup on the `Store` seam — adding one would mean a
 * hosted route as well — so this reads the claims it already can and filters.
 */
export async function citedAmong(store: Store, docs: Document[]): Promise<CitedUpdate[]> {
  const claims = (await Promise.all(STATUSES.map((status) => store.list(status)))).flat()
  return docs
    .map((doc) => ({
      id: doc.id,
      title: doc.title,
      source: doc.source,
      claims: claims.filter((c) => c.cites.some((cite) => cite.doc === doc.id)).map((c) => c.id),
    }))
    .filter((u) => u.claims.length > 0)
}

export type ImportFileResult = { outcome: "empty" } | { outcome: ImportOutcome; document: Document }

/**
 * Read one file and import it as a document under `source`, tagged with
 * `repo` when one is given. A file with no text once its frontmatter is
 * removed comes back `empty` and nothing is stored.
 */
export async function importFile(
  store: Store,
  path: string,
  source: string,
  repo?: string,
): Promise<ImportFileResult> {
  const raw = await readFile(path, "utf-8")
  // Parsed before the emptiness check, not after: a file that is nothing but
  // frontmatter has no document in it, and used to import as a body of YAML.
  const { title, text } = parseImport(raw, path)
  if (text === "") return { outcome: "empty" }
  const { document, outcome } = await store.importDocument({ title, text, source, ...(repo ? { repo } : {}) })
  return { outcome, document }
}

/** A summary with nothing counted yet, plus the updated documents `citedAmong`
 *  is asked about once the run is over. */
export interface ImportTally {
  summary: ImportSummary
  updatedDocs: Document[]
}

export function newTally(): ImportTally {
  return { summary: { created: 0, updated: 0, unchanged: 0, empty: [], cited: [] }, updatedDocs: [] }
}

/** Count one `importFile` result. */
export function tally(t: ImportTally, path: string, result: ImportFileResult): void {
  const { summary } = t
  if (result.outcome === "empty") {
    // Named, not swallowed: "nothing happened" with no path is the same dead
    // end as the 400 the empty check replaced.
    summary.empty.push(path)
  } else if (result.outcome === "created") summary.created++
  else if (result.outcome === "updated") {
    summary.updated++
    t.updatedDocs.push(result.document)
  } else if (result.outcome === "unchanged") summary.unchanged++
  // Exhaustive, not a fallback: `ImportOutcome` has exactly three values
  // today, but a silent `else unchanged++` would miscount a fourth one
  // added later rather than fail loudly.
  else throw new Error(`unexpected import outcome: ${(result as { outcome: string }).outcome}`)
}

/** Close a tally: look up citations only when something actually changed —
 *  see `citedAmong` on what that costs. */
export async function finishTally(store: Store, t: ImportTally): Promise<ImportSummary> {
  const cited = t.updatedDocs.length === 0 ? [] : await citedAmong(store, t.updatedDocs)
  return { ...t.summary, cited }
}
