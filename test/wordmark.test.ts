import { expect, test } from "bun:test"
import { WORDMARK_COLUMNS, wordmark } from "../src/wordmark"

/**
 * The mark itself, and the width guard that decides whether it is drawn at all.
 *
 * The drawing is asserted as a literal picture rather than by property. A
 * property — "five letters wide", "four rows" — passes on a mark that has
 * become unreadable, and unreadable is the only way this can fail: nothing
 * downstream parses it. The literal is also the only place a reviewer can see
 * what shipped without running it.
 */

test("the mark spells cairn", () => {
  expect(wordmark(80)!.join("\n")).toBe(
    [
      "              ▀▀",
      "▄█▀▀▀▀  ▀▀▀█▄ ██ ██▄▀▀ ██▄▀██",
      "██     ▄█▀▀██ ██ ██    ██  ██",
      "▀█▄▄▄▄ ▀█▄▄██ ██ ██    ██  ██",
    ].join("\n"),
  )
})

test("the declared width is the width that is drawn", () => {
  // The guard below compares the terminal against WORDMARK_COLUMNS, so a
  // declared width smaller than the drawing is a mark that wraps in exactly
  // the terminals the guard claims to have cleared. Both directions: no row
  // may exceed it, and one row must reach it, or the number is merely large
  // enough rather than right.
  const rows = wordmark(WORDMARK_COLUMNS)!
  for (const row of rows) expect([...row].length).toBeLessThanOrEqual(WORDMARK_COLUMNS)
  expect(Math.max(...rows.map((r) => [...r].length))).toBe(WORDMARK_COLUMNS)
})

test("no row carries trailing blanks", () => {
  // Invisible and still counted: a trailing space pushes a row past the width
  // the guard just cleared, and the mark wraps by one column.
  for (const row of wordmark(80)!) expect(row).toBe(row.trimEnd())
})

test("a terminal exactly as wide as the mark draws it; one column narrower does not", () => {
  expect(wordmark(WORDMARK_COLUMNS)).not.toBeNull()
  expect(wordmark(WORDMARK_COLUMNS - 1)).toBeNull()
})

test("no width at all is not a narrow terminal — it is not a terminal", () => {
  // `process.stdout.columns` is undefined when stdout is a pipe or a file.
  // Nothing is being laid out there, and a 29-column band of half blocks in a
  // log is noise nobody asked for.
  expect(wordmark(undefined)).toBeNull()
})
