import {
  AGENT_CANNOT_ASSERT_PROVENANCE,
  AGENT_PROVENANCE_CODE,
  EMPTY_RETRACT_REASON,
  EMPTY_SUPPORTS,
  IMPOSSIBLE_HASH,
  RESOLVE_KINDS,
  citeRefusalFromCode,
  notAdoptableMessage,
  notCitableMessage,
  notRetractableMessage,
  notUncitableMessage,
  refusalFromCode,
  retractRefusalFromCode,
  unciteRefusalFromCode,
  unknownClaimMessage,
  unknownDocumentMessage,
} from "@cairn-kb/protocol/event-kinds"
import { generatedRefusalMessage } from "@cairn-kb/protocol/generated"
import type { EventKind, EventSink, KbEvent, Stats, EventInput } from "./events"
import { ftsQuery } from "./search-query"
import type {
  CiteInput,
  Claim,
  Document,
  DocumentInput,
  GeneratedDocumentInput,
  ImportDocumentResult,
  ProposeInput,
  Status,
  Store,
} from "@cairn-kb/protocol/types"
import type { PatchKind } from "@cairn-kb/protocol/event-kinds"

export class CairnHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * The id the refusal is ABOUT, when the service names one — today only the
     * document a citation could not resolve.
     *
     * Carried structurally rather than parsed back out of `message`: the
     * message is a sentence built for a person, and a client that recovered an
     * id from it would break the first time the wording changed. The rule this
     * serves is the one `notAdoptableMessage` set — the server sends a code,
     * the client builds the sentence — and that rule needs the code's subject
     * to travel with it.
     */
    readonly doc?: string,
  ) {
    super(message)
    this.name = "CairnHttpError"
  }
}

/** What any client of the hosted service needs: where it is, who is asking,
 *  and for which space. */
export interface CairnApiOptions {
  baseUrl: string
  token: string
  orgId: string
  /** Injected so tests can answer requests without a network. */
  fetchImpl?: typeof fetch
}

/**
 * One request to the org-scoped API, with the error mapping every CLI surface
 * renders. Shared by the store and the event sink rather than written twice:
 * they speak to the same service and must fail with the same sentences.
 */
