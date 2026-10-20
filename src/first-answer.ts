import { createTools, type SearchResult } from "./mcp"
import type { EventSink } from "./events"
import { statsFromEvents } from "@cairn-kb/protocol/stats"
import type { Store } from "@cairn-kb/protocol/types"

/** A README adds nothing to "what does this say about the project" — every
 *  repo has one and it rarely says more than the title already does. */
const SKIPPED_TITLE = /^readme(\.md)?$/i

export interface FirstQuestion {
  query: string
  question: string
}

/**
 * Picks the first imported title worth asking about, in import order, and
 * phrases it as a question for `cairn init` to ask and answer on the spot.
 *
 * Skips README titles and the repo label itself — both too generic to make
 * a convincing first answer — and falls back to the label when nothing else
 * is left, so there is always a query to run.
 */
export function suggestQuestion(titles: string[], label: string): FirstQuestion {
  const query = titles.find((title) => !SKIPPED_TITLE.test(title) && title !== label) ?? label
  return { query, question: `What does "${query}" say about how this project works?` }
}

/**
 * Discards every event handed to it. `kbSearch` logs a `search` event as
 * part of running one — see `createTools` in `packages/mcp/src/tools.ts` — and `init`'s own
 * demonstration search is not a real agent asking a real question, so it
 * must not move `stats().searches` the way one would.
 */
const NULL_SINK: EventSink = {
  async append() {},
  async appendMany() {},
  async all() {
    return []
  },
  async allStrict() {
    return []
  },
  async stats() {
    return statsFromEvents([])
  },
}

/**
 * Runs `suggestQuestion`'s query through the same search path
 * `team_knowledge_search` uses, so `init`'s first answer is a real result and
 * not a canned one — but through `NULL_SINK`, so it never counts against the
 * space's own search stats.
 */
export async function firstAnswer(store: Store, query: string): Promise<SearchResult> {
  return createTools(store, NULL_SINK).kbSearch(query, 3)
}
