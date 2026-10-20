import { expect, test } from "bun:test"
import { hashText } from "@cairn-kb/protocol/hash"
import {
  CHUNK_CAP,
  CHUNK_TARGET,
  CHUNKER_VERSION,
  DEFAULT_PASSAGE_LIMIT,
  LEG_DEPTH,
  MIN_SECTION,
  PER_DOC_CAP,
  QUERY_EMBED_TIMEOUT_MS,
  RRF_K,
  SEMANTIC_UNAVAILABLE_NOTICE,
  capPerDoc,
  chunk,
  ftsQuery,
  passageText,
  rrf,
} from "@cairn-kb/protocol/retrieval"
import type { Passage } from "@cairn-kb/protocol/types"

/** `n` characters of distinct-looking prose with no paragraph breaks. */
const filler = (letter: string, n: number): string => {
  let s = ""
  while (s.length < n) s += `${letter.repeat(9)} `
  return s.slice(0, n - 1) + letter
}
const a = (n: number) => filler("a", n)
const b = (n: number) => filler("b", n)
const c = (n: number) => filler("c", n)

/** Character ranges of heading lines outside fenced code. */
function headingLines(text: string): [number, number][] {
  const out: [number, number][] = []
  let fenced = false
  let at = 0
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "")
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced && /^ {0,3}#{1,6}([ \t]|$)/.test(line)) out.push([at, at + line.length])
    at += raw.length + 1
  }
  return out
}

/**
 * The coverage invariant: every non-whitespace character outside heading
 * lines lies in exactly one passage span, the spans ascend, and each span is
 * the slice its offset and length name.
 */
function expectCoverage(text: string, passages: Passage[]): void {
  const headings = headingLines(text)
  let end = 0
  passages.forEach((p, i) => {
    expect(p.ordinal).toBe(i)
    expect(p.offset).toBeGreaterThanOrEqual(end)
    expect(p.length).toBeGreaterThan(0)
    end = p.offset + p.length
    const span = text.slice(p.offset, p.offset + p.length)
    expect(span.length).toBe(p.length)
    expect(span.trim().length).toBeGreaterThan(0)
    expect(span).toBe(span.trim())
    // A span neither starts nor ends inside a heading line: headings sit
    // between passages or inside one, never on its edge.
    const last = p.offset + p.length - 1
    for (const [s, e] of headings) {
      if (p.offset >= s && p.offset < e) throw new Error(`passage ${i} starts on the heading ${JSON.stringify(text.slice(s, e))}`)
      if (last >= s && last < e) throw new Error(`passage ${i} ends on the heading ${JSON.stringify(text.slice(s, e))}`)
    }
  })
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) continue
    if (headings.some(([s, e]) => i >= s && i < e)) continue
    const holders = passages.filter((p) => i >= p.offset && i < p.offset + p.length).length
    if (holders !== 1) throw new Error(`character ${i} (${JSON.stringify(text[i])}) is in ${holders} passages`)
  }
}

test("the constants hold their agreed values", () => {
  expect([CHUNK_TARGET, CHUNK_CAP, MIN_SECTION]).toEqual([1200, 2400, 200])
  expect([RRF_K, LEG_DEPTH, PER_DOC_CAP, DEFAULT_PASSAGE_LIMIT]).toEqual([60, 50, 2, 6])
  expect(QUERY_EMBED_TIMEOUT_MS).toBe(1500)
  expect(SEMANTIC_UNAVAILABLE_NOTICE).toBe(
    "semantic search unavailable: the embedding model did not answer; results are keyword-only",
  )
  expect(CHUNKER_VERSION).toBe(1)
})

test("splits at headings and carries the breadcrumb", async () => {
  const text = "# T\n\n" + a(300) + "\n\n## A\n\n" + b(300) + "\n\n### A1\n\n" + c(300)
  const ps = await chunk("T", text)
  expect(ps.map((p) => p.heading)).toEqual(["T", "T › A", "T › A › A1"])
  expect(ps.every((p) => p.doc === "")).toBe(true)
  expectCoverage(text, ps)
})

