import { hashText } from "./hash"
import type { Passage } from "./types"

/**
 * Retrieval: the passage chunker, rank fusion and the full-text query builder
 * that the CLI's local store and the hosted service share.
 *
 * Both sides must cut the same text into the same passages, or an offset one
 * side hands out lands somewhere else on the other, and an embedding cached
 * under a passage's hash never matches again. So the rules live here, once,
 * with no dependencies and no Node builtins.
 */

/** A passage closes once adding the next paragraph would take it past this many characters. */
export const CHUNK_TARGET = 1200
/** No passage is ever longer than this, in characters. */
export const CHUNK_CAP = 2400
/** A section whose body is shorter than this merges into the next one. */
export const MIN_SECTION = 200
/**
 * Which version of the chunking rules produced a passage. Any change to a
 * constant above or to a rule below bumps it, so a store can tell its stored
 * passages are stale and cut them again.
 */
export const CHUNKER_VERSION = 1

/** The `k` in reciprocal rank fusion's `1 / (k + rank)`. */
export const RRF_K = 60
/** How many results each ranking (keyword, vector) contributes before fusion. */
export const LEG_DEPTH = 50
/** At most this many passages of one document in a result. */
export const PER_DOC_CAP = 2
/** How many passages a search returns when the caller names no limit. */
export const DEFAULT_PASSAGE_LIMIT = 6
/** How long a search waits for the query's embedding before going keyword-only. */
export const QUERY_EMBED_TIMEOUT_MS = 1500
/** The notice a search returns when it fell back to keyword-only ranking. */
export const SEMANTIC_UNAVAILABLE_NOTICE =
  "semantic search unavailable: the embedding model did not answer; results are keyword-only"

const SEPARATOR = " › "
const PARAGRAPH_BREAK = /\r?\n[ \t]*\r?\n/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/

/** A half-open range of string indices, `[start, end)`. */
type Span = [number, number]

interface Section {
  /** The heading path, title first. */
  crumbs: string[]
  /** The body, trimmed; may contain heading lines once sections merge. */
  span: Span
}

/**
 * The text a passage is indexed and embedded as: its heading breadcrumb, a
 * blank line, then the span itself. The breadcrumb is not part of `offset`
 * or `length`.
 */
export function passageText(text: string, p: Passage): string {
  return p.heading + "\n\n" + text.slice(p.offset, p.offset + p.length)
}

/**
 * Cut a document into passages: contiguous, non-overlapping spans of `text`,
 * each with the heading breadcrumb it sits under. Offsets are JavaScript
 * string indices into `text`. Every passage's `doc` is `""`; the caller
 * knows the document's id and sets it.
 *
 * 1. Split at ATX headings (`#` to `######`) outside fenced code.
 * 2. A section whose body is shorter than `MIN_SECTION` is prepended to the
 *    next section, under the two breadcrumbs' longest common prefix, and
 *    stays with that section's first paragraph unless the cap splits them.
 * 3. Within a section, pack whole paragraphs (a fenced block is one) up to
 *    `CHUNK_TARGET`; a paragraph longer than `CHUNK_CAP` is split after
 *    sentence ends, falling back to whitespace.
 * 4. No span starts or ends on a heading line, and spans exclude
 *    surrounding whitespace.
 *
 * A document with text but no body under any heading is one passage spanning
 * the whole text; blank text has none.
 */
export async function chunk(title: string, text: string): Promise<Passage[]> {
  if (text.trim().length === 0) return []
  const { sections, fences, headingLines } = parse(title, text)
  const spans: { heading: string; span: Span }[] = []
  for (const section of mergeShort(sections, title)) {
    const heading = section.crumbs.join(SEPARATOR)
    for (const packed of pack(text, section.span, fences, headingLines)) {
      const span = offHeadings(text, packed, headingLines)
      if (span) spans.push({ heading, span })
    }
  }
  if (spans.length === 0) spans.push({ heading: title, span: [0, text.length] })
  return Promise.all(
    spans.map(async ({ heading, span: [start, end] }, ordinal) => ({
      doc: "",
      ordinal,
      offset: start,
      length: end - start,
      heading,
      hash: await hashText(heading + "\n\n" + text.slice(start, end)),
    })),
  )
}