async function requestApi<T>(
  o: CairnApiOptions,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const url = `${o.baseUrl}/v1/orgs/${encodeURIComponent(o.orgId)}${path}`
  let res: Response
  try {
    res = await (o.fetchImpl ?? fetch)(url, {
      ...init,
      headers: {
        authorization: `Bearer ${o.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    })
  } catch (err) {
    // Never a bare catch: name the endpoint AND what to do about it, so "it
    // doesn't work" is one paste long rather than a conversation. The action
    // clause is the same one `cairn doctor`'s account check gives for the same
    // failure — a sentence an operator cannot act on is the same dead end as a
    // bare catch.
    throw new CairnHttpError(
      0,
      "unreachable",
      `cairn is not reachable at ${o.baseUrl} (${(err as Error).message}) — ` +
        `check your network or VPN, then try again`,
    )
  }
  if (res.status === 204) return { status: res.status, body: undefined as T }
  const body = (await res.json().catch(() => ({}))) as { code?: string; doc?: string }
  if (res.ok) return { status: res.status, body: body as T }
  throw new CairnHttpError(res.status, body.code ?? "error", messageFor(res.status, body.code), body.doc)
}

/** The common case: the body, with the status already checked. */
async function callApi<T>(o: CairnApiOptions, path: string, init: RequestInit = {}): Promise<T> {
  return (await requestApi<T>(o, path, init)).body
}

export interface HttpStoreOptions extends CairnApiOptions {
  /**
   * Claims fetched per request by `list`. Defaults to the server's page cap,
   * so the default costs the fewest round trips. It is an option because the
   * accumulate-and-continue loop in `list` is the one place this client can
   * drop or duplicate a page, and at the default that loop needs 101 claims to
   * reach its second iteration — a threshold no test was ever going to cross.
   */
  pageSize?: number
}

/**
 * The Store, over HTTP.
 *
 * This file is on the MCP path, so it must import nothing from
 * @clack/prompts — clack writes to stdout, which the MCP protocol owns.
 */
export class HttpStore implements Store {
  private readonly pageSize: number

  constructor(private readonly opts: HttpStoreOptions) {
    this.pageSize = opts.pageSize ?? 100
  }

  private call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return callApi<T>(this.opts, path, init)
  }

  async list(status: Status, opts: { mine?: boolean } = {}): Promise<Claim[]> {
    const all: Claim[] = []
    let cursor: string | null = null
    // Page transparently: callers keep the semantics FileStore gave them.
    do {
      const q = new URLSearchParams({ status, limit: String(this.pageSize) })
      // The filter is applied server-side, per page, against the same cursor
      // order — so paging a filtered queue is the same paging.
      if (opts.mine) q.set("mine", "1")
      if (cursor) q.set("cursor", cursor)
      const page: { claims: Claim[]; cursor: string | null } = await this.call(`/claims?${q}`)
      all.push(...page.claims)
      cursor = page.cursor
    } while (cursor)
    return all
  }

  async get(id: string): Promise<Claim | null> {
    try {
      return await this.call<Claim>(`/claims/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err instanceof CairnHttpError && err.status === 404) return null
      throw err
    }
  }

  async put(claim: Claim, kind: PatchKind): Promise<void> {
    // Content update of a claim that exists. Creation is `propose`.
    //
    // KNOWN LIMIT, and no longer reachable from the CLI: this carries only
    // `abstract`, `abstractBy` and `tags`. `claim` and `body` are DISCARDED —
    // the server accepts exactly those three fields plus `kind` and nothing
    // else, so there is no shape this could send that would carry the
    // text. That is why nothing in the CLI edits a claim's wording through
    // `put`: `runReview` sends edits through `review`, and `cairn import`
    // writes DOCUMENTS rather than claims, so it never reaches a claim's
    // wording at all -- `importClaim`'s one caller is `runMigration`. The one
    // remaining caller of this method is `runBackfill`, which writes exactly
    // the fields it does carry. Widening it needs the server to accept more
    // fields first.
    await this.call(`/claims/${encodeURIComponent(claim.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        abstract: claim.abstract,
        abstractBy: claim.abstractBy,
        tags: claim.tags,
        kind,
      }),
    })
  }

  async move(id: string, status: Status): Promise<void> {
    if (status === "pending") {
      throw new CairnHttpError(0, "unsupported", "a claim cannot be moved back to pending")
    }
    // Every OTHER status this function maps to `review(reject)` two lines
    // down — that mapping only made sense back when "approved" and
    // "rejected" were the only destinations `review` could not already reach.
    // `retracted` becoming a real `Status` (this branch's target the type
    // system now permits) would fall through the same way and, on a PENDING
    // claim, set `status: "rejected"` AND append a `reject` event — moving
    // `rejected` and `approveRate`, the number review exists to measure, under a
    // call nobody meant as a review. `FileStore.move(id, "retracted")` writes
    // no event at all, so the two stores would disagree about what a
    // retraction even costs. A retraction goes through `retract`, which takes
    // a reason and records who withdrew it — information a bare `move` has no
    // field for.
    if (status === "retracted") {
      throw new CairnHttpError(
        0,
        "unsupported",
        "a claim cannot be retracted through move — call retract, which records why",
      )
    }
    // `review` reports a missing claim as `null`, but `move` returns void, so
    // that null has nowhere to go — discarding it would report success to an
    // operator for a claim nothing moved. `FileStore.move` throws on an unknown
    // id; one seam has to answer this the same way in both implementations, or
    // `cairn review` says it rejected a claim another reviewer had already
    // resolved.
    const moved = await this.review(id, status === "approved" ? "approve" : "reject")
    if (!moved) throw new CairnHttpError(404, "not_found", messageFor(404))
  }

  async search(query: string): Promise<Claim[]> {
    // `Store.search` takes a question in plain words; `/search` takes a full-text
    // query expression. Handing the raw text over is the bug this hides: `-`
    // and `*` are query operators, so `nothing-matches-this` is not "no
    // results", it is a 400 the caller never asked for. `ftsQuery` quotes each
    // term and ORs them together — the same normalisation FileStore does —
    // so a claim sharing any word of the question can match, rather than
    // requiring the whole question verbatim. Ordering is the service's.
    const fts = ftsQuery(query)
    if (fts === null) return []
    const r: { claims: Claim[] } = await this.call(`/search?q=${encodeURIComponent(fts)}`)
    return r.claims
  }

  async propose(input: ProposeInput): Promise<Claim> {
    try {
      return await this.call<Claim>("/claims", {
        method: "POST",
        body: JSON.stringify(proposeBody(input)),
      })
    } catch (err) {
      throw asUnknownDocument(err)
    }
  }

  /**
   * A document entering the space already approved. Its own route on the
   * service, open only to a person: creating approved claims is a way around
   * review, so an agent token cannot reach it.
   */
  async importClaim(input: ProposeInput): Promise<{ claim: Claim; created: boolean }> {
    // 201 created, 200 deduplicated — the service already distinguishes them,
    // and this is the one caller that needs to know which happened.
    try {
      const { status, body } = await requestApi<Claim>(this.opts, "/claims/import", {
        method: "POST",
        body: JSON.stringify(proposeBody(input)),
      })
      return { claim: body, created: status === 201 }
    } catch (err) {
      throw asUnknownDocument(err)
    }
  }

  async stats(): Promise<Stats> {
    return this.call<Stats>("/stats")
  }

  async review(
    id: string,
    decision: "approve" | "reject" | "edit",
    edits: { claim?: string; body?: string; abstract?: string } = {},
    elapsedMs?: number,
  ): Promise<Claim | null> {
    try {
      return await this.call<Claim>(`/claims/${encodeURIComponent(id)}/review`, {
        method: "POST",
        // Spread conditionally rather than passing `elapsedMs` straight
        // through: the server refuses unknown fields, and an explicit
        // `elapsedMs: undefined` survives `JSON.stringify` as an ABSENT key
        // today but would become a present null the moment anyone reached for
        // a different serializer. Not measured and measured-as-nothing are
        // different facts, and this keeps the wire honest about
        // which one it is carrying.
        body: JSON.stringify({
          decision,
          ...edits,
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
        }),
      })
    } catch (err) {
      if (err instanceof CairnHttpError && err.status === 404) return null
      throw err
    }
  }

  async listDocuments(): Promise<Document[]> {
    const r: { documents: Document[] } = await this.call("/documents")
    return r.documents
  }

  async getDocument(id: string): Promise<Document | null> {
    try {
      return await this.call<Document>(`/documents/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err instanceof CairnHttpError && err.status === 404) return null
      throw err
    }
  }

  async searchDocuments(query: string): Promise<Document[]> {
    // Same normalisation as `search`: `Store.searchDocuments` takes a question
    // in plain words and `/documents?q=` takes a query expression, so an
    // unquoted `-` is a 400 rather than "no results".
    const fts = ftsQuery(query)
    if (fts === null) return []
    const r: { documents: Document[] } = await this.call(`/documents?q=${encodeURIComponent(fts)}`)
    return r.documents
  }

  async importDocument(input: DocumentInput): Promise<ImportDocumentResult> {
    // The route returns { document, outcome }: only the server can tell
    // `updated` from `unchanged`, since it holds the previous hash — the
    // outcome travels in the body, so unlike `importClaim` this needs no
    // second look at the status code.
    return await this.call<ImportDocumentResult>("/documents", {
      method: "POST", body: JSON.stringify(input),
    })
  }

  /**
   * Not wired to the hosted service yet — refuses every write with
   * `agent_documents_off` until the route exists. Replaced once the hosted
   * side can accept a generated document; the signature is correct now so
   * the write-document tool can call it against either store without
   * knowing which one it has.
   */
  async writeGenerated(_input: GeneratedDocumentInput): Promise<ImportDocumentResult> {
    throw new Error(generatedRefusalMessage("agent_documents_off"))
  }

  async adoptImport(claimId: string): Promise<Document> {
    try {
      return await this.call<Document>(`/claims/${encodeURIComponent(claimId)}/adopt`, { method: "POST" })
    } catch (err) {
      if (err instanceof CairnHttpError && err.status === 409) {
        // The identical sentence FileStore.adoptImport throws (src/store.ts),
        // pulled from the same shared function so the two cannot drift — the
        // convention `AlreadyResolvedError` already set for this seam: both
        // implementations must refuse a claim the same way in the same
        // words, or an operator reading the CLI's error sees a different
        // explanation depending on which store happened to answer. WHICH
        // refusal travels in the code, because only the server can see the
        // events; an unrecognised 409 falls through rather than being dressed
        // up as an adoption refusal it might not be.
        const refusal = refusalFromCode(err.code)
        if (refusal) throw new Error(notAdoptableMessage(claimId, refusal))
      }
      // The same arrangement one status down, and the outcome that had never
      // been made to agree: only 409 parity was mandated, so a
      // missing claim got the generic 404 sentence — true of every other 404
      // and wrong here, because it sends somebody to run `cairn status` to
      // look for a claim whose absence is the answer. Matched on the code as
      // well as the status, for the reason `agent_cannot_review` is: an
      // unrecognised 404 falls through rather than being dressed up as an
      // adoption outcome it might not be.
      if (err instanceof CairnHttpError && err.status === 404 && err.code === "not_found") {
        throw new Error(unknownClaimMessage(claimId))
      }
      throw err
    }
  }

  async retract(id: string, reason: string, _by: string): Promise<Claim | null> {
    // `_by` is unused: the service takes the actor from the request principal,
    // which is the only actor it can trust. Same arrangement `importClaim` has
    // with `source.author`.
    if (reason.trim() === "") throw new Error(EMPTY_RETRACT_REASON)
    try {
      return await this.call<Claim>(`/claims/${encodeURIComponent(id)}/retract`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      })
    } catch (err) {
      if (err instanceof CairnHttpError && err.status === 404) return null
      if (err instanceof CairnHttpError && err.status === 409) {
        // The identical sentence FileStore.retract throws, from the same
        // shared function so the two cannot drift. WHICH refusal travels in
        // the code, because only the server can see the status; an
        // unrecognised 409 falls through as itself.
        const refusal = retractRefusalFromCode(err.code)
        if (refusal) throw new Error(notRetractableMessage(id, refusal))
      }
      throw err
    }
  }

  async cite(claimId: string, input: CiteInput, _by: string): Promise<Claim | null> {
    // `_by` is unused: the service takes the actor from the request principal,
    // which is the only actor it can trust. Same arrangement `retract` and
    // `importClaim` have.
    if (input.supports.trim() === "") throw new Error(EMPTY_SUPPORTS)
    try {
      // `doc` and `supports` and nothing else. `hash`, `absent` and `by` are
      // the store's to establish — the route refuses them outright — and
      // `provenance` is a migration's, which does not come through here.
      return await this.call<Claim>(`/claims/${encodeURIComponent(claimId)}/cite`, {
        method: "POST",
        body: JSON.stringify({ doc: input.doc, supports: input.supports }),
      })
    } catch (err) {
      if (err instanceof CairnHttpError && err.status === 404) return null
      if (err instanceof CairnHttpError) {
        // The identical sentence FileStore.cite throws, from the same shared
        // function so the two cannot drift. WHICH refusal travels in the code,
        // because only the server can see the documents and the citations
        // already attached; an unrecognised code falls through as itself
        // rather than being dressed up as a citation refusal. Not matched on
        // a status: the two refusals answer with different ones — 400 for a
        // document the space does not hold, 409 for one already cited — and
        // the code is what distinguishes them either way.
        const refusal = citeRefusalFromCode(err.code)
        if (refusal) throw new Error(notCitableMessage(claimId, input.doc, refusal))
      }
      throw err
    }
  }

  async uncite(claimId: string, doc: string): Promise<Claim | null> {
    try {
      return await this.call<Claim>(`/claims/${encodeURIComponent(claimId)}/uncite`, {
        method: "POST",
        body: JSON.stringify({ doc }),
      })
    } catch (err) {
      if (err instanceof CairnHttpError && err.status === 404) return null
      if (err instanceof CairnHttpError && unciteRefusalFromCode(err.code)) {
        throw new Error(notUncitableMessage(claimId, doc))
      }
      throw err
    }
  }
}

