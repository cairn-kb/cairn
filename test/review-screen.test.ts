import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import {
  buildScreen,
  curateAnswerForKey,
  decisionForKey,
  editsUnchanged,
  footerLegend,
  REFS_PANE_WIDTH,
  resolveCites,
  resolveOverlaps,
  runScreenCurate,
  runScreenReview,
  withSuspendedRenderer,
  type RefResult,
} from "../src/review-screen"
import { ABSENCE_FRAMING } from "@cairn-kb/protocol/absence"
import { createUi } from "../src/ui"
import {
  ABSTRACT_PROVENANCE_COLOR,
  BORDER_COLOR,
  CITATION_COLOR,
  OVERLAP_STATUS_COLOR,
  SCROLLBAR_COLOR,
  TEXT_COLOR,
} from "../src/review-style"
import type { Citation, Claim, Document, Store } from "@cairn-kb/protocol/types"

/** A citation, defaulting to the scope-less unchecked shape a claim written
 *  before `supports` existed comes back as. Cases that care about scope,
 *  absences or the recorded hash override those explicitly. */
function cite(doc: string, over: Partial<Citation> = {}): Citation {
  return { doc, supports: "", hash: null, absent: null, by: "unknown", ...over }
}

/** An unresolved lookup with nothing in it — for tests below that only care
 *  about `showReferences`'s cites side and need something type-correct to
 *  pass as the overlaps side. `RefResult<never>`'s `found: never[]` is
 *  assignable wherever a `RefResult<T>` is expected, same as an empty array
 *  literal is. */
const EMPTY_REF_RESULT: RefResult<never> = { found: [], missing: [], failed: null }

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: "c1", status: "pending",
    claim: "Team install is mineru[pipeline], not mineru[core].",
    body: "# Heading\n\nThe **pipeline** extra is what the team uses.\n\n- one\n- two\n",
    source: { author: "alice", agent: "cursor", repo: "MinerU", session: null },
    created: "2026-08-31T00:00:00.000Z", reviewed: null, reviewer: null, retracted: null,
    overlaps: [], cites: [], abstract: null, abstractBy: null, tags: [],
    ...over,
  }
}

/**
 * MarkdownRenderable settles ASYNCHRONOUSLY. `flush()` alone leaves the pane
 * empty, so an assertion made too early passes on blankness — the exact shape
 * of a vacuous test. Poll real wall-clock until the text appears.
 *
 * opentui ships `waitForFrame`, and it is the wrong tool here: it drives flush
 * passes without yielding real time, and markdown highlighting is delivered by
 * a tree-sitter worker that needs the event loop. Measured, the
 * body appears ~95ms after `show`, concealed correctly — and under
 * `waitForFrame` it never appears at all. The `setTimeout` is the point, not an
 * accident.
 *
 * Do not "fix" a slow test here by lengthening the sleep: that is how an early
 * prototype produced a bogus 1.5s timing that was really measuring its own sleep.
 */
async function frameContaining(
  flush: () => Promise<void>,
  capture: () => string,
  needle: string,
  budget = 5000,
): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < budget) {
    await flush()
    const f = capture()
    if (f.includes(needle)) return f
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`never rendered ${JSON.stringify(needle)} within ${budget}ms:\n${capture()}`)
}

/**
 * The BODY pane's bottom border row — the LAST row carrying a closing corner
 * glyph, not the first. The claim sentence now sits in its own bordered box in
 * the header, above the body pane, so the first `┘` on screen closes THAT box
 * and carries no scroll percentage. Throws rather than returning a default: a
 * screen with no bordered pane at all would otherwise make every assertion
 * about the row pass vacuously.
 */
function bottomBorderRow(frame: string): string {
  const row = frame.split("\n").reverse().find((r) => r.includes("┘"))
  if (!row) throw new Error(`no bottom border row in:\n${frame}`)
  return row
}

// --- captureSpans: asserting styling rather than eyeballing it -------------
//
// `captureCharFrame` proves TEXT is on screen; it cannot tell bold from dim
// from plain, so a readability change built on weight and colour needs a
// different capture. `captureSpans()` returns per-span `fg`/`bg`/`attributes`
// — this is the pattern the tests below build on for the claim sentence's weight,
// an overlap's status colour and a focused field's border colour.

/** Derived from `createTestRenderer`'s own return type rather than importing
 *  `CapturedFrame`/`CapturedSpan` from `@opentui/core` — this file may only
 *  reach opentui through `@opentui/core/testing`, the same rule
 *  `review-screen.ts`'s header comment states for the production code. */
type Frame = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"]>
type Span = Frame["lines"][number]["spans"][number]

/**
 * Empirically confirmed, not guessed: a probe render of `bold("BOLDWORD")`
 * and `dim("DIMWORD")` through `captureSpans()` reported
 * `{ text: "BOLDWORD", attributes: 1 }` and `{ text: "DIMWORD", attributes: 2 }`
 * — bit 0 for bold, bit 1 for dim, matching `TextAttributes.BOLD = 1 << 0`
 * in `@opentui/core/types.d.ts`. Not imported as `TextAttributes.BOLD`
 * itself: that lives in `@opentui/core`, off limits in this file, so this is
 * a measured magic number rather than an imported one.
 */
const BOLD_ATTRIBUTE = 1
const isBold = (span: Span): boolean => (span.attributes & BOLD_ATTRIBUTE) !== 0
// Same probe, same file's comment above: bit 1 for dim (`TextAttributes.DIM
// = 1 << 1`). Needed for the references pane's section labels
// ("overlaps"/"cites"), which read as labels the same way the footer's
// already do.
const DIM_ATTRIBUTE = 2
const isDim = (span: Span): boolean => (span.attributes & DIM_ATTRIBUTE) !== 0

/**
 * `Span.fg`/`.bg` are RGBA-like objects (`.equals()`, `.toInts()`), not hex
 * strings, so a captured span can never be compared to a named colour
 * constant from review-style.ts (`BORDER_COLOR.focused`,
 * `OVERLAP_STATUS_COLOR`, `ABSTRACT_PROVENANCE_COLOR`) with a plain `===`.
 * `.toInts()` returns `[r, g, b, a]` in 0-255 — confirmed by reading
 * `@opentui/core`'s own `RGBA.toInts()` and its use of `color.toInts()[3]` as
 * the alpha channel elsewhere in that module. Kept here rather than inline in
 * one test so later tests can reuse it instead of re-deriving it.
 */
function colorEquals(color: { toInts(): number[] } | undefined, hex: string): boolean {
  if (!color) return false
  const clean = hex.replace("#", "")
  const [er, eg, eb] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16))
  const [r, g, b] = color.toInts()
  return r === er && g === eg && b === eb
}

type SpanSource = Frame | Span[]
const spansOf = (source: SpanSource): Span[] => (Array.isArray(source) ? source : source.lines.flatMap((l) => l.spans))

/**
 * The span whose text CONTAINS `needle`, first match in reading order
 * (top-to-bottom, left-to-right). Pass a whole `Frame` when the needle is
 * unambiguous on screen (a whole word like "approved"); pass one line's
 * `spans` — from `lineContaining` below — to scope the search when it is
 * not, the way a bare letter like "e" is ambiguous across a footer legend
 * whose OTHER labels ("reject", "edit" itself) also contain an "e".
 *
 * Fails LOUDLY when nothing matches, the same rule `frameContaining` above
 * follows and for the same reason: a lookup that silently returned some
 * default span would make `expect(isBold(...)).toBe(false)` pass on a
 * screen that never rendered the text at all — vacuously, not because the
 * property actually held.
 */
function spanContaining(source: SpanSource, needle: string): Span {
  const span = spansOf(source).find((s) => s.text.includes(needle))
  if (!span) throw new Error(`no span contains ${JSON.stringify(needle)}`)
  return span
}

/** The span whose text EQUALS `text` exactly — for a needle too short to be
 *  unambiguous even as a substring search, like a single-letter footer key
 *  sitting next to a label that happens to contain the same letter. */
function spanExactly(source: SpanSource, text: string): Span {
  const span = spansOf(source).find((s) => s.text === text)
  if (!span) throw new Error(`no span has exactly the text ${JSON.stringify(text)}`)
  return span
}

/** The spans of the line whose joined text contains `needle` — how a caller
 *  scopes `spanContaining`/`spanExactly` to one row (a footer, a specific
 *  references-pane entry) instead of searching the whole frame. */
function lineContaining(frame: Frame, needle: string): Span[] {
  // Joined, not per-span: the styled footer splits "w write" across a bold
  // "w" span and a dim " write" span, so no SINGLE span's text ever contains
  // the whole needle even though the rendered ROW plainly does.
  const line = frame.lines.find((l) => l.spans.map((s) => s.text).join("").includes(needle))
  if (!line) throw new Error(`no line contains ${JSON.stringify(needle)}`)
  return line.spans
}

test("the span helpers fail rather than passing on text that was never rendered", async () => {
  // Positive control for every span-based test below, the same reason
  // `frameContaining`'s positive control exists: without this, a helper that
  // silently found nothing would make a styling assertion pass vacuously.
  const { renderer, flush, captureSpans } = await createTestRenderer({ width: 70, height: 16 })
  buildScreen(renderer)
  await flush()
  const frame = captureSpans()
  expect(() => spanContaining(frame, "text that is never rendered")).toThrow(/no span contains/)
  expect(() => spanExactly(frame, "text that is never rendered")).toThrow(/no span has exactly/)
  expect(() => lineContaining(frame, "text that is never rendered")).toThrow(/no line contains/)
})

test("the footer's key letters are bold and their labels are not", async () => {
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim(), 1, 1)
  await frameContaining(flush, captureCharFrame, "approve")
  const footer = lineContaining(captureSpans(), "approve")
  // Every decision key is its own bold span...
  for (const key of ["a", "r", "e", "s", "q"]) {
    expect(isBold(spanExactly(footer, key))).toBe(true)
  }
  // ...and its label, right beside it, is not — this is the actual defect:
  // today both render in the same grey, so a check that only asserted the
  // keys were bold would still pass against a footer where the labels were
  // ALSO bold.
  for (const label of ["approve", "reject", "edit", "skip", "quit"]) {
    expect(isBold(spanContaining(footer, label))).toBe(false)
  }
})

test("curate's footer keys are bold too", async () => {
  // The review-only test above exercises `REVIEW_ENTRIES`; curate builds its
  // legend from a different entries array (`w`/`s`/`q`, no `a`/`r`/`e`), so a
  // bug scoped to one kind's table would not show up in the other.
  const { renderer, mockInput, flush, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 70,
    height: 16,
  })
  const c = claim({ status: "approved", abstract: "Generated abstract.", abstractBy: "generated" })
  const done = runScreenCurate({ store: fakeStore({ list: async () => [c] }), ui: createUi(false), renderer })
  const frame = await frameContaining(flush, captureCharFrame, "w write")
  const footer = lineContaining(captureSpans(), "w write")
  expect(isBold(spanExactly(footer, "w"))).toBe(true)
  expect(isBold(spanContaining(footer, "write"))).toBe(false)
  expect(frame).toContain("w write")
  mockInput.pressKey("q")
  await done
})

test("the body renders as markdown, with the syntax markers concealed", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim(), 3, 8)
  const frame = await frameContaining(flush, captureCharFrame, "Heading")
  expect(frame).toContain("Heading")
  expect(frame).not.toContain("# Heading")
  expect(frame).not.toContain("**pipeline**")
})

test("the header names the position and the proposing agent", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim(), 3, 8)
  const frame = await frameContaining(flush, captureCharFrame, "3 of 8")
  expect(frame).toContain("cursor")
  expect(frame).toContain("MinerU")
})

// --- browsing hierarchy: weight and colour ----------------------------------
//
// The defect: the claim sentence — the assertion being judged — rendered in
// the same weight as the body prose beneath it, so the eye had nowhere to
// land. `captureSpans()` is what makes that assertable instead of eyeballed.

test("the claim sentence is bold and the body prose beside it is not", async () => {
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim(), 1, 1)
  await frameContaining(flush, captureCharFrame, "Heading")
  const frame = captureSpans()
  // The sentence: the one thing on this screen that must outrank everything
  // else, because it is the thing the whole screen exists to put in front of
  // a person.
  expect(isBold(spanContaining(frame, "mineru[pipeline]"))).toBe(true)
  // The body prose right beside it must NOT share that weight — the actual
  // defect. A check that only asserted the sentence WAS bold would still
  // pass on a screen where the body was bold too.
  expect(isBold(spanContaining(frame, "team uses"))).toBe(false)
})

test("the claim sentence sits in its own titled box, a named peer of body and references", async () => {
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 130, height: 20 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)
  const frame = await frameContaining(flush, captureCharFrame, "Heading")
  const rows = frame.split("\n")
  // A real pane, not a bold line: its title rides its own top border, and
  // that border's corner sits at column 0, flush with the body pane's below.
  const top = rows.findIndex((r) => r.startsWith("┌─claim"))
  expect(top).toBeGreaterThanOrEqual(0)
  // And it is ABOVE the body pane, in the header — the sentence is what the
  // body is judged against, so it cannot live inside the thing that scrolls.
  expect(rows.findIndex((r) => r.startsWith("┌─body"))).toBeGreaterThan(top)

  const spans = captureSpans()
  const titleRow = lineContaining(spans, "─claim─")
  // Same title colour and same border colour as its two peers — the whole
  // point of the shape. A fourth colour here would claim a meaning the
  // screen does not spend colour on.
  expect(colorEquals(spanContaining(titleRow, "claim").fg, TEXT_COLOR.dim)).toBe(true)
  expect(colorEquals(spanContaining(titleRow, "┌").fg, BORDER_COLOR.idle)).toBe(true)
  expect(colorEquals(spanContaining(titleRow, "claim").fg, BORDER_COLOR.editing)).toBe(false)
  expect(colorEquals(spanContaining(titleRow, "┌").fg, BORDER_COLOR.editing)).toBe(false)
  // The sentence keeps the weight it had before the box: bold, still the one
  // thing on screen that outranks everything else.
  expect(isBold(spanContaining(spans, "mineru[pipeline]"))).toBe(true)
})

test("the claim box's two rows do not collapse the body pane on a short terminal", async () => {
  // The box costs 2 rows of body. At 16 rows — the smallest height anything
  // in this file drives the screen at — the body must still be a pane a
  // person can read, not a border with nothing between it.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim({ body: Array.from({ length: 40 }, (_, i) => `line ${i} of the body`).join("\n") }), 1, 1)
  const frame = await frameContaining(flush, captureCharFrame, "line 0 of the body")
  expect(frame).toContain("┌─claim")
  expect(bodyViewportRows(frame)).toBeGreaterThanOrEqual(5)
  // Not merely sized — actually filled, several rows of it.
  for (const n of [0, 1, 2, 3, 4]) expect(frame).toContain(`line ${n} of the body`)
})

test("no bordered claim box is drawn when there is no sentence to put in it", async () => {
  // The other half of the mount guard, and the half nothing asserted: an
  // empty bordered box titled `claim` does not read as "loading", it reads as
  // "this claim has no sentence". Two ways to reach it — a screen built but
  // never shown a claim, and a claim whose sentence is empty.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  await flush()
  expect(captureCharFrame()).not.toContain("┌─claim")

  screen.show(claim({ claim: "" }), 1, 1)
  const frame = await frameContaining(flush, captureCharFrame, "Heading")
  expect(frame).not.toContain("┌─claim")
  // The claim itself is still on screen — this is about the empty box, not
  // about hiding a claim whose body renders fine.
  expect(frame).toContain("Heading")

  // And the box comes straight back for a claim that does have one.
  screen.show(claim(), 1, 1)
  expect(await frameContaining(flush, captureCharFrame, "mineru[pipeline]")).toContain("┌─claim")
})