/** Split into sections at headings, recording fenced blocks and heading lines on the way. */
function parse(title: string, text: string): { sections: Section[]; fences: Span[]; headingLines: Span[] } {
  const sections: Section[] = []
  const fences: Span[] = []
  const headingLines: Span[] = []
  const stack: { level: number; text: string }[] = []
  let crumbs = [title]
  let bodyStart = 0
  let fence: { char: string; size: number; start: number } | null = null

  const close = (bodyEnd: number) => {
    const span = trim(text, bodyStart, bodyEnd)
    if (span) sections.push({ crumbs, span })
  }

  let at = 0
  while (at <= text.length) {
    const nl = text.indexOf("\n", at)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(at, lineEnd).replace(/\r$/, "")
    const next = nl === -1 ? text.length + 1 : nl + 1
    const fenceMatch = FENCE.exec(line)
    if (fence) {
      const closing = fenceMatch?.[1]
      if (closing && closing[0] === fence.char && closing.length >= fence.size && line.slice(fenceMatch![0].length).trim() === "") {
        fences.push([fence.start, at + line.length])
        fence = null
      }
    } else if (fenceMatch) {
      fence = { char: fenceMatch[1]![0]!, size: fenceMatch[1]!.length, start: at }
    } else {
      const heading = ATX.exec(line)
      if (heading) {
        close(at)
        headingLines.push([at, at + line.length])
        const level = heading[1]!.length
        const label = (heading[2] ?? "").replace(/(^|[ \t]+)#+[ \t]*$/, "").trim()
        while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop()
        stack.push({ level, text: label })
        const path = stack.map((s) => s.text).filter((s) => s.length > 0)
        // A level-1 heading that repeats the title is the title, not a level below it.
        if (stack[0]!.level === 1 && stack[0]!.text === title) path.shift()
        crumbs = [title, ...path]
        bodyStart = next
      }
    }
    at = next
  }
  if (fence) fences.push([fence.start, text.length])
  close(text.length)
  return { sections, fences, headingLines }
}

/** Prepend each short section to the one after it. The last section stays as it is. */
function mergeShort(sections: Section[], title: string): Section[] {
  const out: Section[] = []
  let pending: Section | null = null
  sections.forEach((section, i) => {
    const merged: Section = pending
      ? { crumbs: commonPrefix(pending.crumbs, section.crumbs, title), span: [pending.span[0], section.span[1]] }
      : section
    pending = null
    if (merged.span[1] - merged.span[0] < MIN_SECTION && i < sections.length - 1) pending = merged
    else out.push(merged)
  })
  return out
}

function commonPrefix(x: string[], y: string[], title: string): string[] {
  const out: string[] = []
  for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i++) out.push(x[i]!)
  return out.length > 0 ? out : [title]
}

/** Cut a section's body into passage spans. */
function pack(text: string, body: Span, fences: Span[], headingLines: Span[]): Span[] {
  const out: Span[] = []
  let current: Span | null = null
  for (const { span: para, floor } of paragraphs(text, body, fences, headingLines)) {
    if (current && para[1] - current[0] <= CHUNK_TARGET) {
      current = [current[0], para[1]]
      continue
    }
    if (current) out.push(current)
    current = null
    if (para[1] - para[0] > CHUNK_CAP) out.push(...splitLong(text, para, floor))
    else current = para
  }
  if (current) out.push(current)
  return out
}

/**
 * A paragraph to pack: its trimmed span, and `floor`, the first index a split
 * may fall on. The floor is past any heading line inside the paragraph, so a
 * split never leaves a merged short body on its own or a span on a heading.
 */
interface Paragraph {
  span: Span
  floor: number
}

/**
 * The body's paragraphs, trimmed. A break inside a fenced block does not
 * count.
 *
 * Heading lines only appear inside a body once `mergeShort` has prepended a
 * short section to the next one. The short body, the heading and the next
 * section's first paragraph of content then become ONE paragraph, whatever
 * the target: packed separately, the short body would close as a passage of
 * its own and the next would start on the heading, which is exactly what the
 * merge exists to prevent. Only the cap can split it, and only after the
 * heading.
 */
function paragraphs(text: string, [start, end]: Span, fences: Span[], headingLines: Span[]): Paragraph[] {
  const body = text.slice(start, end)
  const raw: Span[] = []
  let from = start
  for (const m of body.matchAll(PARAGRAPH_BREAK)) {
    const at = start + m.index
    if (fences.some(([s, e]) => at >= s && at < e)) continue
    raw.push([from, at])
    from = at + m[0].length
  }
  raw.push([from, end])
  let out: Paragraph[] = []
  // Where a group still waiting for its first paragraph of content begins.
  let pending: number | null = null
  for (const [s, e] of raw) {
    const span = trim(text, s, e)
    if (!span) continue
    const inside = headingLines.filter(([hs, he]) => he > span[0] && hs < span[1])
    if (inside.length === 0) {
      out.push({ span: [pending ?? span[0], span[1]], floor: span[0] })
      pending = null
      continue
    }
    // Everything before a heading in this body is merged short material
    // (under MIN_SECTION in all), so all of it joins the group.
    const groupStart: number = out.length > 0 ? out[0]!.span[0] : (pending ?? span[0])
    out = []
    const lastHeadingEnd = Math.max(...inside.map(([, he]) => he))
    const content = trim(text, lastHeadingEnd, span[1])
    if (content) {
      out.push({ span: [groupStart, span[1]], floor: content[0] })
      pending = null
    } else {
      pending = groupStart
    }
  }
  if (pending !== null) {
    const rest = trim(text, pending, end)
    if (rest) out.push({ span: rest, floor: rest[0] })
  }
  return out
}

