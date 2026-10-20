/**
 * Review in a full-screen terminal UI.
 *
 * This is the ONLY module that imports `@opentui/core`, and `cli.ts` reaches it
 * only through `await import("./review-screen")`. `cairn mcp` shares stdout with
 * the MCP protocol, where one escape sequence corrupts the stream, and OpenTUI
 * is a far larger surface than clack with a native library behind it. The same
 * arrangement `doctor-render.ts` has with clack, for the same reason, with less
 * margin for error. The purity guard in test/cli.test.ts enforces it.
 *
 * `buildScreen` takes a renderer rather than creating one so the identical tree
 * runs under `createCliRenderer` in production and `createTestRenderer` in the
 * tests.
 */
import {
  BoxRenderable,
  createCliRenderer,
  fg,
  MarkdownRenderable,
  RenderableEvents,
  ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  TextareaRenderable,
  TextRenderable,
  type BoxOptions,
  type TextChunk,
} from "@opentui/core"
import { ABSENCE_FRAMING } from "@cairn-kb/protocol/absence"
import { rootMessage } from "./errors"
import {
  ABSTRACT_PROVENANCE_COLOR,
  BORDER_COLOR,
  BORDER_STYLE,
  CITATION_COLOR,
  legendChunks,
  OVERLAP_STATUS_COLOR,
  SCROLLBAR_COLOR,
  TEXT_COLOR,
  weight,
} from "./review-style"
import {
  editClaim,
  resolveEditor,
  runCurate,
  runReview,
  type ClaimText,
  type CurateAnswer,
  type CurateSummary,
  type Decision,
  type ReviewSummary,
  type SpawnFn,
} from "./review-tui"
import type { Citation, Claim, Document, Store } from "@cairn-kb/protocol/types"
import type { Ui } from "./ui"

/** What a reference lookup produced: the things found, the ids that no longer
 *  resolve, and — distinct from both — a reason the lookup itself could not
 *  be attempted. An empty pane must never be able to mean "the lookup broke". */
export interface RefResult<T> {
  found: T[]
  missing: string[]
  failed: string | null
}

/** Same rule for both edit paths — the screen's own textareas and $EDITOR's
 *  file-based edit — so the `edited` figure this project reports cannot drift
 *  by which path a reviewer used. */
export { unchanged as editsUnchanged } from "./review-tui"

export type Mode = "browsing" | "editing"

/** Which command this screen belongs to.
 *
 *  The two differ in more than wording. Review takes five decisions and shows
 *  a references pane; curate takes three (`w`/`s`/`q`) and shows none — an
 *  abstract is judged against the body it summarises, not against what the
 *  claim overlaps or cites, and there is no `o` to open a pane with. Curate
 *  rendering review's legend advertised `a`, `r`, `e` and `o`, all inert, and
 *  left `w` — its only action — off the screen entirely. */
export type ScreenKind = "review" | "curate"

export interface ReviewScreen {
  show(claim: Claim, index: number, total: number): void
  scroll(delta: number): void
  status(line: string): void
  frameWidth(): number
  pageHeight(): number
  mode(): Mode
  /** Enters edit mode with the claim's markdown SOURCE — rendered markdown is
   *  not typeable, so the `#`/`**` markers must come back.
   *
   *  `fields` restricts which of the three textareas are mounted, tabbable
   *  and focused — not merely which ones `endEdit` later reports as changed.
   *  A caller that can only save a subset (curate saves the abstract alone)
   *  must make the rest UNREACHABLE, not just discard them after the fact:
   *  an operator who typed into a field that quietly never gets saved has
   *  lost work with no warning, which is worse than never having offered the
   *  field. Defaults to all three, focused on the claim sentence — review's
   *  existing behaviour, unchanged; the order is canonical whatever order
   *  the caller lists them in.
   *
   *  Also puts the claim pane back in the layout. The fields mount INSIDE it,
   *  so entering edit mode while the references pane has it swapped out would
   *  leave the operator typing into a field that is not on screen. */
  beginEdit(claim: Claim, fields?: Array<"claim" | "body" | "abstract">): void
  /** Reads back the three fields and returns to browsing. Does not judge
   *  whether anything changed — that is `editsUnchanged`'s job. */
  endEdit(): ClaimText
  /** Populates the references pane once `resolveOverlaps`/`resolveCites` have
   *  come back. `show` already knows synchronously whether the claim HAS any
   *  references — from `claim.overlaps`/`claim.cites`'s length — so the
   *  footer hint and the toggle do not wait on this.
   *
   *  `citations` is `claim.cites` itself, passed alongside `cites` (the
   *  resolved documents) rather than folded into it: `resolveCites` maps to
   *  ids for `store.getDocument` and has no reason to carry `supports`/
   *  `absent`/`hash` back out, so the caller — which already holds the claim
   *  — supplies them separately. `renderCitesRows` matches the two by
   *  `Citation.doc` against `Document.id`. */
  showReferences(overlaps: RefResult<Claim>, cites: RefResult<Document>, citations: Citation[]): void
  /** Below `frameWidth() >= 120` the references pane replaces the claim pane
   *  rather than sitting beside it; this flips which one is showing. A no-op
   *  when the current claim has no overlaps and no cites — there is nothing
   *  to toggle to — and on a curate screen, which mounts no pane at all. */
  toggleReferenceFocus(): void
  destroy(): void
}

/** One footer key and the word beside it. The single source both
 *  `browsingPlain` (the width-checked text `footerLegend` returns) and
 *  `browsingStyled` (the bold-key/dim-label form `paint` actually shows) are
 *  built from, so the legend's words are never hand-typed in two places that
 *  could drift apart. */
interface LegendEntry {
  key: string
  label: string
}

const REVIEW_ENTRIES: LegendEntry[] = [
  { key: "a", label: "approve" },
  { key: "r", label: "reject" },
  { key: "e", label: "edit" },
  { key: "s", label: "skip" },
  { key: "q", label: "quit" },
  { key: "↑↓", label: "scroll" },
]

const CURATE_ENTRIES: LegendEntry[] = [
  { key: "w", label: "write" },
  { key: "s", label: "skip" },
  { key: "q", label: "quit" },
  { key: "↑↓", label: "scroll" },
]

/** The keys each screen actually answers to, long and short. A legend naming
 *  a key the handler does not map is worse than a shorter one: the code's own
 *  rule at `paint` is that a key which does nothing is worse than an absent
 *  one, and that applies to the whole legend, not only to the refs hint.
 *
 *  Neither form carries a scroll percentage any more: position
 *  belongs on the thing that scrolls, so it moved to the body pane's own
 *  `bottomTitle` in `paint` below, and the footer's job shrank to the keys
 *  and — when there is one to show — the refs hint. */
const LEGEND: Record<ScreenKind, { entries: LegendEntry[]; browsingShort: string; editing: string; editingShort: string }> = {
  review: {
    entries: REVIEW_ENTRIES,
    // Not derived from `entries`: the compact form drops the labels AND
    // tightens the join (single space between decision keys, only widening
    // before the arrows), which doesn't follow `browsingPlain`'s "key label"
    // pattern — deriving it would either change its shape or need its own
    // bespoke join rule, no simpler than stating it directly.
    browsingShort: " a r e s q  ↑↓",
    // Review's editor mounts all three fields and can open them in $EDITOR.
    editing: " editing · tab field · esc done · E in $EDITOR",
    editingShort: " editing · esc done",
  },
  curate: {
    entries: CURATE_ENTRIES,
    browsingShort: " w s q  ↑↓",
    // One field, so no Tab to cycle; and `runScreenCurate`'s editing branch
    // handles Esc alone, so there is no `E` (open in $EDITOR) to advertise either.
    editing: " editing the abstract · esc done",
    editingShort: " editing · esc done",
  },
}

/** The browsing legend's plain text — " a approve  r reject  …  ↑↓ scroll" —
 *  the one place that string is assembled. `browsingStyled` below re-styles
 *  this exact text rather than reassembling it, so the two can never say
 *  different words. */
function browsingPlain(entries: LegendEntry[]): string {
  return ` ${entries.map((e) => `${e.key} ${e.label}`).join("  ")}`
}

/** Kept a pure function of width so it can be asserted on without a renderer. */
export function footerLegend(width: number, mode: "browsing" | "editing", kind: ScreenKind = "review"): string {
  const legend = LEGEND[kind]
  const full = mode === "editing" ? legend.editing : browsingPlain(legend.entries)
  const short = mode === "editing" ? legend.editingShort : legend.browsingShort
  return full.length <= width ? full : short.slice(0, width)
}

/** The styled form of the FULL browsing legend: bold keys, dim everything
 *  else — built from the same `entries` and the same join `browsingPlain`
 *  uses, so this is a re-styling of that text, not a second copy of it.
 *  `trailer` carries whatever comes after the entries verbatim — just the
 *  " · o refs" hint, when it fits, now that the percent lives on the body
 *  pane's `bottomTitle` instead — so the two stay one dim run.
 *
 *  Only ever called for the FULL form: the short form (narrow terminals)
 *  drops the labels entirely, and a mid-word slice of the full form has
 *  nothing sensible left to re-style — `paint` below only reaches for this
 *  when `footerLegend` returned the untruncated text. */
function browsingStyled(entries: LegendEntry[], trailer: string): StyledText {
  const chunks: TextChunk[] = [weight.label(" ")]
  entries.forEach((entry, i) => {
    if (i > 0) chunks.push(weight.label("  "))
    chunks.push(...legendChunks(entry.key, entry.label))
  })
  chunks.push(weight.label(trailer))
  return new StyledText(chunks)
}