/**
 * The identical sentence `FileStore` throws for a citation naming a document
 * the space does not hold, rebuilt from the code the service sent — the
 * convention `notAdoptableMessage` set, so an operator sees the same words
 * whichever store answered. Anything else passes through as itself rather than
 * being dressed up as a citation refusal it might not be.
 */
function asUnknownDocument(err: unknown): unknown {
  if (err instanceof CairnHttpError && err.code === "cite_unknown_document") {
    return new Error(unknownDocumentMessage(err.doc ?? "that document"))
  }
  return err
}

/** The wire shape both create routes take: the same information, two doors. */
function proposeBody(input: ProposeInput) {
  return {
    claim: input.claim,
    body: input.body,
    abstract: input.abstract,
    author: input.source.author,
    agent: input.source.agent,
    repo: input.source.repo,
    session: input.source.session,
    tags: input.tags,
    overlaps: input.overlaps,
    // Objects: the route stores each citation's scope, and strips `hash`,
    // `absent` and `by` sent at the top level — those are the store's to
    // establish.
    //
    // `provenance` DOES travel, and it is the only channel by which a
    // citation's recorded facts survive a migration. It used to be stripped
    // here, which meant the mechanism `CiteInput.provenance` exists for
    // protected nothing that ships: `cairn init --team` (FileStore ->
    // HttpStore) is the only migration there is, so every citation it moved
    // was re-derived by the target — today's hash stamped on a check somebody
    // ran days ago, erasing every "this document has changed since it was
    // cited" warning, and a legacy citation's `absent: null` turned into a
    // check nobody ran. Sending it undefined for every other caller is what
    // keeps the wire shape unchanged for them: `propose` from MCP never sets
    // it.
    //
    // The guard that replaced the stripping lives server-side, on the
    // principal rather than on the body: the route honours `provenance` only
    // for a human principal and refuses it by name for an agent token. See
    // `AGENT_CANNOT_ASSERT_PROVENANCE`.
    cites: input.cites.map((c) => ({
      doc: c.doc,
      supports: c.supports,
      provenance: c.provenance,
    })),
  }
}

