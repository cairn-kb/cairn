import type { Document } from "@cairn-kb/protocol/types"

/** How much of a document one `team_knowledge_read` returns. Characters, not
 *  tokens, which keeps this independent of any one model's tokenizer. */
export const READ_WINDOW = 4000
/** How much of a document a search hit shows. */
export const PREVIEW_CHARS = 240

export function previewOf(doc: Document): string {
  return `${doc.title} — ${doc.text.slice(0, PREVIEW_CHARS)}`
}

export function windowOf(
  text: string,
  offset: number,
): { text: string; offset: number; length: number; nextOffset: number | null } {
  const start = Math.max(0, Math.min(offset, text.length))
  const slice = text.slice(start, start + READ_WINDOW)
  const end = start + slice.length
  return { text: slice, offset: start, length: text.length, nextOffset: end < text.length ? end : null }
}