/**
 * Lazy and per-claim: only the claim being rendered is resolved, so the cost is
 * bounded by what the reviewer actually looks at rather than growing with the
 * approved corpus — the same class of bug `cairn status` has: cost that grows
 * with the corpus instead of staying bounded to what is actually used.
 *
 * Two functions rather than one generic one. They route to different store
 * methods on the `doc-` prefix the ids already carry, and collapsing them would
 * mean a lookup that falls back on a miss — the thing `kbRead`
 * (packages/mcp/src/tools.ts) deliberately does not do.
 */
async function resolveRefs<T>(
  ids: string[],
  lookup: (id: string) => Promise<T | null>,
): Promise<RefResult<T>> {
  if (ids.length === 0) return { found: [], missing: [], failed: null }
  try {
    const results = await Promise.all(ids.map(lookup))
    const found: T[] = []
    const missing: string[] = []
    results.forEach((r, i) => (r === null ? missing.push(ids[i]!) : found.push(r)))
    return { found, missing, failed: null }
  } catch (err) {
    return { found: [], missing: [], failed: rootMessage(err) }
  }
}

export function resolveOverlaps(store: Store, claim: Claim): Promise<RefResult<Claim>> {
  return resolveRefs(claim.overlaps, (id) => store.get(id))
}

/** What the claim was drawn from. Often empty, which is a question worth
 *  showing rather than a reason to skip it. */
export function resolveCites(store: Store, claim: Claim): Promise<RefResult<Document>> {
  return resolveRefs(claim.cites.map((c) => c.doc), (id) => store.getDocument(id))
}

const NONE = "  none"

/** The `cites` section's own empty state, which the overlaps section's bare
 *  `NONE` cannot serve — see the comment at its one use in `renderCitesRows`.
 *  An overlap that does not exist is only an absence; a citation that does not
 *  exist is either correct or a gap, and this pane cannot tell. */
const CITES_NONE = "none — not every claim has a document to cite"

/** The references pane's width, and the room its text actually has: one
 *  border column each side, **and one for the scrollbar**.
 *
 *  Wrapping happens HERE, not in the renderable. A real overlap is a whole
 *  sentence — the thing this pane exists to show — and left to the renderable
 *  it wrapped to a second row starting at the pane's column 0, hard against
 *  the border, indistinguishable from the start of a new entry.
 *
 *  The third column was missing for a release. Making
 *  this pane a `ScrollBoxRenderable` put a scrollbar INSIDE the border, so
 *  once the content overflows the viewport is one column narrower than the
 *  border pair suggests — and every line `wrapEntry` filled to the old width
 *  lost its last character. `kept fo`, `after whic`, `a judgement of whethe`.
 *
 *  Subtracted UNCONDITIONALLY, not only while the scrollbar is showing. The
 *  library shows and hides it on its own as content changes
 *  (`ScrollBarRenderable.recalculateVisibility`), so a width that tracked it
 *  would re-wrap every line in the pane the moment a citation was added or a
 *  lookup came back. One column of slack on a pane that fits is invisible; text
 *  that reflows under the reader is not.
 *
 *  Found by driving the pane on a real terminal. Every test in the suite was
 *  green: they pin fragments, and a pane that fits shows no scrollbar and
 *  clips nothing. */
export const REFS_PANE_WIDTH = 44
const REFS_TEXT_WIDTH = REFS_PANE_WIDTH - 3

/** One entry of the pane, wrapped to fit it.
 *
 *  `first` prefixes the opening line and `cont` every line after it — a
 *  hanging indent, so a sentence that takes three rows still reads as one
 *  entry and the next entry is visibly a new one. A word longer than the
 *  pane (an id, a URL) is split rather than left to overflow, because there
 *  is no space in it to break at. */
function wrapEntry(text: string, first = "  ", cont = "    "): string[] {
  const lines: string[] = []
  let indent = first
  let current = ""
  const commit = () => {
    lines.push(indent + current)
    indent = cont
    current = ""
  }
  const room = () => Math.max(1, REFS_TEXT_WIDTH - indent.length)
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    let rest = word
    while (rest.length > room()) {
      if (current !== "") commit()
      current = rest.slice(0, room())
      rest = rest.slice(current.length)
      commit()
    }
    if (rest === "") continue
    if (current === "") current = rest
    else if (current.length + 1 + rest.length <= room()) current += ` ${rest}`
    else {
      commit()
      current = rest
    }
  }
  if (current !== "") commit()
  return lines
}

/** A plain (unstyled) chunk — the building block every line in the pane is
 *  made of when it carries no colour or weight of its own. `TextChunk`'s
 *  `__isChunk` brand is part of the exported type (see `text-buffer.d.ts`),
 *  not just a runtime convention, so a literal built by hand has to carry it
 *  to type-check as one. */
function plainChunk(text: string): TextChunk {
  return { __isChunk: true, text }
}

/** One visual row of the pane: a run of chunks with no newline of its own.
 *  Kept apart from the flat `TextChunk[]` a `StyledText` ultimately wants so
 *  a status token can sit on a row by itself — `joinLines` below is what
 *  turns rows back into one chunk stream, with the newlines between them. */
type Row = TextChunk[]

/** Stitches rows into the flat chunk list `StyledText` wants, one bare `\n`
 *  chunk between each pair. A row is not itself allowed to contain "\n" —
 *  `wrapEntry` already split the text at the pane's width, so every row here
 *  is one line by construction. */
function joinLines(rows: Row[]): TextChunk[] {
  const chunks: TextChunk[] = []
  rows.forEach((row, i) => {
    if (i > 0) chunks.push(plainChunk("\n"))
    chunks.push(...row)
  })
  return chunks
}

/** The indent a status token, or a wrapped continuation line, sits under —
 *  the same width as `ENTRY_MARKER` below, so a continuation reads as
 *  belonging to the entry above it rather than starting a new one. */
const STATUS_INDENT = "    "

/** Anchors the first line of an entry — an overlap's sentence, a citation's
 *  title, a missing id's message. Before this, every row in the pane opened
 *  at the same indent, so two entries back to back were one run of text with
 *  no seam between them. The marker is deliberately the same visual width as
 *  `STATUS_INDENT`: the text after it lines up with the text on every
 *  continuation line below, and the dot itself is the only thing that marks
 *  "a new entry starts here". */
const ENTRY_MARKER = "  · "

/** An overlap's status colour, when it has one. `approved`, `pending` and
 *  `retracted` are meaning-bearing (see `OVERLAP_STATUS_COLOR`'s own comment
 *  in review-style.ts) — a `rejected` overlap's status is still its own line,
 *  just not a coloured one. */
function overlapStatusChunk(status: string): TextChunk {
  const color = (OVERLAP_STATUS_COLOR as Record<string, string>)[status]
  return color ? fg(color)(status) : plainChunk(status)
}

/** Render an overlap as its sentence and its status — the two things a
 *  reviewer needs to judge a contradiction without opening the other claim.
 *  The status is its OWN row, not a clause trailing the wrapped sentence:
 *  deciding between a pending claim and an approved one it contradicts is
 *  the judgement the review gate exists to make, and that reads as a clause
 *  easy to miss at the end of a wrapped line.
 *
 *  Entries are separated by a blank row — `separateEntries` below — so two
 *  overlaps back to back read as two things, not one block of run-on text.
 *
 *  All three states this section can render — a found overlap, a missing
 *  id, and a failed lookup — open with `ENTRY_MARKER`. There is only ever
 *  one failed-lookup row, so the marker buys it no separation from a
 *  neighbour, but a marker on two of three states and not the third is the
 *  kind of inconsistency that reads as an oversight later; better it stays
 *  uniform now while the convention is still being established. */
function renderOverlapRows(r: RefResult<Claim>): Row[] {
  const rows: Row[] = [[weight.label("overlaps")]]
  if (r.failed) {
    for (const line of wrapEntry(`could not check overlaps: ${r.failed}`, ENTRY_MARKER, STATUS_INDENT)) rows.push([plainChunk(line)])
  } else if (r.found.length === 0 && r.missing.length === 0) {
    rows.push([plainChunk(NONE)])
  } else {
    const separate = separateEntries(rows)
    for (const c of r.found) {
      separate()
      for (const line of wrapEntry(c.claim, ENTRY_MARKER, STATUS_INDENT)) rows.push([plainChunk(line)])
      rows.push([plainChunk(STATUS_INDENT), overlapStatusChunk(c.status)])
    }
    for (const id of r.missing) {
      separate()
      for (const line of wrapEntry(`${id} — no longer in this space`, ENTRY_MARKER, STATUS_INDENT)) rows.push([plainChunk(line)])
    }
  }
  return rows
}

/** A blank row before every entry after the first — the fix for entries that
 *  ran together with nothing to separate one from the next. Returns a closure
 *  bound to one `rows` array rather than taking it as a parameter each call,
 *  so a call site cannot forget which list it is separating. */
function separateEntries(rows: Row[]): () => void {
  let first = true
  return () => {
    if (!first) rows.push([plainChunk("")])
    first = false
  }
}

/** A paragraph is text up to the first blank line — enough to judge relevance
 *  without pulling the whole document into a 42-column pane. */
function firstParagraph(text: string): string {
  return (text.split(/\n\s*\n/)[0] ?? "").trim()
}

/** The line worth showing beneath a citation's title, or none.
 *  A document imported from markdown with a top-level heading has that
 *  heading as its OWN first paragraph: identical text to `title`, with a
 *  leading `#` still attached. Rendered as originally written, the pane
 *  showed the title, then the same title again with a raw `#` in front of
 *  it, then the id — two rows spent repeating what row one already said.
 *  Stripped of a leading heading marker and compared to the title; a match
 *  means there is nothing here a reviewer doesn't already have, so the entry
 *  skips straight from title to id instead of manufacturing a blank row. */
