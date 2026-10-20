/**
 * Retrieval strategies: each turns a question into the context an agent would
 * read to answer it.
 */
import { Database } from "bun:sqlite"
import type { Document, Store } from "@cairn-kb/protocol/types"
import type { EventSink } from "../../src/events"
import { ftsQuery } from "../../src/search-query"
import type { Question } from "./questions"

/**
 * What a strategy can reach: the store the corpus was imported into, and an
 * event sink, so a strategy can call `createTools(env.store, env.log)` the way
 * an agent's MCP server would. `memo` builds a strategy's own per-run state
 * (an index, say) once, however many questions are asked.
 */
export interface EvalEnv {
  store: Store
  log: EventSink
  memo<T>(key: string, build: () => Promise<T>): Promise<T>
}

/** What a strategy hands back for one question, from one search. */
export interface Retrieval {
  /** Everything the agent would read for this question, as one string. */
  context: string
  /** The texts of the passages (or documents) it ranked, best first. Recall@6
   *  and MRR read this; a strategy without it reports neither. */
  ranked?: string[]
}

export interface Strategy {
  id: string
  retrieve(q: Question, env: EvalEnv): Promise<Retrieval>
}

/** How deep `doc-bm25` ranks for recall@6 and MRR. */
const RANK_DEPTH = 50

/** A whole-document FTS5 index of its own, built over the imported documents.
 *  Never `store.searchDocuments`: that search can change underneath the
 *  baseline, and the baseline must keep measuring the same thing. */
async function docIndex(env: EvalEnv): Promise<{ db: Database; byId: Map<string, Document> }> {
  return env.memo("doc-bm25", async () => {
    const docs = await env.store.listDocuments()
    const db = new Database(":memory:")
    db.run("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, title, text)")
    const insert = db.prepare("INSERT INTO docs (id, title, text) VALUES (?, ?, ?)")
    db.transaction(() => {
      for (const d of docs) insert.run(d.id, d.title, d.text)
    })()
    return { db, byId: new Map(docs.map((d) => [d.id, d])) }
  })
}

async function rankDocuments(q: Question, env: EvalEnv, limit: number): Promise<Document[]> {
  const match = ftsQuery(q.question)
  if (match === null) return []
  const { db, byId } = await docIndex(env)
  const rows = db
    .query<{ id: string }, [string, number]>("SELECT id FROM docs WHERE docs MATCH ? ORDER BY bm25(docs), title, id LIMIT ?")
    .all(match, limit)
  return rows.map((r) => byId.get(r.id)).filter((d): d is Document => d !== undefined)
}

/** The top two documents read in full. */
const docBm25: Strategy = {
  id: "doc-bm25",
  async retrieve(q, env) {
    const docs = await rankDocuments(q, env, RANK_DEPTH)
    return {
      context: docs
        .slice(0, 2)
        .map((d) => d.text)
        .join("\n\n"),
      ranked: docs.map((d) => d.text),
    }
  },
}

export const STRATEGIES: Record<string, Strategy> = {
  [docBm25.id]: docBm25,
}