test("a short section merges forward under the common ancestor", async () => {
  const text = "# T\n\nshort intro\n\n## A\n\n" + a(500)
  const ps = await chunk("T", text)
  expect(ps).toHaveLength(1)
  expect(ps[0]!.heading).toBe("T")
  expect(ps[0]!.offset).toBe(text.indexOf("short intro"))
  expect(ps[0]!.offset + ps[0]!.length).toBe(text.length)
  expectCoverage(text, ps)
})

test("a merged short section stays with the next section's first paragraph", async () => {
  // Short body plus the next paragraph is over the target but under the cap:
  // they stay together rather than leaving "short intro" a passage alone.
  const one = "# T\n\nshort intro\n\n## A\n\n" + a(1190) + "\n\n" + b(500)
  const ps1 = await chunk("T", one)
  expect(ps1[0]!.offset).toBe(one.indexOf("short intro"))
  expect(ps1[0]!.offset + ps1[0]!.length).toBe(one.indexOf("\n\nbbb"))
  expect(ps1[0]!.heading).toBe("T")
  expectCoverage(one, ps1)

  // Over the cap: the split falls after the heading, never before it.
  const two = "# T\n\nshort intro\n\n## A\n\n" + a(3000)
  const ps2 = await chunk("T", two)
  expect(ps2[0]!.offset).toBe(two.indexOf("short intro"))
  expect(ps2[0]!.length).toBeGreaterThan(two.indexOf("aaa") - ps2[0]!.offset)
  for (const p of ps2) expect(p.length).toBeLessThanOrEqual(CHUNK_CAP)
  expectCoverage(two, ps2)

  // A sentence end in the short body is not a place to split either.
  const three = "# T\n\nShort intro. \n\n## A\n\n" + "x".repeat(3000)
  const ps3 = await chunk("T", three)
  expect(ps3[0]!.offset).toBe(three.indexOf("Short intro."))
  expect(ps3[0]!.length).toBeGreaterThan(three.indexOf("xxx") - ps3[0]!.offset)
  expectCoverage(three, ps3)
})

test("only a level-1 heading that repeats the title is folded into it", async () => {
  const text = "## T\n\n" + a(300)
  const ps = await chunk("T", text)
  expect(ps.map((p) => p.heading)).toEqual(["T › T"])
})

test("packs paragraphs to the target and never exceeds the cap", async () => {
  const paras = "abcdefghij".split("").map((l) => filler(l, 300))
  const text = "# T\n\n" + paras.join("\n\n")
  const ps = await chunk("T", text)
  expect(ps.length).toBeGreaterThan(1)
  for (const p of ps) expect(p.length).toBeLessThanOrEqual(CHUNK_TARGET)
  expectCoverage(text, ps)
})

test("splits an oversized paragraph at sentence ends", async () => {
  const sentence = "w".repeat(98) + ". "
  const text = sentence.repeat(50).trimEnd()
  expect(text.length).toBe(4999)
  const ps = await chunk("T", text)
  expect(ps.length).toBeGreaterThan(1)
  for (const p of ps) {
    expect(p.length).toBeLessThanOrEqual(CHUNK_CAP)
    const end = p.offset + p.length
    const endsOnSentence = text.slice(end - 1, end + 1) === ". "
    expect(endsOnSentence || end === text.length).toBe(true)
  }
  expectCoverage(text, ps)
})

test("a heading inside a fenced block is not a heading", async () => {
  const text = "```\n# not a heading\n```"
  const ps = await chunk("T", text)
  expect(ps).toHaveLength(1)
  expect(ps[0]!.heading).toBe("T")
  expect(ps[0]!.offset).toBe(0)
  expect(ps[0]!.length).toBe(text.length)
})

test("a fenced block is one paragraph, blank lines and all", async () => {
  // 1,500 characters: over the target, under the cap. Split at its blank
  // lines it would become two passages; as one paragraph it stays whole.
  const lines = Array.from({ length: 10 }, (_, i) => filler(String(i), 140))
  const fence = "```\n" + lines.join("\n\n") + "\n```"
  const text = "# T\n\n" + fence
  const ps = await chunk("T", text)
  expect(ps).toHaveLength(1)
  expect(text.slice(ps[0]!.offset, ps[0]!.offset + ps[0]!.length)).toBe(fence)
})

test("no headings uses the title", async () => {
  const text = "just some words\n\nand another paragraph"
  const ps = await chunk("T", text)
  expect(ps.map((p) => p.heading)).toEqual(["T"])
  expectCoverage(text, ps)
})