function citationSnippet(d: Document): string | null {
  const stripped = firstParagraph(d.text).replace(/^#+\s*/, "").trim()
  return stripped === "" || stripped === d.title.trim() ? null : stripped
}

/** Render a citation as its title, what it is claimed to support, what was
 *  absent from it, and its id in full — the store has no prefix lookup
 *  (`store.getDocument`/`cairn show` both match an id exactly), so a
 *  shortened id would look up nothing and the row it saves is not worth
 *  that.
 *
 *  Absences are a plain list and never a score: presence is not support, and
 *  "5 of 6 terms found" would read as validation of a citation a human
 *  might reject on the merits — verifying presence is not verifying absence.
 *  `formatClaim` in `src/cli.ts`
 *  settled this exact wording for all four states a citation can be in; this
 *  pane matches it rather than inventing a second vocabulary for the same
 *  four facts.
 *
 *  That parity was ASSERTED here and not true: this pane rendered "not in
 *  the document" and a subjectless "changed since it was cited" where
 *  `formatClaim` says "not found in the document" and "the document has
 *  changed since it was cited". Three of the four states had a test in
 *  `test/review-screen.test.ts` and the drift lived in the fourth — the
 *  absent-terms line, which is also the one a reader is most likely to take
 *  as a verdict. All four are pinned there now. A comment claiming parity
 *  is not parity; the tests are. */
/** Pushes one citation's recorded facts — scope, absence, and (only when the
 *  document is still here to compare against) hash staleness — as wrapped
 *  rows under an entry that has already opened.
 *
 *  `doc` is `null` exactly when the cited document is gone: the store still
 *  has the CITATION (it lives on the claim, not the document), so what it
 *  recorded does not become unknown just because the document cannot be
 *  re-read. This is the case where the recorded facts matter most, since
 *  there is no other way left to check them — `cairn show` (`src/cli.ts`)
 *  renders them unconditionally for the same reason. Only the hash
 *  comparison is skipped for a missing document, because there is no
 *  current hash to compare the recorded one against — not because the
 *  citation stopped mattering. */
function pushCiteFacts(
  push: (line: string, color?: string) => void,
  cite: Citation,
  doc: Document | null,
): void {
  // Three of the lines below say "nobody established this", and they are the
  // ones that must not read like the ones that say "somebody did". Colour is
  // the last layer where that distinction can still be lost: the types carry
  // `null` vs `[]` all the way here, and then every line renders in one grey.
  if (cite.supports === "") push("no scope stated", CITATION_COLOR.unverified)
  else push(`supports ${cite.supports}`)
  if (cite.absent === null) {
    // Not the same as an empty list, and must never render as one: this
    // citation was attached before the check existed and nobody has run it
    // since.
    push("never checked for absent terms", CITATION_COLOR.unverified)
  } else if (cite.absent.length > 0) {
    push(`not found in the document: ${cite.absent.join(", ")}`)
  } else {
    // NOT "every term of the claim appears here" — that is the exact
    // sentence `formatClaim` (`src/cli.ts`) removed as a defect. `claimTerms` (`packages/protocol/src/absence.ts`) drops every
    // token under `MIN_TERM_LENGTH` and every stopword BEFORE it ever checks
    // anything, so `absent: []` proves only that none of the CHECKED terms
    // are missing — a claim made entirely of short or common words reaches
    // `absent: []` having checked nothing at all, and `gpu` (three letters)
    // would read as verified present when it was silently skipped. Match
    // `formatClaim`'s wording rather than asserting presence.
    push("no absence found — short and common words are not checked")
  }
  if (doc) {
    if (cite.hash === null) {
      // Not the same as a matching hash: this citation predates hashes and
      // there is nothing to compare it against.
      push("no hash recorded — cannot tell whether the document has changed", CITATION_COLOR.unverified)
    } else if (cite.hash !== doc.hash) {
      // Red, not amber: this is not an unchecked citation, it is a checked
      // one whose ground moved. Every absence rendered above it was computed
      // against text the document no longer contains.
      push("the document has changed since it was cited", CITATION_COLOR.stale)
    }
  }
}

function renderCitesRows(r: RefResult<Document>, citations: Citation[]): Row[] {
  const rows: Row[] = [[weight.label("cites")]]
  if (r.failed) {
    for (const line of wrapEntry(`could not load the cited documents: ${r.failed}`, ENTRY_MARKER, STATUS_INDENT)) rows.push([plainChunk(line)])
  } else if (r.found.length === 0 && r.missing.length === 0) {
    // NOT the bare `NONE` the overlaps section uses.
    // Many approved claims render this section empty. "No citations" means BOTH "correctly grounded in a
    // discussion" and "nobody has done the work" — opposite situations — and a
    // bare `none`, under a permanent label, in a pane whose neighbouring lines
    // are amber for "nobody has looked", reads as the second.
    //
    // `cairn show` has no equivalent because it prints no `cites` label at all
    // when there are none: silence never asked the question, so it does not
    // have to answer it. This pane's label asks it on every claim.
    //
    // The clause echoes `team_knowledge_cite`'s own description, so an
    // agent and a reviewer are told the same thing. It is a fact about claims
    // in general and says nothing about THIS one — which is the most cairn can
    // honestly say, since nothing in the model distinguishes the two cases.
    for (const line of wrapEntry(CITES_NONE, "  ", "  ")) rows.push([plainChunk(line)])
  } else {
    // Once, above the citations it qualifies, and dim: it is a standing note
    // about what the lines below are, not a fact about any one citation. The
    // position is the fix — see `ABSENCE_FRAMING` (packages/protocol/src/absence.ts).
    for (const line of wrapEntry(ABSENCE_FRAMING, "  ", "  ")) rows.push([weight.label(line)])
    const separate = separateEntries(rows)
    for (const d of r.found) {
      separate()
      for (const line of wrapEntry(d.title, ENTRY_MARKER, STATUS_INDENT)) rows.push([plainChunk(line)])
      const snippet = citationSnippet(d)
      if (snippet !== null) {
        // DIM, where the lines under it are not: this is the DOCUMENT's own
        // opening line, and everything below it is cairn's account of the
        // citation. Rendered at the same weight the two are indistinguishable
        // — and on a citation whose document happens to restate the claim,
        // the pane read as though it were contradicting itself: the document's
        // sentence asserting the claim, and directly beneath it, in the same
        // grey, "no scope stated". Pushing the quotation back is what lets the
        // coloured assessment lines carry the eye.
        for (const line of wrapEntry(snippet, STATUS_INDENT, STATUS_INDENT)) rows.push([weight.label(line)])
      }
      const push = (line: string, color?: string) => {
        for (const l of wrapEntry(line, STATUS_INDENT, STATUS_INDENT)) {
          rows.push([color ? fg(color)(l) : plainChunk(l)])
        }
      }
      // Matched by id, not by array position: `r.found` and `citations` are
      // resolved independently (one is a store round trip, the other is the
      // claim's own field) and a missing citation or a reordered lookup would
      // silently pair a document with the wrong scope if this zipped instead.
      const cite = citations.find((c) => c.doc === d.id)
      if (cite) pushCiteFacts(push, cite, d)
      // The one string here worth carrying elsewhere — `cairn show` takes it
      // and the store matches ids exactly, so it is printed in full and
      // coloured to mark it as the thing to copy rather than more prose.
      for (const line of wrapEntry(d.id, STATUS_INDENT, STATUS_INDENT)) {
        rows.push([fg(CITATION_COLOR.docId)(line)])
      }
    }
    for (const id of r.missing) {
      separate()
      for (const line of wrapEntry(`${id} — no longer in this space`, ENTRY_MARKER, STATUS_INDENT)) rows.push([plainChunk(line)])
      // The document is gone, but the CITATION survives on the claim — see
      // `pushCiteFacts`'s own comment for why its facts still render here.
      const push = (line: string, color?: string) => {
        for (const l of wrapEntry(line, STATUS_INDENT, STATUS_INDENT)) {
          rows.push([color ? fg(color)(l) : plainChunk(l)])
        }
      }
      const cite = citations.find((c) => c.doc === id)
      if (cite) pushCiteFacts(push, cite, null)
    }
  }
  return rows
}

/** The whole pane's content, both sections, for one call to `TextRenderable.content =`.
 *  A blank row (not a bare `\n\n` baked into a string) sits between them —
 *  building it from `Row[]` keeps that spacing a fact about the layout, the
 *  same way the sections themselves are, rather than a string literal
 *  someone could drift out of sync with `joinLines`. */
function refsPaneContent(overlaps: RefResult<Claim>, cites: RefResult<Document>, citations: Citation[]): StyledText {
  return new StyledText(joinLines([...renderOverlapRows(overlaps), [plainChunk("")], ...renderCitesRows(cites, citations)]))
}

/** The pane's content while a lookup is still in flight — same two dim
 *  section labels the resolved content uses, so the pane never LOOKS like a
 *  different screen while it waits on the store round trip. */
function refsPaneResolvingContent(): StyledText {
  return new StyledText(
    joinLines([
      [weight.label("overlaps")],
      [plainChunk("  resolving…")],
      [plainChunk("")],
      [weight.label("cites")],
      [plainChunk("  resolving…")],
    ]),
  )
}

const EMPTY_REF_RESULT = { found: [], missing: [], failed: null }

export function buildScreen(renderer: any, kind: ScreenKind = "review"): ReviewScreen {
  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  })
  renderer.root.add(root)

  // No padding of its own any more: the claim pane below is a bordered box
  // and has to line its left edge up with the body pane's, which starts at
  // column 0. The one-column indent the header padding used to give the meta
  // line is now the meta line's own margin, so it still sits where the
  // footer's leading space puts the footer.
  const header = new BoxRenderable(renderer, {
    id: "header",
    flexDirection: "column",
    flexShrink: 0,
  })
  const meta = new TextRenderable(renderer, {
    id: "meta",
    content: "",
    fg: TEXT_COLOR.dim,
    marginLeft: 1,
    marginRight: 1,
  })
  // A titled, bordered pane like `body` and `references`, so the assertion
  // being judged is a NAMED peer of the vocabulary already on screen rather
  // than a loose bold line above it. Same title colour and same border colour
  // as its two peers — the screen spends colour on an overlap's status and an
  // abstract's provenance, and a fourth colour here would say the claim pane
  // means something those two don't.
  //
  // Still in the header, still OUTSIDE the scroll pane: the sentence is what
  // the body is judged against, and it must not be able to scroll away from
  // it. This wraps the sentence; it does not move it.
  const claimPane = new BoxRenderable(renderer, {
    id: "claim-pane",
    flexDirection: "column",
    flexShrink: 0,
    border: true,
    borderStyle: BORDER_STYLE,
    borderColor: BORDER_COLOR.idle,
    title: "claim",
    titleColor: TEXT_COLOR.dim,
    paddingLeft: 1,
    paddingRight: 1,
  })
  const sentence = new TextRenderable(renderer, { id: "sentence", content: "" })
  claimPane.add(sentence)
  header.add(meta)
  // `claimPane` is NOT added here — `paint` mounts it, and only when there is
  // a sentence to put in it.
  const showClaimPane = (show: boolean) => {
    if (show) {
      if (claimPane.parent !== header) header.add(claimPane)
    } else if (claimPane.parent === header) {
      header.remove(claimPane)
    }
  }

  // What `show` last set the sentence to. Kept apart from `sentence.content`
  // itself: while editing, the claim field carries the sentence and the
  // header must not repeat it, but browsing needs it back the moment editing
  // ends — `paint` below is the one place that decides which of the two the
  // header shows, from this and the mode it is painting.
  let sentenceText = ""

  const scroll = new ScrollBoxRenderable(renderer, {
    id: "scroll",
    flexGrow: 1,
    scrollY: true,
    // A real title, not a line of content pretending to be one — the same
    // fix the references pane gets below. `bottomTitle` carries the scroll
    // position instead of the global footer — set per-frame in
    // `paint`, right-aligned so it reads as a corner indicator rather than
    // competing with the title on the opposite corner of the same border.
    rootOptions: {
      border: true,
      borderStyle: BORDER_STYLE,
      borderColor: BORDER_COLOR.idle,
      title: "body",
      // Explicit, not inherited. `BoxRenderable.renderSelf` falls back to
      // `titleColor ?? currentBorderColor`, and this pane's resting border is
      // `#3a3a3a` — ~1.85:1 on black, below anything readable. That fallback
      // took the scroll percentage WITH it when it moved off the footer onto
      // `bottomTitle` (one `titleColor` colours both titles), so the
      // affordance that move existed to improve came out ~3x less
      // legible than the `#8a8a8a` footer fragment it replaced. `dim` is
      // that same colour, back again.
      titleColor: TEXT_COLOR.dim,
      bottomTitleAlignment: "right",
      // Deliberately NO `focusedBorderColor` here — see `scroll.focusable`
      // below for why this pane's border is driven by assignment instead.
    },
    contentOptions: { paddingLeft: 1, paddingRight: 1 },
    // The scrollbar the library already shows/hides on its own, based on
    // whether the content overflows the viewport
    // (`ScrollBarRenderable.recalculateVisibility`) — nothing here decides
    // WHEN it shows, only what it looks like when it does. `showArrows:
    // false` keeps it a picture of position, not a second, redundant set of
    // up/down controls next to the `↑↓` the footer already advertises.
    // Coloured from the same quiet pair the idle border and dim text already
    // use (`SCROLLBAR_COLOR`), not a colour of its own — a scroll position
    // isn't one of the two facts this screen spends colour on.
    verticalScrollbarOptions: {
      showArrows: false,
      trackOptions: { backgroundColor: SCROLLBAR_COLOR.track, foregroundColor: SCROLLBAR_COLOR.thumb },
    },
  })
  // The body pane takes no focus of its own, and this is the whole of the fix
  // for an amber border that stayed on in BROWSING mode.
  //
  // `BoxRenderable.renderSelf` picks `_focusedBorderColor` over `_borderColor`
  // whenever `focusable && (focused || hasFocusedDescendant)`. `createCliRenderer`
  // enables mouse input and, on a left mousedown, walks from the clicked
  // renderable up its ancestors and focuses the first FOCUSABLE one
  // (`CliRenderer.dispatchMouseEvent`, guarded by the `autoFocus` config which
  // defaults to true). `ScrollBoxRenderable` sets `_focusable = true` as a class
  // field, so one click anywhere in the body focused this pane — permanently,
  // for the rest of the session — and from then on the pane rendered
  // `focusedBorderColor`, which had been set to the editing amber.
  // Browsing showed the editing colour, so the colour meant nothing. The tests
  // could not see it because nothing in them clicked.
  //
  // Not focusable means `hasFocusWithin` is false in every frame, so the pane
  // has exactly one border colour source: the `scroll.borderColor` assignments
  // in `beginEdit`/`endEdit`, which is how they were written before any focus
  // colour existed. Neither opentui's default cyan nor
  // a stuck amber can occur, because `_focusedBorderColor` is never consulted.
  //
  // Confirmed nothing depended on it being focusable, rather than assumed:
  // scrolling by key goes through this module's own keypress handler calling
  // `screen.scroll()`; wheel scrolling is `ScrollBoxRenderable.onMouseEvent`,
  // which handles `type === "scroll"` with no focus check; and drag selection
  // is gated on `selectable`, a separate flag, in `CliRenderer`'s mousedown
  // path and in `startSelection`. Tests below exercise all three.
  //
  // Assigned after construction, not passed in `rootOptions`: the class field
  // `_focusable = true` runs after the super constructor, so an option would be
  // overwritten.
  scroll.focusable = false
  const body = new MarkdownRenderable(renderer, {
    id: "body",
    content: "",
    syntaxStyle: SyntaxStyle.create(),
  })
  scroll.add(body)

  // The abstract, when the claim has one: its own two renderables, not a
  // line folded into `body`'s markdown source. `_abstract (generated)_`
  // rendered as markdown gave every provenance the same italic weight —
  // there is no per-WORD colour inside tree-sitter's fixed syntax-highlight
  // groups, only per-token-TYPE styling, so "coloured by source" has to
  // happen outside the markdown pipeline. `abstractHeader` is that: a plain
  // styled line, label dim and provenance coloured by `ABSTRACT_PROVENANCE_COLOR`.
  // `abstractBody` keeps the abstract's own text rendering as markdown, same
  // as before — only the header line moved out.
  const abstractHeader = new TextRenderable(renderer, { id: "abstract-header", content: "", marginTop: 1 })
  const abstractBody = new MarkdownRenderable(renderer, {
    id: "abstract-body",
    content: "",
    syntaxStyle: SyntaxStyle.create(),
  })
  // Mounted/unmounted together, in `show` (per claim) and around edit mode
  // (`beginEdit`/`endEdit`), the same as `body` itself — never left attached
  // while `editColumn` is also in `scroll`, and never shown for a claim with
  // no abstract to summarise.
  //
  // Guarded against `scroll.content`, not `scroll` — `ScrollBoxRenderable.add`
  // forwards to its internal `content` box (confirmed by reading
  // `ScrollBoxRenderable.add`/`.remove` in @opentui/core), so a mounted
  // child's `.parent` is `scroll.content`, never `scroll` itself. Guarding on
  // the wrong one made `unmountAbstract`'s check permanently false — the
  // abstract stayed mounted underneath `editColumn` for the whole edit
  // session, caught by "curate's editor mounts only the abstract field"
  // failing with the browsing abstract still in the captured frame.
  const mountAbstract = () => {
    if (abstractHeader.parent !== scroll.content) scroll.add(abstractHeader)
    if (abstractBody.parent !== scroll.content) scroll.add(abstractBody)
  }
  const unmountAbstract = () => {
    if (abstractHeader.parent === scroll.content) scroll.remove(abstractHeader)
    if (abstractBody.parent === scroll.content) scroll.remove(abstractBody)
  }
  // Set by `show`, read by `endEdit` — whether the CURRENT claim has an
  // abstract to bring back once editing ends.
  let hasAbstract = false

  // The edit column: three plain (non-modal) textareas standing in for the
  // markdown pane while editing. Built once and reused across claims —
  // `beginEdit` repopulates them with `setText`, which deliberately clears
  // undo history so one claim's undo stack never bleeds into the next.
  const editColumn = new BoxRenderable(renderer, { id: "edit-column", flexDirection: "column", flexGrow: 1 })

  // Each field is its own titled, focus-reactive box — the fix for "three
  // unlabelled, visually identical textareas" that this change exists to close.
  // `focusable` plus `focusedBorderColor` is declarative, not something
  // `paint()` has to compute: opentui's `Renderable.focus()` walks the
  // focused node's ANCESTOR chain and flips `_hasFocusedDescendant` on every
  // box along it, and `BoxRenderable.renderSelf` swaps to
  // `focusedBorderColor` whenever `focusable && (focused ||
  // hasFocusedDescendant)`. So the plain `textarea.focus()` calls already
  // below (Tab, and the initial field on `beginEdit`) are enough to light the
  // surrounding border — no border colour is ever assigned by hand here.
  //
  // The TITLE is the one thing that does not come for free. `renderSelf`
  // falls back to `titleColor ?? currentBorderColor`, so leaving it unset
  // named every unfocused field in the idle border's `#3a3a3a` — ~1.85:1 on
  // black, which is not "named even when empty", it is a name nobody can
  // read. `titleColor` takes a single value, not a focused/unfocused pair,
  // so the swap is driven by the field's own focus events (below) rather
  // than by anything `paint()` computes: dim while resting, and the same
  // bright `focused` the border takes while typing goes there, because
  // "which field am I in" is a distinction worth keeping.
  function fieldBox(id: string, title: string, sizing: Partial<BoxOptions>): BoxRenderable {
    return new BoxRenderable(renderer, {
      id,
      title,
      titleColor: TEXT_COLOR.dim,
      flexDirection: "column",
      border: true,
      borderStyle: BORDER_STYLE,
      borderColor: BORDER_COLOR.idle,
      focusable: true,
      focusedBorderColor: BORDER_COLOR.focused,
      ...sizing,
    })
  }
  // Sized to roughly what the unboxed fields occupied before: the claim box
  // adds 2 rows of border to the old fixed 3, and body/abstract keep their
  // 3:1 flexGrow split of whatever's left.
  const claimBox = fieldBox("claim-box", "claim", { flexShrink: 0, height: 5 })
  const bodyBox = fieldBox("body-box", "body", { flexGrow: 3 })
  const abstractBox = fieldBox("abstract-box", "abstract", { flexGrow: 1 })
  const claimField = new TextareaRenderable(renderer, { id: "claim-field", flexGrow: 1, wrapMode: "word" })
  const bodyField = new TextareaRenderable(renderer, { id: "body-field", flexGrow: 1, wrapMode: "word" })
  const abstractField = new TextareaRenderable(renderer, { id: "abstract-field", flexGrow: 1, wrapMode: "word" })
  claimBox.add(claimField)
  bodyBox.add(bodyField)
  abstractBox.add(abstractField)
  // editColumn's children are NOT fixed at build time any more: `beginEdit`
  // mounts only the fields its caller can save, and Tab must not be able to
  // reach the rest. This is why the three boxes above are built once but
  // added to `editColumn` here, per-session, instead of unconditionally.
  type FieldName = "claim" | "body" | "abstract"
  const fieldsByName: Record<FieldName, TextareaRenderable> = {
    claim: claimField,
    body: bodyField,
    abstract: abstractField,
  }
  // What actually mounts/unmounts on `editColumn` — the titled box, not the
  // bare textarea, so the title and the focus-reactive border come along
  // with it rather than being a separate thing `beginEdit` would have to
  // remember to add.
  const fieldBoxByName: Record<FieldName, BoxRenderable> = {
    claim: claimBox,
    body: bodyBox,
    abstract: abstractBox,
  }
  // Canonical order: also the Tab/Shift-Tab cycle order, and focus must
  // start on the claim sentence when it's in play.
  const ALL_FIELDS: FieldName[] = ["claim", "body", "abstract"]
  // The title's half of the focus distinction, wired once here rather than
  // recomputed per frame. `Renderable.focus()`/`.blur()` emit these, and
  // `CliRenderer.focusRenderable` blurs whatever held focus before — so Tab
  // moving focus fires `blurred` on the field it left and `focused` on the
  // one it reached, with no bookkeeping of "which one was lit" in this file.
  for (const name of ALL_FIELDS) {
    const box = fieldBoxByName[name]
    const field = fieldsByName[name]
    field.on(RenderableEvents.FOCUSED, () => {
      box.titleColor = BORDER_COLOR.focused
    })
    field.on(RenderableEvents.BLURRED, () => {
      box.titleColor = TEXT_COLOR.dim
    })
    // A click lands on whatever renderable is under the pointer, and opentui
    // then focuses the first FOCUSABLE ancestor of it — so a click on the
    // box's own border row (the one carrying its title) focuses the BOX, not
    // the textarea inside it. That left the border lit by
    // `focusedBorderColor` with the title still dim and, worse, no field
    // holding keyboard focus at all: the operator is in editing mode, a box
    // looks selected, and typing goes nowhere. Handing focus straight on to
    // the field makes the box's border mean exactly what it means when it is
    // reached by Tab. Not a loop: focusing the field blurs the box, which
    // only emits `blurred`.
    box.on(RenderableEvents.FOCUSED, () => {
      field.focus()
    })
  }
  // What the CURRENT edit session may touch — set by `beginEdit`, read by the
  // Tab handler and `endEdit`. Starts as all three so a stray Tab before any
  // `beginEdit` call (there shouldn't be one — mode is "browsing") is inert
  // rather than throwing on an empty list.
  let activeFields: TextareaRenderable[] = ALL_FIELDS.map((f) => fieldsByName[f])

  // The references pane: what a claim overlaps and what it cites, resolved to
  // the things themselves by `showReferences` rather than left as a count.
  // Fixed width rather than flexGrow — it is a reading pane, not one that
  // benefits from stretching to whatever room a wide terminal has spare. The
  // width is module-level because `wrapEntry` above wraps the text to it.
  const refsPane = new ScrollBoxRenderable(renderer, {
    id: "refs-pane",
    width: REFS_PANE_WIDTH,
    flexShrink: 0,
    scrollY: true,
    rootOptions: {
      border: true,
      borderStyle: BORDER_STYLE,
      borderColor: BORDER_COLOR.idle,
      // A real pane title, not content pretending to be one — "overlaps" and
      // "cites" below are section labels WITHIN this pane, not a second and
      // third title standing in for it.
      title: "references",
      // Same reason as the body pane's above: unset, this inherits the idle
      // border's `#3a3a3a` and the pane is named in a colour nobody can read.
      titleColor: TEXT_COLOR.dim,
    },
    // NO `bottomTitle` here, where the body pane has a percentage — a
    // deliberate choice. The body earns a number because it is the
    // thing being read; a second one in a 44-column side pane would put two
    // competing percentages on a screen that spends its emphasis carefully.
    // The scrollbar is the whole indicator, and the library shows and hides it
    // on its own once the content overflows
    // (`ScrollBarRenderable.recalculateVisibility`), so a claim with one
    // citation still renders a clean pane with nothing to dismiss.
    verticalScrollbarOptions: {
      showArrows: false,
      trackOptions: { backgroundColor: SCROLLBAR_COLOR.track, foregroundColor: SCROLLBAR_COLOR.thumb },
    },
  })
  // Not focusable, for exactly the reason the body pane is not — see
  // `scroll.focusable` above. `ScrollBoxRenderable` sets `_focusable = true`
  // as a class field, and `CliRenderer.dispatchMouseEvent` focuses the first
  // focusable ancestor of whatever was clicked, permanently. Left alone, one
  // click in this pane would pin opentui focus here for the session and hand
  // the pane `focusedBorderColor` — the same bug fixed on the body above.
  //
  // The mouse still reaches it without that: `ScrollBoxRenderable.onMouseEvent`
  // handles `type === "scroll"` with NO focus check, so the wheel scrolls
  // whichever pane the pointer is over and never needs a click at all. What
  // `o` adds is the KEYBOARD path — evidence that can only be reached with a
  // mouse is still evidence some reviewers cannot reach, which is the same
  // silence the keyboard path has to close.
  refsPane.focusable = false
  const refsText = new TextRenderable(renderer, {
    id: "refs-text",
    content: refsPaneContent(EMPTY_REF_RESULT, EMPTY_REF_RESULT, []),
  })
  refsPane.add(refsText)

  // Holds `scroll` and, depending on width, `refsPane` beside or instead of
  // it — see `layoutRefs`.
  const middleRow = new BoxRenderable(renderer, { id: "middle-row", flexDirection: "row", flexGrow: 1 })
  middleRow.add(scroll)

  const footer = new TextRenderable(renderer, {
    id: "footer",
    content: "",
    flexShrink: 0,
    fg: TEXT_COLOR.dim,
  })
  root.add(header)
  root.add(middleRow)
  root.add(footer)

  // The width past which the references pane sits BESIDE the claim rather
  // than replacing it. Below this, `o` toggles between the two — a terminal
  // this narrow cannot show both without squeezing the claim body unreadable.
  const WIDE = 120

  const width = () => renderer.terminalWidth ?? renderer.width ?? 80

  // Set synchronously by `show`, from `claim.overlaps`/`claim.cites` — this
  // does not wait on `resolveOverlaps`/`resolveCites`, so the footer hint and
  // the toggle are available the instant a claim with references is shown,
  // not only once the store round trip finishing resolving it.
  let claimHasRefs = false
  // Which pane the operator has asked for. Below `WIDE` that decides which of
  // the two is MOUNTED; at or above it both are mounted and it decides which
  // one the arrows drive. One flag for both, because it is one intention —
  // "I want to look at the references" — and a terminal narrowed while the
  // references are driven should land on the references, not on the body.
  let refsFocused = false

  /** Whether the arrows are currently driving the references pane. NOT
   *  opentui focus, which this screen deliberately gives neither pane; see
   *  `refsPane.focusable`. Gated on `claimHasRefs` for the same reason `o`
   *  itself is: driving an empty pane is a key that does nothing. */
  const refsDriven = () => refsFocused && claimHasRefs

  const layoutRefs = () => {
    // Curate never mounts the pane. `runScreenCurate` resolves no references
    // — it has no reason to — and a pane that mounts anyway sits there saying
    // "resolving…" for the whole session: a state that means "the lookup
    // broke" while claiming to be in progress, which is the failure
    // `RefResult.failed` exists to prevent, reached through another door.
    if (kind === "curate") return
    if (width() >= WIDE) {
      if (scroll.parent !== middleRow) middleRow.add(scroll)
      if (refsPane.parent !== middleRow) middleRow.add(refsPane)
      return
    }
    const showRefs = refsFocused && claimHasRefs
    if (showRefs) {
      if (scroll.parent === middleRow) middleRow.remove(scroll)
      if (refsPane.parent !== middleRow) middleRow.add(refsPane)
    } else {
      if (refsPane.parent === middleRow) middleRow.remove(refsPane)
      if (scroll.parent !== middleRow) middleRow.add(scroll)
    }
  }

  const paint = (mode: Mode = "browsing") => {
    // Browsing keeps the sentence in the header; editing drops it, because
    // the claim field now shows it — rendering it in both places was the
    // duplication this change exists to remove. Bold while it's shown: the
    // sentence is the assertion being judged, the one thing on this screen
    // that must outrank everything else.
    sentence.content = mode === "editing" ? "" : new StyledText([weight.emphasis(sentenceText)])
    // The box goes with the sentence rather than staying behind empty. Two
    // states put nothing in it: editing, where the claim FIELD carries the
    // sentence and a second box titled `claim` directly above it would be the
    // duplication this screen already removed once; and a screen built but
    // not yet shown a claim. An empty bordered box named after content that
    // isn't there is a worse label than no box — it reads as "this claim has
    // no sentence".
    showClaimPane(mode === "browsing" && sentenceText !== "")
    const h = scroll.viewport?.height ?? 0
    const percent =
      scroll.scrollHeight <= h || h === 0
        ? 0
        : Math.min(100, Math.round(((scroll.scrollTop + h) / scroll.scrollHeight) * 100))
    // Position belongs on the thing that scrolls, not a fragment of
    // the global footer. Undefined while editing — `scroll` no longer holds
    // the body at that point (`editColumn` does, see `beginEdit`), so a
    // percentage of it would describe something the operator isn't looking
    // at, the same reason the OLD footer's editing legend never showed one
    // either. Recomputed on every `paint`, the same as `scroll.title`'s own
    // browsing/editing swap below, rather than a separate clear/restore pair
    // — this IS that pair, just expressed as one assignment instead of two.
    scroll.bottomTitle = mode === "browsing" ? `${percent}%` : undefined
    // Which pane the arrows drive, said where the reviewer is already looking.
    // Only at or above WIDE: below it exactly one pane is mounted, so there is
    // nothing to disambiguate and a lit border would be decoration on the only
    // thing on screen.
    //
    // By ASSIGNMENT, never `focusedBorderColor`. That property is consulted
    // only for a focusable renderable and neither pane is focusable — see
    // `refsPane.focusable` and `scroll.focusable` — which is the same reason
    // `beginEdit`/`endEdit` drive the body pane's border this way. Reusing the
    // focus colour for a thing that is not opentui-focused is deliberate: to a
    // reviewer it means "this is where the keys go", which is exactly what it
    // means on an edit field.
    refsPane.borderColor =
      mode === "browsing" && width() >= WIDE && refsDriven() ? BORDER_COLOR.focused : BORDER_COLOR.idle
    const legend = footerLegend(width(), mode, kind)
    // "o refs" only when there is something to look at — a key that does
    // nothing is worse than an absent one — and only if it still fits.
    //
    // The width test that used to be here is gone, and its removal is the
    // point rather than a regression. It existed because `o` was inert at or
    // above WIDE, so advertising it there named a key an operator could press
    // to no effect. The fix gave `o` a job at every width — it moves which
    // pane the arrows drive — so the footer telling the truth now means
    // showing it at every width. The rule never changed: advertise exactly
    // what the handler will do.
    const hint = mode === "browsing" && claimHasRefs ? " · o refs" : ""
    const fits = legend.length + hint.length <= width()
    const shown = fits ? hint : ""
    // Styled only when `legend` is browsing's untruncated form — compared
    // against the exact text `browsingStyled` would reproduce, so a
    // truncated short form (which carries no per-entry labels to dim) falls
    // through to the plain string exactly as before.
    footer.content =
      mode === "browsing" && legend === browsingPlain(LEGEND[kind].entries)
        ? browsingStyled(LEGEND[kind].entries, shown)
        : fits
          ? `${legend}${hint}`
          : legend
    layoutRefs()
  }

  let mode: Mode = "browsing"

  // Tab/Shift-Tab cycle focus between the three fields. Registered here,
  // inside buildScreen, rather than in runScreenReview's decision listener:
  // this is a detail of the editing UI, not a reviewing decision, and the
  // fields it cycles are private to this closure. A no-op outside editing.
  renderer.keyInput.on("keypress", (key: { name?: string; shift?: boolean; stopPropagation?: () => void }) => {
    if (mode !== "editing" || key?.name !== "tab") return
    // Cycles only `activeFields` — whatever `beginEdit` mounted for this
    // session — so Tab physically cannot reach a field its caller excluded.
    const from = activeFields.findIndex((f) => f.focused)
    const next = ((from === -1 ? 0 : from) + (key.shift ? -1 : 1) + activeFields.length) % activeFields.length
    activeFields[next]?.focus()
    key.stopPropagation?.()
  })

  return {
    show(claim, index, total) {
      const where = claim.source.repo ? ` in ${claim.source.repo}` : ""
      const position =
        claim.status === "pending"
          ? `${index} of ${total} pending`
          : `${index} of ${total} · already ${claim.status}`
      meta.content = `${position} · proposed by ${claim.source.agent}${where}`
      sentenceText = claim.claim
      body.content = claim.body
      // The provenance is the point: "generated" means a model wrote it and no
      // human has looked, and it is what other agents navigate by — see
      // `abstractHeader`'s own comment for why it is a separate renderable
      // rather than folded into `body`'s markdown source.
      hasAbstract = Boolean(claim.abstract)
      unmountAbstract()
      if (hasAbstract) {
        const source = claim.abstractBy ?? "unknown"
        const color = (ABSTRACT_PROVENANCE_COLOR as Record<string, string>)[source]
        // The brackets are punctuation around the label, so they take the
        // label's weight — at full white they outranked the dim "abstract"
        // they enclose, a hierarchy inversion sitting in the middle of the
        // one line this screen spends a semantic colour on. Only the
        // provenance itself is allowed to be louder than the label.
        abstractHeader.content = new StyledText([
          weight.label("abstract"),
          weight.label(" ("),
          color ? fg(color)(source) : plainChunk(source),
          weight.label(")"),
        ])
        abstractBody.content = claim.abstract ?? ""
        mountAbstract()
      }
      scroll.scrollTo(0)
      // The references pane too, and for a sharper reason than tidiness: left
      // where the last claim's fourth citation put it, a new claim's pane
      // opens part-way down its own references with the first ones scrolled
      // off — the same scroll defect, reintroduced by the fix for it.
      refsPane.scrollTo(0)
      // Known synchronously from the claim itself — `showReferences` fills
      // in the resolved pane content once the store round trip comes back,
      // but whether there is anything to wait for is known right now.
      // Curate shows no pane, so it has no references to wait for either:
      // false here is what keeps the "resolving…" seed, the `o` hint and the
      // toggle out of a screen that would never fill any of them in.
      claimHasRefs = kind === "review" && (claim.overlaps.length > 0 || claim.cites.length > 0)
      refsFocused = false
      refsText.content = claimHasRefs ? refsPaneResolvingContent() : refsPaneContent(EMPTY_REF_RESULT, EMPTY_REF_RESULT, [])
      paint()
    },
    scroll(delta) {
      if (refsDriven()) refsPane.scrollBy(delta)
      else scroll.scrollBy(delta)
      paint()
    },
    status(line) {
      // `meta` is ONE row. The loops emit multi-line ANSI strings — the
      // re-rendered claim after a conflict is the whole of `renderClaim` —
      // and assigning one of those here paints over the rows beneath it.
      // Only the first line goes on screen, marked as having more behind it;
      // the rest is not lost, it is in the transcript that reaches stdout
      // once the screen is torn down. Never silent, and never wrecking the
      // layout in order to say so.
      const rows = line.split("\n").filter((row) => row.trim() !== "")
      meta.content = rows.length > 1 ? `${rows[0]} …` : (rows[0] ?? "")
      paint()
    },
    frameWidth: width,
    // A page is a page of whatever the arrows are driving. Asked for at the
    // moment the key is pressed (see `applyScroll`), so this follows `o` with
    // no state of its own.
    pageHeight: () => (refsDriven() ? refsPane.viewport?.height : scroll.viewport?.height) ?? 10,
    mode: () => mode,
    beginEdit(claim, fields = ALL_FIELDS) {
      // setText, not replaceText: each claim starts a fresh editing session,
      // and undo reaching back into a PREVIOUS claim's text would be a worse
      // surprise than losing an in-progress edit's undo stack across claims.
      // All three are seeded regardless of `fields` — a field left OUT never
      // gets mounted or focused below, so its content can never be changed
      // from the claim's own text no matter what it holds.
      claimField.setText(claim.claim)
      bodyField.setText(claim.body)
      abstractField.setText(claim.abstract ?? "")
      // Mount only the requested fields, in canonical order — this is what
      // makes an excluded field physically unreachable rather than merely
      // unsaved: it is not in the tree, so it cannot be focused, typed into,
      // or Tabbed to.
      for (const f of ALL_FIELDS) {
        const el = fieldBoxByName[f]
        if (el.parent === editColumn) editColumn.remove(el)
      }
      for (const f of ALL_FIELDS) {
        if (fields.includes(f)) editColumn.add(fieldBoxByName[f])
      }
      // ALL_FIELDS order, not the caller's: the mount loop above is canonical,
      // so deriving the Tab cycle from the argument order would let a caller
      // passing ["abstract", "claim"] get a visual order that disagrees with
      // the Tab order — and focus would start on whichever field it happened
      // to name first rather than on the claim sentence.
      activeFields = ALL_FIELDS.filter((f) => fields.includes(f)).map((f) => fieldsByName[f])
      // The abstract's own renderables come out with `body` — `editColumn`
      // takes `scroll`'s one visible slot, and an abstract left mounted
      // underneath it would either overlap the fields or push them off
      // screen depending on layout, neither of which is "editing with what's
      // on screen visible".
      unmountAbstract()
      scroll.remove(body)
      scroll.add(editColumn)
      scroll.borderColor = BORDER_COLOR.editing
      // The outer pane's own "body" title would otherwise sit directly above
      // the inner `body` FIELD's identical title — two nested panes both
      // claiming to be "body" is worse than the one this change is fixing.
      // The field boxes are the titled thing while editing; the wrapper goes
      // back to naming itself once `endEdit` returns the plain body to view.
      scroll.title = undefined
      mode = "editing"
      // The editor mounts INSIDE `scroll`, and below `WIDE` a toggled-on
      // references pane takes `scroll` out of the layout altogether — so
      // entering edit mode from the references pane put the operator in a
      // field that was not on screen at all, with `o` inert until Esc and no
      // sign that typing was going anywhere. Returning to the claim pane
      // makes "editing with nothing visible to edit" unreachable rather than
      // merely unlikely; the references are one `o` away again after Esc.
      refsFocused = false
      // paint(), not a bare assignment to `footer.content`: painting is what
      // re-runs `layoutRefs`, and the layout is the half that was missing.
      paint("editing")
      activeFields[0]?.focus()
    },
    endEdit() {
      // Trimmed here, matching what `editClaim`'s $EDITOR path already hands
      // `unchanged`/`editsUnchanged` — otherwise a field's own trailing
      // newline would make an untouched edit compare unequal to itself.
      // Reading all three, not just `activeFields`, is safe rather than
      // careless: a field `beginEdit` excluded was never mounted, so its
      // `plainText` can only be the value `beginEdit` seeded it with — the
      // claim's own trimmed text — and a caller that only wants a subset
      // (curate wants the abstract) reads back exactly the original for the
      // rest, never a stray edit that quietly went nowhere.
      const edits: ClaimText = {
        claim: claimField.plainText.trim(),
        body: bodyField.plainText.trim(),
        abstract: abstractField.plainText.trim(),
      }
      activeFields.find((f) => f.focused)?.blur()
      scroll.remove(editColumn)
      scroll.add(body)
      // Bring the abstract back exactly if the claim being edited had one —
      // `hasAbstract` is what `show` last determined for THIS claim, so this
      // does not depend on guessing from the fields just edited.
      if (hasAbstract) mountAbstract()
      scroll.borderColor = BORDER_COLOR.idle
      scroll.title = "body"
      mode = "browsing"
      paint()
      return edits
    },
    showReferences(overlaps, cites, citations) {
      refsText.content = refsPaneContent(overlaps, cites, citations)
    },
    toggleReferenceFocus() {
      if (!claimHasRefs) return
      // No early return at or above `WIDE` any more. `o` used to be inert
      // there — both panes are mounted, so there was nothing to swap — and
      // that left the references pane's overflowing content reachable by
      // nothing at all. It now moves what the ARROWS drive, so
      // the key does the same job at every width: "put me in the references".
      //
      // The hazard the old early return was guarding is gone rather than
      // ignored. It flipped a flag that only meant something below `WIDE`, so
      // a terminal narrowed afterwards repainted into a pane the operator had
      // never asked for. The flag now means the same thing at both widths, so
      // narrowing while driving the references SHOWS the references — which
      // is what was asked for, not a surprise.
      refsFocused = !refsFocused
      // `paint()`, not the bare `layoutRefs()` this used to call. Painting is
      // what re-runs the layout AND re-derives the border that says which pane
      // the arrows drive — with only the layout re-run, `o` moved the keys at
      // or above WIDE while every pixel on screen stayed put, which is the
      // same silence wearing a different hat.
      paint()
    },
    destroy() {
      root.destroyRecursively?.()
    },
  }
}