/**
 * The event log, over HTTP.
 *
 * Selected alongside the store, and for the same reason: `cairn status` reading
 * its claims from a shared space and its counts from a file on one laptop
 * produced a report whose lines contradicted each other, and an agent session
 * whose proposal landed on the service while its reads landed on the machine
 * that happened to run it.
 */
export class HttpEventSink implements EventSink {
  constructor(private readonly opts: CairnApiOptions) {}

  /**
   * Kinds the service records ITSELF, inside the request that changed the
   * claim — that atomicity is why `propose`, `review` and `importClaim` are on
   * the store seam rather than move-then-append. Posting them here as well
   * would count them twice, so a caller that appends one after the operation
   * gets a no-op rather than a second entry. Nothing is lost: the event exists,
   * written by the only party that could write it atomically.
   */
  private static readonly SELF_RECORDED = new Set<EventKind>([
    ...RESOLVE_KINDS,
    "propose",
    "import",
    // Both halves of a grounding pass are written by the route that changed
    // the claim, inside the same batch — so a caller appending one here would
    // count it twice, and `cite` in particular is the event a promotion
    // decision reads.
    "cite",
    "uncite",
  ])

  async append(kind: EventKind, id?: string, meta?: Record<string, unknown>): Promise<void> {
    if (HttpEventSink.SELF_RECORDED.has(kind)) return
    await callApi(this.opts, "/events", {
      method: "POST",
      body: JSON.stringify({ kind, claimId: id, meta }),
    })
  }