test("the body pane and the references pane carry real titles, not content pretending to be one", async () => {
  // Wide enough that the references pane is mounted beside the claim, not
  // toggled — both titles need to be checkable from one frame.
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 130, height: 20 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)
  const frame = await frameContaining(flush, captureCharFrame, "Heading")
  // A REAL title sits on the box's own top border row, next to the corner
  // glyph — this is what tells it apart from the word merely appearing
  // somewhere in the pane's content.
  const spans = captureSpans()
  const bodyTitleRow = lineContaining(spans, "body")
  expect(spanContaining(bodyTitleRow, "┌")).toBeTruthy()
  const refsTitleRow = lineContaining(spans, "references")
  expect(spanContaining(refsTitleRow, "┌")).toBeTruthy()
  expect(frame).toContain("references")
})

test("the claim sentence stays visible after the body is scrolled", async () => {
  // Plain-text body, one "\n" per line rather than markdown's blank-line-
  // separated paragraphs. With paragraphs, MarkdownRenderable lays out a
  // blank spacer row after each one, so a row-based scroll delta lands on
  // roughly half the paragraph index it looks like it should — scroll(40)
  // on paragraph text landed around "line 20", never "line 4"/"line 40-49",
  // and frameContaining spun until both its own budget and bun's per-test
  // timeout expired, which reads as a hang. 40 lines is already ~3.6x the
  // 11-row viewport, so the property (scroll past a screenful) still holds.
  const long = claim({ body: Array.from({ length: 40 }, (_, i) => `line ${i} of the body`).join("\n") })
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(long, 1, 1)
  await frameContaining(flush, captureCharFrame, "line 0")
  screen.scroll(20)
  const frame = await frameContaining(flush, captureCharFrame, "line 25")
  // The sentence is the assertion being judged. It must never scroll away.
  expect(frame).toContain("mineru[pipeline]")
  expect(frame).not.toContain("line 0 of the body")
})

test("the frame helper fails rather than passing on a blank pane", async () => {
  // Positive control for the helper every other test in this file depends on.
  // Without it, an empty frame would satisfy a `not.toContain` assertion and a
  // broken screen would ship as coverage.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  buildScreen(renderer)
  await expect(
    frameContaining(flush, captureCharFrame, "text that is never rendered", 400),
  ).rejects.toThrow(/never rendered/)
})

test("the footer legend fits the terminal it is given", () => {
  // A fixed legend overflowed at 84 columns in an early prototype and pushed the
  // layout. Width-aware is a requirement, not a nicety.
  //
  // The scroll percentage is no longer in the footer at all (it now
  // lives on the body pane's `bottomTitle`), which changed the two numbers
  // this test is built against: the "browsing" legend, with no percentage
  // to append, is now exactly 55 characters. 55 is deliberately included: at
  // that width the fit check passes whether or not the truncation branch
  // runs at all — that width alone can't tell a working guard from a deleted
  // one. 40 sits strictly between the 14-char short legend and the 55-char
  // full one, so it fails unless truncation is genuinely exercised.
  for (const width of [40, 55, 84, 120]) {
    expect(footerLegend(width, "browsing").length).toBeLessThanOrEqual(width)
  }
  expect(footerLegend(120, "browsing")).toContain("approve")
  expect(footerLegend(120, "editing")).toContain("esc")
})

test("curate's legend names curate's keys, and only those, at every width", () => {
  // The screen used to paint review's legend: `a approve  r reject  e edit  s
  // skip  q quit … · o refs`, of which curate maps exactly one — `s` — while
  // `w`, its only action, was nowhere on it.
  //
  // Widths chosen against the full legend (35 chars, percentage-free) and
  // the short one (10), so each branch is genuinely taken: 8
  // forces the slice, 15 and 34 force the short form without a slice, 35 is
  // the exact fit, 80 has room to spare. A width where the full legend
  // already fits proves nothing about truncation — that is how the browsing
  // check at width 55 was once vacuous.
  for (const width of [8, 15, 34, 35, 80]) {
    expect(footerLegend(width, "browsing", "curate").length).toBeLessThanOrEqual(width)
    expect(footerLegend(width, "editing", "curate").length).toBeLessThanOrEqual(width)
  }
  // The slice really ran: a 10-char short legend cut to 8.
  expect(footerLegend(8, "browsing", "curate")).toHaveLength(8)
  // One column under the full legend is enough to drop to the short form.
  expect(footerLegend(34, "browsing", "curate")).not.toContain("write")
  expect(footerLegend(35, "browsing", "curate")).toContain("w write")
  // Review's keys are absent from curate's screen at every width, because
  // `curateAnswerForKey` maps none of them.
  for (const width of [8, 15, 34, 35, 80]) {
    const legend = footerLegend(width, "browsing", "curate")
    expect(legend).not.toContain("approve")
    expect(legend).not.toContain("reject")
    expect(legend).not.toContain("r e s q")
  }
  // Curate's editor has one field and no "open in $EDITOR" — naming Tab or `E`
  // would advertise two more keys that do nothing.
  expect(footerLegend(80, "editing", "curate")).not.toContain("tab")
  expect(footerLegend(80, "editing", "curate")).not.toContain("$EDITOR")
  // Review's legend is what the two-argument form still gives.
  expect(footerLegend(120, "browsing")).toBe(footerLegend(120, "browsing", "review"))
})

// --- affordances: visible scrollbar and bottomTitle ------------------------
//
// Before this change the only scroll affordance was a bare percentage in the
// global footer — a number to interpret rather than a picture of where you
// are. The percentage also moved: position belongs on the pane that
// scrolls, so it is now the body pane's own `bottomTitle`, and the footer
// tests above already confirm it carries no percentage of its own any more.

test("the vertical scrollbar shows when the body overflows and stays hidden when it fits", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  const overflowing = claim({ body: Array.from({ length: 40 }, (_, i) => `line ${i} of the body`).join("\n") })
  screen.show(overflowing, 1, 1)
  const overflowFrame = await frameContaining(flush, captureCharFrame, "line 0")
  // opentui hides the scrollbar itself whenever content fits the viewport
  // (`ScrollBarRenderable.recalculateVisibility`) — this proves the screen
  // actually reaches that behaviour through its own options, not
  // reimplementing the rule.
  expect(overflowFrame).toMatch(/[▀▄█]/)

  const fitting = claim()
  screen.show(fitting, 1, 1)
  const fittingFrame = await frameContaining(flush, captureCharFrame, "Heading")
  expect(fittingFrame).not.toMatch(/[▀▄█]/)
})

test("the scrollbar's thumb and track are coloured from the screen's quiet palette, not a colour of their own", async () => {
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  const overflowing = claim({ body: Array.from({ length: 40 }, (_, i) => `line ${i} of the body`).join("\n") })
  screen.show(overflowing, 1, 1)
  await frameContaining(flush, captureCharFrame, "line 0")
  // A scroll position isn't one of the two facts this screen spends colour
  // on (an overlap's status, an abstract's provenance) — so the thumb reuses
  // the dim text colour and the track reuses the idle border colour rather
  // than inventing a third semantic colour nothing asked for.
  const thumb = spanContaining(captureSpans(), "▀")
  expect(colorEquals(thumb.fg, SCROLLBAR_COLOR.thumb)).toBe(true)
  expect(colorEquals(thumb.bg, SCROLLBAR_COLOR.track)).toBe(true)
})

test("scroll position is the body pane's bottomTitle, not a fragment of the footer", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim(), 1, 1)
  const frame = await frameContaining(flush, captureCharFrame, "Heading")
  const rows = frame.split("\n")
  // The bottom border row is the one carrying the closing corner glyph — the
  // same way `spanContaining(..., "┌")` picks out a TOP title elsewhere in
  // this file.
  const borderRow = bottomBorderRow(frame)
  const footerRow = rows.find((r) => r.includes("approve"))
  if (!borderRow || !footerRow) throw new Error(`expected border and footer rows in:\n${frame}`)
  expect(borderRow).toContain("0%")
  expect(footerRow).not.toContain("%")
})

test("the bottomTitle's percentage is cleared while editing, and returns once editing ends", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  const c = claim()
  screen.show(c, 1, 1)
  const browsing = await frameContaining(flush, captureCharFrame, "Heading")
  expect(bottomBorderRow(browsing)).toContain("0%")

  screen.beginEdit(c)
  const editing = await frameContaining(flush, captureCharFrame, "esc done")
  // `scroll` no longer holds the body while a field owns the pane (see
  // `beginEdit`) — the same reason the OLD footer never showed a percentage
  // while editing either.
  expect(editing).not.toContain("%")

  screen.endEdit()
  const after = await frameContaining(flush, captureCharFrame, "Heading")
  // Not necessarily back to "0%": `endEdit` swaps the content back
  // synchronously and `scroll.scrollHeight` catches up with it on the next
  // layout pass, a pre-existing quirk of this same percent formula — the OLD
  // footer showed the same stale, nonzero figure here before this change moved
  // it. What this change promises is that the pane is titled with A percentage
  // again, not that it is `0%` specifically.
  expect(bottomBorderRow(after)).toMatch(/\d+%/)
})

test("the decision keys map to the loop's decisions", () => {
  expect(decisionForKey("a")).toBe("approve")
  expect(decisionForKey("r")).toBe("reject")
  expect(decisionForKey("e")).toBe("edit")
  expect(decisionForKey("s")).toBe("skip")
  expect(decisionForKey("q")).toBe("quit")
})

test("navigation keys are not decisions", () => {
  expect(decisionForKey("up")).toBe("scroll-up")
  expect(decisionForKey("pagedown")).toBe("page-down")
  // An unmapped key must do nothing rather than fall through to a decision.
  expect(decisionForKey("z")).toBeNull()
  expect(decisionForKey("")).toBeNull()
})

test("decision keys are inert while a field has focus", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim(), 1, 1)
  await frameContaining(flush, captureCharFrame, "pipeline")
  expect(screen.mode()).toBe("browsing")
  screen.beginEdit(claim())
  // The whole point of the mode model: `a` must type an "a", not approve.
  expect(screen.mode()).toBe("editing")
  const frame = await frameContaining(flush, captureCharFrame, "esc done")
  expect(frame).not.toContain("a approve")
})

test("edit mode shows markdown source, not the rendered form", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  const c = claim()
  screen.show(c, 1, 1)
  await frameContaining(flush, captureCharFrame, "Heading")
  screen.beginEdit(c)
  // Rendered markdown is not typeable. The markers must come back.
  const frame = await frameContaining(flush, captureCharFrame, "# Heading")
  expect(frame).toContain("**pipeline**")
})

test("the editor's field order is canonical, not the order the caller listed", async () => {
  // `beginEdit` mounts in ALL_FIELDS order and used to build the Tab cycle
  // from the caller's order, so a caller naming ["abstract", "claim"] would
  // get a visual order that disagrees with the Tab order — and focus would
  // start on the abstract rather than on the claim sentence, which comes
  // first whenever it is in play.
  //
  // Asserted by typing: the character lands wherever focus actually is.
  const { renderer, mockInput } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  const c = claim({ abstract: "An abstract." })
  screen.beginEdit(c, ["abstract", "claim"])
  await tick()
  mockInput.pressKey("Z")
  await tick()
  const edits = screen.endEdit()
  expect(edits.claim).toContain("Z")
  expect(edits.abstract).not.toContain("Z")
})

test("leaving the editor untouched reports no change", async () => {
  const { renderer } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  const c = claim()
  screen.beginEdit(c)
  const edits = screen.endEdit()
  // Recording an `edit` here would report an improvement that did not happen,
  // and `edited` is a figure this project reports.
  expect(editsUnchanged(c, edits)).toBe(true)
})

test("the unchanged check compares against trimmed originals across all three fields", () => {
  const c = claim({ body: "  spaced body  ", abstract: null })
  expect(editsUnchanged(c, { claim: c.claim, body: "spaced body", abstract: "" })).toBe(true)
  expect(editsUnchanged(c, { claim: c.claim, body: "different", abstract: "" })).toBe(false)
  expect(editsUnchanged(c, { claim: "different", body: "spaced body", abstract: "" })).toBe(false)
  expect(editsUnchanged(c, { claim: c.claim, body: "spaced body", abstract: "written" })).toBe(false)
})

// --- withSuspendedRenderer --------------------------------------------------

test("the renderer is suspended around the spawn and resumed after", async () => {
  const calls: string[] = []
  const fake = {
    suspend: () => { calls.push("suspend") },
    resume: () => { calls.push("resume") },
  }
  const out = await withSuspendedRenderer(fake, async () => { calls.push("spawn"); return 7 })
  expect(out).toBe(7)
  expect(calls).toEqual(["suspend", "spawn", "resume"])
})

