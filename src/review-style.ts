/**
 * The review screen's visual vocabulary: weight, colour and border choices,
 * kept in one place so edit-mode focus, browsing hierarchy and affordances
 * have a single home to pull a colour from instead of a new hex
 * constant appearing wherever the pane that needed it happened to be.
 *
 * A separate module rather than a const block near the top of
 * review-screen.ts: that file is already 900 lines, and the design this
 * implements explicitly calls out palette-scattering-across-a-huge-file as
 * the thing to avoid. It is reachable only through review-screen.ts, the
 * same way review-screen.ts itself is reachable only through cli.ts's
 * `await import` — see the guard `no module reachable from cli.ts statically
 * imports opentui` and its review-style.ts counterpart in test/cli.test.ts.
 *
 * The rule this follows: weight first, colour only where it changes meaning.
 * Hierarchy is bold / normal / dim; colour is spent on exactly two facts an
 * operator would act on differently — an overlap's settled/unsettled status,
 * and an abstract's provenance.
 */
import { bold, dim } from "@opentui/core"
import type { StylableInput, TextChunk } from "@opentui/core"

// --- borders -----------------------------------------------------------

/** The one border shape every pane in the screen uses. Not "double" or
 *  "heavy": this screen already spends its emphasis on weight and on the two
 *  semantic colours below, and a heavier border would compete with both
 *  rather than add to either. This was revisited rather than assumed:
 *  "the pane you are reading" and "the field you are typing in" are both
 *  already told apart by `BORDER_COLOR` (idle/editing/focused), so a second
 *  vocabulary of SHAPES would draw a distinction nothing asked for — shape
 *  carries no meaning here, only colour and weight do. One shape stays quiet
 *  everywhere; that is the deliberate choice, not a default left untouched. */
export const BORDER_STYLE = "single" as const

export const BORDER_COLOR = {
  /** Default, unfocused pane border — browsing mode. */
  idle: "#3a3a3a",
  /** The scroll pane while a field inside it is being edited. Distinct from
   *  `idle` on purpose: the mode change must be visible at the same instant
   *  the text stops being rendered markdown. */
  editing: "#e0a030",
  /** The field currently receiving keystrokes (the per-field
   *  `focusedBorderColor`). Brighter than either state above so "this is
   *  where typing goes" reads as a state of a field, not a third screen
   *  mode of its own. */
  focused: "#f0f0f0",
} as const

/** The screen's one "quiet" colour — meta
 *  lines, and the footer wherever its text isn't a bold/dim key-and-label
 *  pair (editing mode's sentence-shaped legend, and a too-narrow terminal's
 *  short form). Kept as a named fg rather than folded into `weight.label`'s
 *  DIM attribute so moving it into this module changes where the colour
 *  lives, not what it looks like. Whether meta should become attribute-based
 *  dim the way the footer's labels did is still open. */
export const TEXT_COLOR = {
  dim: "#8a8a8a",
} as const

/** The body pane's vertical scrollbar. Not a semantic colour — a
 *  scroll position doesn't change what a reviewer would DO, only where they
 *  are, so it borrows the same idle/dim pair everything else quiet uses
 *  rather than earning a colour of its own: `track` matches the pane's own
 *  resting border colour, `thumb` matches the screen's one existing dim text
 *  colour. The library already hides this scrollbar whenever the content
 *  fits the viewport (`ScrollBarRenderable.recalculateVisibility`), so no
 *  visibility flag lives here — only what it looks like on the claims where
 *  it shows at all. */
export const SCROLLBAR_COLOR = {
  track: BORDER_COLOR.idle,
  thumb: TEXT_COLOR.dim,
} as const

// --- weight --------------------------------------------------------------

/** Weight roles the screen actually uses. `emphasis` is for the one thing
 *  that must outrank everything else on screen — the claim sentence, the
 *  assertion being judged. `label` is for everything present but secondary:
 *  meta lines, pane titles read as labels, a footer key's word. Body prose
 *  gets neither — normal weight is itself a role, the baseline the other two
 *  are relative to. */