  /**
   * One request for the whole batch. The service takes an array on the
   * same route and records it all-or-nothing, so a batch never lands halfway.
   *
   * Self-recorded kinds are filtered first for the same reason `append`
   * ignores them, and a batch left empty by that filter makes no request at
   * all — posting `[]` would be a round trip that writes nothing, and the
   * service refuses it anyway.
   */
  async appendMany(events: EventInput[]): Promise<void> {
    const send = events.filter((e) => !HttpEventSink.SELF_RECORDED.has(e.kind))
    if (send.length === 0) return
    await callApi(this.opts, "/events", {
      method: "POST",
      body: JSON.stringify(send.map((e) => ({ kind: e.kind, claimId: e.id, meta: e.meta }))),
    })
  }

  /**
   * Not available, and deliberately not faked. The service exposes counts, not
   * a raw event stream, and answering with an empty array would make a caller's
   * arithmetic quietly wrong instead of loudly absent. `stats()` is what every
   * caller of `all()` actually wanted.
   */
  async all(): Promise<KbEvent[]> {
    throw new CairnHttpError(
      0,
      "unsupported",
      "the hosted service does not hand back its raw event log — use stats() for the counts",
    )
  }

  /**
   * Same refusal as `all()`, for the same reason: there is no raw event log
   * to hand back. Never actually called — `HttpStore.adoptImport` talks to
   * the hosted `/adopt` route directly, and the service reads its events from
   * its own storage rather than through this interface — but the
   * method has to exist for `HttpEventSink` to satisfy `EventSink`.
   */
  async allStrict(): Promise<KbEvent[]> {
    return this.all()
  }

