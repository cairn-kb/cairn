import { expect, test } from "bun:test"
import { hashText } from "@cairn-kb/protocol/hash"
import {
  READ_WINDOW, makeDocId, titleOf, normalizeSource, previewOf, windowOf,
  serializeDocument, parseDocument, parseImport,
} from "../src/documents"
import type { Document } from "@cairn-kb/protocol/types"

const doc = (over: Partial<Document> = {}): Document => ({
  id: "doc-2026-09-01-using-mineru-a1b2c3",
  title: "Using MinerU",
  text: "# Using MinerU\n\nIt wants Python 3.10.",
  source: "tools/mineru.md",
  created: "2026-09-01T09:00:00.000Z",
  updated: "2026-09-01T09:00:00.000Z",
  hash: "abc",
  ...over,
})

test("a document id is distinguishable from a claim id by prefix alone", async () => {
  // cairn show and team_knowledge_read route on this prefix rather than
  // guessing with a speculative claim lookup.
  expect(makeDocId("Using MinerU", new Date("2026-09-01"))).toStartWith("doc-")
})

test("two documents with the same title get different ids", () => {
  const a = makeDocId("Using MinerU", new Date("2026-09-01"))
  const b = makeDocId("Using MinerU", new Date("2026-09-01"))
  expect(a === b).toBe(false)
})

test("the hash is of the text alone and is stable", async () => {
  expect(await hashText("hello")).toBe(await hashText("hello"))
  expect(await hashText("hello") === (await hashText("hello "))).toBe(false)
  // 64 hex characters: SHA-256, the same encoding the hosted service uses,
  // because both sides compute this and must agree.
  expect((await hashText("hello")).length).toBe(64)
})

test("the title is the first heading, or the filename when there is none", () => {
  expect(titleOf("# Using MinerU\n\nbody", "/tmp/seed/x.md")).toBe("Using MinerU")
  expect(titleOf("no heading here", "/tmp/seed/mineru-notes.md")).toBe("mineru-notes.md")
})

test("source is relative to the imported directory, with POSIX separators", () => {
  expect(normalizeSource("/tmp/seed", "/tmp/seed/specs/auth.md")).toBe("specs/auth.md")
  expect(normalizeSource("/tmp/seed/", "/tmp/seed/auth.md")).toBe("auth.md")
})

test("a preview is a prefix, and says so by being one", () => {
  const long = doc({ text: "x".repeat(500) })
  // 240 characters of text plus the title and a separator — never a summary,
  // and never the whole document.
  expect(previewOf(long).length < 500).toBe(true)
  expect(previewOf(long).startsWith("Using MinerU")).toBe(true)
})

test("a window reports where to continue, and null when there is no more", () => {
  const text = "y".repeat(READ_WINDOW + 10)
  const first = windowOf(text, 0)
  expect(first.text.length).toBe(READ_WINDOW)
  expect(first.length).toBe(READ_WINDOW + 10)
  expect(first.nextOffset).toBe(READ_WINDOW)
  const second = windowOf(text, READ_WINDOW)
  expect(second.text.length).toBe(10)
  expect(second.nextOffset).toBeNull()
  // Concatenating the windows reproduces the document exactly: a window that
  // drops or repeats a character is the failure this catches.
  expect(first.text + second.text).toBe(text)
})

test("an offset past the end is an empty final window, not a crash", () => {
  const w = windowOf("short", 99)
  expect(w.text).toBe("")
  expect(w.nextOffset).toBeNull()
})

test("a document survives a round trip through disk", () => {
  const d = doc()
  expect(parseDocument(serializeDocument(d))).toEqual(d)
})

test("a document with no source round-trips as null, not as the string 'null'", () => {
  // Adopted documents have no path. A source that comes back as "null" would
  // match nothing on re-import and would be created a second time.
  const d = doc({ source: null })
  expect(parseDocument(serializeDocument(d)).source).toBeNull()
})

test("frontmatter is metadata, not body: an imported file arrives parsed", () => {
  // A memory note opens with a `---` fence and carries no heading, so the
  // title degraded to the filename and the 240-character preview was YAML.
  const raw = '---\nname: a-note\ndescription: "the one-line summary"\n---\n\nBody.\n'
  const parsed = parseImport(raw, "/tmp/fm/a-note.md")
  expect(parsed.title).toBe("a-note")
  expect(parsed.text).toBe("the one-line summary\n\nBody.")
})

test("a frontmatter title outranks a heading, which outranks the filename", () => {
  const fm = (front: string, body: string) => parseImport(`---\n${front}\n---\n\n${body}`, "/tmp/fm/x.md")
  expect(fm("title: The Title\nname: the-name", "# Heading\n\nbody").title).toBe("The Title")
  expect(fm("name: the-name", "# Heading\n\nbody").title).toBe("the-name")
  expect(fm("other: 1", "# Heading\n\nbody").title).toBe("Heading")
  expect(fm("other: 1", "no heading").title).toBe("x.md")
})

test("a file with no frontmatter imports exactly as it did before", () => {
  expect(parseImport("# Using MinerU\n\nIt wants Python 3.10.", "/tmp/seed/x.md")).toEqual({
    title: "Using MinerU",
    text: "# Using MinerU\n\nIt wants Python 3.10.",
  })
  expect(parseImport("no heading here", "/tmp/seed/mineru-notes.md").title).toBe("mineru-notes.md")
})

test("malformed frontmatter imports the file whole rather than throwing", () => {
  // A half-written `---` fence in a corpus is ordinary. The file is worth less
  // parsed than it is unimported.
  const raw = '---\nname: "unclosed\n  bad: [\n---\n\nBody.'
  const parsed = parseImport(raw, "/tmp/fm/broken.md")
  expect(parsed.title).toBe("broken.md")
  expect(parsed.text).toBe(raw.trim())
})

test("a description with no body is still a document", () => {
  const parsed = parseImport('---\ndescription: "just the summary"\n---\n', "/tmp/fm/d.md")
  expect(parsed.text).toBe("just the summary")
})
