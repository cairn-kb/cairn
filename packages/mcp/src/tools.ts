import { findOverlaps } from "./overlap"
import { previewOf, windowOf } from "./view"
import { EMPTY_SUPPORTS, unknownDocumentMessage } from "@cairn-kb/protocol/event-kinds"
import type { EventKind } from "@cairn-kb/protocol/stats"
import type { CiteInput, Claim, ImportOutcome, Status, Store } from "@cairn-kb/protocol/types"
import { SEARCH_GUIDANCE } from "./guidance"

/** The precision bar lives here: tunable without a code change. */
export const PROPOSE_DESCRIPTION = `Propose a piece of durable team knowledge for human review.

Use this only for knowledge the whole team benefits from later: decisions and why \
they were made, gotchas that cost someone an hour, conventions the team follows. \
Not task status, not what is already visible in the code, not anything true only \
for this session. Proposing rarely and well is better than proposing often.`

/**
 * What an abstract must contain. It is coverage-aware on purpose: an abstract
 * that sounds complete but omits something makes a reading agent stop
 * searching too early. Tunable here without a code change.
 */
export const ABSTRACT_GUIDANCE = `One or two sentences an agent will read to decide whether to open this claim. \
Name what it settles — the systems, decisions and entities involved — then state what it does NOT settle, so an \
agent knows when it still needs to look elsewhere. No preamble, 40 words maximum.`

/**
 * What a citation asserts, and — the part that had to be said — when there is
 * nothing to cite.
 *
 * CONSTRAINING, NOT ENCOURAGING, deliberately. The when-to-cite sentence was
 * removed from `team_knowledge_search`'s description when `cite` shipped,
 * because a description that tells agents to cite makes a non-empty
 * `cites` measure instruction-following rather than agents actually grounding
 * anything. Nothing here tells an agent to cite more; every sentence narrows
 * what a citation may be attached to, so what that removal protects stays
 * intact.
 *
 * The last paragraph exists because of claims settled in a design discussion,
 * which no document in the space could ever ground. An agent needing evidence
 * attaches the nearest documents about something else, and the absence report
 * then reports the headline term missing from all of them, which reads as a
 * weak citation when the truth is that the claim should never have been asked
 * for one. A claim can be a
 * DERIVED claim, taken from source material, or a DECIDED claim, settled by
 * people; only the first kind has a document to point at.
 */
export const CITE_DESCRIPTION = `Attach a document to an existing claim as the source it was written from. \
The citation records what you say the document supports, the document's content hash at this moment, and which \
words of the claim do not appear in the document at all. It takes effect immediately and changes no claim's \
review status. A document already cited by this claim is refused rather than replaced.

Cite only a document you have actually read, and only when it states the thing you say it states. The absence \
report notes words that are missing; it cannot tell whether the document supports the claim, and nothing else \
checks that either — the "supports" you write is the only account of it anyone gets.

Some claims have no document to cite, and for those the right number of citations is zero. A decision the team \
reached in conversation is grounded in that discussion, not in any file — put the reasoning in the claim's body \
and cite nothing. Attaching the nearest related document to a claim like that does not ground it; it makes an \
ungrounded claim look sourced, which is worse than leaving it bare.`

/** What `generated` on a document means, said in both tools that return one. */
export const GENERATED_NOTE =
  "A document with generated: true was written by an agent from the code; treat it as " +
  "inference, not a team decision."

/**
 * Names the gap rather than papering over it: a claim can land with no
 * abstract written for it, and an admitted absence is worth more to a
 * reading agent than a title dressed up as a summary. Import writes
 * documents now, never claims, so a null abstract no longer marks imported
 * material specifically — it only ever means nobody has written one yet.
 */
export const MAP_DESCRIPTION = `What the team already knows: every approved claim, each with its abstract.

An entry whose abstract is null has none written — its claim sentence is all there is, and a claim sentence alone \
does not tell you what the claim covers. Read the claim in full before relying on it.`

/**
 * Lands in the host's system prompt at connect time.
 *
 * The map-first rule used to open MAP_DESCRIPTION. It is load-bearing —
 * reads-per-session is only computable because agents
 * call `map` at session start — but a tool description is the wrong slot for
 * it twice over. Anthropic's connector review criteria reject descriptions
 * that "tell Claude to behave in ways unrelated to the tool's function"; and a
 * sentence about WHEN to call a tool is not a description of what that tool
 * returns, so it made MAP_DESCRIPTION worse at its actual job.
 *
 * It also means a user no longer has to paste this rule into their own
 * CLAUDE.md by hand for the counter to work.
 *
 * It opens with the search guidance from the instructions block `cairn init`
 * writes, word for word, so a host that never reads that block is still told
 * when to search. The search description says what the tool holds, and the
 * instruction to search first lives in SEARCH_GUIDANCE.
 */
