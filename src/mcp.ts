import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { findOverlaps } from "./claims"
import { previewOf, windowOf } from "./documents"
import { EMPTY_SUPPORTS, unknownDocumentMessage } from "@cairn-kb/protocol/event-kinds"
import type { EventInput, EventSink } from "./events"
import type { CiteInput, Claim, ImportOutcome, Status, Store } from "@cairn-kb/protocol/types"
import type { Mode } from "./config"
import { VERSION } from "./version"
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
export const WRITE_DOCUMENT_DESCRIPTION = `Write an overview document into the local space, labelled generated so people \
can tell a machine wrote it. The text is shown to people exactly as you write it — there is no draft stage.

\`repo\` is the repository label you were given for this work, not one you invent. \`slug\` names the document within \
that repo and must be lowercase letters, digits and hyphens only, such as "architecture" — it becomes part of the \
document's identity, so it cannot contain "/" or "..". Calling this again with the same repo and slug replaces that \
document's text in place rather than creating a second one, which is how you keep an overview current as the repo \
changes.`

/**
 * What an agent is told when it tries to write a generated document against a
 * space that talks to the hosted service. Points at the one path that works
 * today — importing by hand in the console — rather than leaving the agent to
 * guess whether this is a bug or a missing feature.
 */
export const TEAM_WRITE_REFUSAL =
  "team_knowledge_write_document: agents cannot write documents to a team space yet. " +
  "Import this text as a document yourself in the console instead."

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
 * document hit carries `preview` — see `previewOf` in src/documents.ts — and
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
 * `READ_WINDOW` characters — see src/documents.ts — with `offset` and
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
   * Writes a generated overview document into the local space, under the
   * synthetic source `generated:${repo}/${slug}` — the same source-matching
   * `Store.importDocument` already does for `cairn import` means calling this
   * again with the same repo and slug replaces the document in place rather
   * than creating a second copy. Team mode is refused by the MCP server
   * handler, not here — this function has no notion of mode.
   */
  kbWriteDocument(input: {
    repo: string
    slug: string
    title: string
    text: string
    agent: string
  }): Promise<{ id: string; outcome: ImportOutcome }>
}

/**
 * `slug` ends up as a path-like segment inside `generated:${repo}/${slug}`,
 * so it is held to the shape that alone rules out "/" and ".." without a
 * second, separate traversal check that could drift from it: lowercase
 * letters, digits and hyphens, starting with a letter or digit, at most 64
 * characters.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * `repo` is a label an agent was handed, not a path segment it invents, and
 * ends up on the right of `generated:${repo}/...` — still compared by string
 * equality (`Store.importDocument` matches on `source` as a whole), never
 * split apart or joined onto a filesystem path (see `taggedFields` in
 * src/store.ts). So it is allowed the shape of an actual repository name,
 * `owner/name` or just `name`: each part letters of either case, digits, ".",
 * "_" and "-", at most one "/", 1 to 100 characters in all. A part of ".."
 * passes this pattern — harmless, since nothing ever resolves it against a
 * directory.
 */
const REPO_PATTERN = /^(?=.{1,100}$)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/

function assertSlug(value: string): void {
  if (!SLUG_PATTERN.test(value)) {
    throw new Error(
      `team_knowledge_write_document: slug must be lowercase letters, digits and hyphens only, ` +
        `starting with a letter or digit, at most 64 characters (no "/", ".." or uppercase) — ` +
        `got "${value}".`,
    )
  }
}

function assertRepo(value: string): void {
  if (!REPO_PATTERN.test(value)) {
    throw new Error(
      `team_knowledge_write_document: repo must be owner/name or name, each part letters, digits, ` +
        `".", "_" or "-" only, 1 to 100 characters in all — got "${value}".`,
    )
  }
}

export function createTools(store: Store, log: EventSink): KbTools {
  return {
    async kbMap(ctx: MapContext & { limit?: number } = {}) {
      await log.append("map", undefined, { agent: ctx.agent ?? null, session: ctx.session ?? null })
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
          // src/documents.ts. Anything else falls through to the claim branch
          // below, so a claim id can never be mistaken for a document id and
          // slip past the approval gate that follows it.
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
            events.push({ kind: "read", id, meta: { target: "document", found: doc !== null } })
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
          events.push({ kind: "read", id, meta: { denied: true, retracted: true } })
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
        events.push({ kind: "read", id, ...(allowed ? {} : { meta: { denied: true } }) })
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
      await log.append("search", undefined, { query })
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
      assertRepo(input.repo)
      assertSlug(input.slug)
      if (input.title.trim() === "") {
        throw new Error("team_knowledge_write_document: title must not be empty.")
      }
      if (input.text.trim() === "") {
        throw new Error("team_knowledge_write_document: text must not be empty.")
      }
      const { document, outcome } = await store.importDocument({
        title: input.title,
        text: input.text,
        // The source `cairn import` could never produce — see the doc
        // comment on `KbTools.kbWriteDocument` for why that is what makes a
        // second write with the same repo and slug replace this document
        // rather than create a sibling.
        source: `generated:${input.repo}/${input.slug}`,
        generated: true,
        repo: input.repo,
      })
      return { id: document.id, outcome }
    },
  }
}

