import { expect, test } from "bun:test"
import { titleOf } from "@cairn-kb/protocol/document-title"

test("takes the first heading", () => {
  expect(titleOf("# Using MinerU\n\ntext", "notes.md")).toBe("Using MinerU")
})

test("strips any depth of hash and the space after it", () => {
  expect(titleOf("### Deep\n", "notes.md")).toBe("Deep")
})

test("falls back to what the caller supplies when there is no heading", () => {
  // The fallback is the CALLER's, and the two callers differ on purpose:
  // the CLI passes `basename(path)` and keeps the extension, the console
  // strips it. See packages/protocol/src/document-title.ts.
  expect(titleOf("no heading here", "notes.md")).toBe("notes.md")
})

test("a heading later in the file still wins over the fallback", () => {
  expect(titleOf("intro\n\n# Later\n", "notes.md")).toBe("Later")
})