test("the renderer resumes even when the editor throws", async () => {
  // A child editor and a live renderer fighting over the terminal corrupts the
  // display, and it shows on the way BACK — so the resume must not be skipped
  // by the failure path.
  const calls: string[] = []
  const fake = { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") }
  await expect(
    withSuspendedRenderer(fake, async () => { throw new Error("editor exited 1") }),
  ).rejects.toThrow("editor exited 1")
  expect(calls).toEqual(["suspend", "resume"])
})

// --- decision keys through the real keypress handler ------------------------

/**
 * A double that implements the real seam rather than being cast past it, in
 * the spirit of test/review-tui.test.ts's `fakeStore`. Every method
 * `runScreenReview` has no business calling throws with its own name, so a
 * bug that starts calling one fails loudly instead of quietly agreeing with
 * an `undefined`.
 */
function unsupported(name: string): never {
  throw new Error(`runScreenReview must not call Store.${name}`)
}

function fakeStore(over: Partial<Store>): Store {
  return {
    list: async () => unsupported("list"),
    get: async () => unsupported("get"),
    put: async () => unsupported("put"),
    move: async () => unsupported("move"),
    search: async () => unsupported("search"),
    propose: async () => unsupported("propose"),
    review: async () => unsupported("review"),
    retract: async () => unsupported("retract"),
    cite: async () => unsupported("cite"),
    uncite: async () => unsupported("uncite"),
    importClaim: async () => unsupported("importClaim"),
    stats: async () => unsupported("stats"),
    listDocuments: async () => unsupported("listDocuments"),
    getDocument: async () => unsupported("getDocument"),
    searchDocuments: async () => unsupported("searchDocuments"),
    importDocument: async () => unsupported("importDocument"),
    writeGenerated: async () => unsupported("writeGenerated"),
    adoptImport: async () => unsupported("adoptImport"),
    ...over,
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/**
 * The existing "decision keys are inert while a field has focus" test above
 * only asserts that `screen.mode()` flipped and the footer stopped
 * advertising "a approve" — both true even for a handler that still resolves
 * "approve" while a field is focused. This drives an actual keystroke through
 * `renderer.keyInput` — the same event `runScreenReview`'s handler is
 * registered on — via `createTestRenderer`'s `mockInput`, exactly the path a
 * real terminal would take, and watches what the store is actually told.
 *
 * The property that matters: recording an approval a human never made is the
 * worst failure this product can have.
 */
test("decision keys reach no store call while a field has focus, through the real keypress handler", async () => {
  const { renderer, mockInput } = await createTestRenderer({ width: 70, height: 16 })
  const decisions: string[] = []
  const store = fakeStore({
    list: async () => [claim()],
    review: async (_id, decision) => {
      decisions.push(decision)
      return null
    },
  })
  const done = runScreenReview({ store, ui: createUi(false), renderer })

  // Let `runReview` read the pending list and reach the first `ask`.
  await tick()
  mockInput.pressKey("e") // begin in-place editing
  await tick()

  // The whole point of the mode model: "a" must type an "a" into the focused
  // field, not resolve as an approval. If the editing-mode guard fell
  // through, `resolve?.("approve")` would fire synchronously here — well
  // before Escape is ever pressed.
  mockInput.pressKey("a")
  await tick()
  expect(decisions).toEqual([])

  // Clean up: leave editing (Esc), which resolves the parked "edit" decision
  // and lets `runReview`'s loop finish on its own — otherwise `done` and this
  // renderer leak into later tests.
  mockInput.pressEscape()
  await done

  // Whatever the eventual decision was — the stray "a" landed in the field
  // and became part of the edited text — it was never recorded as "approve".
  expect(decisions).not.toContain("approve")
})

/**
 * The mode-entry keystroke itself.
 *
 * `beginEdit` focuses a textarea synchronously, inside this very keypress
 * dispatch, and opentui runs renderable handlers after the global ones — so
 * the `e` that opened the editor was being typed into the claim sentence it
 * opened. A reviewer who pressed `e`, changed their mind and pressed Esc then
 * recorded `store.review("c1", "edit", { claim: "eTeam install is …" })`:
 * an approval, of a corrupted sentence, tallied as a human edit. The
 * `unchanged` guard cannot catch it — the stray character makes the text
 * genuinely different.
 *
 * Asserted on WHAT THE STORE WAS TOLD, not on field contents: the field is
 * where the bug shows, but the store is where the damage is done.
 */
test("the key that opens the editor is not typed into it — e then Esc records nothing and leaves the claim pending", async () => {
  const { renderer, mockInput } = await createTestRenderer({ width: 70, height: 16 })
  const recorded: Array<[string, string, unknown]> = []
  const c = claim()
  const store = fakeStore({
    list: async () => [c],
    review: async (id, decision, edits) => {
      recorded.push([id, decision, edits])
      return c
    },
  })
  const done = runScreenReview({ store, ui: createUi(false), renderer })
  await tick()
  mockInput.pressKey("e") // open the editor
  await tick()
  mockInput.pressEscape() // change of mind: nothing was typed
  const summary = await done

  expect(recorded).toEqual([])
  // "left pending", not "edited": `runReview` reaches its unchanged guard
  // because the text really is unchanged.
  expect(summary).toEqual({ approved: 0, rejected: 0, edited: 0, skipped: 1 })
})

/**
 * Below 120 columns the references pane REPLACES the claim pane, and the
 * editor mounts inside the claim pane — so `o` then `e` used to put the
 * operator into three textareas that were not in the layout at all: the refs
 * pane still on screen, no field anywhere, the footer saying
 * "editing · tab field · esc done", and `o` swallowed by the editing branch
 * so there was no way back but Esc. It read as a hung screen.
 *
 * The property, stated so it cannot regress into a weaker one: entering edit
 * mode must leave a field ON SCREEN. The markdown SOURCE is the proof — only
 * a mounted textarea shows `# Heading` rather than rendered markdown.
 */
test("entering edit mode from the references pane leaves the editor visible", async () => {
  const { renderer, mockInput, flush, captureCharFrame } = await createTestRenderer({ width: 90, height: 20 })
  // Short enough to stay on one row in a 44-column pane: this test is about
  // whether the pane is MOUNTED, so a needle that wraps would fail it for a
  // reason it does not care about.
  const overlap = claim({ id: "c2", status: "approved", claim: "Overlap for the editing test." })
  const store = fakeStore({
    list: async () => [claim({ overlaps: ["c2"] })],
    get: async () => overlap,
  })
  const done = runScreenReview({ store, ui: createUi(false), renderer })
  await tick()
  mockInput.pressKey("o") // swap the claim pane out for the references pane
  await frameContaining(flush, captureCharFrame, "Overlap for the editing test.", 2000)
  mockInput.pressKey("e")
  // Budgets shorter than bun's 5s per-test timeout on purpose: a regression
  // here must fail with `frameContaining`'s "never rendered … <frame>" — the
  // frame is the evidence — not with a bare "test timed out".
  const frame = await frameContaining(flush, captureCharFrame, "# Heading", 2000)
  expect(frame).toContain("**pipeline**")
  // And the references pane is gone rather than sitting on top of an editor
  // nobody can see.
  expect(frame).not.toContain("Overlap for the editing test.")
  mockInput.pressEscape()
  await done
})

// --- edit-mode field boxes: titles and focus -------------------------------
//
// The defect: three textareas, unlabelled and visually identical, with no
// on-screen sign of which one Tab just moved focus to — and the claim
// sentence rendered twice, once in the header and once as the first field.

test("each field in the editor is its own titled box, named even when empty", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 20 })
  const screen = buildScreen(renderer)
  const c = claim() // abstract: null — the empty field must still carry its name
  screen.beginEdit(c)
  const frame = await frameContaining(flush, captureCharFrame, "abstract", 2000)
  expect(frame).toContain("claim")
  expect(frame).toContain("body")
  expect(frame).toContain("abstract")
})

/**
 * The load-bearing assertion for this change: not "a border exists" but "the
 * ONE field with focus reads differently from its siblings", and Tab moves
 * which one that is. Confirmed declarative per `src/review-screen.ts`: the
 * boxes set `focusable` and `focusedBorderColor`, and `textarea.focus()` —
 * already called by `beginEdit` and the Tab handler — is what lights the
 * surrounding border; nothing in `paint()` assigns a border colour by hand.
 */
test("the focused field's border differs from its unfocused siblings, and Tab moves which one is lit", async () => {
  const { renderer, mockInput, flush, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 70,
    height: 20,
  })
  const screen = buildScreen(renderer)
  screen.beginEdit(claim())
  await frameContaining(flush, captureCharFrame, "abstract", 2000)

  const topBorder = (frame: Frame, title: string) => spanContaining(lineContaining(frame, title), "┌")

  // Focus starts on the claim field (the canonical order): its
  // border is lit and its siblings' are not.
  const initial = captureSpans()
  const claimBorder = topBorder(initial, "claim")
  const bodyBorder = topBorder(initial, "body")
  const abstractBorder = topBorder(initial, "abstract")
  expect(colorEquals(claimBorder.fg, BORDER_COLOR.focused)).toBe(true)
  expect(colorEquals(bodyBorder.fg, BORDER_COLOR.focused)).toBe(false)
  expect(colorEquals(abstractBorder.fg, BORDER_COLOR.focused)).toBe(false)
  expect(claimBorder.fg.equals(bodyBorder.fg)).toBe(false)

  // Tab moves it: body lights, claim goes back to idle.
  mockInput.pressTab()
  await new Promise((r) => setTimeout(r, 30))
  const afterTab = captureSpans()
  expect(colorEquals(topBorder(afterTab, "claim").fg, BORDER_COLOR.focused)).toBe(false)
  expect(colorEquals(topBorder(afterTab, "body").fg, BORDER_COLOR.focused)).toBe(true)
  expect(colorEquals(topBorder(afterTab, "abstract").fg, BORDER_COLOR.focused)).toBe(false)
})

test("the header drops the duplicated claim sentence while editing, and it returns once editing ends", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 20 })
  const screen = buildScreen(renderer)
  const c = claim()
  screen.show(c, 1, 1)
  const browsing = await frameContaining(flush, captureCharFrame, "mineru[pipeline]")
  // The header is four rows now: the meta line, then the claim box — its top
  // border carrying the title, the sentence, its bottom border. Updated
  // because the design deliberately moved (the sentence gained a box), not
  // because the old row index went red: the property being asserted is
  // unchanged, that the header and not the scroll pane carries the sentence.
  expect(browsing.split("\n")[1]).toContain("─claim─")
  expect(browsing.split("\n")[2]).toContain("mineru[pipeline]")

  screen.beginEdit(c)
  const editing = await frameContaining(flush, captureCharFrame, "# Heading")
  // The header's own row no longer repeats it...
  expect(editing.split("\n")[1]).not.toContain("mineru[pipeline]")
  // ...and the box goes with it rather than staying behind empty. The claim
  // FIELD is titled `claim` too, but it is indented inside the scroll pane;
  // the header's box is the only one whose corner sits at column 0.
  expect(editing.split("\n").filter((r) => r.startsWith("┌─claim"))).toEqual([])
  // ...but it is still on screen once — inside the claim field, not gone.
  expect(editing).toContain("mineru[pipeline]")

  screen.endEdit()
  const after = await frameContaining(flush, captureCharFrame, "mineru[pipeline]")
  expect(after.split("\n")[1]).toContain("─claim─")
  expect(after.split("\n")[2]).toContain("mineru[pipeline]")
})

test("curate's editor mounts only the abstract field, titled and focused the same way review's fields are", async () => {
  const { renderer, mockInput, flush, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 70,
    height: 16,
  })
  const c = claim({ status: "approved", abstract: "Generated abstract.", abstractBy: "generated" })
  const done = runScreenCurate({ store: fakeStore({ list: async () => [c] }), ui: createUi(false), renderer })
  await frameContaining(flush, captureCharFrame, "w write", 2000)
  mockInput.pressKey("w") // begin editing — curate's only field
  const frame = await frameContaining(flush, captureCharFrame, "abstract", 2000)
  // Titled, same as review's fields...
  expect(frame).toContain("abstract")
  // ...and it is the ONLY field curate can ever mount — `runCurate`'s write
  // case can carry nothing else, and exposing more once let an operator type
  // into the claim body and lose it silently.
  expect(frame).not.toContain("claim")
  expect(frame).not.toContain("body")
  // Focused the same way: its border is lit, declaratively, the moment it
  // mounts — there is no Tab in a one-field editor to move it there.
  const border = spanContaining(lineContaining(captureSpans(), "abstract"), "┌")
  expect(colorEquals(border.fg, BORDER_COLOR.focused)).toBe(true)
  mockInput.pressEscape()
  await done
})

test("a multi-line message is never assigned to the one-line header", async () => {
  // `meta` is a single TextRenderable row, and the loops hand `out` whole
  // rendered claims. The header shows the first line and says there is more;
  // the rest belongs to the transcript, not to a row that cannot hold it.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim(), 1, 1)
  await frameContaining(flush, captureCharFrame, "Heading")
  screen.status("could not record that decision: network is down\nsecond line of the message")
  const frame = await frameContaining(flush, captureCharFrame, "could not record that decision", 2000)
  expect(frame).toContain("…")
  expect(frame).not.toContain("second line of the message")
})

/**
 * Nothing the loop says may be lost.
 *
 * `out` used to go straight to the one-line header, so a 409 on the first
 * claim printed its warning and was overwritten by the re-rendered claim in
 * the same tick, then by the next claim's `show()`. The captured frame showed
 * claim 2, clean, with no trace of the failure — an operator who pressed `a`
 * and watched it move on believes they approved it. The `still pending`
 * epilogue went the same way: written line by line into the header
 * immediately before `renderer.destroy()`.
 *
 * Asserted on STDOUT, through the real `console.log` — the same stream
 * `cli.ts` prints its tally to, after the same teardown — rather than on a
 * frame, because a frame is exactly what cannot hold this.
 */
test("a failed decision and the still-pending list reach stdout after the screen is torn down", async () => {
  const { renderer, mockInput } = await createTestRenderer({ width: 70, height: 16 })
  const first = claim({ id: "c1" })
  const second = claim({ id: "c2", claim: "A second pending claim sentence." })
  const store = fakeStore({
    list: async () => [first, second],
    // The re-read after the conflict: what the claim's status actually is now.
    get: async (id) => (id === "c1" ? claim({ id: "c1", status: "approved" }) : null),
    review: async () => {
      throw Object.assign(new Error("that claim was reviewed by somebody else"), { status: 409 })
    },
  })

  const logged: string[] = []
  const realLog = console.log
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "))
  }
  let summary
  try {
    const done = runScreenReview({ store, ui: createUi(false), renderer })
    await tick()
    mockInput.pressKey("a") // approve claim 1 — the store refuses it
    await tick(100)
    mockInput.pressKey("q") // quit on claim 2
    summary = await done
  } finally {
    console.log = realLog
  }

  // Nothing was approved, and the operator is told so in words, not by a
  // tally they have to infer it from.
  expect(summary).toEqual({ approved: 0, rejected: 0, edited: 0, skipped: 1 })
  const printed = logged.join("\n")
  expect(printed).toContain("that claim was reviewed by somebody else")
  expect(printed).toContain("nothing was recorded")
  // The re-rendered claim, in full — the multi-line string the one-line
  // header could never have held.
  expect(printed).toContain("already approved")
  // And the epilogue, naming the claim rather than counting it.
  expect(printed).toContain("still pending (1):")
  expect(printed).toContain(first.claim)
})

// --- curate: curateAnswerForKey / runScreenCurate ---------------------------

test("curate keys map to its three answers and nothing else", () => {
  expect(curateAnswerForKey("w")).toBe("write")
  expect(curateAnswerForKey("s")).toBe("skip")
  expect(curateAnswerForKey("q")).toBe("quit")
  // `a` and `r` approve and reject in review. Curate has no such decisions, and
  // a key that silently means nothing here is better than one that means
  // something surprising.
  expect(curateAnswerForKey("a")).toBeNull()
  expect(curateAnswerForKey("r")).toBeNull()
})

test("curate shows the body and the abstract it is judging", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 18 })
  const screen = buildScreen(renderer)
  const c = claim({
    status: "approved",
    abstract: "Settles which extra the team installs.",
    abstractBy: "generated",
  })
  screen.show(c, 1, 4)
  // Not "pipeline": that substring is already on screen synchronously, in
  // the (bold) claim SENTENCE ("mineru[pipeline]") — it settles before either
  // MarkdownRenderable does and proves nothing about the abstract. The
  // abstract is its own separate MarkdownRenderable now (`abstractBody`,
  // see its comment in review-screen.ts for why), which settles on
  // its OWN tree-sitter pass, independent of `body`'s. Waiting on its actual
  // text is what makes this test wait for the right thing instead of
  // passing by coincidence.
  //
  // Two separate waits, one per pane's own MarkdownRenderable — `body` and
  // `abstractBody` settle on independent tree-sitter passes, so waiting on
  // only one of them races the other. "team uses" is the body's own needle:
  // not "pipeline", which this test's name-only defect hid behind — that
  // substring is ALSO in the (bold) claim sentence in the header, so it was
  // on screen synchronously and proved nothing about whether the body pane
  // itself had rendered anything at all. This test's only assertions used to
  // be on the abstract's text and its provenance — never once on
  // `claim.body` — despite its name promising both; stopping the body from
  // rendering at all left it green.
  await frameContaining(flush, captureCharFrame, "team uses")
  const frame = await frameContaining(flush, captureCharFrame, "Settles which extra")
  // An abstract can only be judged against the text it claims to summarise.
  expect(frame).toContain("team uses")
  expect(frame).toContain("Settles which extra")
  // The provenance is the whole reason curate exists.
  expect(frame).toContain("generated")
})

