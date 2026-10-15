import { expect, test } from "bun:test"
import { colorsEnabled, createUi, progressLine } from "../src/ui"

// --- colorsEnabled --------------------------------------------------------

test("colour is on for an interactive terminal", () => {
  expect(colorsEnabled({}, true)).toBe(true)
})

test("colour is off when output is piped", () => {
  expect(colorsEnabled({}, false)).toBe(false)
})

test("NO_COLOR wins even on a terminal", () => {
  expect(colorsEnabled({ NO_COLOR: "1" }, true)).toBe(false)
})

test("an empty NO_COLOR still disables colour", () => {
  // The convention is presence, not truthiness.
  expect(colorsEnabled({ NO_COLOR: "" }, true)).toBe(false)
})

// --- createUi -------------------------------------------------------------

test("plain mode emits no escape sequences at all", () => {
  const ui = createUi(false)
  const out = [ui.bold("a"), ui.dim("b"), ui.green("c"), ui.yellow("d"), ui.cyan("e")].join("")
  expect(out).toBe("abcde")
  expect(out).not.toContain("")
})

test("colour mode wraps text in escape sequences", () => {
  const ui = createUi(true)
  expect(ui.green("ok")).toContain("")
  expect(ui.green("ok")).toContain("ok")
})

test("symbols survive plain mode so piped output stays readable", () => {
  const ui = createUi(false)
  expect(ui.ok("written")).toBe("✓ written")
  expect(ui.skip("unchanged")).toBe("· unchanged")
  expect(ui.warn("needs you")).toBe("! needs you")
})

test("symbols carry colour when colour is on", () => {
  const ui = createUi(true)
  expect(ui.ok("written")).toContain("✓")
  expect(ui.ok("written")).toContain("")
})

// --- progressLine ---------------------------------------------------------

test("progress shows position against the total", () => {
  expect(progressLine(12, 48, "imported")).toContain("12/48")
  expect(progressLine(12, 48, "imported")).toContain("imported")
})

test("progress handles the final item without overflowing", () => {
  expect(progressLine(48, 48, "imported")).toContain("48/48")
})
