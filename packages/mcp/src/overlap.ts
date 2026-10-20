import type { Claim } from "@cairn-kb/protocol/types"

export function trigrams(text: string): Set<string> {
  const clean = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `
  const out = new Set<string>()
  for (let i = 0; i < clean.length - 2; i++) out.add(clean.slice(i, i + 3))
  return out
}

/** Dice coefficient over trigrams: 0 (nothing shared) to 1 (identical). */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a)
  const tb = trigrams(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return (2 * shared) / (ta.size + tb.size)
}

/**
 * Candidate claims this proposal may duplicate or contradict. A shared tag
 * lowers the bar, since same-topic claims are the ones worth comparing.
 */
export function findOverlaps(
  claimText: string,
  tags: string[],
  existing: Claim[],
  threshold = 0.4,
): string[] {
  return existing
    .map((c) => {
      const sharesTag = c.tags.some((t) => tags.includes(t))
      const score = similarity(claimText, c.claim)
      return { id: c.id, score, bar: sharesTag ? threshold * 0.75 : threshold }
    })
    .filter((r) => r.score >= r.bar)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.id)
}