test("the abstract's label reads as a label, and its provenance is coloured by source", async () => {
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 70, height: 18 })
  const screen = buildScreen(renderer)
  const c = claim({
    status: "approved",
    abstract: "Settles which extra the team installs.",
    abstractBy: "generated",
  })
  screen.show(c, 1, 4)
  await frameContaining(flush, captureCharFrame, "generated")
  const frame = captureSpans()
  // "generated" means a model wrote it and no human has looked — the whole
  // reason `abstractBy` is tracked. "abstract" beside it is just the label
  // naming what follows, so it stays dim rather than sharing the colour.
  //
  // `spanContaining`, not `spanExactly`: the brackets around the provenance
  // now carry the label's own weight, so "abstract" and " (" render as ONE
  // dim run and no span's text is the bare word any more. That merge IS the
  // fix — while the brackets were plain they rendered at full white, louder
  // than the dim label they enclose, in the middle of the one line this
  // screen spends a semantic colour on.
  expect(isDim(spanContaining(frame, "abstract"))).toBe(true)
  // The brackets are punctuation around that label, so they take its weight.
  // At full white they outranked the dim word they enclose — a hierarchy
  // inversion on the one line this screen spends a semantic colour on. Each
  // is checked on its own: they sit on opposite sides of the coloured token,
  // so they are never one span.
  expect(isDim(spanContaining(frame, "("))).toBe(true)
  expect(isDim(spanContaining(frame, ")"))).toBe(true)
  // And the provenance itself is NOT dimmed — it is the one thing on this
  // line allowed to outrank the label.
  const provenance = spanExactly(frame, "generated")
  expect(isDim(provenance)).toBe(false)
  expect(colorEquals(provenance.fg, ABSTRACT_PROVENANCE_COLOR.generated)).toBe(true)
})

test("abstract provenance colours human and agent differently from generated, and from each other", async () => {
  // Three distinct sources, three distinct colours — the point of
  // `ABSTRACT_PROVENANCE_COLOR` carrying all three, not just the one
  // ("generated") the other test above already covers.
  const widths = { width: 70, height: 18 }
  const human = await createTestRenderer(widths)
  buildScreen(human.renderer).show(
    claim({ status: "approved", abstract: "A human wrote this one.", abstractBy: "human" }),
    1,
    1,
  )
  const humanFrame = await frameContaining(human.flush, human.captureCharFrame, "human")
  const humanSpan = spanExactly(human.captureSpans(), "human")
  expect(colorEquals(humanSpan.fg, ABSTRACT_PROVENANCE_COLOR.human)).toBe(true)

  const agent = await createTestRenderer(widths)
  buildScreen(agent.renderer).show(
    claim({ status: "approved", abstract: "The proposing agent wrote this one.", abstractBy: "agent" }),
    1,
    1,
  )
  await frameContaining(agent.flush, agent.captureCharFrame, "agent")
  const agentSpan = spanExactly(agent.captureSpans(), "agent")
  expect(colorEquals(agentSpan.fg, ABSTRACT_PROVENANCE_COLOR.agent)).toBe(true)

  expect(colorEquals(humanSpan.fg, ABSTRACT_PROVENANCE_COLOR.agent)).toBe(false)
  expect(colorEquals(agentSpan.fg, ABSTRACT_PROVENANCE_COLOR.human)).toBe(false)
})

/**
 * The two tests above are pure/rendering checks on `curateAnswerForKey` and
 * `buildScreen.show` in isolation. Neither drives a keystroke through the
 * handler `runScreenCurate` actually registers, so neither would catch a bug
 * in the wiring itself — e.g. a decision key resolving `pending` while a
 * field still has focus. This mirrors review's
 * "decision keys reach no store call while a field has focus" test: a real
 * keypress via `mockInput`, through the exact `renderer.keyInput` handler
 * `runScreenCurate` installs, watching what the store is actually told.
 *
 * An earlier version of this test asserted only `expect(puts).toEqual([])`
 * after the stray key and again after Escape. That assertion cannot tell
 * "the mode gate held, the key typed into the field, Escape found nothing
 * changed" apart from "the mode gate was bypassed, the key resolved as quit,
 * the loop broke before ever calling `store.put`" — both leave `puts` empty.
 * Two changes fix that: asserting the loop is still ALIVE after the stray
 * key (a premature quit ends it; a key absorbed by the field does not), and
 * driving a real edit through to a `store.put` whose content proves where
 * the keystroke actually landed.
 */
test("curate keys type into the focused abstract field instead of resolving mid-edit, and Escape then reaches the store with what was typed, through the real keypress handler", async () => {
  const { renderer, mockInput } = await createTestRenderer({ width: 70, height: 16 })
  const puts: Claim[] = []
  const c = claim({ status: "approved", abstract: "Generated abstract.", abstractBy: "generated" })
  const store = fakeStore({
    list: async () => [c],
    put: async (updated) => {
      puts.push(updated)
    },
  })
  const done = runScreenCurate({ store, ui: createUi(false), renderer })

  // Let `runCurate` read the approved/generated list and reach the first `ask`.
  await tick()
  mockInput.pressKey("w") // begin editing — focus starts on the abstract field
  await tick()

  // "q" is curate's quit key outside editing. With the mode gate holding, it
  // must land in the focused field instead of resolving `pending` as quit.
  mockInput.pressKey("q")
  await tick()

  // Proof the loop is still alive: a genuine quit would have let `runCurate`
  // return already, settling `done`. Raced against a real 50ms timeout — the
  // same wall-clock-poller spirit as `frameContaining` above, for the same
  // reason: this is about a promise settling on the event loop, not a frame
  // render, but "did it settle yet" is exactly as unsafe to assume from a
  // synchronous check as "did it render yet" is.
  const stillRunning = await Promise.race([
    done.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50)),
  ])
  expect(stillRunning).toBe(true)

  mockInput.pressEscape() // commit the edit
  await done

  // The stray "q" became part of the abstract, and the write reached the
  // store carrying it — proof the keystroke landed in the field the operator
  // was looking at, not nowhere and not as a decision.
  expect(puts).toHaveLength(1)
  expect(puts[0]!.abstract).toContain("q")
  expect(puts[0]!.abstract).not.toBe(c.abstract)
})

/**
 * Curate's half of the same defect. `w` opened the abstract editor and was
 * then typed into it, so `w` + Esc wrote `{ abstract: "wgen abstract",
 * abstractBy: "human" }` — a model's abstract stamped as a human's, which is
 * precisely the distinction `cairn curate` exists to make meaningful.
 */
test("the key that opens curate's editor is not typed into it — w then Esc leaves the abstract generated and unchanged", async () => {
  const { renderer, mockInput } = await createTestRenderer({ width: 70, height: 16 })
  const puts: Claim[] = []
  const c = claim({ status: "approved", abstract: "Generated abstract.", abstractBy: "generated" })
  const store = fakeStore({
    list: async () => [c],
    put: async (updated) => {
      puts.push(updated)
    },
  })
  const done = runScreenCurate({ store, ui: createUi(false), renderer })
  await tick()
  mockInput.pressKey("w") // open the abstract editor
  await tick()
  mockInput.pressEscape() // change of mind: nothing was typed
  const summary = await done

  expect(puts).toEqual([])
  expect(summary).toEqual({ written: 0, skipped: 1 })
})

/**
 * The screen curate actually paints, driven through `runScreenCurate` rather
 * than `buildScreen` — the defect was in what the command wires up.
 *
 * Two findings in one frame, because they were one screen: the footer used to
 * read `a approve  r reject  e edit  s skip  q quit  ↑↓ scroll  0% · o refs`,
 * of which `curateAnswerForKey` maps only `s` and `q` — `w` was absent and
 * four inert keys were advertised — and at 120 columns and up the references
 * pane mounted unconditionally, seeded with "resolving…" by `show` and never
 * resolved by anything, since `runScreenCurate` calls neither
 * `resolveOverlaps` nor `showReferences`.
 *
 * 130 columns on purpose: that is where review mounts the pane whether or not
 * the claim has references, so it is the width at which curate's own answer
 * has to be visible.
 */
test("curate paints its own footer and mounts no references pane", async () => {
  const { renderer, mockInput, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 20 })
  const store = fakeStore({
    list: async () => [
      claim({
        status: "approved",
        abstract: "Generated abstract.",
        abstractBy: "generated",
        overlaps: ["c2"],
        cites: [cite("doc-1")],
      }),
    ],
  })
  const done = runScreenCurate({ store, ui: createUi(false), renderer })
  const frame = await frameContaining(flush, captureCharFrame, "w write", 2000)
  expect(frame).toContain("s skip")
  expect(frame).toContain("q quit")
  // Keys curate does not map must not be offered.
  expect(frame).not.toContain("a approve")
  expect(frame).not.toContain("e edit")
  expect(frame).not.toContain("o refs")
  // And no pane claiming a lookup is in progress that nothing will finish.
  expect(frame).not.toContain("resolving")
  // Lowercase now — "overlaps" — since section labels moved to match the
  // pane-title vocabulary this change introduces; the property this guards
  // (curate mounts no references pane, so neither section label ever
  // appears) is unchanged.
  expect(frame).not.toContain("overlaps")
  // The pane itself must not appear either — curate mounts none, at any
  // width, so its title has nothing to attach to.
  expect(frame).not.toContain("references")
  mockInput.pressKey("q")
  await done
})

// --- resolveOverlaps / resolveCites -----------------------------------------

function doc(over: Partial<Document> = {}): Document {
  return {
    id: "doc-1", title: "Ingest topology", text: "Docling Serve by default.",
    source: "notes/ingest.md", created: "2026-09-01T00:00:00.000Z",
    updated: "2026-09-01T00:00:00.000Z", hash: "abc", ...over,
  } as Document
}

/**
 * Every method the screen has no business calling throws with its own name.
 * All fourteen are listed on purpose: the previous double named nine and the
 * `as unknown as Store` cast meant the five added with the document noun were
 * silently uncovered. Overrides come last so a test can open exactly one door.
 */
function storeWith(over: Partial<Store>): Store {
  const no = (n: string) => async () => { throw new Error(`the screen must not call Store.${n}`) }
  return {
    list: no("list"), get: no("get"), put: no("put"), move: no("move"),
    search: no("search"), propose: no("propose"), review: no("review"),
    importClaim: no("importClaim"), stats: no("stats"),
    listDocuments: no("listDocuments"), getDocument: no("getDocument"),
    searchDocuments: no("searchDocuments"), importDocument: no("importDocument"),
    adoptImport: no("adoptImport"),
    ...over,
  } as unknown as Store
}

test("overlapping claims are resolved to their sentences", async () => {
  const other = claim({ id: "c2", claim: "Team install is mineru[core].", status: "approved" })
  const store = storeWith({ get: async (id) => (id === "c2" ? other : null) })
  const result = await resolveOverlaps(store, claim({ overlaps: ["c2"] }))
  expect(result.found.map((c) => c.id)).toEqual(["c2"])
  expect(result.missing).toEqual([])
  expect(result.failed).toBeNull()
})

test("an id the store no longer has is reported, not dropped", async () => {
  const store = storeWith({ get: async () => null })
  const result = await resolveOverlaps(store, claim({ overlaps: ["gone"] }))
  expect(result.found).toEqual([])
  expect(result.missing).toEqual(["gone"])
})

test("a failed lookup degrades to a named reason rather than an empty pane", async () => {
  // No bare catch: a silent empty pane says "nothing to worry about", which is
  // the opposite of what a failed lookup means.
  const store = storeWith({ get: async () => { throw new Error("network is down") } })
  const result = await resolveOverlaps(store, claim({ overlaps: ["c2"] }))
  expect(result.failed).toContain("network is down")
  expect(result.found).toEqual([])
})

test("no overlaps means the store is never touched", async () => {
  const result = await resolveOverlaps(storeWith({}), claim({ overlaps: [] }))
  expect(result).toEqual({ found: [], missing: [], failed: null })
})

test("cited documents are resolved to their titles and text", async () => {
  // The question the product exists to answer is whether this list is ever
  // non-empty. When it is, the reviewer must see the document, not a count.
  //
  // The name promises "titles and text" — checking title alone would still
  // pass a resolveCites that dropped or truncated the body, so both are
  // asserted here rather than just the one the earlier draft checked.
  const store = storeWith({ getDocument: async (id) => (id === "doc-1" ? doc() : null) })
  const result = await resolveCites(store, claim({ cites: [cite("doc-1")] }))
  expect(result.found.map((d) => d.title)).toEqual(["Ingest topology"])
  expect(result.found.map((d) => d.text)).toEqual(["Docling Serve by default."])
  expect(result.missing).toEqual([])
  expect(result.failed).toBeNull()
})

test("cites resolves through getDocument, never through get", async () => {
  // `doc-` routing is the whole decision, the same way kbRead routes in
  // packages/mcp/src/tools.ts. A claim lookup that falls back to a document
  // lookup makes a stale claim id and a real document id fail identically.
  //
  // A routing bug here does not throw past resolveCites — resolveRefs's own
  // catch turns a wrongly-called Store.get into a *degraded* result, not an
  // exception. Asserting on `found` alone would fail on that bug (length 0
  // vs 1) but never show why; the `failed` assertion is what actually pins
  // the reason to `the screen must not call Store.get` in the failure text.
  const store = storeWith({ getDocument: async () => doc() })
  const result = await resolveCites(store, claim({ cites: [cite("doc-1")] }))
  expect(result.failed).toBeNull()
  expect(result.found).toHaveLength(1)
})

test("a cited document that has been removed is named, not dropped", async () => {
  const store = storeWith({ getDocument: async () => null })
  const result = await resolveCites(store, claim({ cites: [cite("doc-gone")] }))
  expect(result.found).toEqual([])
  expect(result.missing).toEqual(["doc-gone"])
})

test("no cites means the store is never touched", async () => {
  const result = await resolveCites(storeWith({}), claim({ cites: [] }))
  expect(result).toEqual({ found: [], missing: [], failed: null })
})

// --- the references pane: showReferences / toggleReferenceFocus / the footer hint

test("decisionForKey maps 'o' to the reference toggle", () => {
  // Pure and cheap, but real: this is the only mapping between the key a
  // reviewer presses and the action that opens the pane a citation has to be
  // judged from.
  expect(decisionForKey("o")).toBe("toggle-refs")
})

test("the footer offers to toggle refs when the claim has an overlap or a citation", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)
  const frame = await frameContaining(flush, captureCharFrame, "approve")
  expect(frame).toContain("o refs")
})

test("the footer omits the refs hint when the claim has neither — a key that does nothing is worse than an absent one", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim(), 1, 1) // default: overlaps: [], cites: []
  const frame = await frameContaining(flush, captureCharFrame, "approve")
  expect(frame).not.toContain("o refs")
})

