/**
 * A question set: what to ask, and the literal facts a context must hold for
 * an agent reading it to answer.
 */
import { readFileSync } from "node:fs"

export interface Question {
  id: string
  question: string
  /** Short literal substrings of the corpus, matched after `normalise`. */
  facts: string[]
  /** 2 when the facts sit in two different documents. */
  hop: 1 | 2
  /** Kept out of tuning, so it can decide whether a change helped. */
  held_out: boolean
}

export interface QuestionSet {
  /** The corpus commit the facts were written against; null for a set that
   *  ships beside its corpus. */
  corpus_commit: string | null
  questions: Question[]
}

/** Reads and checks a set. A malformed entry throws, naming it: a question
 *  that silently scores zero would read as a retrieval failure. */
export function loadQuestions(path: string): QuestionSet {
  const raw = Bun.YAML.parse(readFileSync(path, "utf-8")) as unknown
  if (!raw || typeof raw !== "object") throw new Error(`${path}: not a question set`)
  const set = raw as Record<string, unknown>
  const commit = set.corpus_commit ?? null
  if (commit !== null && typeof commit !== "string") throw new Error(`${path}: corpus_commit must be a sha or null`)
  if (!Array.isArray(set.questions)) throw new Error(`${path}: questions must be a list`)

  const seen = new Set<string>()
  const questions = set.questions.map((entry, i): Question => {
    const q = (entry ?? {}) as Record<string, unknown>
    const where = `${path}: question ${typeof q.id === "string" ? q.id : `#${i + 1}`}`
    if (typeof q.id !== "string" || q.id === "") throw new Error(`${where}: id must be a non-empty string`)
    if (seen.has(q.id)) throw new Error(`${where}: id is used twice`)
    seen.add(q.id)
    if (typeof q.question !== "string" || q.question.trim() === "") throw new Error(`${where}: question is empty`)
    if (
      !Array.isArray(q.facts) ||
      q.facts.length === 0 ||
      !q.facts.every((f) => typeof f === "string" && f.trim() !== "")
    ) {
      throw new Error(`${where}: facts must be a list of non-empty strings`)
    }
    if (q.hop !== 1 && q.hop !== 2) throw new Error(`${where}: hop must be 1 or 2`)
    if (typeof q.held_out !== "boolean") throw new Error(`${where}: held_out must be true or false`)
    return { id: q.id, question: q.question, facts: q.facts as string[], hop: q.hop, held_out: q.held_out }
  })
  return { corpus_commit: commit as string | null, questions }
}