/** Moving through the body, as opposed to deciding anything about it. Both
 *  screens answer to these and both legends advertise `↑↓`, so the mapping
 *  and the handling below live in ONE place rather than being restated per
 *  command — curate's legend promised `↑↓ scroll` against a handler that
 *  mapped only `w`/`s`/`q`, and every arrow key did nothing on the one
 *  screen whose whole job is judging an abstract against a body too long to
 *  fit the viewport. */
const SCROLL_ACTIONS = ["scroll-up", "scroll-down", "page-up", "page-down"] as const
export type ScrollAction = (typeof SCROLL_ACTIONS)[number]

/** Narrows a mapped action to a navigation one, so each handler can hand it
 *  straight to `applyScroll` without a cast — the two mappings return unions
 *  that only OVERLAP on these four, and a cast would be the place a fifth
 *  action could silently join them. */
function isScrollAction(action: unknown): action is ScrollAction {
  return (SCROLL_ACTIONS as readonly unknown[]).includes(action)
}

export function scrollForKey(name: string): ScrollAction | null {
  switch (name) {
    case "up": return "scroll-up"
    case "down": return "scroll-down"
    case "pageup": return "page-up"
    case "pagedown": return "page-down"
    default: return null
  }
}

/** A page is whatever the pane can currently show, asked for at the moment
 *  the key is pressed rather than captured earlier — a resized terminal
 *  changes it. Shared by both handlers for the same reason `scrollForKey`
 *  is. */
