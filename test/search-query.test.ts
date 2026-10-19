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