export const SERVER_INSTRUCTIONS =
  SEARCH_GUIDANCE +
  "\n\n" +
  "Call team_knowledge_map at the start of a session to see what the team already knows, " +
  "passing your agent name and a stable session id."

/**
 * What an agent needs to know before writing an overview nobody asked it to
 * cite. The text it writes will be shown to people exactly as given — this is
 * not a draft a human edits before it is visible — and `repo` is the label
 * the person who asked it to run gave it, not a guess: using the wrong one
 * mislabels the document for everyone who reads it afterwards.
 */
export const WRITE_DOCUMENT_DESCRIPTION = `Write an overview document into this space, labelled generated so people \
can tell a machine wrote it. The text is shown to people exactly as you write it — there is no draft stage.

\`repo\` is the repository label you were given for this work, not one you invent. \`slug\` names the document within \
that repo and must be lowercase letters, digits and hyphens only, such as "architecture" — it becomes part of the \
document's identity, so it cannot contain "/" or "..". Calling this again with the same repo and slug replaces that \
document's text in place rather than creating a second one, which is how you keep an overview current as the repo \
changes.`

/**
 * Which transport a tool call arrived over: `cairn mcp`'s stdio, or the hosted
 * service's connector. The map, read and search events the tools append carry
 * it as `meta.via`, so a count can be split by where agents actually reach the
 * space from. Propose and cite events are the store's to write, and do not.
 */
export type Via = "stdio" | "connector"

/**
 * Exactly the store methods the tools call — `tsc` holds this list to what
 * `createTools` uses. A human-only write (`uncite`, `review`, `retract`) or a
 * bulk import path is not reachable from an agent's tool call, because it is
 * not on this type at all.
 */
export type ToolStore = Pick<
  Store,
  "list" | "get" | "getDocument" | "search" | "searchDocuments" | "propose" | "cite" | "writeGenerated"
>

/** One entry for `appendMany`. The same three fields `append` takes. */
export interface EventInput {
  kind: EventKind
  id?: string
  meta?: Record<string, unknown>
}

/**
 * All an event log has to do for the tools: record. Reading the log back is
 * the CLI's business (stats, adoption guards), not the tool surface's.
 */
export interface ToolSink {
  append(kind: EventKind, id?: string, meta?: Record<string, unknown>): Promise<void>
  appendMany(events: EventInput[]): Promise<void>
}

export interface ProposeInput {
  claim: string
  body: string
  abstract: string
  author: string
  agent: string
  repo?: string
  session?: string
  tags?: string[]
}

/** Who is asking. team_knowledge_map is the call agents make at session start,
 *  which is what makes reads-per-session computable at all. */
export interface MapContext {
  agent?: string
  session?: string
}

/**
 * What an agent navigates by. `abstract` is null when nobody wrote one, so the
 * two fields cannot be confused: `claim` is an assertion, `abstract` is a
 * statement of coverage, and only the latter can be trusted to bound what
 * opening the claim would add.
 */
export interface MapEntry {
  id: string
  claim: string
  abstract: string | null
}

/**
 * What a search hit is, discriminated by `kind` so a caller can tell a
 * vouched-for claim from raw source material without a second lookup. A
 * document hit carries `preview` — see `previewOf` in ./view.ts — and
 * never the whole text: search is for deciding what to read next, not for
 * reading.
 */
export type SearchHit =
  | {
      kind: "claim"
      id: string
      /** The sentence a human judged. */
      claim: string
      abstract: string | null
      tags: string[]
      status: Status
    }
  | {
      kind: "document"
      id: string
      title: string
      source: string | null
      preview: string
      /** A machine wrote this document; never a team decision. */
      generated: boolean
      /** The repository label the document came from, or null when it has none. */
      repo: string | null
    }

/** How many hits of EACH kind a search returns when the caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 10
/** How many entries `team_knowledge_map` returns when the caller names no limit. */
export const DEFAULT_MAP_LIMIT = 50

/**
 * A bounded response, with the truncation stated rather than implied. An agent
 * that reads only `hits` still behaves correctly; one that reads `notice`
 * learns there is more and how to reach it.
 */
export interface SearchResult {
  hits: SearchHit[]
  /** Matches left out by the limit, across both kinds. 0 when nothing was cut. */
  omitted: number
  /** Present only when `omitted` is non-zero. */
  notice?: string
}