test("showReferences renders a found overlap as its sentence and status, and a found citation as its title and opening text", async () => {
  // Wide enough (>=120) that the references pane sits beside the claim rather
  // than replacing it, so both can be asserted on from one frame.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"], cites: [cite("doc-1")] }), 1, 1)
  const other = claim({ id: "c2", claim: "Team install is mineru[core].", status: "approved" })
  const cited = doc({ title: "Ingest topology", text: "Docling Serve by default.\n\nMore detail below." })
  screen.showReferences({ found: [other], missing: [], failed: null }, { found: [cited], missing: [], failed: null }, [cite("doc-1")])
  const frame = await frameContaining(flush, captureCharFrame, "Ingest topology")
  // The overlap: the sentence being judged, and the status it's judged against.
  expect(frame).toContain("Team install is mineru[core].")
  expect(frame).toContain("approved")
  // The citation: title and opening text, not the count `cites 1 document(s)`
  // this change exists to replace.
  expect(frame).toContain("Ingest topology")
  expect(frame).toContain("Docling Serve by default.")
  // The second paragraph is deliberately NOT shown — a reading pane, not the
  // whole document.
  expect(frame).not.toContain("More detail below.")
})

test("the references pane's section labels read as labels — dim, not content masquerading as a heading", async () => {
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"], cites: [cite("doc-1")] }), 1, 1)
  const other = claim({ id: "c2", claim: "Team install is mineru[core].", status: "approved" })
  const cited = doc()
  screen.showReferences({ found: [other], missing: [], failed: null }, { found: [cited], missing: [], failed: null }, [cite("doc-1")])
  await frameContaining(flush, captureCharFrame, "Ingest topology")
  const frame = captureSpans()
  expect(isDim(spanExactly(frame, "overlaps"))).toBe(true)
  expect(isDim(spanExactly(frame, "cites"))).toBe(true)
  // And the entry beneath a label carries no such dimming — only the LABEL
  // is a label.
  expect(isDim(spanContaining(frame, "Team install is mineru[core]"))).toBe(false)
})

test("an overlap's status is its own coloured token, approved and pending reading differently", async () => {
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2", "c3"] }), 1, 1)
  const approvedOne = claim({ id: "c2", claim: "Approved overlap sentence.", status: "approved" })
  const pendingOne = claim({ id: "c3", claim: "Pending overlap sentence.", status: "pending" })
  screen.showReferences(
    { found: [approvedOne, pendingOne], missing: [], failed: null },
    { found: [], missing: [], failed: null },
    [],
  )
  await frameContaining(flush, captureCharFrame, "Pending overlap sentence.")
  const frame = captureSpans()
  // Deciding between a pending claim and an approved one it contradicts is
  // the judgement the review gate exists to make — so the two must read
  // differently, not just be two instances of the same grey "approved"/
  // "pending" word the operator has to read carefully to tell apart.
  const approvedSpan = spanExactly(frame, "approved")
  const pendingSpan = spanExactly(frame, "pending")
  expect(colorEquals(approvedSpan.fg, OVERLAP_STATUS_COLOR.approved)).toBe(true)
  expect(colorEquals(pendingSpan.fg, OVERLAP_STATUS_COLOR.pending)).toBe(true)
  expect(colorEquals(approvedSpan.fg, OVERLAP_STATUS_COLOR.pending)).toBe(false)
})

test("an overlap's status sits on its own line, not a clause trailing the wrapped sentence", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)
  const other = claim({ id: "c2", claim: "Short overlap sentence.", status: "approved" })
  screen.showReferences({ found: [other], missing: [], failed: null }, { found: [], missing: [], failed: null }, [])
  const frame = await frameContaining(flush, captureCharFrame, "Short overlap sentence.")
  // Not glued onto the sentence with an em dash any more.
  expect(frame).not.toContain("Short overlap sentence. — approved")
  expect(frame).not.toContain("sentence. — approved")
  // The sentence and the status both still appear, on separate rows — sliced
  // to the pane's own inner 42 columns first, the way "a long overlap
  // sentence wraps..." below does (borders peeled off with it): an unsliced
  // row also carries the claim pane's content on its left AND the pane's own
  // left border character, so trimming the whole row leaves that border
  // character in front of "approved" instead of whitespace.
  const inner = frame
    .split("\n")
    .filter((r) => r.length >= 130)
    .map((r) => r.slice(130 - 44).slice(1, 43))
  const sentenceRow = inner.findIndex((r) => r.includes("Short overlap sentence."))
  const statusRow = inner.findIndex((r) => r.trim().startsWith("approved"))
  expect(sentenceRow).toBeGreaterThanOrEqual(0)
  expect(statusRow).toBeGreaterThan(sentenceRow)
})

test("a long overlap sentence wraps inside the pane, indented under its entry", async () => {
  // The normal case for a real overlap: a whole sentence in a 44-column pane.
  // Left to the renderable it wrapped to a row starting at the pane's column
  // 0 — hard against the border, and indistinguishable from the first line of
  // a new entry.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)
  const long = claim({
    id: "c2",
    status: "approved",
    claim: "The team installs mineru[core] rather than the pipeline extra on every ingest worker.",
  })
  screen.showReferences({ found: [long], missing: [], failed: null }, { found: [], missing: [], failed: null }, [])
  const frame = await frameContaining(flush, captureCharFrame, "The team installs", 2000)

  // The pane is the rightmost 44 columns at this width.
  const rows = frame.split("\n").filter((r) => r.length >= 130).map((r) => r.slice(130 - 44))
  const top = rows.findIndex((r) => r.startsWith("┌"))
  const bottom = rows.findIndex((r) => r.startsWith("└"))
  expect(top).toBeGreaterThanOrEqual(0)
  expect(bottom).toBeGreaterThan(top + 1)

  const inner: string[] = []
  for (const row of rows.slice(top + 1, bottom)) {
    // Both borders survive: nothing was painted over them.
    expect(row[0]).toBe("│")
    expect(row[43]).toBe("│")
    inner.push(row.slice(1, 43))
  }
  for (const row of inner) {
    // Section labels are lowercase now — "overlaps"/"cites" — matching the
    // pane-title vocabulary this change introduces ("body", "abstract",
    // "references"); still excluded from the indent check below since a
    // label is not an entry.
    if (row.trim() === "" || row.startsWith("overlaps") || row.startsWith("cites")) continue
    // Everything else belongs to an entry, so it is indented under one. A row
    // that starts at column 0 is a wrap that has escaped its entry.
    expect(row.startsWith("  ")).toBe(true)
  }
  // The sentence is all there, across however many rows it took...
  const joined = inner.map((r) => r.trim()).filter((r) => r !== "").join(" ")
  expect(joined).toContain("on every ingest worker.")
  // ...and the status is no longer a clause trailing it — it reads as its
  // own token now (asserted properly, with colour, in the styling test
  // below), so it must not be glued onto the sentence with an em dash the
  // way it was before this change.
  expect(joined).not.toContain("worker. — approved")
})

test("each entry opens with a marker, anchoring where it starts", async () => {
  // The readability defect this exists to close: with no marker, an entry's
  // first line looked exactly like a continuation of the one above it.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"], cites: [cite("doc-1")] }), 1, 1)
  const other = claim({ id: "c2", claim: "Marked overlap sentence.", status: "approved" })
  const cited = doc({ title: "Marked citation title", text: "A distinct opening line." })
  screen.showReferences({ found: [other], missing: [], failed: null }, { found: [cited], missing: [], failed: null }, [cite("doc-1")])
  const frame = await frameContaining(flush, captureCharFrame, "Marked citation title")
  expect(frame).toContain("· Marked overlap sentence.")
  expect(frame).toContain("· Marked citation title")
})

test("two overlaps are separated by a blank row, not run together", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2", "c3"] }), 1, 1)
  const first = claim({ id: "c2", claim: "First overlap sentence.", status: "approved" })
  const second = claim({ id: "c3", claim: "Second overlap sentence.", status: "pending" })
  screen.showReferences(
    { found: [first, second], missing: [], failed: null },
    { found: [], missing: [], failed: null },
    [],
  )
  const frame = await frameContaining(flush, captureCharFrame, "Second overlap sentence.")
  // Sliced to the pane's own inner 42 columns, same as the wrap test above —
  // an unsliced row also carries the claim pane's own content on its left.
  const inner = frame.split("\n").filter((r) => r.length >= 130).map((r) => r.slice(130 - 44).slice(1, 43))
  const firstStatusRow = inner.findIndex((r) => r.trim().startsWith("approved"))
  const secondEntryRow = inner.findIndex((r) => r.includes("Second overlap sentence."))
  expect(firstStatusRow).toBeGreaterThanOrEqual(0)
  expect(secondEntryRow).toBeGreaterThan(firstStatusRow)
  // Exactly one blank row between the first entry's status and the second
  // entry's opening line — not zero (run together) and not several.
  const between = inner.slice(firstStatusRow + 1, secondEntryRow)
  expect(between.length).toBe(1)
  expect(between.every((r) => r.trim() === "")).toBe(true)
})

test("a citation's first paragraph is skipped when it only repeats the title as a heading", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ cites: [cite("doc-1")] }), 1, 1)
  const cited = doc({
    id: "doc-mineru-cli",
    title: "Using MinerU",
    // A real imported file's shape: the H1 IS its own first paragraph
    // (nothing but a blank line before the next one), so the pane's
    // "first paragraph" field is exactly this heading, word for word.
    text: "# Using MinerU\n\nCommand line tools usage instructions.",
  })
  screen.showReferences({ found: [], missing: [], failed: null }, { found: [cited], missing: [], failed: null }, [cite("doc-1")])
  const frame = await frameContaining(flush, captureCharFrame, "doc-mineru-cli")
  // The title appears once, not once as the title and again as a "# "-prefixed
  // duplicate first paragraph — the defect this test guards against. The entry goes
  // straight from title to id; the second paragraph was never shown even
  // before this fix (a reading pane, not the whole document — see the
  // "second paragraph is deliberately NOT shown" test above), so it must
  // stay absent here too.
  expect(frame).toContain("Using MinerU")
  expect(frame).not.toContain("# Using MinerU")
  expect(frame).not.toContain("Command line tools usage instructions.")
  expect(frame.split("Using MinerU").length - 1).toBe(1)
})

test("a citation's first paragraph is shown, '#' stripped, when it is a heading but not the title", async () => {
  // The dedupe in the test above must not eat a real opening line just
  // because it happens to be written as a heading.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ cites: [cite("doc-1")] }), 1, 1)
  const cited = doc({ title: "Using MinerU", text: "## Prerequisites\n\nSomething else entirely." })
  screen.showReferences({ found: [], missing: [], failed: null }, { found: [cited], missing: [], failed: null }, [cite("doc-1")])
  const frame = await frameContaining(flush, captureCharFrame, "Prerequisites")
  expect(frame).toContain("Prerequisites")
  expect(frame).not.toContain("## Prerequisites")
})

test("a citation's id renders in full — the store has no prefix lookup to shorten it against", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ cites: [cite("doc-1")] }), 1, 1)
  const longId = "doc-2026-09-01-a-fairly-long-slug-for-wrapping-abc123"
  const cited = doc({ id: longId, title: "Long id document", text: "Distinct opening line." })
  screen.showReferences({ found: [], missing: [], failed: null }, { found: [cited], missing: [], failed: null }, [cite("doc-1")])
  const frame = await frameContaining(flush, captureCharFrame, "Distinct opening line.")
  const inner = frame
    .split("\n")
    .filter((r) => r.length >= 130)
    .map((r) => r.slice(130 - 44).slice(1, 43))
    .filter((r) => r.trim() !== "" && !r.startsWith("overlaps") && !r.startsWith("cites"))
    .map((r) => r.trim())
  // No ellipsis or other truncation mark, and the id's own characters
  // reconstruct exactly when its wrapped lines are joined back together.
  expect(frame).not.toContain("…")
  expect(inner.join("")).toContain(longId)
})

test("a missing id is named in the pane, not dropped", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c-gone"] }), 1, 1)
  screen.showReferences({ found: [], missing: ["c-gone"], failed: null }, { found: [], missing: [], failed: null }, [])
  const frame = await frameContaining(flush, captureCharFrame, "c-gone")
  expect(frame).toContain("c-gone — no longer in this space")
})

test("a failed lookup names its reason in the pane rather than leaving it empty", async () => {
  // The 44-column pane word-wraps a reason this long — "network is" lands on
  // one row and "down" on the next, confirmed by inspecting the captured
  // frame directly. Asserting the exact unwrapped substring would be a false
  // negative on a passing screen, so the prefix and the reason are checked as
  // separate fragments instead, matching how a person reading the pane would
  // still see both.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)
  screen.showReferences({ found: [], missing: [], failed: "network is down" }, { found: [], missing: [], failed: null }, [])
  const frame = await frameContaining(flush, captureCharFrame, "could not check overlaps")
  expect(frame).toContain("could not check overlaps:")
  expect(frame).toContain("network is")
  expect(frame).toContain("down")
})

test("found, missing, and failed overlaps all open with the same entry marker", async () => {
  // The marker convention this change establishes must be uniform across the
  // three states a lookup can produce — a found entry, a missing id, and a
  // failed lookup — not applied to two of three and skipped on the third,
  // which would read as an oversight later rather than a deliberate choice.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)

  screen.showReferences({ found: [claim({ id: "c2", claim: "Found overlap sentence.", status: "approved" })], missing: [], failed: null }, { found: [], missing: [], failed: null }, [])
  const foundFrame = await frameContaining(flush, captureCharFrame, "Found overlap sentence.")
  expect(foundFrame).toContain("· Found overlap sentence.")

  screen.showReferences({ found: [], missing: ["c-missing"], failed: null }, { found: [], missing: [], failed: null }, [])
  const missingFrame = await frameContaining(flush, captureCharFrame, "c-missing")
  expect(missingFrame).toContain("· c-missing — no longer in this space")

  screen.showReferences({ found: [], missing: [], failed: "network is down" }, { found: [], missing: [], failed: null }, [])
  const failedFrame = await frameContaining(flush, captureCharFrame, "could not check overlaps")
  // Wraps across two rows at this width, same as the dedicated failed-lookup
  // test above — check the marker and both fragments rather than one
  // unwrapped substring.
  expect(failedFrame).toContain("· could not check overlaps: network is")
  expect(failedFrame).toContain("down")

  // Three renders, three different messages — an empty pane, or one state's
  // text bleeding into another's, must never be able to read as "broke".
  expect(missingFrame).not.toContain("Found overlap sentence.")
  expect(failedFrame).not.toContain("c-missing")
})

test("toggleReferenceFocus swaps the single pane below 120 columns", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  const c = claim({ overlaps: ["c2"] })
  screen.show(c, 1, 1)
  const other = claim({ id: "c2", claim: "Overlap sentence for the toggle test.", status: "approved" })
  screen.showReferences({ found: [other], missing: [], failed: null }, { found: [], missing: [], failed: null }, [])
  // Before toggling: the claim's own body, not the references.
  const before = await frameContaining(flush, captureCharFrame, "Heading")
  expect(before).not.toContain("Overlap sentence for the toggle test.")
  screen.toggleReferenceFocus()
  // After: the references pane, and the claim body has been swapped OUT —
  // a single pane below 120 columns, not both squeezed together.
  const after = await frameContaining(flush, captureCharFrame, "Overlap sentence for the toggle test.")
  expect(after).not.toContain("Heading")
  screen.toggleReferenceFocus()
  const backAgain = await frameContaining(flush, captureCharFrame, "Heading")
  expect(backAgain).not.toContain("Overlap sentence for the toggle test.")
})

/**
 * The scroll percentage the body pane carries as its `bottomTitle`, read off
 * the body pane's own bottom border row (`bottomBorderRow` above). Throws
 * rather than returning a default: a screen
 * with no percentage at all would otherwise make "the percentage did not
 * move" pass vacuously, which is exactly the shape of the bug below.
 */
