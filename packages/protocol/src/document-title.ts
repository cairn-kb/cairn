/**
 * What a document is called, with NO IMPORTS AT ALL.
 *
 * Extracted from the CLI's src/documents.ts so the hosted service can use it.
 * That module pulls `node:path` and `gray-matter`, which is why the answer
 * is an extraction rather than a compatibility flag: a flag would have made a
 * dependency that should not exist work.
 *
 * THE FALLBACK IS THE CALLER'S, AND THE TWO CALLERS DIFFER ON PURPOSE.
 * `cairn import` passes `basename(path)` and keeps the extension; the hosted
 * service strips it. Two reasons, both concrete, and neither is tidiness:
 *
 *   1. Changing the CLI's fallback would RENAME existing documents on the next
 *      `cairn import`, because a re-import rewrites the title in place.
 *   2. The hosted import is a batch, so nobody gets to fix a title before it
 *      is written. `handbook` is the right title where `handbook.pdf` is the
 *      right file.
 *
 * Do not "fix" the inconsistency by making them match.
 */
export function titleOf(text: string, fallback: string): string {
  const heading = text.split("\n").find((l) => l.startsWith("#"))
  return heading ? heading.replace(/^#+\s*/, "") : fallback
}