export interface MapResult {
  entries: MapEntry[]
  omitted: number
  notice?: string
}

/**
 * What `team_knowledge_read` hands back for a document id. `text` is at most
 * `READ_WINDOW` characters — see ./view.ts — with `offset` and
 * `length` naming where in the full document this slice sits, and
 * `nextOffset` either where to continue or `null` once the document is
 * exhausted. Documents have no status, so unlike `Claim` there is nothing
 * here to gate.
 */
export interface ReadDocument {
  kind: "document"
  id: string
  title: string
  source: string | null
  /**
   * The document's hash NOW — `Document.hash`, not a hash of the window in
   * `text`. Here so an agent can do what `cairn show` does: compare it against
   * the `hash` a claim's citation recorded and see that the document has
   * changed since it was cited. A re-import updates a document in
   * place and keeps its id, so the recorded hash was the only record that the
   * cited text had moved — and without this field the agent holding it had
   * nothing to compare it with.
   */
  hash: string
  /** A machine wrote this document; never a team decision. */
  generated: boolean
  /** The repository label the document came from, or null when it has none. */
  repo: string | null
  text: string
  offset: number
  length: number
  nextOffset: number | null
}

/**
 * What `team_knowledge_read` hands back for a claim id whose status is
 * `"retracted"`, in place of the claim itself. A retracted claim was once
 * approved, so answering with the ordinary denial — indistinguishable from a
 * claim that was never approved — would leave an agent holding a stale copy
 * with no way to learn it was withdrawn. `reason` is `claim.retracted.reason`,
 * carried through so the agent knows WHY, not just that it happened.
 */
export interface Tombstone {
  kind: "retracted"
  id: string
  reason: string
}

export interface KbTools {
  kbMap(ctx?: MapContext & { limit?: number }): Promise<MapResult>
  /**
   * `offset` only ever applies to a single document. Passed alongside
   * several ids it would silently reuse the same window for every one of
   * them but the first — so that combination is refused, not guessed at.
   */
  kbRead(ids: string[], offset?: number): Promise<(Claim | ReadDocument | Tombstone)[]>
  /**
   * `limit` bounds EACH block, not the response as a whole. Claims are
   * returned as a whole block before documents, so a single overall limit
   * would let a query that matches many claims return no documents at all —
   * and whether a claim ever cites a document is the question the document
   * noun exists to answer. A limit that can starve documents out of search
   * would answer it by construction.
   */
  kbSearch(query: string, limit?: number): Promise<SearchResult>
  kbPropose(input: ProposeInput & { cites?: CiteInput[] }): Promise<{ id: string; overlaps: string[] }>
  /**
   * Attach a document to a claim as evidence, in place. No `kbUncite` exists
   * beside it, deliberately, and the MCP surface enforces it by the tool not
   * existing rather than by a runtime check an agent could hit and route
   * around. See `Store.uncite`'s doc comment for why detaching is human-only.
   */
  kbCite(input: { claim: string; doc: string; supports: string; agent: string }): Promise<{
    id: string
    cites: number
  }>
  /**
   * Writes a generated overview document through `Store.writeGenerated`,
   * under the synthetic source `generated:${repo}/${slug}` — so calling this
   * again with the same repo and slug replaces the document in place rather
   * than creating a second copy. The store decides whether slug, repo and
   * size are acceptable, so both stores refuse in the same words. A space
   * that cannot take the write at all is refused by the MCP server handler
   * (`ServerOptions.teamWriteRefusal`), not here.
   */
  kbWriteDocument(input: {
    repo: string
    slug: string
    title: string
    text: string
    agent: string
  }): Promise<{ id: string; outcome: ImportOutcome }>
}

