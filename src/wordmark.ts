/**
 * The `cairn` wordmark, as terminal rows.
 *
 * Deliberately a glyph table rather than OpenTUI's `ASCIIFontRenderable`:
 * `fonts` and `measureText` are reachable only through `@opentui/core`'s main
 * entry (its `exports` map has no `./lib/*` subpath), which pulls in the
 * renderer and its native library, and `renderFontToFrameBuffer` writes into an
 * `OptimizedBuffer` — there is no render-to-plain-text path. Two of the three
 * places this mark is drawn are reached from `src/cli.ts`, which
 * `test/cli.test.ts` keeps free of `@opentui/core` on the static import graph
 * so `cairn mcp` cannot corrupt the MCP stream with an escape sequence. So: a
 * few dozen lines of string data, no dependency, no native library.
 *
 * Drawn with half blocks, two pixel rows to a terminal cell. A cell is about
 * twice as tall as it is wide, so the letterforms below are designed on a grid
 * twice as tall as the rows they print on; full blocks at this size would give
 * letters stretched to twice their intended height.
 */

/** `#` is on, `.` is off. Eight rows: the dot of the `i`, the gap under it, and
 *  six rows of x-height. Every glyph carries all eight so the rows line up
 *  without any per-glyph baseline arithmetic — the four letters with nothing
 *  above the x-height simply start blank. */
const GLYPHS: Record<string, readonly string[]> = {
  c: [
    "......",
    "......",
    ".#####",
    "##....",
    "##....",
    "##....",
    "##....",
    ".#####",
  ],
  a: [
    "......",
    "......",
    ".####.",
    "....##",
    ".#####",
    "##..##",
    "##..##",
    ".#####",
  ],
  i: [
    "##",
    "..",
    "##",
    "##",
    "##",
    "##",
    "##",
    "##",
  ],
  r: [
    ".....",
    ".....",
    "##.##",
    "###..",
    "##...",
    "##...",
    "##...",
    "##...",
  ],
  n: [
    "......",
    "......",
    "##.###",
    "###.##",
    "##..##",
    "##..##",
    "##..##",
    "##..##",
  ],
}

const WORD = "cairn"
/** Pixel columns between two letters. */
const GAP = 1
/** Pixel rows. Even, because two of them share a cell. */
const PIXEL_ROWS = 8

const width = (ch: string) => GLYPHS[ch]![0]!.length

/** Columns the drawn mark occupies, derived from the table rather than typed
 *  in beside it: a hand-kept number goes wrong the first time a letterform is
 *  redrawn a column wider, and the guard below is the only thing standing
 *  between a narrow terminal and a mark that wraps into rubble. */
export const WORDMARK_COLUMNS =
  [...WORD].reduce((n, ch) => n + width(ch), 0) + GAP * (WORD.length - 1)

/** Rows of the wordmark, or `null` when it does not fit.
 *
 *  `null` rather than a plain-text `cairn`, because every place this is drawn
 *  already says the word in plain text — the usage synopsis, `init`'s closing
 *  line — or has a sentence of its own that the mark was only ever decorating.
 *  A caller that prints its own fallback keeps that text in one place instead
 *  of choosing between two spellings of the same word.
 *
 *  `undefined` columns means stdout is not a terminal: piped output has no
 *  width to guard against, and a 29-column band of half blocks in a log or a
 *  pipe is noise nobody asked for. */
export function wordmark(columns: number | undefined): string[] | null {
  if (columns === undefined || columns < WORDMARK_COLUMNS) return null
  const pixels = Array.from({ length: PIXEL_ROWS }, (_, row) =>
    [...WORD].map((ch) => GLYPHS[ch]![row]!).join(".".repeat(GAP)),
  )
  const lines: string[] = []
  for (let row = 0; row < PIXEL_ROWS; row += 2) {
    const top = pixels[row]!
    const bottom = pixels[row + 1]!
    let line = ""
    for (let col = 0; col < top.length; col++) {
      const above = top[col] === "#"
      const below = bottom[col] === "#"
      line += above && below ? "█" : above ? "▀" : below ? "▄" : " "
    }
    // Trailing blanks are invisible and still count: they push a line past the
    // terminal's width and wrap the mark by one column.
    lines.push(line.trimEnd())
  }
  return lines
}
