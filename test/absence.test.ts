import { expect, test } from "bun:test"
import { MIN_TERM_LENGTH, absentTerms, claimTerms } from "@cairn-kb/protocol/absence"

// Two failure shapes, with short invented documents: a headline term absent
// from a document that shares the claim's other vocabulary.
const MINERU_DOC =
  "MinerU installation. Install with `pip install mineru[core]`. The pipeline backend runs on CPU. " +
  "Use `-b pipeline` to select it. Layout detection and formula recognition are included."

test("a headline term absent from the cited document is reported", () => {
  // A claim about one tool, citing a document in which that tool's name
  // appears zero times.
  const absent = absentTerms("Docling Serve is the production default for ingestion", MINERU_DOC)
  expect(absent).toContain("docling")
})

test("a term the document does contain is NOT reported", () => {
  // The vacuity control. A rule that returned every term would satisfy the
  // assertion above and be worthless; this is the case that fails if it does.
  const absent = absentTerms("MinerU pipeline backend runs on CPU", MINERU_DOC)
  expect(absent).not.toContain("mineru")
  expect(absent).not.toContain("pipeline")
  expect(absent).not.toContain("backend")
})

test("a term is present when it sits inside a longer word", () => {
  // Substring, not word match — a deliberate bias toward reporting FEWER
  // absences. A false alarm costs a reader's attention on every citation; a
  // missed one costs it only on the citations that were going to be wrong.
  expect(absentTerms("serve the request", "the server handles requests")).toEqual([])
})

test("terms shorter than the floor are not reported at all", () => {
  // A claim's clause about GPUs can be ungrounded and this rule does not
  // catch it. Pinned so the limitation is visible in the
  // suite rather than discovered later.
  expect(MIN_TERM_LENGTH).toBe(4)
  expect(absentTerms("gpu and cpu are absent here", "nothing relevant")).not.toContain("gpu")
  expect(claimTerms("gpu and cpu")).toEqual([])
})

test("stopwords are dropped, and the same term is reported once", () => {
  expect(claimTerms("This document would have been about that")).toEqual(["document"])
  // Deduped, not repeated: a term absent twice is one absence a reader acts on
  // once.
  expect(absentTerms("Docling and Docling", MINERU_DOC)).toEqual(["docling"])
})

test("matching ignores case and punctuation on both sides", () => {
  expect(absentTerms("The DOCLING-Serve default", "docling serve is the default here")).toEqual([])
})

test("an empty document makes every surviving term absent", () => {
  expect(absentTerms("Docling Serve default", "")).toEqual(["docling", "serve", "default"])
})