/**
 * Why every tool carries annotations, and why `propose` is not destructive.
 *
 * Anthropic's connector review criteria make `title` plus the applicable hint
 * a pass/fail requirement, and say what the hint is FOR: "read-only tools can
 * run without per-call confirmation; destructive tools always prompt." With no
 * annotation a host must assume the worst, so `team_knowledge_map` — the call
 * an agent makes at the start of every session — and `team_knowledge_search`
 * were each costing a permission prompt they do not need. Those are the two
 * calls `cairn status` counts, which meant the product was reading friction it
 * imposed itself as agents not being interested.
 *
 * `propose` is a write and is deliberately NOT marked destructive: it appends
 * a pending claim and deletes or overwrites nothing. Marking it destructive
 * would put a confirmation dialog in front of the one action the product wants
 * more of. It is not idempotent either — proposing twice files two claims.
 *
 * `openWorldHint` is deliberately absent rather than true. It would be
 * accurate for the hosted store and false for a local one, and the same server
 * serves both; an unset hint is silence, while a true one would be a statement
 * about the world that is wrong half the time.
 */
const READ_ONLY = { readOnlyHint: true } as const

export function createMcpServer(
  store: Store,
  log: EventSink,
  opts: { mode?: Mode; onSearchResult?: (hits: number) => Promise<void> } = {},
): McpServer {
  const mode: Mode = opts.mode ?? "local"
  const server = new McpServer(
    { name: "cairn", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  )
  const tools = createTools(store, log)

  server.registerTool(
    "team_knowledge_map",
    {
      title: "Team knowledge map",
      description: MAP_DESCRIPTION,
      inputSchema: {
        agent: z.string().optional().describe("Which agent is calling, e.g. cursor"),
        session: z
          .string()
          .optional()
          .describe("Stable id for this session, so reads can be counted per session"),
        limit: z
          .number()
          .optional()
          .describe(
            `How many claims to return. Defaults to ${DEFAULT_MAP_LIMIT}; the response says how ` +
              "many were left out.",
          ),
      },
      annotations: READ_ONLY,
    },
    async (ctx) => ({
      content: [{ type: "text", text: JSON.stringify(await tools.kbMap(ctx)) }],
    }),
  )

  server.registerTool(
    "team_knowledge_read",
    {
      title: "Read team knowledge",
      description:
        "Read full claims or documents by id, once an abstract from map or a hit from search looks " +
        "relevant. A single call accepts claim ids and document ids together. A document longer " +
        "than one window comes back with nextOffset — pass that back as offset on your next call " +
        "to keep reading. offset only works when ids has exactly one id in it; to keep reading " +
        "several documents, call once per document instead. A document comes back with its hash " +
        "as it is now; a claim's citation records the hash of the document it was read from, so " +
        "the two differing means the document has changed since it was cited and the citation may " +
        "no longer describe what is in it. A claim that comes back as " +
        '{"kind":"retracted"} was approved and has since been withdrawn by a human — discard any ' +
        "copy you are holding. " +
        GENERATED_NOTE,
      inputSchema: {
        ids: z.array(z.string()),
        offset: z
          .number()
          .optional()
          .describe(
            "Where to resume a long document, taken from a previous read's nextOffset. Valid " +
              "only when ids has exactly one element — passed alongside several ids it would " +
              "reuse the same window for all of them, so that combination is refused.",
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ ids, offset }) => ({
      content: [{ type: "text", text: JSON.stringify(await tools.kbRead(ids, offset)) }],
    }),
  )

  server.registerTool(
    "team_knowledge_search",
    {
      title: "Search team knowledge",
      description:
        "Search claims and documents by text when you have a specific question map's abstracts " +
        "didn't already answer. It covers the team's recorded decisions, conventions, " +
        "architecture and history, so it is the source for questions about this project that " +
        "memory alone can't settle, and it shows whether a claim you are about to propose " +
        "already exists. Results come back as two blocks in a fixed order — every matching " +
        "claim, then every matching document — never interleaved by relevance score, so you can " +
        "always predict where one block ends and the next begins. A claim is durable knowledge a " +
        "human has reviewed and approved. A document is raw imported source material nobody has " +
        "judged — read it the way you would read any file in the repo. " +
        GENERATED_NOTE +
        " A claim's cites each name a " +
        "document together with what it supports. Neither kind of hit carries " +
        "full text: a claim hit is its sentence and abstract, a document hit a short preview. " +
        "Call team_knowledge_read on the ids that look relevant. Results are bounded — the " +
        "response says how many matches it left out.",
      inputSchema: {
        query: z.string().describe("Words to match against claims and documents"),
        limit: z
          .number()
          .optional()
          .describe(
            `How many hits of EACH kind to return — claims and documents are bounded ` +
              `separately, so a query matching many claims still returns documents. Defaults ` +
              `to ${DEFAULT_SEARCH_LIMIT}.`,
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const result = await tools.kbSearch(query, limit)
      // Only here, never inside `createTools(...).kbSearch` itself — that
      // function is also called directly by tests and by any future
      // in-process caller that should not have to carry this along.
      //
      // Guarded against both a synchronous throw and a rejection: this hook
      // is instrumentation (the first-answer metric uses it), not part of the
      // search contract, so a hook that misbehaves must never turn an
      // agent's search into an error.
      try {
        await opts.onSearchResult?.(result.hits.length)
      } catch {
        // Swallowed deliberately — see above.
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] }
    },
  )

  server.registerTool(
    "team_knowledge_propose",
    {
      title: "Propose team knowledge",
      description: PROPOSE_DESCRIPTION,
      inputSchema: {
        claim: z.string().describe("One assertive sentence — the thing a reviewer judges"),
        body: z.string().describe("Detail and rationale"),
        abstract: z.string().describe(ABSTRACT_GUIDANCE),
        author: z.string(),
        agent: z.string(),
        repo: z.string().optional(),
        session: z.string().optional(),
        tags: z.array(z.string()).optional(),
        cites: z
          .array(z.object({ doc: z.string(), supports: z.string().min(1) }))
          .optional()
          .describe(
            "Documents this claim was written from, each with what it supports. `doc` is a " +
              "document id from team_knowledge_search or team_knowledge_read; `supports` names " +
              "which part of the claim that document grounds. An unknown id is refused, naming " +
              "which one — check it is a document id, not a claim id, before retrying.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(await tools.kbPropose(input)) }],
    }),
  )

  server.registerTool(
    "team_knowledge_cite",
    {
      title: "Cite a document on a claim",
      description: CITE_DESCRIPTION,
      inputSchema: {
        claim: z.string().describe("The claim id, from team_knowledge_map or team_knowledge_search"),
        doc: z.string().describe("The document id, from team_knowledge_search or team_knowledge_read"),
        supports: z
          .string()
          .min(1)
          .describe(
            "What this document grounds — which part of the claim it backs up, in your own words. " +
              "Name the specific assertion, not the topic. If the document grounds one clause and " +
              "not the rest, say which one; a citation that covers part of a claim is worth more " +
              "than one that implies it covers all of it.",
          ),
        agent: z.string().describe("Which agent is attaching this, e.g. cursor"),
      },
      // Not idempotent (a second call on an already-cited document is
      // refused, not a no-op) and not destructive (it appends evidence and
      // removes nothing) — the same reasoning `team_knowledge_propose`'s
      // annotations already state for a write that is neither.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => ({ content: [{ type: "text", text: JSON.stringify(await tools.kbCite(input)) }] }),
  )

  server.registerTool(
    "team_knowledge_write_document",
    {
      title: "Write a generated document",
      description: WRITE_DOCUMENT_DESCRIPTION,
      inputSchema: {
        repo: z.string().describe("The repository label you were given for this work, not one you invent"),
        slug: z
          .string()
          .describe(
            "Names this document within the repo, lowercase letters, digits and hyphens only " +
              '(e.g. "architecture") — it becomes part of the document\'s identity, so it cannot ' +
              'contain "/" or "..".',
          ),
        title: z.string().describe("The document's title, shown to people exactly as given"),
        text: z.string().describe("The document's full text, shown to people exactly as given"),
        agent: z.string().describe("Which agent is calling, e.g. cursor"),
      },
      // Writing again with the same repo and slug replaces the document's
      // text rather than creating a second one — idempotent in effect, but
      // not marked so: the response differs ("created" vs. "updated") in a
      // way a host should not assume away. Not destructive: it replaces this
      // one generated document's own text and removes nothing else.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      // Mode decides this before the input is even looked at: a space
      // talking to the hosted service has no path yet for an agent to write
      // a document into it, so nothing here should get far enough to try.
      if (mode === "team") throw new Error(TEAM_WRITE_REFUSAL)
      return { content: [{ type: "text", text: JSON.stringify(await tools.kbWriteDocument(input)) }] }
    },
  )

  // No `team_knowledge_uncite` is registered here, deliberately — see the doc
  // comment on KbTools.kbCite and Store.uncite. Enforced structurally: a
  // capability-inventory test (test/mcp.test.ts) reads this file's source and
  // asserts the exact set of registered tool names, so a call added here
  // later would need that assertion changed alongside it rather than slipping
  // in unnoticed.

  return server
}