function scrollPercent(frame: string): number {
  const match = bottomBorderRow(frame).match(/(\d+)%/)
  if (!match) throw new Error(`no scroll percentage on the bottom border row of:\n${frame}`)
  return Number(match[1])
}

/** A body far longer than any viewport in this file, one plain line each —
 *  markdown's blank-line paragraph spacing makes a row-based scroll delta
 *  land somewhere other than the line number it looks like, see the
 *  "claim sentence stays visible" test above. */
const longBody = () => claim({ body: Array.from({ length: 40 }, (_, i) => `line ${i} of the body`).join("\n") })

/**
 * `↑↓ scroll` is on BOTH legends, and until this test nothing in the suite
 * ever pressed an arrow key — `pressArrow` appeared zero times, and every
 * scroll test called `screen.scroll(n)` directly, straight past the binding.
 * So curate advertised the keys against a `curateAnswerForKey` that mapped
 * only `w`/`s`/`q` and a handler that returned on `null`: ten arrow presses
 * left the pane at line 0 and 0%, on the one screen whose entire job is
 * judging a generated abstract against a body the viewport cannot hold.
 * Review's binding was real but equally untested.
 *
 * Driven through `renderer.keyInput` via `mockInput`, the exact path a
 * terminal takes — and asserted on BOTH the content and the pane's own
 * percentage, because either one alone would still pass on a screen that
 * moved the other.
 */
test("review's arrow keys scroll the body, through the real keypress handler", async () => {
  const { renderer, mockInput, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const store = fakeStore({ list: async () => [longBody()] })
  const done = runScreenReview({ store, ui: createUi(false), renderer })
  const top = scrollPercent(await frameContaining(flush, captureCharFrame, "line 0 of the body", 2000))

  for (let i = 0; i < 10; i++) mockInput.pressArrow("down")
  const after = await frameContaining(flush, captureCharFrame, "line 10 of the body", 2000)
  expect(after).not.toContain("line 0 of the body")
  const scrolled = scrollPercent(after)
  expect(scrolled).toBeGreaterThan(top)

  // And back up again — a binding that only ever moved one way would still
  // satisfy everything above. Compared against the scrolled-down reading
  // rather than the opening one: `scroll.scrollHeight` catches up with the
  // content a layout pass after `show`, so the pane's first "0%" is the
  // pre-existing lag the bottomTitle test above documents, not the figure
  // this one should be measured against.
  for (let i = 0; i < 10; i++) mockInput.pressArrow("up")
  const back = await frameContaining(flush, captureCharFrame, "line 0 of the body", 2000)
  expect(scrollPercent(back)).toBeLessThan(scrolled)

  mockInput.pressKey("q")
  await done
})

test("curate's arrow keys scroll the body it is judging the abstract against, through the real keypress handler", async () => {
  const { renderer, mockInput, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const c = claim({
    ...longBody(),
    status: "approved",
    abstract: "Generated abstract.",
    abstractBy: "generated",
  })
  const store = fakeStore({ list: async () => [c] })
  const done = runScreenCurate({ store, ui: createUi(false), renderer })
  const top = scrollPercent(await frameContaining(flush, captureCharFrame, "line 0 of the body", 2000))

  for (let i = 0; i < 10; i++) mockInput.pressArrow("down")
  const after = await frameContaining(flush, captureCharFrame, "line 10 of the body", 2000)
  // The whole failure this closes: the curator stamps `abstractBy: "human"`
  // on an abstract summarising a body they could only ever read the top of.
  expect(after).not.toContain("line 0 of the body")
  const scrolled = scrollPercent(after)
  expect(scrolled).toBeGreaterThan(top)

  for (let i = 0; i < 10; i++) mockInput.pressArrow("up")
  const back = await frameContaining(flush, captureCharFrame, "line 0 of the body", 2000)
  expect(scrollPercent(back)).toBeLessThan(scrolled)

  mockInput.pressKey("q")
  await done
})

/** The line number of the first body line still on screen — the top of the
 *  viewport. Throws rather than defaulting: a frame with no body line at all
 *  would make "the page moved" pass on a blank pane. */
function topBodyLine(frame: string): number {
  const match = frame.match(/line (\d+) of the body/)
  if (!match) throw new Error(`no body line on screen in:\n${frame}`)
  return Number(match[1])
}

/** How many rows the body pane can show: the rows between its own top border
 *  (the one carrying its title) and the next closing corner beneath it. Read
 *  off the frame rather than derived from the terminal height, so a header
 *  that grows or shrinks cannot silently turn "a page" into a wrong constant
 *  — which is exactly what the claim box's two extra rows did to the line
 *  number this test used to name. */
function bodyViewportRows(frame: string): number {
  const rows = frame.split("\n")
  const top = rows.findIndex((r) => r.includes("─body─"))
  const bottom = rows.findIndex((r, i) => i > top && r.includes("┘"))
  if (top === -1 || bottom === -1) throw new Error(`no body pane in:\n${frame}`)
  return bottom - top - 1
}

test("the page keys move a screenful on both commands, and neither legend advertises them", async () => {
  // Review has bound PgUp/PgDn since the first version of the handler and
  // curate now mirrors it — unadvertised on purpose, so this checks the
  // binding AND the silence: a key the legend does not name may exist, but a
  // key the legend names must work (which is `↑↓`'s test above).
  const pageDown = "\u001b[6~"
  for (const kind of ["review", "curate"] as const) {
    const { renderer, mockInput, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
    const c =
      kind === "review"
        ? longBody()
        : claim({ ...longBody(), status: "approved", abstract: "Generated abstract.", abstractBy: "generated" })
    const store = fakeStore({ list: async () => [c] })
    const done =
      kind === "review"
        ? runScreenReview({ store, ui: createUi(false), renderer })
        : runScreenCurate({ store, ui: createUi(false), renderer })
    const top = scrollPercent(await frameContaining(flush, captureCharFrame, "line 0 of the body", 2000))
    mockInput.pressKey(pageDown)
    // A page is the viewport's own height, so one press must clear a whole
    // screenful rather than the single row an arrow clears. Asserted against
    // the viewport this frame actually has: starting at the top, the first
    // body line still visible after one page down IS the number of rows the
    // pane can show.
    const after = await frameContaining(flush, captureCharFrame, "line 11 of the body", 2000)
    expect(scrollPercent(after)).toBeGreaterThan(top)
    expect(topBodyLine(after)).toBe(bodyViewportRows(after))
    // And that is more than one row, so it is genuinely a page and not an
    // arrow press wearing a different key name.
    expect(bodyViewportRows(after)).toBeGreaterThan(1)
    const legend = footerLegend(120, "browsing", kind)
    expect(legend).not.toContain("PgUp")
    expect(legend).not.toContain("pgdn")
    mockInput.pressKey("q")
    await done
  }
})

// --- legible titles, and the editing border --------------------------------
//
// `BoxRenderable.renderSelf` colours a title `titleColor ?? currentBorderColor`
// — so every title added here inherited the idle border's `#3a3a3a`,
// about 1.85:1 on black. The tests that came with those titles all checked the
// text was in the character frame; none checked anyone could read it. These
// check the colour.

/**
 * The BODY pane's own border row: the outermost box in the middle row, so its
 * corner sits at column 0 while every field box inside it is indented by the
 * border plus the content padding.
 *
 * NOT "the first row beginning with the corner glyph", which is what this was
 * and which silently stopped meaning the body pane the moment the claim
 * sentence got a bordered box of its own in the header. That box is the first
 * column-0 box in browsing, it is not focusable and nothing ever repaints it —
 * so a locator that found it reported `BORDER_COLOR.idle` no matter what the
 * body pane was doing, and every border assertion built on it passed against
 * the exact bug it was written to catch. Confirmed by execution: with the
 * amber fix reverted, the click test still passed.
 *
 * The claim box is skipped by its title. While EDITING it is unmounted and the
 * pane's own title is cleared, so the pane is then the only column-0 box there
 * is — which is why the title is used to exclude rather than to select.
 *
 * The bottom border is paired to the top one — the first column-0 `└` BELOW
 * the pane's own top row — rather than located independently, so the two can
 * never end up describing different boxes.
 */
function outerBorderRow(frame: Frame, corner: "┌" | "└"): Span {
  const startsWith = (line: Frame["lines"][number], glyph: string) => (line.spans[0]?.text ?? "").startsWith(glyph)
  const joined = (line: Frame["lines"][number]) => line.spans.map((sp) => sp.text).join("")
  const top = frame.lines.findIndex((l) => startsWith(l, "┌") && !joined(l).includes("─claim─"))
  if (top === -1) throw new Error("no body pane top border: no `┌` at column 0 that is not the claim box")
  if (corner === "┌") return frame.lines[top]!.spans[0]!
  const bottom = frame.lines.findIndex((l, i) => i > top && startsWith(l, "└"))
  if (bottom === -1) throw new Error("no body pane bottom border: no `└` at column 0 below its top border")
  return frame.lines[bottom]!.spans[0]!
}

test("the panes are named in a colour that can be read, not the idle border's near-black", async () => {
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 130, height: 20 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)
  await frameContaining(flush, captureCharFrame, "Heading")
  const spans = captureSpans()
  for (const title of ["body", "references"]) {
    // `spanContaining`, not `spanExactly`: a title left to inherit the border
    // colour renders as ONE run with the border and no span's text is the
    // bare word — which would fail with "no span has exactly …" and name the
    // span helper rather than the colour. This way the failure names the
    // colour that is actually wrong.
    const span = spanContaining(lineContaining(spans, title), title)
    expect(colorEquals(span.fg, TEXT_COLOR.dim)).toBe(true)
    // Stated as its own assertion, not implied: `#3a3a3a` is what the
    // fallback produced, and it is the failure being closed.
    expect(colorEquals(span.fg, BORDER_COLOR.idle)).toBe(false)
  }
  // The scroll percentage rides the same `titleColor` as the pane title
  // (`renderSelf` passes one value for both), so its move from the
  // footer onto `bottomTitle` took it from the footer's `#8a8a8a` down to
  // `#3a3a3a` — a regression in the one affordance that change existed to
  // improve. It is back at the contrast it had.
  const percent = spanContaining(lineContaining(spans, "0%"), "0%")
  expect(colorEquals(percent.fg, TEXT_COLOR.dim)).toBe(true)
  expect(colorEquals(percent.fg, BORDER_COLOR.idle)).toBe(false)
})

test("an unfocused field is still named legibly, and the focused one keeps its bright title", async () => {
  const { renderer, mockInput, flush, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 70,
    height: 20,
  })
  const screen = buildScreen(renderer)
  screen.beginEdit(claim())
  await frameContaining(flush, captureCharFrame, "abstract", 2000)
  const spans = captureSpans()

  // "named even when empty" was the stated goal and it held for
  // exactly one field: the one already being typed in. The other two were
  // named in the idle border's colour.
  for (const title of ["body", "abstract"]) {
    const span = spanContaining(lineContaining(spans, title), title)
    expect(colorEquals(span.fg, TEXT_COLOR.dim)).toBe(true)
    expect(colorEquals(span.fg, BORDER_COLOR.idle)).toBe(false)
  }
  // The focused field keeps the bright title — that distinction is doing
  // real work, and dimming everything would have thrown it away. Its title
  // shares the lit border's colour, so it renders as one run with it rather
  // than as a span of its own.
  const focusedTitle = spanContaining(lineContaining(spans, "claim"), "claim")
  expect(colorEquals(focusedTitle.fg, BORDER_COLOR.focused)).toBe(true)

  // And it MOVES with focus: Tab makes body's title the bright one and
  // hands claim's back to dim. A titleColor pinned at build time would pass
  // everything above and fail here.
  mockInput.pressTab()
  await tick()
  const afterTab = captureSpans()
  expect(colorEquals(spanContaining(lineContaining(afterTab, "body"), "body").fg, BORDER_COLOR.focused)).toBe(true)
  expect(colorEquals(spanContaining(lineContaining(afterTab, "claim"), "claim").fg, TEXT_COLOR.dim)).toBe(true)
})

test("the pane's border takes the palette's amber while editing, never opentui's default blue", async () => {
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 70, height: 20 })
  const screen = buildScreen(renderer)
  const c = claim()
  screen.show(c, 1, 1)
  await frameContaining(flush, captureCharFrame, "Heading")
  // Browsing: the pane rests at idle, and is NOT already amber — otherwise
  // the assertion below would prove nothing about the mode change.
  const browsing = outerBorderRow(captureSpans(), "┌")
  expect(colorEquals(browsing.fg, BORDER_COLOR.idle)).toBe(true)
  expect(colorEquals(browsing.fg, BORDER_COLOR.editing)).toBe(false)

  screen.beginEdit(c)
  await frameContaining(flush, captureCharFrame, "# Heading", 2000)
  const editing = captureSpans()
  // `ScrollBoxRenderable` is focusable, so a focused textarea inside it made
  // `renderSelf` reach for `_focusedBorderColor` — never set, so it fell
  // back to the library's `#00AAFF`. `BORDER_COLOR.editing` had never once
  // been rendered, and the loudest colour on a screen whose rule is "colour
  // only where it changes meaning" belonged to no palette at all.
  for (const corner of ["┌", "└"] as const) {
    const border = outerBorderRow(editing, corner)
    expect(colorEquals(border.fg, BORDER_COLOR.editing)).toBe(true)
    expect(colorEquals(border.fg, "#00aaff")).toBe(false)
  }

  screen.endEdit()
  await frameContaining(flush, captureCharFrame, "Heading")
  expect(colorEquals(outerBorderRow(captureSpans(), "┌").fg, BORDER_COLOR.idle)).toBe(true)
})

// --- the click that made the editing amber permanent ----------------------
//
// The bug the tests above could not see. `createCliRenderer` enables mouse
// input; on a left mousedown it walks from the clicked renderable up its
// ancestors and focuses the first FOCUSABLE one. `ScrollBoxRenderable` sets
// `_focusable = true`, so ONE click in the body focused the body pane for the
// rest of the session — and `BoxRenderable.renderSelf` then rendered
// `focusedBorderColor`, which was the editing amber. Browsing wore the editing
// colour permanently, which is the same as the colour meaning nothing.
//
// Every test above drives the screen by keyboard alone, so every one of them
// passed against the broken build. The trigger is a CLICK, and
// `createTestRenderer` hands one over: `mockMouse`.

/** The row of `frame` whose text contains `needle`, as a y coordinate for
 *  `mockMouse` — clicking a hard-coded row would silently start hitting the
 *  wrong pane the moment the header grows a line. Throws rather than
 *  defaulting: a click delivered to row 0 would prove nothing and pass. */
function rowContaining(frame: string, needle: string): number {
  const y = frame.split("\n").findIndex((row) => row.includes(needle))
  if (y === -1) throw new Error(`no row contains ${JSON.stringify(needle)} in:\n${frame}`)
  return y
}