/**
 * Split a paragraph longer than the cap: after sentence ends, else at
 * whitespace, else hard. No split falls before `floor`.
 */
function splitLong(text: string, [start, end]: Span, floor: number): Span[] {
  const out: Span[] = []
  let at = start
  while (end - at > CHUNK_CAP) {
    // A floor the cap cannot reach is ignored; the cap is the harder rule.
    const lo = floor > at && floor < at + CHUNK_CAP ? floor : at
    const cut =
      lastBreak(text, lo, at + CHUNK_TARGET, /[.!?]\s/g) ??
      lastBreak(text, lo, at + CHUNK_CAP, /[.!?]\s/g) ??
      lastBreak(text, lo, at + CHUNK_CAP, /\s/g) ??
      hardCut(text, at + CHUNK_CAP)
    const span = trim(text, at, cut)
    if (span) out.push(span)
    at = cut
    while (at < end && /\s/.test(text[at]!)) at++
  }
  const rest = trim(text, at, end)
  if (rest) out.push(rest)
  return out
}

/**
 * Move a span's edges off heading lines: a start on a heading moves to the
 * first content after it, an end on one moves back before it. Null when
 * nothing is left.
 */
function offHeadings(text: string, [s, e]: Span, headingLines: Span[]): Span | null {
  for (const [hs, he] of headingLines) {
    if (s >= hs && s < he) s = trim(text, he, e)?.[0] ?? e
  }
  for (let i = headingLines.length - 1; i >= 0; i--) {
    const [hs, he] = headingLines[i]!
    if (e - 1 >= hs && e - 1 < he) e = trim(text, s, hs)?.[1] ?? s
  }
  return s < e ? [s, e] : null
}

/**
 * The index just past the last match's first character (the sentence's
 * punctuation, or nothing for bare whitespace) with the cut no later than
 * `limit`, or null when there is none past `from`.
 */
function lastBreak(text: string, from: number, limit: number, pattern: RegExp): number | null {
  const window = text.slice(from, limit + 1)
  let best: number | null = null
  for (const m of window.matchAll(pattern)) {
    const cut = from + m.index + (m[0].length > 1 ? 1 : 0)
    if (cut > from && cut <= limit) best = cut
  }
  return best
}

/** Never cut a surrogate pair in half. */
function hardCut(text: string, at: number): number {
  const code = text.charCodeAt(at - 1)
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at
}

/** `[s, e)` with surrounding whitespace removed, or null when nothing is left. */
function trim(text: string, s: number, e: number): Span | null {
  while (s < e && /\s/.test(text[s]!)) s++
  while (e > s && /\s/.test(text[e - 1]!)) e--
  return s < e ? [s, e] : null
}

/**
 * Reciprocal rank fusion: each id scores `1 / (k + rank)` summed over the
 * lists it appears in, with ranks counted from 1. Best first. A tie goes to
 * the id ranked better in the earliest list that tells them apart, then to
 * the id itself. An id repeated within one list counts at its first rank.
 */
export function rrf(lists: string[][], k: number = RRF_K): { id: string; score: number }[] {
  const scores = new Map<string, number>()
  const ranks = new Map<string, number[]>()
  lists.forEach((list, li) => {
    list.forEach((id, r) => {
      let rs = ranks.get(id)
      if (!rs) {
        rs = lists.map(() => Infinity)
        ranks.set(id, rs)
      }
      if (rs[li] !== Infinity) return
      rs[li] = r
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + r + 1))
    })
  })
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((x, y) => {
      if (x.score !== y.score) return y.score - x.score
      const rx = ranks.get(x.id)!
      const ry = ranks.get(y.id)!
      for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i]! < ry[i]! ? -1 : 1
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
    })
}

/** Keep hits in order, dropping each document's hits past the first `cap`. */
export function capPerDoc<T extends { doc: string }>(hits: T[], cap: number = PER_DOC_CAP): T[] {
  const seen = new Map<string, number>()
  return hits.filter((h) => {
    const n = seen.get(h.doc) ?? 0
    seen.set(h.doc, n + 1)
    return n < cap
  })
}

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
 *
 * ASCII control characters (C0, `\u0000`–`\u001F`, and DEL `\u007F`) are
 * stripped before splitting. None of them is whitespace, so left in place a
 * NUL byte or similar would ride inside a term verbatim — and a NUL inside
 * the query string handed to SQLite's FTS5 tokenizer throws rather than
 * simply failing to match.
 *
 * Shared with the hosted service so both build the same query from the same
 * question.
 */
export function ftsQuery(text: string): string | null {
  const cleaned = text.replace(/[\u0000-\u001F\u007F]/g, "")
  const terms = cleaned.split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ")
}