test("a document of only headings still has one passage", async () => {
  const text = "# A\n\n## B\n"
  const ps = await chunk("T", text)
  expect(ps).toHaveLength(1)
  expect(ps[0]!.offset).toBe(0)
  expect(ps[0]!.length).toBe(text.length)
})

test("blank text has no passages", async () => {
  expect(await chunk("T", " \n")).toEqual([])
  expect(await chunk("T", "")).toEqual([])
})

test("offsets are string indices through emoji, CJK and CRLF", async () => {
  const text = "# T\r\n\r\n" + "😀漢字 ".repeat(100) + "\r\n\r\n## B\r\n\r\n" + "x".repeat(300)
  const ps = await chunk("T", text)
  expect(ps.map((p) => p.heading)).toEqual(["T", "T › B"])
  expect(text.slice(ps[0]!.offset, ps[0]!.offset + ps[0]!.length)).toBe("😀漢字 ".repeat(100).trimEnd())
  expect(text.slice(ps[1]!.offset, ps[1]!.offset + ps[1]!.length)).toBe("x".repeat(300))
  expectCoverage(text, ps)

  // `\r\n\r\n` is a paragraph break, so CRLF paragraphs pack like LF ones.
  const paras = "abcdefghij".split("").map((l) => filler(l, 300))
  const crlf = paras.join("\r\n\r\n")
  const lf = paras.join("\n\n")
  const crlfPs = await chunk("T", crlf)
  const lfPs = await chunk("T", lf)
  expect(crlfPs.length).toBe(lfPs.length)
  expect(crlfPs.length).toBeGreaterThan(1)
  for (const p of crlfPs) expect(p.length).toBeLessThanOrEqual(CHUNK_TARGET)
  expectCoverage(crlf, crlfPs)
})

test("chunk is deterministic and hashes passageText", async () => {
  const text = "# T\n\n" + a(900) + "\n\n" + b(900) + "\n\n## A\n\n" + c(400)
  const one = await chunk("T", text)
  const two = await chunk("T", text)
  expect(one).toEqual(two)
  for (const p of one) {
    expect(passageText(text, p)).toBe(p.heading + "\n\n" + text.slice(p.offset, p.offset + p.length))
    expect(p.hash).toBe(await hashText(passageText(text, p)))
  }
})

test("rrf fuses by reciprocal rank", () => {
  const fused = rrf([["a", "b", "c"], ["c", "a"]])
  expect(fused.map((f) => f.id)).toEqual(["a", "c", "b"])
  expect(fused[0]!.score).toBe(1 / 61 + 1 / 62)
})

test("rrf breaks ties by the earlier list's rank, then by id", () => {
  // x and y each appear once at rank 1, so their scores tie; x's rank in the
  // first list is the better one.
  expect(rrf([["x"], ["y"]]).map((f) => f.id)).toEqual(["x", "y"])
  expect(rrf([[], ["q"], ["p"]]).map((f) => f.id)).toEqual(["q", "p"])
  // m and n tie, as do z and k: in each pair the one ranked in the first list wins.
  expect(rrf([["m", "z"], ["n", "k"]], 60).map((f) => f.id)).toEqual(["m", "n", "z", "k"])
})

test("capPerDoc keeps two per document in order", () => {
  const hits = [
    { doc: "d1", n: 1 }, { doc: "d1", n: 2 }, { doc: "d2", n: 3 },
    { doc: "d1", n: 4 }, { doc: "d2", n: 5 }, { doc: "d2", n: 6 }, { doc: "d3", n: 7 },
  ]
  expect(capPerDoc(hits).map((h) => h.n)).toEqual([1, 2, 3, 5, 7])
  expect(capPerDoc(hits, 1).map((h) => h.n)).toEqual([1, 3, 7])
})

test("ftsQuery moved without change", () => {
  expect(ftsQuery("how do we deploy")).toBe('"how" OR "do" OR "we" OR "deploy"')
  expect(ftsQuery('say "hi')).toBe('"say" OR """hi"')
  expect(ftsQuery("NOT *")).toBe('"NOT" OR "*"')
  expect(ftsQuery("")).toBeNull()
  expect(ftsQuery(" \t\n")).toBeNull()
  expect(ftsQuery("x\u0000y")).toBe('"xy"')
})