test("clicking the body pane leaves the browsing border idle — the amber never means anything but editing", async () => {
  const { renderer, mockMouse, flush, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 70,
    height: 20,
  })
  const screen = buildScreen(renderer)
  screen.show(claim(), 1, 1)
  const frame = await frameContaining(flush, captureCharFrame, "Heading")
  // Idle before the click, so the assertion after it is about the click and
  // not about a pane that was already grey for some other reason.
  expect(colorEquals(outerBorderRow(captureSpans(), "┌").fg, BORDER_COLOR.idle)).toBe(true)

  await mockMouse.click(10, rowContaining(frame, "Heading"))
  await flush()

  // The whole bug, in one assertion: browsing, after a click, still idle.
  const after = outerBorderRow(captureSpans(), "┌")
  expect(colorEquals(after.fg, BORDER_COLOR.idle)).toBe(true)
  // Named explicitly rather than left implied by the line above — amber is
  // what it actually turned, and it is what must never appear in browsing.
  expect(colorEquals(after.fg, BORDER_COLOR.editing)).toBe(false)
  // And not the library default either: the cyan that the `focusedBorderColor`
  // this fix removed was originally added to displace.
  expect(colorEquals(after.fg, "#00aaff")).toBe(false)
})

test("a click while editing does not repaint the pane out of its amber", async () => {
  // The other direction of the same fix. The pane's border is now driven only
  // by `beginEdit`/`endEdit`'s assignments, so a click must not be able to
  // move it — neither back to idle nor on to a focus colour that belongs to
  // the FIELDS.
  const { renderer, mockMouse, flush, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 70,
    height: 22,
  })
  const screen = buildScreen(renderer)
  const c = claim()
  screen.beginEdit(c)
  const frame = await frameContaining(flush, captureCharFrame, "# Heading", 2000)
  await mockMouse.click(10, rowContaining(frame, "# Heading"))
  await flush()
  const border = outerBorderRow(captureSpans(), "┌")
  expect(colorEquals(border.fg, BORDER_COLOR.editing)).toBe(true)
  expect(colorEquals(border.fg, BORDER_COLOR.focused)).toBe(false)
})

test("the wheel still scrolls the body and a drag still selects it, with the pane no longer focusable", async () => {
  // The cost of the fix, asserted rather than assumed. `focusable` drives
  // exactly one thing in opentui — which renderable receives keystrokes — and
  // neither of these goes through it: wheel scrolling is
  // `ScrollBoxRenderable.onMouseEvent`'s `type === "scroll"` branch, and drag
  // selection is gated on the separate `selectable` flag. If either broke,
  // making the pane non-focusable would be the wrong fix.
  const long = claim({
    body: "# Heading\n\n" + Array.from({ length: 60 }, (_, i) => `line ${i} of the body prose.`).join("\n\n"),
  })
  const { renderer, mockMouse, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 20 })
  const screen = buildScreen(renderer)
  screen.show(long, 1, 1)
  const before = await frameContaining(flush, captureCharFrame, "line 0 of")
  const y = rowContaining(before, "line 0 of")

  for (let i = 0; i < 10; i++) await mockMouse.scroll(10, y, "down")
  await flush()
  const after = captureCharFrame()
  // Scrolled: the first line of the body has left the viewport.
  expect(after.includes("line 0 of")).toBe(false)
  // Keyboard scrolling shares no code with this, so assert the wheel moved
  // the SAME pane the footer's ↑↓ moves rather than merely changing pixels.
  expect(after).toContain("line ")

  await mockMouse.drag(3, y, 30, y + 2)
  await flush()
  const selection = (renderer as unknown as { getSelection?: () => { getSelectedText?: () => string } | null }).getSelection?.()
  expect(selection?.getSelectedText?.() ?? "").toContain("line ")
})

test("clicking a field's box border puts focus in that field, not on the box", async () => {
  // The same defect wearing a different hat, found by sweeping for it: the
  // field boxes are focusable too, and a click on a box's own border row
  // focused the BOX. Its border lit with `focusedBorderColor` while its title
  // stayed dim and NO field held keyboard focus — editing mode, a box that
  // looks selected, and typing that goes nowhere.
  const { renderer, mockMouse, flush, captureCharFrame, captureSpans } = await createTestRenderer({
    width: 70,
    height: 22,
  })
  const screen = buildScreen(renderer)
  screen.beginEdit(claim())
  const frame = await frameContaining(flush, captureCharFrame, "# Heading", 2000)

  await mockMouse.click(10, rowContaining(frame, "─body─"))
  await flush()
  const spans = captureSpans()
  // Focus landed in the body FIELD: its box is lit AND its title is bright,
  // the pair that only ever happens when the textarea itself has focus.
  const title = spanContaining(lineContaining(spans, "─body─"), "body")
  expect(colorEquals(title.fg, BORDER_COLOR.focused)).toBe(true)
  // And the field it left is fully handed back — both halves, not just one.
  const claimTitle = spanContaining(lineContaining(spans, "─claim─"), "claim")
  expect(colorEquals(claimTitle.fg, TEXT_COLOR.dim)).toBe(true)
})

test("`o` at 120 columns and up mounts both panes still, and carries the intention down a resize", async () => {
  // The old contract here was that `o` did NOTHING at or above WIDE, and the
  // test existed because it nonetheless flipped `refsFocused` — a flag that
  // only meant something below WIDE, so narrowing afterwards swapped the body
  // out for a pane nobody asked to open.
  //
  // The fix gave the flag one meaning at both widths: "I want the
  // references". So the resize now lands on the references DELIBERATELY —
  // same flag, same key, and no longer a surprise, because the operator asked
  // for them at the width where asking moved the arrows. What must still hold
  // is that `o` does not disturb the LAYOUT while both panes fit.
  const { renderer, flush, captureCharFrame, resize } = await createTestRenderer({ width: 130, height: 20 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)
  const other = claim({ id: "c2", claim: "Overlap sentence for the width test.", status: "approved" })
  screen.showReferences({ found: [other], missing: [], failed: null }, { found: [], missing: [], failed: null }, [])
  // Waiting on the BODY, not the pane: `refsText` is assigned synchronously,
  // so a frame carrying the overlap sentence proves nothing about whether
  // `body`'s own tree-sitter pass has landed yet — and the assertion beneath
  // it would then fail for the wrong reason.
  const wide = await frameContaining(flush, captureCharFrame, "Heading")
  // Both panes, side by side — the state `o` has nothing to change.
  expect(wide).toContain("Overlap sentence for the width test.")

  screen.toggleReferenceFocus()
  const afterToggle = await frameContaining(flush, captureCharFrame, "Heading")
  expect(afterToggle).toContain("Overlap sentence for the width test.")

  // Below WIDE the panes swap, and `refsFocused` is what decides which shows.
  // The toggle above asked for the references, so this is where they appear.
  resize(70, 20)
  screen.status("a line that forces a repaint")
  const narrow = await frameContaining(flush, captureCharFrame, "Overlap sentence for the width test.", 2000)
  expect(narrow).not.toContain("Heading")
  // And `o` still comes back — the key means the same thing at this width as
  // it did at the one above, which is the whole reason the early return went.
  screen.toggleReferenceFocus()
  const toggled = await frameContaining(flush, captureCharFrame, "Heading", 2000)
  expect(toggled).not.toContain("Overlap sentence for the width test.")
})

test("review's editor unmounts the browsing abstract too, not only curate's", async () => {
  // `unmountAbstract` guards on `scroll.content`, because `ScrollBoxRenderable.add`
  // forwards to that inner box and a mounted child's `.parent` is never
  // `scroll` itself. Guarding on the wrong one made the check permanently
  // false and left the abstract rendered UNDERNEATH the editor for a whole
  // session. Only curate's one-field test caught it, so an edit to that test
  // could silently reopen the hole on the path that mounts all three fields.
  // Tall enough that the abstract FIELD has rows for its text, not just its
  // border — at height 20 the 3:1 body/abstract split leaves the abstract box
  // two rows, so "the text is on screen exactly once" would be measuring the
  // layout rather than the mount.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 30 })
  const screen = buildScreen(renderer)
  const c = claim({ status: "approved", abstract: "Settles which extra the team installs.", abstractBy: "generated" })
  screen.show(c, 1, 1)
  await frameContaining(flush, captureCharFrame, "Settles which extra", 2000)
  screen.beginEdit(c)
  const frame = await frameContaining(flush, captureCharFrame, "# Heading", 2000)
  // The provenance header is browsing-only — the editor has a field titled
  // "abstract", but nothing in it renders "(generated)".
  expect(frame).not.toContain("(generated)")
  // And the abstract's text is on screen exactly once: in the field. Twice
  // means the browsing copy is still mounted beneath it.
  expect(frame.split("Settles which extra").length - 1).toBe(1)
})

test("toggleReferenceFocus does nothing when the claim has neither overlaps nor cites", async () => {
  // A key that does nothing is worse than an absent one — but the reverse
  // failure mode is just as real: `o` on a claim with nothing to show must
  // not blank the claim pane the reviewer is currently reading.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 70, height: 16 })
  const screen = buildScreen(renderer)
  screen.show(claim(), 1, 1) // no overlaps, no cites
  await frameContaining(flush, captureCharFrame, "Heading")
  screen.toggleReferenceFocus()
  const frame = await frameContaining(flush, captureCharFrame, "Heading")
  expect(frame).toContain("Heading")
})

test("a retracted overlap does not fall through to an undefined colour", () => {
  // OVERLAP_STATUS_COLOR is keyed on a narrower union than Status. A retracted
  // overlap reaching it returned undefined, which opentui renders as the
  // default foreground — silently indistinguishable from an approved one.
  expect(OVERLAP_STATUS_COLOR.retracted).toBeDefined()
  expect(OVERLAP_STATUS_COLOR.retracted).not.toBe(OVERLAP_STATUS_COLOR.approved)
})

// --- showReferences renders a citation's scope, absences and hash status ---

test("the references pane shows what each citation supports", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { supports: "the ingestion default" })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "MinerU" })], missing: [], failed: null }, [c])
  const frame = await frameContaining(flush, captureCharFrame, "the ingestion default")
  // The `supports ` prefix is part of the assertion, not scenery: without it
  // this passed on a pane that printed the scope bare, which is the one thing
  // that would make it read as the claim's own words.
  expect(frame).toContain("supports the ingestion default")
})

test("the pane lists absent terms and never a coverage score", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { absent: ["docling", "ingest"] })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "MinerU" })], missing: [], failed: null }, [c])
  const frame = await frameContaining(flush, captureCharFrame, "docling")
  expect(frame).toContain("docling")
  expect(frame).toContain("ingest")
  // Presence is not support — the document a rejected claim
  // cited can share its claim's vocabulary while contradicting it, and any
  // "n of m" would have read as validation of a citation a human rejected
  // on the merits.
  //
  // Scoped to the pane's own inner columns, not the whole frame: the header
  // above the panes reads "1 of 1 pending", which the naive whole-frame
  // check below would (falsely) flag as the very pattern this test exists
  // to rule out.
  const paneRows = frame.split("\n").filter((r) => r.length >= 130).map((r) => r.slice(130 - 44).slice(1, 43))
  expect(paneRows.join(" ")).not.toMatch(/\d+\s*(of|\/)\s*\d+/)
})

test("the pane warns when the cited document has changed since it was cited", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { hash: "abc" })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(
    EMPTY_REF_RESULT,
    { found: [doc({ title: "MinerU", hash: "CHANGED" })], missing: [], failed: null },
    [c],
  )
  // Names its subject, matching `formatClaim` — and at 44 columns that wraps,
  // so the fragments are asserted separately the way every other wrapped line
  // in this file is. A subjectless "changed since it was cited" left a
  // reviewer to guess whether the DOCUMENT or the claim had moved.
  const frame = await frameContaining(flush, captureCharFrame, "the document has changed since it was")
  expect(frame).toContain("the document has changed since it was")
  expect(frame).toContain("cited")
})

test("an unchecked citation does not render as a clean one", async () => {
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { supports: "", hash: null, absent: null, by: "unknown" })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "Old" })], missing: [], failed: null }, [c])
  const frame = await frameContaining(flush, captureCharFrame, "no scope stated")
  expect(frame).toContain("no scope stated")
  // The whole sentence. "never checked" alone also matches "never checked for
  // absent terms" being replaced by anything starting the same way, and this
  // is the state that must not read like a clean one.
  expect(frame).toContain("never checked for absent terms")
})

// The four citation states pinned individually, plus the
// missing-document case — the gap a review found: nothing in this file
// previously asserted `absent: []`'s wording, `hash: null`'s wording, or
// that a matching hash stays silent, which is exactly how a false "every
// term of the claim appears here" (formatClaim's own removed defect) shipped
// through a fully green suite.

test("absent: [] renders as checked-but-clear, never as every term present", async () => {
  // Verified this fails if `pushCiteFacts`'s `else` branch is reverted to
  // `push("every term of the claim appears here")` — the exact sentence
  // `claimTerms` (packages/protocol/src/absence.ts) makes false, since it drops every term
  // under MIN_TERM_LENGTH and every stopword before checking anything.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { absent: [] })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "MinerU" })], missing: [], failed: null }, [c])
  // Wraps across two rows at this width, same as the failed-lookup test
  // above — asserted as separate fragments rather than one unwrapped
  // substring, matching how a reader of the pane would still see both.
  const frame = await frameContaining(flush, captureCharFrame, "no absence found")
  expect(frame).toContain("no absence found — short and common")
  expect(frame).toContain("words are not checked")
  expect(frame).not.toContain("every term of the claim appears")
})

test("absent terms are named in formatClaim's words, not a second vocabulary", async () => {
  // The one citation state this file never pinned — and the one a reader is
  // most likely to take as a verdict on the citation, which is exactly how
  // the pane drifted to "not in the document" while the other three stayed
  // in step with `formatClaim`. `test/cli.test.ts` pins this sentence on
  // `cairn show`; the two surfaces must read identically or the review
  // screen is saying something `show` does not.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { absent: ["docling"] })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "MinerU" })], missing: [], failed: null }, [c])
  const frame = await frameContaining(flush, captureCharFrame, "not found in the document")
  expect(frame).toContain("not found in the document: docling")
})

test("a failed cites lookup names the load that failed, not a check that did not run", async () => {
  // `resolveCites` fails when `store.getDocument` does: a LOOKUP, not a
  // check. "could not check citations" borrowed this pane's own verb for the
  // absence check ("never checked for absent terms"), so it read as a
  // validation that had not run — telling a reviewer cairn validates
  // citations. It does not; this screen must not imply it
  // can. The overlaps twin keeps "check" because computing overlaps is work
  // cairn actually does.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1")
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [], missing: [], failed: "network is down" }, [c])
  const frame = await frameContaining(flush, captureCharFrame, "could not load the cited")
  expect(frame).toContain("could not load the cited")
  expect(frame).not.toContain("could not check citations")
})

test("hash: null renders as no hash recorded, not as a match", async () => {
  // Verified this fails if the `cite.hash === null` branch in `pushCiteFacts`
  // is removed (falling through to the `!==` comparison, which is false for
  // `null !== "abc"` and would render nothing at all — a null hash silently
  // reading exactly like a matching one).
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { hash: null })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "MinerU" })], missing: [], failed: null }, [c])
  // Wraps across two rows at this width — see the fragment-based assertion
  // above for why this checks two substrings rather than one.
  // Asserted through `paneText` rather than as wrap fragments: the fragments
  // this used to pin stayed green while the scrollbar clipped the last
  // character off both of these rows.
  const frame = await frameContaining(flush, captureCharFrame, "no hash recorded")
  expect(paneText(frame)).toContain("no hash recorded — cannot tell whether the document has changed")
})