export const weight = {
  emphasis: (input: StylableInput): TextChunk => bold(input),
  label: (input: StylableInput): TextChunk => dim(input),
}

/** A footer legend entry as it actually reads: the key is what an operator
 *  scans for, so it carries the emphasis; the word beside it is a reminder,
 *  not something to read every time, so it stays dim. Centralised here
 *  rather than left to whoever assembles the footer, so "which one is bold"
 *  is a fact about the vocabulary, not a choice re-made at the call site. */
export function legendChunks(key: string, label: string): TextChunk[] {
  return [weight.emphasis(key), weight.label(label === "" ? "" : ` ${label}`)]
}

// --- semantic colour -----------------------------------------------------

/** An overlap's status. `approved` means someone has already settled it;
 *  `pending` means nobody has — exactly the judgment call the review gate
 *  exists to make between a pending claim and an approved one it
 *  contradicts. `retracted` is the third meaning-bearing state: a fact a
 *  reviewer must not misread as still settled, since someone who approved
 *  it has since taken it back — left uncoloured, it fell through to
 *  `undefined`, which opentui renders as plain foreground and made a
 *  withdrawn overlap silently indistinguishable from an approved one.
 *  `rejected` overlaps can appear in the pane too, but the design calls out
 *  only these three states as meaning-bearing — `rejected` never entered
 *  the corpus, so its status token is left at normal weight rather than
 *  guessing at a fourth colour nothing asked for. */
export const OVERLAP_STATUS_COLOR: Record<"approved" | "pending" | "retracted", string> = {
  approved: "#5fbf6f",
  pending: "#e0a030",
  // A withdrawn overlap is a fact a reviewer must not misread as a settled
  // one. `rejected` is still left at normal weight — it never entered the
  // corpus — but `retracted` did, and someone took it back.
  retracted: "#c05050",
}

/** An abstract's provenance — `claim.abstractBy`. `generated` means
 *  `cairn curate` wrote it and no human has looked; `human` means a curator
 *  read it and kept or replaced it; `agent` means the proposing agent wrote
 *  it at claim time, alongside the claim itself rather than as a separate
 *  curation step. Three distinct sources, three distinct colours — the
 *  whole reason `abstractBy` is tracked at all is so this distinction can be
 *  shown, not just stored. */
export const ABSTRACT_PROVENANCE_COLOR: Record<"generated" | "human" | "agent", string> = {
  generated: "#e0a030",
  human: "#5fbf6f",
  agent: "#6fa8dc",
}

/**
 * What a citation's line MEANS, in the two ways a reviewer must not miss.
 *
 * Deliberately the same two hexes `OVERLAP_STATUS_COLOR` already uses, because
 * they already mean these things on this screen and a second amber would be a
 * second vocabulary:
 *
 *   - `unverified` is `pending`/`generated`'s amber. Those mean "nobody has
 *     looked"; so does a citation with no stated scope, no absence check, or
 *     no recorded hash. Older citations are all three at once, and left
 *     uncoloured they read exactly like a citation somebody
 *     checked — which is the conflation the nullable `absent`/`hash` types
 *     exist to prevent, surviving all the way to the last layer.
 *   - `stale` is `retracted`'s red, for the identical reason it was given
 *     one: a fact a reviewer must not misread as still settled. The cited
 *     document has moved since the citation was attached, so every absence
 *     shown beside it was computed against text that is no longer there.
 *
 * `docId` is the one string in the pane worth carrying somewhere else —
 * `cairn show <id>` takes it and the store has no prefix lookup, so it is
 * printed in full. A colour marks it as the thing to copy rather than more
 * prose to read.
 */
export const CITATION_COLOR = {
  unverified: "#e0a030",
  stale: "#c05050",
  docId: "#6fa8dc",
} as const