function applyScroll(screen: ReviewScreen, action: ScrollAction): void {
  const page = screen.pageHeight()
  if (action === "scroll-up") return screen.scroll(-1)
  if (action === "scroll-down") return screen.scroll(1)
  if (action === "page-up") return screen.scroll(-page)
  return screen.scroll(page)
}

/** Pure so the mapping can be asserted without a terminal. An unrecognized key
 *  answers null: doing nothing is the only safe default when the alternative is
 *  recording a decision the reviewer did not make. */
export function decisionForKey(
  name: string,
): Decision | ScrollAction | "toggle-refs" | null {
  const scrolling = scrollForKey(name)
  if (scrolling) return scrolling
  switch (name) {
    case "a": return "approve"
    case "r": return "reject"
    case "e": return "edit"
    case "s": return "skip"
    case "q": return "quit"
    case "o": return "toggle-refs"
    default: return null
  }
}

/**
 * Real $EDITOR launch: inherits this process's stdio so the child owns the
 * terminal, which is exactly what `withSuspendedRenderer`'s suspend/resume
 * pair makes safe to do. `cmd` may carry its own arguments (`$VISUAL` is
 * commonly `"code -w"`), so it is split on whitespace rather than passed as a
 * single argv entry.
 */
const spawnEditor: SpawnFn = (cmd, file) => {
  const [command, ...args] = cmd.trim().split(/\s+/)
  return Bun.spawn([command, ...args, file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited
}

/**
 * Leave the alternate screen and raw mode before spawning a child that owns
 * the terminal, and re-enter afterwards no matter what happened. Skipping the
 * resume on the failure path leaves the operator in a terminal they must
 * reset by hand, and the corruption shows on the way BACK rather than on the
 * way out — the expensive time to find out. Hence `finally`, never a resume
 * only on the success path.
 */
export async function withSuspendedRenderer<T>(renderer: any, fn: () => Promise<T>): Promise<T> {
  renderer.suspend?.()
  try {
    return await fn()
  } finally {
    renderer.resume?.()
  }
}

/**
 * Everything the loops say, kept in order and printed once the screen is gone.
 *
 * `screen.status` is a one-line header, and it was the only place `out` went:
 * every message overwrote the one before it inside the same tick — a failed
 * approve, then the re-rendered claim, then the next claim's `show()` — and
 * the `still pending (N)` epilogue, written line by line immediately before
 * `renderer.destroy()`, was never on screen long enough to read at all. The
 * invariant in review-tui.ts is that a decision which FAILED must never look
 * like a human who declined to decide; a message that is painted over in the
 * same tick is silent in every way that matters.
 *
 * So: the header keeps showing the most recent line as a transient, and the
 * whole buffer goes to stdout after the teardown — where `cli.ts` already
 * prints its tally, so the ordering has a precedent and the alternate screen
 * is no longer there to paint over it.
 */
function createTranscript(screen: ReviewScreen) {
  const lines: string[] = []
  return {
    out(line: string): void {
      lines.push(line)
      screen.status(line)
    },
    /** Only after `renderer.destroy()`: printed any earlier, the next frame
     *  paints over it. */
    flush(): void {
      if (lines.length > 0) console.log(lines.join("\n"))
    },
  }
}

export async function runScreenReview(
  deps: { store: Store; ui: Ui; renderer?: any; mine?: boolean },
): Promise<ReviewSummary> {
  // `deps.renderer` lets tests inject `createTestRenderer`'s output and drive
  // it with `mockInput` through this exact handler — the production caller
  // (cli.ts) never sets it, so it always gets the real terminal renderer.
  const renderer = deps.renderer ?? (await createCliRenderer({ exitOnCtrlC: true }))
  const screen = buildScreen(renderer)
  const transcript = createTranscript(screen)
  // One handler for the lifetime of the screen; `ask` parks a resolver here.
  let pending: ((d: Decision) => void) | null = null
  // The claim `ask` is currently showing — `e`/`E` need it to start an edit,
  // since the keypress handler only ever sees the key, not the claim on
  // screen.
  let currentClaim: Claim | null = null
  // What `endEdit` (or the $EDITOR round trip below) produced, handed to the
  // `edit` injection below once the decision it belongs to resolves.
  let lastEdit: ClaimText | null = null
  // `withSuspendedRenderer`'s spawn is async; nothing before this flag stops
  // an autorepeated E, or one queued while the first spawn is still running,
  // from firing a second child editor on top of the first.
  let openingEditor = false
  const openExternalEditor = async () => {
    const claim = currentClaim
    if (!claim || openingEditor) return
    openingEditor = true
    try {
      // `process.env` is `NodeJS.ProcessEnv` (an index signature, no named
      // VISUAL/EDITOR), which TS's weak-type check rejects against
      // `resolveEditor`'s all-optional param — hence the cast.
      const env = process.env as { VISUAL?: string; EDITOR?: string }
      const edits = await withSuspendedRenderer(renderer, () =>
        editClaim(claim, resolveEditor(env, (cmd) => Bun.which(cmd) !== null), spawnEditor),
      )
      lastEdit = edits
      const resolve = pending
      pending = null
      resolve?.("edit")
    } catch (err) {
      // Never silent: an editor that exits non-zero (EDITOR=false) or fails
      // to spawn at all must not read as "the reviewer chose nothing", and
      // must leave the claim exactly as it was.
      transcript.out(`could not open $EDITOR: ${(err as Error).message} — the claim is unchanged`)
    } finally {
      openingEditor = false
    }
  }
  renderer.keyInput.on("keypress", (key: { name?: string; shift?: boolean; stopPropagation?: () => void }) => {
    if (screen.mode() === "editing") {
      if (key?.name === "escape") {
        lastEdit = screen.endEdit()
        const resolve = pending
        pending = null
        resolve?.("edit")
        return
      }
      if (key?.name === "e" && key.shift) {
        // The escape hatch: leave the in-place fields behind — `editClaim`
        // seeds $EDITOR from the claim's own text, not the textareas, so
        // whatever was typed there is abandoned in favour of a clean file —
        // and hand the terminal to the operator's editor instead.
        screen.endEdit()
        void openExternalEditor()
        return
      }
      return // every other key belongs to the focused field
    }
    const action = decisionForKey(key?.name ?? "")
    if (action === null) return
    if (isScrollAction(action)) return applyScroll(screen, action)
    if (action === "toggle-refs") return screen.toggleReferenceFocus()
    if (action === "edit") {
      // Does not resolve `pending` — the decision waits until Esc ends the
      // edit, so a reviewer who backs out with nothing typed can still
      // approve, reject or skip the same claim.
      if (currentClaim) {
        screen.beginEdit(currentClaim)
        // The mode-entry keystroke must not also be typed into the field it
        // just opened. `beginEdit` focuses a textarea SYNCHRONOUSLY, and the
        // key handlers renderables register run after this global one — so
        // without this, the `e` that opened the editor lands in the claim
        // sentence, and a reviewer who changes their mind and presses Esc
        // records an `edit` of a corrupted sentence they never made. The
        // `unchanged` guard cannot save it: the stray character makes the
        // text genuinely different. Same reason the Tab handler in
        // `buildScreen` stops propagation after it moves focus.
        key.stopPropagation?.()
      }
      return
    }
    const resolve = pending
    pending = null
    resolve?.(action)
  })
  try {
    return await runReview({
      store: deps.store,
      ui: deps.ui,
      mine: deps.mine,
      out: (line) => transcript.out(line),
      ask: (claim, index, total) => {
        currentClaim = claim
        screen.show(claim, index, total)
        // Resolved after `show`, not before: the claim itself renders
        // immediately, and the pane fills in once the store round trip
        // comes back rather than holding up the whole screen for it. Guarded
        // by identity so a claim the reviewer has already moved past cannot
        // overwrite the pane the CURRENT claim is showing.
        void Promise.all([resolveOverlaps(deps.store, claim), resolveCites(deps.store, claim)]).then(
          ([overlaps, cites]) => {
            if (currentClaim === claim) screen.showReferences(overlaps, cites, claim.cites)
          },
        )
        return new Promise<Decision>((resolve) => {
          pending = resolve
        })
      },
      // `ask` only ever resolves "edit" after the keypress handler above has
      // already stashed a result — either the in-place fields via Esc, or
      // $EDITOR's file via E — this is that result, not a fresh prompt.
      edit: async (): Promise<ClaimText> => {
        if (!lastEdit) {
          throw new Error("no edit was recorded for this claim — press e/Esc or E to edit before approving the edit")
        }
        const edits = lastEdit
        lastEdit = null
        return edits
      },
    })
  } finally {
    // Always: a thrown error that leaves the alternate screen up gives the
    // operator a terminal they have to reset by hand.
    renderer.destroy()
    // And then everything the loop said, on the terminal the operator gets
    // back — including the lines it said on the way out of a failure.
    transcript.flush()
  }
}

/** Curate has three answers, not five. `a` and `r` approve and reject in
 *  review; curate makes no such decision, and an unmapped key answers null
 *  for the same reason it does there: doing nothing beats guessing.
 *
 *  The navigation keys are not a fourth answer — they are the same
 *  `scrollForKey` review's mapping starts with. Curate's legend has
 *  advertised `↑↓ scroll` since it got a legend of its own, while this
 *  function mapped only `w`/`s`/`q` and the handler returned on `null`: a
 *  curator looking at a 33 KB body saw a scrollbar thumb, `0%`, a footer
 *  promising the keys, and no way to read past the first screenful before
 *  stamping `abstractBy: "human"` on the abstract summarising it. */
export function curateAnswerForKey(name: string): "write" | "skip" | "quit" | ScrollAction | null {
  const scrolling = scrollForKey(name)
  if (scrolling) return scrolling
  switch (name) {
    case "w": return "write"
    case "s": return "skip"
    case "q": return "quit"
    default: return null
  }
}

export async function runScreenCurate(
  deps: { store: Store; ui: Ui; renderer?: any },
): Promise<CurateSummary> {
  // Same injection seam as runScreenReview, for the same reason: tests drive
  // createTestRenderer's output through this exact handler, and the
  // production caller (cli.ts) never sets it.
  const renderer = deps.renderer ?? (await createCliRenderer({ exitOnCtrlC: true }))
  // "curate", not the default: three keys, not five, and no references pane.
  const screen = buildScreen(renderer, "curate")
  const transcript = createTranscript(screen)
  // One handler for the lifetime of the screen; `ask` parks a resolver here,
  // the same arrangement runScreenReview uses.
  let pending: ((a: CurateAnswer) => void) | null = null
  // The claim `ask` is currently showing — `w` needs it to start an edit,
  // since the keypress handler only ever sees the key, not the claim on
  // screen.
  let currentClaim: Claim | null = null
  renderer.keyInput.on("keypress", (key: { name?: string; shift?: boolean; stopPropagation?: () => void }) => {
    if (screen.mode() === "editing") {
      if (key?.name === "escape") {
        // `beginEdit` below was called with `["abstract"]`, so `edits.claim`
        // and `edits.body` are provably the claim's own untouched text —
        // those fields were never mounted, so nothing could have changed
        // them. `runCurate`'s own rules (empty refused, unchanged left as
        // generated) judge `edits.abstract` from here on.
        const edits = screen.endEdit()
        const resolve = pending
        pending = null
        resolve?.({ kind: "write", abstract: edits.abstract })
        return
      }
      return // every other key belongs to the focused field
    }
    const action = curateAnswerForKey(key?.name ?? "")
    if (action === null) return
    // Review's arrangement, not a second one: same mapping, same applier,
    // same position in the handler — before the answers, since a navigation
    // key resolves nothing.
    if (isScrollAction(action)) return applyScroll(screen, action)
    if (action === "write") {
      // Does not resolve `pending` — the answer waits until Esc ends the
      // edit, so a curator who backs out with nothing typed can still skip
      // or quit the same claim.
      //
      // `["abstract"]`, not the default: curate can only ever save the
      // abstract (`runCurate`'s two rules — empty refused, unchanged left as
      // generated — are keyed on it alone), so the claim and body fields
      // must not be mountable here at all. Offering them and then discarding
      // whatever was typed would be silent data loss; excluding them makes
      // that impossible rather than merely unlikely.
      if (currentClaim) {
        screen.beginEdit(currentClaim, ["abstract"])
        // As in review: the `w` that opened the editor must not also be typed
        // into the abstract it opened. `beginEdit` focuses synchronously, and
        // a stray `w` makes the text differ from the generated one — so
        // `runCurate`'s "nothing changed — left as generated" rule cannot
        // catch it, and a model's abstract gets stamped `abstractBy: "human"`.
        key.stopPropagation?.()
      }
      return
    }
    const resolve = pending
    pending = null
    resolve?.(action === "skip" ? { kind: "skip" } : { kind: "quit" })
  })
  try {
    return await runCurate({
      store: deps.store,
      ui: deps.ui,
      out: (line) => transcript.out(line),
      ask: (claim, index, total) => {
        currentClaim = claim
        // renderAbstract's framing ("approved, abstract written by …") is
        // already what `show` renders for an approved claim carrying an
        // abstract — the body pane holds it, and the status line
        // already carries "already approved" plus who proposed it.
        screen.show(claim, index, total)
        return new Promise<CurateAnswer>((resolve) => {
          pending = resolve
        })
      },
    })
  } finally {
    // Always: a thrown error that leaves the alternate screen up gives the
    // operator a terminal they have to reset by hand.
    renderer.destroy()
    // And then everything the loop said, on the terminal the operator gets
    // back — including the lines it said on the way out of a failure.
    transcript.flush()
  }
}
