/**
 * Scoring a strategy over a question set, and printing the result.
 */
import { answerable, countTokens, normalise } from "./answerable"
import type { Question } from "./questions"
import type { EvalEnv, Strategy } from "./strategies"

export interface StrategyResult {
  /** Questions whose context held every fact. */
  answerable: number
  /** Of those, the ones marked `held_out`. */
  held_out: number
  /** Of those, the ones with `hop: 2`. */
  multi_hop: number
  tokens_total: number
  tokens_mean: number
  /** Share of facts found in one of the first six ranked texts; null for a
   *  strategy that ranks nothing. */
  recall_at_6: number | null
  /** Mean over facts of 1 / the rank of the first ranked text holding it (0
   *  when none does); null for a strategy that ranks nothing. */
  mrr: number | null
}

export type Report = Record<string, StrategyResult>

/** Rank (1-based) of the first text containing the fact, or null. */
function rankOf(ranked: string[], fact: string): number | null {
  const needle = normalise(fact)
  const i = ranked.findIndex((t) => t.includes(needle))
  return i === -1 ? null : i + 1
}

export async function score(strategy: Strategy, questions: Question[], env: EvalEnv): Promise<StrategyResult> {
  let ok = 0
  let heldOut = 0
  let multiHop = 0
  let tokens = 0
  let facts = 0
  let within6 = 0
  let reciprocal = 0
  // A strategy that ranks for some questions and not others has no
  // comparable recall or MRR, so one unranked answer withholds both.
  let unranked = false
  for (const q of questions) {
    const { context, ranked: texts } = await strategy.retrieve(q, env)
    tokens += countTokens(context)
    if (answerable(context, q.facts)) {
      ok++
      if (q.held_out) heldOut++
      if (q.hop === 2) multiHop++
    }
    if (texts === undefined) {
      unranked = true
    } else {
      const ranked = texts.map(normalise)
      for (const f of q.facts) {
        facts++
        const r = rankOf(ranked, f)
        if (r !== null && r <= 6) within6++
        if (r !== null) reciprocal += 1 / r
      }
    }
  }
  const ranks = !unranked && facts > 0
  return {
    answerable: ok,
    held_out: heldOut,
    multi_hop: multiHop,
    tokens_total: tokens,
    tokens_mean: questions.length === 0 ? 0 : Math.round(tokens / questions.length),
    recall_at_6: ranks ? round(within6 / facts) : null,
    mrr: ranks ? round(reciprocal / facts) : null,
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** One row per strategy; counts are shown against how many questions could
 *  have scored them. */
export function formatTable(report: Report, questions: Question[]): string {
  const total = questions.length
  const held = questions.filter((q) => q.held_out).length
  const hops = questions.filter((q) => q.hop === 2).length
  const header = ["strategy", "answerable", "held-out", "multi-hop", "tokens mean", "recall@6", "MRR"]
  const rows = Object.entries(report).map(([id, r]) => [
    id,
    `${r.answerable}/${total}`,
    `${r.held_out}/${held}`,
    `${r.multi_hop}/${hops}`,
    String(r.tokens_mean),
    r.recall_at_6 === null ? "-" : r.recall_at_6.toFixed(3),
    r.mrr === null ? "-" : r.mrr.toFixed(3),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)))
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ")
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n")
}