test("a matching hash renders neither a staleness warning nor 'no hash recorded'", async () => {
  // Verified this fails if `cite.hash !== doc.hash` is replaced with `true`
  // — the mutation that would warn on every citation regardless of whether
  // its document actually changed.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { hash: "abc" }) // doc()'s default hash is "abc"
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "Ingest topology" })], missing: [], failed: null }, [c])
  const frame = await frameContaining(flush, captureCharFrame, "Ingest topology")
  expect(frame).not.toContain("the document has changed since it was")
  expect(frame).not.toContain("no hash recorded")
})

test("a citation's recorded facts still render when its document is gone", async () => {
  // This block once sat inside the `r.found` loop only, so a
  // deleted document lost its citation's scope and absences even though
  // `cairn show` (src/cli.ts) still prints them — the two surfaces
  // disagreeing about what is still known. This is the case those facts
  // matter most: the document cannot be re-read, so the citation is all
  // that survives. Verified this fails if the `if (cite) pushCiteFacts(push,
  // cite, null)` call in the `r.missing` loop is deleted.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { supports: "the ingestion default", absent: ["docling"] })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [], missing: ["doc-1"], failed: null }, [c])
  const frame = await frameContaining(flush, captureCharFrame, "no longer in this space")
  expect(frame).toContain("no longer in this space")
  expect(frame).toContain("the ingestion default")
  expect(frame).toContain("docling")
})

// --- what a citation's colour means --------------------------------------
//
// The `null` vs `[]` distinction is carried by the types through parsing, storage,
// the wire and both renderers — and colour is the LAST layer where it can
// still be lost. Rendered in one grey, a citation nobody ever checked reads
// exactly like one somebody did. These pin the two meanings apart.

test("a citation nobody established anything about is coloured as unverified", async () => {
  const { renderer, flush, captureSpans, captureCharFrame } = await createTestRenderer({ width: 130, height: 30 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { supports: "", hash: null, absent: null })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "Old" })], missing: [], failed: null }, [c])
  await frameContaining(flush, captureCharFrame, "never checked")
  const spans = captureSpans()
  // Whole sentences where a whole sentence fits on one span. The hash line is
  // the exception and not by choice: the pane wraps it after "cannot tell", so
  // no single span can carry the rest, and a needle spanning the break cannot
  // match anything. Pinned as far as the wrap allows rather than left at the
  // bare "no hash recorded" it used to be.
  for (const needle of [
    "no scope stated",
    "never checked for absent terms",
    "no hash recorded — cannot tell",
  ]) {
    expect(colorEquals(spanContaining(spans, needle).fg, CITATION_COLOR.unverified)).toBe(true)
  }
})

test("a cited document that has moved is coloured as stale, not as unverified", async () => {
  // Red rather than amber, and the difference carries meaning: this citation
  // WAS checked, and the ground under it moved. Every absence above it was
  // computed against text the document no longer contains.
  const { renderer, flush, captureSpans, captureCharFrame } = await createTestRenderer({ width: 130, height: 30 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { supports: "the default", hash: "abc", absent: [] })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(
    EMPTY_REF_RESULT,
    { found: [{ ...doc({ title: "MinerU" }), hash: "MOVED" }], missing: [], failed: null },
    [c],
  )
  await frameContaining(flush, captureCharFrame, "the document has changed since it was")
  const span = spanContaining(captureSpans(), "the document has changed since it was")
  expect(colorEquals(span.fg, CITATION_COLOR.stale)).toBe(true)
  expect(colorEquals(span.fg, CITATION_COLOR.unverified)).toBe(false)
})

test("the document id is coloured as the thing to copy", async () => {
  const { renderer, flush, captureSpans, captureCharFrame } = await createTestRenderer({ width: 130, height: 30 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { supports: "the default" })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "MinerU" })], missing: [], failed: null }, [c])
  await frameContaining(flush, captureCharFrame, "doc-1")
  expect(colorEquals(spanContaining(captureSpans(), "doc-1").fg, CITATION_COLOR.docId)).toBe(true)
})

// --- The pane must not take a position cairn cannot take ---

test("an empty cites section says that zero can be the right number", async () => {
  // Many approved claims render this. "No citations"
  // means BOTH "correctly grounded in a
  // discussion" and "nobody has done the work" — and a bare `none`, under a
  // label, in a pane whose neighbouring lines are amber for "nobody looked",
  // reads as the second. The clause echoes `team_knowledge_cite`'s own
  // description, so the agent and the reviewer are told the same thing,
  // and it says nothing about THIS claim either way.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  screen.show(claim({ overlaps: ["c2"] }), 1, 1)
  screen.showReferences(
    { found: [claim({ id: "c2", claim: "An overlap.", status: "approved" })], missing: [], failed: null },
    EMPTY_REF_RESULT,
    [],
  )
  const frame = await frameContaining(flush, captureCharFrame, "not every claim has a")
  expect(paneText(frame)).toContain("none — not every claim has a document to cite")
})

test("the clause is absent when the claim actually cites something", async () => {
  // It answers "why is this empty", so on a populated section it would be
  // prose excusing work that was done.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { absent: ["docling"] })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "MinerU" })], missing: [], failed: null }, [c])
  const frame = await frameContaining(flush, captureCharFrame, "MinerU")
  expect(frame).not.toContain("not every claim has a")
})

test("the pane frames an absence as a word check before listing any", async () => {
  // The pane's half — same sentence `formatClaim` prints, for
  // the same reason the four state lines are identical on both surfaces.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { absent: ["docling"] })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found: [doc({ title: "MinerU" })], missing: [], failed: null }, [c])
  const frame = await frameContaining(flush, captureCharFrame, "a word check")
  expect(frame).toContain("a word check, not a judgement")
  expect(frame.indexOf("a word check")).toBeLessThan(frame.indexOf("not found in the document"))
})

// --- The pane scrolls, and nothing at its bottom is unreachable ---

/** Four citations, which overflows the pane at every height these tests use.
 *  Real claims rarely carry this many, so the case only exists as a
 *  fixture, which is why it is built once here. */
function fourCitations(): { cites: Citation[]; found: Document[] } {
  const cites = [cite("doc-1"), cite("doc-2"), cite("doc-3"), cite("doc-4")]
  const found = [
    doc({ id: "doc-1", title: "First document" }),
    doc({ id: "doc-2", title: "Second document" }),
    doc({ id: "doc-3", title: "Third document" }),
    doc({ id: "doc-4", title: "Fourth document" }),
  ]
  return { cites, found }
}

test("the references pane reaches a citation the viewport cannot hold", async () => {
  // The whole of the defect: the fourth citation was cut off mid-line with no
  // ellipsis, no indicator and no key that reached it — on the screen whose
  // entire purpose is judging whether a claim's evidence supports it.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const { cites, found } = fourCitations()
  screen.show(claim({ cites }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found, missing: [], failed: null }, cites)
  const before = await frameContaining(flush, captureCharFrame, "First document")
  expect(before).not.toContain("Fourth document")
  screen.toggleReferenceFocus()
  screen.scroll(40)
  const after = await frameContaining(flush, captureCharFrame, "Fourth document")
  expect(after).toContain("Fourth document")
})

test("`o` decides which pane the arrows drive at or above 120 columns", async () => {
  // `o` was deliberately inert here, because both panes are mounted and there
  // was nothing to swap. It now has a job: the arrows drive one pane at a
  // time, and this is how a keyboard-only reviewer reaches the pane that does
  // not hold them by default. NOT opentui focus — see `refsPane.focusable`.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const { cites, found } = fourCitations()
  screen.show(claim({ cites, body: "# B\n\n" + "body line\n\n".repeat(60) }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found, missing: [], failed: null }, cites)
  await frameContaining(flush, captureCharFrame, "First document")

  // Arrows start on the body: the references pane does not move.
  screen.scroll(40)
  const bodyScrolled = await frameContaining(flush, captureCharFrame, "First document")
  expect(bodyScrolled).not.toContain("Fourth document")

  // After `o` they drive the references pane instead.
  screen.toggleReferenceFocus()
  screen.scroll(40)
  const refsScrolled = await frameContaining(flush, captureCharFrame, "Fourth document")
  expect(refsScrolled).toContain("Fourth document")
})

/** The pane's rows with the border and scrollbar glyphs stripped, joined in
 *  order — so an assertion can name a whole sentence without encoding where
 *  `wrapEntry` happens to break it. Every other assertion in this file pins
 *  fragments, which is why a one-column change in the usable width was able to
 *  clip text with the suite still green. */
function paneText(frame: string): string {
  return frame
    .split("\n")
    .filter((r) => r.length >= 130)
    .map((r) => r.slice(130 - REFS_PANE_WIDTH).replace(/[│┌┐└┘─▀▄█]/g, "").trim())
    .filter((r) => r !== "")
    .join(" ")
}

test("the scrollbar does not eat the last column of a wrapped line", async () => {
  // Found by driving the pane on a real terminal, not by review: `kept fo`,
  // `after whic`, `a judgement of whethe`. Making this pane a
  // ScrollBoxRenderable, the scrollbar takes a column INSIDE the border
  // once it is visible — so the usable width is two less than the border pair
  // suggests, while `wrapEntry` was still wrapping to one less.
  //
  // Only reproducible when the content overflows, which is why every test
  // above missed it: a pane that fits shows no scrollbar and loses nothing.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const { cites, found } = fourCitations()
  screen.show(claim({ cites }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found, missing: [], failed: null }, cites)
  const frame = await frameContaining(flush, captureCharFrame, "a word check")
  expect(paneText(frame)).toContain(ABSENCE_FRAMING)
})

test("a new claim opens its references at the top, not where the last one was left", async () => {
  // The fix for the scroll defect can reintroduce it: a pane scrolled to the
  // fourth citation keeps that offset, so the NEXT claim's references open
  // part-way down with its first ones scrolled off and nothing saying so.
  // `show` resets this beside the body pane's own `scrollTo(0)`.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const { cites, found } = fourCitations()
  screen.show(claim({ cites }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found, missing: [], failed: null }, cites)
  await frameContaining(flush, captureCharFrame, "First document")
  screen.toggleReferenceFocus()
  screen.scroll(40)
  expect(await frameContaining(flush, captureCharFrame, "Fourth document")).toContain("Fourth document")

  screen.show(claim({ id: "c2", cites }), 2, 2)
  screen.showReferences(EMPTY_REF_RESULT, { found, missing: [], failed: null }, cites)
  const fresh = await frameContaining(flush, captureCharFrame, "First document")
  expect(fresh).toContain("First document")
  expect(fresh).not.toContain("Fourth document")
})

test("at 120 columns and up the lit border says which pane the arrows drive", async () => {
  // With both panes mounted, `o` moves the arrows and nothing else moves —
  // so without this the screen has no way to say where the next keypress
  // goes, and an operator pressing Down on a pane that already fits sees
  // nothing happen and learns nothing about why.
  const { renderer, flush, captureCharFrame, captureSpans } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const { cites, found } = fourCitations()
  screen.show(claim({ cites }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found, missing: [], failed: null }, cites)
  await frameContaining(flush, captureCharFrame, "First document")

  // Both panes' top borders sit on ONE row at this width, so the body's `┌`
  // comes first and the references pane's is the last one on the line.
  const refsCorner = (frame: Frame) => {
    const corners = spansOf(lineContaining(frame, "references")).filter((sp) => sp.text.includes("┌"))
    return corners[corners.length - 1]!
  }

  expect(colorEquals(refsCorner(captureSpans()).fg, BORDER_COLOR.focused)).toBe(false)
  screen.toggleReferenceFocus()
  await frameContaining(flush, captureCharFrame, "First document")
  expect(colorEquals(refsCorner(captureSpans()).fg, BORDER_COLOR.focused)).toBe(true)
  screen.toggleReferenceFocus()
  await frameContaining(flush, captureCharFrame, "First document")
  expect(colorEquals(refsCorner(captureSpans()).fg, BORDER_COLOR.focused)).toBe(false)
})

test("the references pane shows position as a scrollbar and never as a percentage", async () => {
  // A deliberate choice: the body pane earns a percentage in its bottom title
  // because it is the thing being read; a 44-column side pane showing a second
  // percentage would put two competing numbers on one screen. The library
  // shows and hides the scrollbar on its own once the content overflows
  // (`ScrollBarRenderable.recalculateVisibility`), so a short pane stays clean
  // without anything here deciding when.
  const { renderer, flush, captureCharFrame } = await createTestRenderer({ width: 130, height: 24 })
  const screen = buildScreen(renderer)
  const { cites, found } = fourCitations()
  screen.show(claim({ cites }), 1, 1)
  screen.showReferences(EMPTY_REF_RESULT, { found, missing: [], failed: null }, cites)
  const frame = await frameContaining(flush, captureCharFrame, "First document")
  // The pane occupies the rightmost 44 columns; slice it out rather than
  // searching the whole frame, where the BODY pane's own percentage lives.
  const paneRows = frame.split("\n").filter((r) => r.length >= 130).map((r) => r.slice(130 - 44))
  expect(paneRows.join(" ")).not.toMatch(/\d+%/)
})

test("the footer offers `o refs` at every width, because `o` now acts at every width", async () => {
  // The inverse of what this test used to assert, and deliberately so.
  // `toggleReferenceFocus` used to return early at or above WIDE, so the
  // footer suppressing `o refs` there was the fix: it stopped naming a key
  // that did nothing when pressed. The fix removed the early return instead
  // — `o` now moves which pane the arrows drive — so suppressing the hint
  // would hide the only signpost to content nothing else reaches.
  //
  // The rule is unchanged and this is still a test of it: advertise exactly
  // what the handler will do. What moved is what the handler does.
  const wide = await createTestRenderer({ width: 130, height: 24 })
  const wideScreen = buildScreen(wide.renderer)
  wideScreen.show(claim({ cites: [cite("doc-1")] }), 1, 1)
  await wide.flush()
  expect(wide.captureCharFrame()).toContain("o refs")

  const narrow = await createTestRenderer({ width: 100, height: 24 })
  const narrowScreen = buildScreen(narrow.renderer)
  narrowScreen.show(claim({ cites: [cite("doc-1")] }), 1, 1)
  await narrow.flush()
  expect(narrow.captureCharFrame()).toContain("o refs")

  // Still absent when there is nothing to look at — the half of the rule that
  // did not change, and the one a claim with no references depends on.
  const bare = await createTestRenderer({ width: 130, height: 24 })
  const bareScreen = buildScreen(bare.renderer)
  bareScreen.show(claim(), 1, 1)
  await bare.flush()
  expect(bare.captureCharFrame()).not.toContain("o refs")
})

test("the document's own words are dimmed, so cairn's assessment of them is not", async () => {
  // The hierarchy this fixes: the snippet is the DOCUMENT speaking and every
  // line under it is cairn speaking. At one weight a reader cannot tell which
  // is which — and when a cited document restates the claim, the pane reads
  // as self-contradiction.
  const { renderer, flush, captureSpans, captureCharFrame } = await createTestRenderer({ width: 130, height: 30 })
  const screen = buildScreen(renderer)
  const c = cite("doc-1", { supports: "" })
  screen.show(claim({ cites: [c] }), 1, 1)
  screen.showReferences(
    EMPTY_REF_RESULT,
    { found: [{ ...doc({ title: "Ingestion defaults" }), text: "Quoted document prose." }], missing: [], failed: null },
    [c],
  )
  await frameContaining(flush, captureCharFrame, "Quoted document prose")
  expect(isDim(spanContaining(captureSpans(), "Quoted document prose"))).toBe(true)
})