export function createTools(store: ToolStore, log: ToolSink, via: Via = "stdio"): KbTools {
  return {
    async kbMap(ctx: MapContext & { limit?: number } = {}) {
      await log.append("map", undefined, { agent: ctx.agent ?? null, session: ctx.session ?? null, via })
      const approved = await store.list("approved")
      // Bounded, because this is the call every agent makes at the start of
      // every session — the last response in the system that should grow with
      // the size of the space.
      const limit = ctx.limit ?? DEFAULT_MAP_LIMIT
      const entries = approved
        .slice(0, limit)
        .map((c) => ({ id: c.id, claim: c.claim, abstract: c.abstract }))
      const omitted = approved.length - entries.length
      return {
        entries,
        omitted,
        ...(omitted > 0
          ? {
              notice:
                `${omitted} more approved claim(s) are not shown here — ` +
                `use team_knowledge_search to find them by text.`,
            }
          : {}),
      }
    },

    async kbRead(ids: string[], offset?: number) {
      // See the doc comment on KbTools.kbRead: a shared offset across several
      // ids would quietly hand back the wrong window from every document but
      // the first, so the combination is refused outright, naming the fix.
      if (offset !== undefined && ids.length !== 1) {
        throw new Error(
          "team_knowledge_read: offset is only valid when reading one document at a time — " +
            "pass a single id, or omit offset and call again per id.",
        )
      }
      const out: (Claim | ReadDocument | Tombstone)[] = []
      // Collected and written once at the end: against the hosted store
      // each append is a POST, so this loop used to make one round trip per
      // id on the path agents use most.
      //
      // The write happens in a `finally`, so a read that throws part-way
      // still records what the agent ASKED for. Recording nothing there would
      // under-count `reads` — the one direction a measurement error must
      // never quietly take.
      const events: EventInput[] = []
      try {
        for (const id of ids) {
          // The `doc-` prefix is the whole routing decision — see makeDocId in
          // the CLI's src/documents.ts. Anything else falls through to the
          // claim branch below, so a claim id can never be mistaken for a
          // document id and slip past the approval gate that follows it.
          if (id.startsWith("doc-")) {
            const doc = await store.getDocument(id)
            // Documents have no status to gate on, so a missing id is NOT a
            // gate refusal — it is a typo, a hallucinated id, or a stale one.
            // `deniedReads` (packages/protocol/src/stats.ts) is read to judge whether the
            // approval gate is a bottleneck; setting `denied: true` here would
            // fold "agent guessed a bad id" into that number and either
            // manufacture apparent review friction or bury a real document-id
            // usability problem where nobody would think to look for it. The
            // read still counts — `found: false` says so without touching
            // `deniedReads`.
            events.push({ kind: "read", id, meta: { target: "document", found: doc !== null, via } })
            if (doc === null) continue
            const win = windowOf(doc.text, offset ?? 0)
            out.push({
              kind: "document",
              id: doc.id,
              title: doc.title,
              source: doc.source,
              hash: doc.hash,
              generated: doc.generated ?? false,
              repo: doc.repo ?? null,
              ...win,
            })
            continue
        }
        const claim = await store.get(id)
        // A retracted claim answers with a tombstone rather than the generic
        // denial. An agent that read this claim while it was approved is
        // holding a copy, and "denied" is what a claim that was NEVER approved
        // returns — indistinguishable, so the agent would keep its stale copy.
        // Still a denied read for the ledger: the agent asked for something it
        // may no longer have.
        if (claim !== null && claim.status === "retracted") {
          events.push({ kind: "read", id, meta: { denied: true, retracted: true, via } })
          out.push({ kind: "retracted", id, reason: claim.retracted?.reason ?? "" })
          continue
        }
        // A pending or rejected claim is invisible to agents, same as a
        // missing one — the approval gate applies to every read path, not
        // just team_knowledge_map.
        const allowed = claim !== null && claim.status === "approved"
        // A denied read is still an agent asking. Logging nothing would make
        // "asked for something it was not allowed to see" indistinguishable
        // from "never asked", under-counting reads.
        events.push({ kind: "read", id, meta: allowed ? { via } : { denied: true, via } })
        if (allowed) out.push(claim)
        }
      } finally {
        await log.appendMany(events)
      }
      return out
    },

    async kbSearch(query: string, limit?: number) {
      // Its own kind: logging searches as "read" conflated them with claim
      // reads and inflated the reads-per-session metric.
      //
      // Written once the hits are known, so the event can say how many came
      // back — and in a `finally`, so a search that throws part-way is still
      // counted (with `hits: null`), the same rule kbRead's events follow.
      let hits: number | null = null
      try {
        const [claimResults, docResults] = await Promise.all([store.search(query), store.searchDocuments(query)])
        // Same gate as kbRead: the FTS index covers every status, so the
        // service layer — not the store — filters to what agents may see.
        const claims = claimResults.filter((c) => c.status === "approved")
        // Claims first, then documents, as two whole blocks — not interleaved
        // by score. A human has vouched for a claim; nobody has vouched for a
        // document, so a document must never outrank curated knowledge just
        // because it happens to match the query text more closely. That is a
        // rule an agent can learn once and predict, not a weight it has to
        // reverse-engineer from result order.
        // Per block, not overall — see `kbSearch` on `KbTools` for why.
        const cap = limit ?? DEFAULT_SEARCH_LIMIT
        // No body. Search is for deciding what to read next, and the body is
        // what team_knowledge_read is for: one query over nine claims returned
        // 12,449 bytes when the whole claim came back here.
        const claimHits: SearchHit[] = claims.slice(0, cap).map((c) => ({
          kind: "claim",
          id: c.id,
          claim: c.claim,
          abstract: c.abstract,
          tags: c.tags,
          status: c.status,
        }))
        const docHits: SearchHit[] = docResults.slice(0, cap).map((doc) => ({
          kind: "document",
          id: doc.id,
          title: doc.title,
          source: doc.source,
          preview: previewOf(doc),
          generated: doc.generated ?? false,
          repo: doc.repo ?? null,
        }))
        hits = claimHits.length + docHits.length
        const omitted = claims.length - claimHits.length + (docResults.length - docHits.length)
        return {
          hits: [...claimHits, ...docHits],
          omitted,
          ...(omitted > 0
            ? {
                notice:
                  `${omitted} more match(es) than shown, ranked best first — raise limit to see ` +
                  `more (it bounds claims and documents separately).`,
              }
            : {}),
        }
      } finally {
        await log.append("search", undefined, { query, hits, via })
      }
    },

    async kbPropose(input: ProposeInput & { cites?: CiteInput[] }) {
      const tags = input.tags ?? []
      const cites = input.cites ?? []
      // The bare-string shape this replaced, refused by name rather than by a
      // schema error the agent has to decode. The zod schema on the wire
      // catches a malformed MCP call; this catches every other caller of
      // kbPropose directly, including a test harness that bypasses zod
      // entirely. A citation that cannot say what it supports is the defect
      // this guards against.
      const malformed = cites.filter((c) => typeof c !== "object" || c === null || typeof c.doc !== "string")
      if (malformed.length > 0) {
        throw new Error(
          `team_knowledge_propose: each entry in cites must be an object with a document id and a ` +
            `\`supports\` field saying what that document grounds — a bare id no longer says enough.`,
        )
      }
      for (const c of cites) {
        if (c.supports.trim() === "") throw new Error(EMPTY_SUPPORTS)
      }
      // Refused by name, not silently dropped or stored as a dangling
      // reference: a claim that cites a document nobody can find is worse
      // than a claim that admits it cites nothing. The sentence itself comes
      // from `unknownDocumentMessage` rather than being restated here — a
      // citation refused at propose time and one refused after the fact by
      // `store.cite` are refused for the identical reason, and two sentences
      // for one fact is the drift `notCitableMessage`'s own comment warns
      // against.
      const unknown: string[] = []
      for (const c of cites) {
        if ((await store.getDocument(c.doc)) === null) unknown.push(c.doc)
      }
      if (unknown.length > 0) {
        throw new Error(
          `team_knowledge_propose: ${unknown.map((id) => unknownDocumentMessage(id)).join(" ")}`,
        )
      }
      const approved = await store.list("approved")
      const overlaps = findOverlaps(input.claim, tags, approved)
      const claim = await store.propose({
        claim: input.claim,
        body: input.body,
        abstract: input.abstract,
        source: {
          author: input.author,
          agent: input.agent,
          repo: input.repo ?? null,
          session: input.session ?? null,
        },
        overlaps,
        cites,
        tags,
      })
      return { id: claim.id, overlaps }
    },

    async kbCite(input: { claim: string; doc: string; supports: string; agent: string }) {
      const claim = await store.cite(input.claim, { doc: input.doc, supports: input.supports }, input.agent)
      if (claim === null) {
        throw new Error(
          `team_knowledge_cite: no claim with id ${input.claim} in this space. Check it came from ` +
            `team_knowledge_map or team_knowledge_search.`,
        )
      }
      // The count, not the citations: this is a write acknowledgement, and
      // handing back every citation's absences would make an attach cost as
      // much as a read.
      return { id: claim.id, cites: claim.cites.length }
    },

    async kbWriteDocument(input: {
      repo: string
      slug: string
      title: string
      text: string
      agent: string
    }) {
      // Slug, repo and size are the store's to judge (`validateGenerated`),
      // so a local and a hosted store refuse in one voice. A blank title or
      // text is this tool's own rule, checked here as well as by the schema
      // so a direct caller that bypasses zod is held to it too.
      if (input.title.trim() === "") {
        throw new Error("team_knowledge_write_document: title must not be empty.")
      }
      if (input.text.trim() === "") {
        throw new Error("team_knowledge_write_document: text must not be empty.")
      }
      const { document, outcome } = await store.writeGenerated({
        repo: input.repo,
        slug: input.slug,
        title: input.title,
        text: input.text,
        agent: input.agent,
      })
      return { id: document.id, outcome }
    },
  }
}
