import { ABSTRACT_GUIDANCE } from "./mcp"

/**
 * The word limit the shared guidance states. Read from the guidance text
 * rather than restated, so the two cannot drift apart.
 */
const MAX_WORDS = Number(/(\d+) words maximum/.exec(ABSTRACT_GUIDANCE)?.[1] ?? 40)

/**
 * The plausibility bar for a model-written abstract. Shared by `cairn model
 * --verify` and ordinary backfill, so a model that passes verification is the
 * same model whose output reaches the store.
 *
 * Deliberately conservative: it asks "could this plausibly be an abstract",
 * not "does it match the template". The guidance asks for a shape, not
 * literal words, so this does not require "settles" or "does not settle",
 * and it does not reject on word count alone — a terse but useful abstract
 * (`"Caches DNS lookups."`) is exactly the kind of reply the guidance wants,
 * and a count floor would reject it next to the bare labels it exists for.
 * Bare labels are caught by their SHAPE instead: a single token, with or
 * without trailing punctuation (`SAFE`, `Safe.`), or a label/value verdict
 * with a colon and no sentence ending.
 *
 * Returns the trimmed text. Throws an ordinary Error naming the reason, so
 * callers report it the way they report any other generation failure.
 * Provider truncation is NOT checked here — that stays a provider error.
 */
export function plausibleAbstract(raw: string): string {
  const text = raw.trim()
  if (!text) throw new Error("the reply was empty")

  const words = text.split(/\s+/)
  const hasSentenceEnding = /[.!?]/.test(text)

  // A single token is a bare label or verdict ("SAFE", "benign") regardless
  // of trailing punctuation — "Safe." is still one word, not a sentence; a
  // period does not turn a label into prose. Two or more words can still be a
  // genuine terse sentence ("Caches DNS lookups.") and stay accepted below.
  if (words.length === 1) {
    throw new Error(`the reply is a bare label, not a sentence: "${text}"`)
  }
  // A label/value verdict such as "Safety classification: unsafe" has a colon
  // and no sentence ending. Prose can contain a colon, so this needs both.
  if (text.includes(":") && !hasSentenceEnding) {
    throw new Error(`the reply reads as a label and value, not a sentence: "${text}"`)
  }
  if (words.length > MAX_WORDS) {
    throw new Error(`the reply is ${words.length} words; the guidance allows ${MAX_WORDS}`)
  }
  return text
}