  async stats(): Promise<Stats> {
    return callApi<Stats>(this.opts, "/stats")
  }
}

/**
 * Every branch names an ACTION, not just a fact. A sentence an operator cannot
 * act on is the same dead end as a bare catch: it ends the conversation at
 * "it doesn't work" instead of at the next thing to try.
 */
function messageFor(status: number, code?: string): string {
  // Before the generic 400 below, and built from the same shared constant
  // `FileStore` throws: a proposal whose citation states no scope is refused
  // by both stores in the same words, not by one with a sentence and by the
  // other with "one of the values sent was empty or malformed". The hosted
  // half sends the code; this is where the client turns it back into the
  // sentence, exactly as `agent_cannot_review` does below.
  if (status === 400 && code === "empty_supports") return EMPTY_SUPPORTS
  // Same arrangement, same reason: the hosted service decides, the
  // code is the only channel, and the sentence is built here so a migration
  // refused for an impossible hash reads identically whichever store refused it.
  if (status === 400 && code === "impossible_hash") return IMPOSSIBLE_HASH
  // A 403 that is neither a membership problem nor a review one: the caller is
  // an agent token that tried to supply a citation's recorded facts. It needs
  // its own sentence for the reason `agent_cannot_review` does — "ask an owner
  // to add you" is false and unactionable here.
  if (status === 403 && code === AGENT_PROVENANCE_CODE) {
    return AGENT_CANNOT_ASSERT_PROVENANCE
  }
  if (status === 400) {
    return "cairn could not read that request — one of the values sent was empty or malformed; check what you typed and try again"
  }
  if (status === 401) return "your token was revoked or expired — run `cairn login`"
  // Two different refusals arrive as 403 and they need different answers. One
  // is the wrong space; the other is the right space with a credential that may
  // not review. Collapsing them sends a person to check a membership that is
  // fine, when what they need is to authorize this machine. Matched on the
  // status as well as the code: only the human-only check emits this code today, and
  // pinning both is what keeps that true if some other status reuses the name.
  if (status === 403 && code === "agent_cannot_review") {
    return "this is an agent token, which cannot review — run `cairn login` to authorize this machine"
  }
  if (status === 403) {
    return "your token is not a member of that space — ask an owner to add you, or run `cairn login` if you meant to sign in as someone else"
  }
  if (status === 404) {
    return "that claim is not in this space — it may have been reviewed or removed already; run `cairn status` to see what is there"
  }
  if (status === 409) return "someone else already reviewed this claim"
  if (status === 503) return "cairn's storage is unavailable — try again shortly"
  return `cairn returned ${status}${code ? ` (${code})` : ""}`
}
