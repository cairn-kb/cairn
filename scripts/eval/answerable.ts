/**
 * How a context is scored: whether it holds every fact a question needs, and
 * how many tokens an agent pays to read it.
 */
import { getEncoding, type Tiktoken } from "js-tiktoken"

/**
 * Both sides of a match go through this: lowercased, `*`, `_` and `` ` ``
 * removed, and every run of whitespace collapsed to one space. Markdown
 * emphasis and a line break in the middle of a sentence are formatting, not a
 * different fact.
 */
export function normalise(s: string): string {
  return s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim()
}

/** True when the context holds every fact. A two-hop question needs both. */
export function answerable(context: string, facts: string[]): boolean {
  const haystack = normalise(context)
  return facts.every((f) => haystack.includes(normalise(f)))
}

let encoder: Tiktoken | null = null

/** Tokens in `s`, counted with `cl100k_base`. */
export function countTokens(s: string): number {
  encoder ??= getEncoding("cl100k_base")
  return encoder.encode(s).length
}
