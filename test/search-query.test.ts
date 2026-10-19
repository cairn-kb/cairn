import { expect, test } from "bun:test"
import { ftsQuery } from "../src/search-query"

test("each term is quoted and OR-joined", () =>
  expect(ftsQuery("how do we deploy")).toBe('"how" OR "do" OR "we" OR "deploy"'))

test("quotes are doubled so they cannot end a term", () =>
  expect(ftsQuery('say "hi')).toBe('"say" OR """hi"'))

test("operators are inert words", () => expect(ftsQuery("NOT *")).toBe('"NOT" OR "*"'))

test("blank text has no query", () => {
  expect(ftsQuery("")).toBeNull()
  expect(ftsQuery(" \t\n")).toBeNull()
})

test("ASCII control characters are stripped before splitting", () => {
  // A NUL byte (or any other C0 control or DEL) reaching SQLite's FTS5
  // tokenizer raw used to throw rather than return no match. Stripping them
  // first means a term built around one is still a term, not a crash.
  expect(ftsQuery("x\u0000y")).toBe('"xy"')
  expect(ftsQuery("\u0000")).toBeNull()
})
