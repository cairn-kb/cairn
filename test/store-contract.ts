import type { CiteInput, Claim, ProposeInput, Store } from "@cairn-kb/protocol/types"
import {
  EMPTY_RETRACT_REASON,
  EMPTY_SUPPORTS,
  IMPOSSIBLE_HASH,
  notAdoptableMessage,
  notCitableMessage,
  notRetractableMessage,
  notUncitableMessage,
  unknownClaimMessage,
  unknownDocumentMessage,
} from "@cairn-kb/protocol/event-kinds"

/**
 * A Claim literal, for tests that need one in hand (rendering, parsing).
 *
 * Deliberately NOT how the contract cases below create claims: the store owns
 * the id, and a client-authored one never exists in a store that assigns them
 * server-side. Use `proposal` and `store.propose` for that.
 */
export const sample = (id: string, text: string): Claim => ({
  id,
  status: "pending",
  claim: text,
  body: "detail",
  source: { author: "alice", agent: "cursor", repo: null, session: null },
  created: "2026-08-28T09:00:00.000Z",
  reviewed: null,
  reviewer: null,
  retracted: null,
  overlaps: [],
  cites: [],
  abstract: null,
  abstractBy: null,
  tags: ["architecture"],
})

/**
 * The input side of the seam: everything a caller may decide about a new claim.
 * Everything absent from it — id, status, created, reviewer — belongs to the
 * store, which is why the cases below never author those.
 */
export const proposal = (text: string, over: Partial<ProposeInput> = {}): ProposeInput => ({
  claim: text,
  body: "detail",
  abstract: "what it settles",
  source: { author: "alice", agent: "cursor", repo: null, session: null },
  overlaps: [],
  cites: [],
  tags: ["architecture"],
  ...over,
})

/**
 * The subset of an assertion library any test runner provides. Keeping this
 * minimal is what lets the contract run under more than one runner without
 * either leaking into the other's environment.
 */
export interface ExpectFn {
  (actual: unknown): {
    toEqual(expected: unknown): void
    toBe(expected: unknown): void
    toBeNull(): void
  }
}

/**
 * The one event-log capability a contract case needs and the `Store` seam does
 * not expose.
 *
 * `read` is logged by the MCP layer, not by the store — locally through
 * `EventLog`, hosted through `POST /events` — yet it lands on the same event
 * stream the adoption guard reads, carrying the claim's id. That is exactly
 * why an imported claim an agent had read used to be un-adoptable, and a case
 * pinning the fix has to be able to record a read the way the real read path
 * does. Each harness supplies its own, so the hosted case goes through the
 * real route rather than a stand-in.
 */
export interface ContractLog {
  read(claimId: string): Promise<void>

  /**
   * Retract as an actor GUARANTEED distinct from whoever reviewed the claim
   * in this case, and the identity that actor's write should be attributed
   * to (`retractActorId`).
   *
   * `Store.retract` takes a `by` parameter, but `HttpStore.retract` ignores
   * it — the hosted route takes the actor from the authenticated principal,
   * the only actor it can trust — so a single `HttpStore` instance can never
   * retract as anyone other than whoever it is already signed in as. A
   * contract case that reviews and retracts through the same store therefore
   * reviews and retracts as the SAME actor on the hosted side, which is what
   * made the reviewer-preservation case below only accidentally correct: a
   * hosted retract that wrongly overwrote the recorded reviewer with the
   * retracting actor's id would be invisible, because that id is identical
   * to the reviewer's. Each harness supplies a second, genuinely different
   * identity — a second string for FileStore, a second seeded token for
   * HttpStore — so the case can tell "preserved" from "coincidentally equal".
   */
  retractAs(claimId: string, reason: string): Promise<Claim | null>
  retractActorId: string

  /**
   * Attach a citation as an actor GUARANTEED distinct from whoever proposed or
   * reviewed the claim, and the identity that actor's citation should be
   * attributed to (`citeActorId`).
   *
   * The exact arrangement `retractAs` has, for the exact reason: `HttpStore.cite`
   * IGNORES its `by` argument, because the hosted route takes the actor from
   * the authenticated principal — the only actor it can trust — so a single
   * `HttpStore` can only ever cite as whoever it is signed in as. Citing
   * through the case's own store would therefore attribute the citation to the
   * same identity that proposed the claim, and a `cite` that wrongly recorded
   * the claim's author, its proposing agent or the seeding principal would read
   * back identical to the right answer. Each harness supplies a second,
   * genuinely different identity — a second literal for FileStore, a second
   * seeded token for HttpStore — so the case can tell "the acting principal"
   * from "something belonging to the claim".
   */
  citeAs(claimId: string, input: CiteInput): Promise<Claim | null>
  citeActorId: string
}

export interface ContractCase {
  name: string
  run(store: Store, expect: ExpectFn, log: ContractLog): Promise<void>
}

/**
 * Ids in a stable order. `list` order differs legitimately between
 * implementations — FileStore sorts newest-first, the hosted list pages
 * oldest-first — and the interface promises neither, so the cases compare the
 * set. Sorting a set of store-assigned ids is deterministic; asserting an
 * order the interface does not specify would pin a local detail.
 */
const ids = (claims: Claim[]): string[] => claims.map((c) => c.id).sort()

/**
 * Behaviour every Store implementation must have.
 *
 * FileStore proves these describe something real; HttpStore is held to the
 * same list against the hosted service, which is what lets a local space and
 * a team space be swapped behind `Store` without either one behaving
 * differently.
 *
 * Two rules keep every case implementable by a hosted store:
 *   - claims are created through `propose`, because the store assigns the id;
 *   - a store's output is only ever compared to the same store's output, never
 *     to a client-authored literal whose id, created and reviewer the store
 *     legitimately owns.
 */
export const CONTRACT_CASES: ContractCase[] = [
  {
    name: "propose returns a pending claim that get returns unchanged",
    async run(store, expect) {
      const created = await store.propose(proposal("bun test does not typecheck"))
      expect(created.status).toBe("pending")
      // The write path and the read path must agree: a field the store keeps
      // in memory but loses on the way back out fails here.
      expect(await store.get(created.id)).toEqual(created)
    },
  },
  {
    name: "a fully populated proposal keeps its overlaps, abstract, tags and source",
    async run(store, expect) {
      // The fields most likely to be dropped in transit: a non-empty array of
      // ids, a nullable string with an enum companion, and the two source
      // fields that are null in a default proposal.
      const first = await store.propose(proposal("indexing happens on write"))
      const second = await store.propose(proposal("the index is rebuildable from files"))
      const created = await store.propose(
        proposal("a populated proposal must survive the round trip", {
          overlaps: [first.id, second.id],
          abstract: "Settles X. Does not settle Y.",
          tags: ["architecture", "testing"],
          source: { author: "alice", agent: "cursor", repo: "cairn", session: "s1" },
        }),
      )

      expect(await store.get(created.id)).toEqual(created)
      // The round trip above still passes when BOTH sides drop a field, so the
      // populated fields are asserted directly against what was proposed. An
      // implementation whose create path has no `overlaps` fails here, which is
      // the point: the store changes, not this case.
      expect([...created.overlaps].sort()).toEqual([first.id, second.id].sort())
      expect(created.abstract).toBe("Settles X. Does not settle Y.")
      // A machine wrote it and no human has looked; the provenance is part of
      // what a store must record, not a field it may invent.
      expect(created.abstractBy).toBe("agent")
      expect([...created.tags].sort()).toEqual(["architecture", "testing"])
      expect(created.source).toEqual({
        author: "alice",
        agent: "cursor",
        repo: "cairn",
        session: "s1",
      })
    },
  },
  {
    name: "an unknown id is null, not a throw",
    async run(store, expect) {
      expect(await store.get("missing")).toBeNull()
    },
  },
  {
    name: "list returns only the claims in the requested status",
    async run(store, expect) {
      const queued = await store.propose(proposal("stays in the queue"))
      const reviewed = await store.propose(proposal("leaves the queue once reviewed"))
      await store.review(reviewed.id, "approve")
      expect(ids(await store.list("pending"))).toEqual([queued.id])
      expect(ids(await store.list("approved"))).toEqual([reviewed.id])
    },
  },
  {
    name: "move changes status and the claim is findable under the new one",
    async run(store, expect) {
      const created = await store.propose(proposal("move is still part of the seam"))
      await store.move(created.id, "approved")
      expect((await store.get(created.id))!.status).toBe("approved")
      expect(await store.list("pending")).toEqual([])
    },
  },
  {
    name: "move on an unknown id rejects rather than silently succeeding",
    async run(store, expect) {
      // `move` returns void, so an implementation that treats "not there" as
      // "nothing to do" reports success for a claim it never moved. That is
      // the shape a hosted store falls into for free, because its review
      // endpoint answers a missing claim with a 404 the client is otherwise
      // happy to map to null — and `cairn review` would then tell an operator
      // it rejected a claim another reviewer had already resolved.
      // `.then(ok, err)` rather than try/catch: the runner-neutral ExpectFn
      // has no `rejects`, and this keeps the outcome a value to assert on.
      const outcome = await store.move("missing", "approved").then(
        () => "resolved",
        () => "rejected",
      )
      expect(outcome).toBe("rejected")
    },
  },
  {
    name: "review approves a claim and returns it in its new status",
    async run(store, expect) {
      const created = await store.propose(proposal("the status change and the event are one"))
      const decided = await store.review(created.id, "approve")
      expect(decided!.status).toBe("approved")
      expect((await store.get(created.id))!.status).toBe("approved")
    },
  },
  {
    name: "review with edits rewrites the claim, body and abstract and approves it in one operation",
    async run(store, expect) {
      // All THREE fields, because that is what terminal review sends on every
      // edit — `editClaim` opens claim, body and abstract in $EDITOR and hands
      // back all of them. A case that exercised only `claim` left the other two
      // unheld by either implementation.
      const created = await store.propose(proposal("the original wording"))
      const edits = {
        claim: "the improved wording",
        body: "the improved body, which is prose and spans as much as it likes",
        abstract: "Settles the wording. Does not settle the schedule.",
      }
      const decided = await store.review(created.id, "edit", edits)
      // An edit-then-approve IS an approval: the human read it, improved it and
      // let it through.
      expect(decided!.claim).toBe(edits.claim)
      expect(decided!.body).toBe(edits.body)
      expect(decided!.abstract).toBe(edits.abstract)
      expect(decided!.status).toBe("approved")
      const stored = await store.get(created.id)
      expect(stored!.claim).toBe(edits.claim)
      expect(stored!.body).toBe(edits.body)
      expect(stored!.abstract).toBe(edits.abstract)
    },
  },
  {
    name: "reviewing an already-resolved claim is refused rather than counted twice",
    async run(store, expect) {
      // Two reviewers open the queue at the same time, or one presses the key
      // twice. A second decision on a resolved claim appends a second
      // approve/reject and moves BOTH halves of the approve rate — the number
      // the product measures — for a claim nobody reviewed twice.
      const created = await store.propose(proposal("two people opened the queue at once"))
      await store.review(created.id, "approve")
      const err = await store.review(created.id, "reject").then(
        () => null,
        (e: unknown) => e,
      )
      // Both implementations have to report a lost race the same way: a numeric
      // 409 on the error, which is what `runReview` reads structurally to tell
      // a conflict from an infrastructure failure.
      expect((err as { status?: unknown } | null)?.status).toBe(409)
      expect((await store.get(created.id))!.status).toBe("approved")
      const s = await store.stats()
      expect(s.approved).toBe(1)
      expect(s.rejected).toBe(0)
      expect(s.approveRate).toBe(1)
    },
  },
  {
    name: "review rejects a claim, and the rejected claim is still readable",
    async run(store, expect) {
      const created = await store.propose(proposal("rejection is a decision, not a delete"))
      const decided = await store.review(created.id, "reject")
      expect(decided!.status).toBe("rejected")
      expect(ids(await store.list("rejected"))).toEqual([created.id])
    },
  },
  {
    name: "reviewing an unknown id is null, not a throw",
    async run(store, expect) {
      expect(await store.review("missing", "approve")).toBeNull()
    },
  },
  {
    name: "retract withdraws an approved claim and leaves the approve rate alone",
    run: async (store: Store, expect: ExpectFn, log: ContractLog) => {
      const claim = await store.propose(proposal("a sentence worth withdrawing"))
      const approved = await store.review(claim.id, "approve")
      const before = await store.stats()
      // Retracted through `log.retractAs`, not `store.retract` — a genuinely
      // different actor from whoever just reviewed it. See `ContractLog`.
      const out = await log.retractAs(claim.id, "the citation does not support it")
      expect(out?.status).toBe("retracted")
      expect(out?.retracted?.reason).toBe("the citation does not support it")
      // `Claim.retracted.by` names the actor who withdrew it — the
      // retractor, never the original reviewer.
      expect(out?.retracted?.by).toBe(log.retractActorId)
      // The original reviewer is not overwritten by the retraction. Compared
      // against the APPROVED claim, not the proposed one: the hosted store
      // records the reviewer at review time and FileStore leaves it
      // null, so the proposal's null would pin a difference between the two
      // stores rather than the thing this case is about. Meaningful only
      // because the retractor above is a different actor than the reviewer —
      // otherwise a reviewer wrongly overwritten by the
      // retraction would read back identical to the original by coincidence.
      expect(out?.reviewer).toEqual(approved?.reviewer)
      expect(out?.reviewed).toEqual(approved?.reviewed)
      const after = await store.stats()
      expect(after.approved).toBe(before.approved)
      expect(after.rejected).toBe(before.rejected)
      expect(after.approveRate).toBe(before.approveRate)
    },
  },
  {
    name: "retract reports an unknown claim as null",
    run: async (store: Store, expect: ExpectFn) => {
      expect(await store.retract("no-such-claim", "reason", "alice")).toBeNull()
    },
  },
  {
    name: "retract refuses a pending claim in the same words on both stores",
    run: async (store: Store, expect: ExpectFn) => {
      const claim = await store.propose(proposal("still pending"))
      let message: string | null = null
      try {
        await store.retract(claim.id, "reason", "alice")
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(notRetractableMessage(claim.id, "pending"))
    },
  },
  {
    name: "retract refuses a rejected claim in the same words on both stores",
    run: async (store: Store, expect: ExpectFn) => {
      const claim = await store.propose(proposal("turned down"))
      await store.review(claim.id, "reject")
      let message: string | null = null
      try {
        await store.retract(claim.id, "reason", "alice")
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(notRetractableMessage(claim.id, "rejected"))
    },
  },
  {
    name: "retracting twice is refused, not silently accepted",
    run: async (store: Store, expect: ExpectFn) => {
      const claim = await store.propose(proposal("withdrawn once"))
      await store.review(claim.id, "approve")
      await store.retract(claim.id, "first reason", "alice")
      let message: string | null = null
      try {
        await store.retract(claim.id, "second reason", "alice")
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(notRetractableMessage(claim.id, "already-retracted"))
      // The first retraction's reason survives the refused second attempt.
      expect((await store.get(claim.id))?.retracted?.reason).toBe("first reason")
    },
  },
  {
    name: "retract refuses an empty reason",
    run: async (store: Store, expect: ExpectFn) => {
      const claim = await store.propose(proposal("needs a reason"))
      await store.review(claim.id, "approve")
      let message: string | null = null
      try {
        await store.retract(claim.id, "   ", "alice")
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(EMPTY_RETRACT_REASON)
      expect((await store.get(claim.id))?.status).toBe("approved")
    },
  },
  {
    name: "retract trims a padded reason instead of storing it verbatim",
    run: async (store: Store, expect: ExpectFn) => {
      // The hosted service trims before the reason is stored — a reason of
      // "  x  " is stored as "x" there. `FileStore.retract`
      // used to check the trimmed value but persist the untrimmed one, which
      // is the one place the two stores disagreed about a reason a person
      // will read back later. Pinned here so both stores stay agreed, rather
      // than only on the route's own test.
      const claim = await store.propose(proposal("padding around the stated reason"))
      await store.review(claim.id, "approve")
      const out = await store.retract(
        claim.id,
        "  the citation does not support it  ",
        "alice",
      )
      expect(out?.retracted?.reason).toBe("the citation does not support it")
    },
  },
  {
    name: "put updates the abstract, its provenance and the tags of an existing claim",
    async run(store, expect) {
      // put is a content update, not a create: the hosted store maps it to a
      // patch of exactly these three fields on a claim that already exists.
      const created = await store.propose(proposal("put edits what propose created"))
      await store.put({
        ...created,
        abstract: "Curated by a human.",
        abstractBy: "human",
        tags: ["architecture", "testing"],
      }, "curate")
      const updated = await store.get(created.id)
      expect(updated!.abstract).toBe("Curated by a human.")
      expect(updated!.abstractBy).toBe("human")
      expect([...updated!.tags].sort()).toEqual(["architecture", "testing"])
    },
  },
  {
    name: "search finds a claim by its text",
    async run(store, expect) {
      const created = await store.propose(proposal("typecheck separately from the test run"))
      expect(ids(await store.search("typecheck"))).toEqual([created.id])
    },
  },
  {
    name: "search finds a claim by text that appears only in its body",
    async run(store, expect) {
      const created = await store.propose(
        proposal("an unremarkable headline", { body: "zephyrine invoice batching detail" }),
      )
      expect(ids(await store.search("zephyrine"))).toEqual([created.id])
    },
  },
  {
    name: "search excludes a claim whose text does not match the query",
    async run(store, expect) {
      // Every other search case holds exactly one claim, so a `search` that
      // ignored its argument and returned everything would pass all of them.
      // Two claims with disjoint wording is the smallest arrangement that can
      // tell a real query apart from "return the lot" — which matters most for
      // a store that compiles the query into an FTS expression.
      const matching = await store.propose(proposal("the ledger reconciles nightly"))
      await store.propose(proposal("an unrelated note about typography"))
      expect(ids(await store.search("ledger"))).toEqual([matching.id])
    },
  },
  {
    name: "search returns empty rather than throwing on no match",
    async run(store, expect) {
      expect(await store.search("nothing-matches-this")).toEqual([])
    },
  },
  {
    name: "search ranks the claim matching more of the question first",
    async run(store, expect) {
      // X matches both "deploy" and "wrangler"; Z matches only "wrangler"; Y
      // shares no word with the question at all, so a search that is still
      // one exact phrase would find none of them, and a search that merely
      // ORs the terms without ranking by how many matched would not be able
      // to tell X and Z apart, or put Y ahead of either.
      const x = await store.propose(
        proposal("The deploy uses wrangler", { body: "Run wrangler deploy from the api folder." }),
      )
      const z = await store.propose(proposal("Wrangler is pinned", { body: "Pinned to one version." }))
      await store.propose(proposal("Staging is separate", { body: "Unrelated." }))
      const hits = await store.search("how do we deploy with wrangler?")
      expect(hits.map((c) => c.id)).toEqual([x.id, z.id])
    },
  },
  {
    name: "search survives hostile text",
    async run(store, expect) {
      // Characters an FTS query expression treats as syntax: a bare quote, a
      // reserved keyword, a wildcard, a hyphen that reads as column-minus, an
      // unbalanced paren, and text that is nothing BUT punctuation. A
      // caller's literal words, none of this should ever reach the query
      // compiler unescaped.
      for (const q of ['"', "NOT", "*", "a-b", "(x", "?", "...", "- * ?"]) {
        expect(Array.isArray(await store.search(q))).toBe(true)
      }
      expect(await store.search("   ")).toEqual([])
    },
  },
  {
    name: "stats counts a proposal and the approval that resolved it",
    async run(store, expect) {
      // The approve rate is the number the product measures, and it now
      // comes from the store rather than from a file beside it. Both
      // implementations have to report it the same way or `cairn status` means
      // something different depending on who is signed in.
      const created = await store.propose(proposal("stats come from the store now"))
      await store.review(created.id, "approve")
      const s = await store.stats()
      expect(s.proposed).toBe(1)
      expect(s.approved).toBe(1)
      expect(s.rejected).toBe(0)
      expect(s.approveRate).toBe(1)
    },
  },
  {
    name: "importClaim creates an approved claim without a review",
    async run(store, expect) {
      const { claim: imported, created } = await store.importClaim(
        proposal("a document that entered without review"),
      )
      expect(created).toBe(true)
      expect(imported.status).toBe("approved")
      expect((await store.get(imported.id))!.status).toBe("approved")
      expect(ids(await store.list("approved"))).toEqual([imported.id])
      expect(await store.list("pending")).toEqual([])
      // Resolved, and attributed to whoever ran the import. The two stores
      // spell the identity differently — a local username here, an actor id
      // there — so the contract can only hold them both to "somebody", which
      // is enough to stop either drifting back to null.
      expect(imported.reviewed === null).toBe(false)
      expect(imported.reviewer === null).toBe(false)
    },
  },
  {
    name: "importing the same document twice creates it once and says so",
    async run(store, expect) {
      // The hosted store dedupes on the content of every claim it holds, in
      // any status. A caller cannot tell a fresh import from a repeat unless
      // the store says which happened — and a caller that guesses either
      // double-counts an import or aborts on one.
      const doc = proposal("the same document, imported twice")
      const first = await store.importClaim(doc)
      const second = await store.importClaim(doc)
      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.claim.id).toBe(first.claim.id)
      expect(ids(await store.list("approved"))).toEqual([first.claim.id])
    },
  },
  {
    name: "importing content a reviewer already rejected reports it rather than reviving it",
    async run(store, expect) {
      // The concrete path this closes: import a directory, reject one of the
      // claims in review, import the directory again. The store hands back the
      // rejected claim; an import that treated that as a failure would abort
      // every subsequent run, with no advice that could ever work.
      const doc = proposal("a document somebody already rejected")
      const proposed = await store.propose(doc)
      await store.review(proposed.id, "reject")
      const again = await store.importClaim(doc)
      expect(again.created).toBe(false)
      expect(again.claim.id).toBe(proposed.id)
      // Still rejected: importing must not walk a claim back past the gate.
      expect(again.claim.status).toBe("rejected")
      expect(await store.list("approved")).toEqual([])
    },
  },
  {
    name: "an import is neither an approval nor a resolution",
    async run(store, expect) {
      // The reason the `import` kind exists. Spelled as propose + approve, an
      // import of N documents adds N to both halves of the approve rate; if
      // either number below moves, the metric is being padded by an action
      // nobody reviewed.
      await store.importClaim(proposal("importing is not reviewing"))
      const s = await store.stats()
      expect(s.proposed).toBe(0)
      expect(s.approved).toBe(0)
      expect(s.rejected).toBe(0)
      expect(s.approveRate).toBeNull()
      // And it must not look like an unresolved proposal either: that is what
      // grows pendingAgeDays for ever against an empty queue.
      expect(s.pendingAgeDays).toBeNull()
    },
  },
]

/**
 * Document behaviour every Store implementation must have.
 *
 * Separate from CONTRACT_CASES only because the two implementations gained it
 * in different commits. Both harnesses run both arrays. Typed as plain
 * `ContractCase[]` now that `Store` itself carries the document methods —
 * both implementations satisfy them, so the `StoreWithDocuments` intersection
 * this used to need is gone.
 */
export const DOCUMENT_CONTRACT_CASES: ContractCase[] = [
  {
    name: "importDocument creates, and getDocument returns it unchanged",
    async run(store, expect) {
      const { document, outcome } = await store.importDocument({
        title: "Using MinerU", text: "It wants Python 3.10.", source: "tools/mineru.md",
      })
      expect(outcome).toBe("created")
      expect(document.id.startsWith("doc-")).toBe(true)
      expect(document.source).toBe("tools/mineru.md")
      expect(document.created).toBe(document.updated)
      expect(await store.getDocument(document.id)).toEqual(document)
    },
  },
  {
    name: "the same file imported twice is unchanged, not a second document",
    async run(store, expect) {
      const input = { title: "T", text: "same text", source: "a.md" }
      const first = await store.importDocument(input)
      const second = await store.importDocument(input)
      expect(second.outcome).toBe("unchanged")
      expect(second.document.id).toBe(first.document.id)
      expect((await store.listDocuments()).length).toBe(1)
    },
  },
  {
    name: "a changed file updates its document in place, keeping the id",
    async run(store, expect) {
      const first = await store.importDocument({ title: "T", text: "v1", source: "a.md" })
      const second = await store.importDocument({ title: "T2", text: "v2", source: "a.md" })
      expect(second.outcome).toBe("updated")
      // The id is what `cites` points at. A changed document that got a new id
      // would orphan every citation to it — which is the whole reason a
      // document is updated rather than superseded.
      expect(second.document.id).toBe(first.document.id)
      expect(second.document.text).toBe("v2")
      expect(second.document.title).toBe("T2")
      expect(second.document.created).toBe(first.document.created)
      // `updated` must never go backwards, and must not predate creation. That
      // it ADVANCES on a change is the real intent, but two imports inside one
      // millisecond produce identical ISO strings — asserting movement here is
      // asserting the clock's resolution, a flaky class of test to avoid.
      expect(second.document.updated >= first.document.updated).toBe(true)
      expect(second.document.updated >= second.document.created).toBe(true)
      expect((await store.listDocuments()).length).toBe(1)
    },
  },
  {
    name: "the same text at a different path is a different document",
    async run(store, expect) {
      await store.importDocument({ title: "T", text: "shared", source: "a.md" })
      const b = await store.importDocument({ title: "T", text: "shared", source: "b.md" })
      // Only a SOURCELESS document is claimed by matching text. Two real files
      // are two documents even when their contents coincide.
      expect(b.outcome).toBe("created")
      expect((await store.listDocuments()).length).toBe(2)
    },
  },
  {
    name: "searchDocuments finds a document by its text",
    async run(store, expect) {
      const { document } = await store.importDocument({
        title: "Ingestion", text: "conversion is an out-of-band pre-step", source: "a.md",
      })
      const hits = await store.searchDocuments("out-of-band")
      expect(hits.map((d) => d.id)).toEqual([document.id])
    },
  },
  {
    name: "searchDocuments ranks the document matching more of the question first",
    async run(store, expect) {
      // The same shape as the claim-ranking case, over documents instead of
      // claims: X matches both "deploy" and "wrangler", Z matches only
      // "wrangler", Y shares no word with the question and is excluded
      // outright.
      const { document: x } = await store.importDocument({
        title: "Deploy",
        text: "The deploy uses wrangler. Run wrangler deploy from the api folder.",
        source: "x.md",
      })
      const { document: z } = await store.importDocument({
        title: "Wrangler version",
        text: "Wrangler is pinned. Pinned to one version.",
        source: "z.md",
      })
      await store.importDocument({ title: "Staging", text: "Staging is separate. Unrelated.", source: "y.md" })
      const hits = await store.searchDocuments("how do we deploy with wrangler?")
      expect(hits.map((d) => d.id)).toEqual([x.id, z.id])
    },
  },
  {
    name: "searchDocuments survives hostile text",
    async run(store, expect) {
      // Same hostile inputs as the claim-search case: none of this should
      // ever reach the query compiler unescaped, and a blank question is no
      // question at all rather than a request for everything.
      for (const q of ['"', "NOT", "*", "a-b", "(x", "?", "...", "- * ?"]) {
        expect(Array.isArray(await store.searchDocuments(q))).toBe(true)
      }
      expect(await store.searchDocuments("   ")).toEqual([])
    },
  },
  {
    name: "a proposal's citations survive a round trip",
    async run(store, expect) {
      const { document } = await store.importDocument({ title: "T", text: "cited text", source: "a.md" })
      const claim = await store.propose(
        proposal("built on that document", { cites: [{ doc: document.id, supports: "the whole thing" }] }),
      )
      // Dropped anywhere between the tool call and storage, this is silent:
      // the claim still arrives, and only the citation is missing.
      expect((await store.get(claim.id))?.cites.map((c) => c.doc)).toEqual([document.id])
    },
  },
  {
    name: "a proposal's citation records what it supports, the document's hash and what was absent",
    async run(store, expect) {
      const { document } = await store.importDocument({
        title: "MinerU",
        text: "MinerU installs with pip install mineru[core]. The pipeline backend runs on CPU.",
        source: "mineru.md",
      })
      const claim = await store.propose(
        proposal("Docling Serve is the production default", {
          cites: [{ doc: document.id, supports: "the ingestion default" }],
        }),
      )
      const [cite] = (await store.get(claim.id))!.cites
      expect(cite!.doc).toBe(document.id)
      expect(cite!.supports).toBe("the ingestion default")
      // Copied from the document, never recomputed: `Document.hash` is already
      // hashText(text), and a second computation is how the two would drift.
      expect(cite!.hash).toBe(document.hash)
      // The headline term is absent; a term the document does contain is not
      // reported. Both halves, or a rule returning everything would pass.
      expect(cite!.absent).toEqual(["docling", "serve", "production", "default"])
    },
  },
  {
    name: "a proposal citing a document that is not in the space is refused by name",
    async run(store, expect) {
      let message = ""
      try {
        await store.propose(proposal("built on nothing", { cites: [{ doc: "doc-nope", supports: "x" }] }))
      } catch (err) {
        message = (err as Error).message
      }
      // A citation must point at a real document, because that is where its
      // hash comes from. Both stores refuse in the same sentence.
      expect(message).toBe(unknownDocumentMessage("doc-nope"))
    },
  },
  {
    name: "importing a document moves no reported number",
    async run(store, expect) {
      await store.importDocument({ title: "T", text: "text", source: "a.md" })
      const s = await store.stats()
      expect(s.proposed).toBe(0)
      expect(s.approved).toBe(0)
      expect(s.rejected).toBe(0)
      expect(s.approveRate).toBeNull()
      expect(s.pendingAgeDays).toBeNull()
    },
  },
  {
    name: "adoptImport turns an imported claim into a document and removes the claim",
    async run(store, expect) {
      const { claim } = await store.importClaim(proposal("Using MinerU", { body: "It wants Python 3.10." }))
      const doc = await store.adoptImport(claim.id)
      expect(doc.id.startsWith("doc-")).toBe(true)
      expect(doc.title).toBe("Using MinerU")
      expect(doc.text).toBe("It wants Python 3.10.")
      // No path was ever recorded for a claim, so there is none to invent.
      expect(doc.source).toBeNull()
      expect(await store.get(claim.id)).toBeNull()
      expect((await store.list("approved")).length).toBe(0)
    },
  },
  {
    name: "adoptImport refuses a claim a human proposed",
    async run(store, expect) {
      const claim = await store.propose(proposal("a human proposed this"))
      await store.review(claim.id, "approve")
      let message: string | null = null
      try {
        await store.adoptImport(claim.id)
      } catch (err) {
        message = (err as Error).message
      }
      // Both stores must refuse with the SAME sentence — asserting only that
      // it threw would pass even if the two implementations drifted onto
      // different wording, which is exactly what packages/protocol/src/event-kinds.ts's shared
      // `notAdoptableMessage` exists to make impossible.
      expect(message).toBe(notAdoptableMessage(claim.id, "judged"))
      // The guard is only worth having if the claim survives it.
      expect((await store.get(claim.id))?.status).toBe("approved")
    },
  },
  {
    name: "adoptImport refuses a claim that is not there, in the same words on both stores",
    async run(store, expect) {
      // The one outcome of `adoptImport` that was never made to agree.
      // Only 409 parity was mandated, so the two stores answered a
      // missing claim with different sentences — and the hosted one was the
      // generic 404, which tells you to run `cairn status` to find a claim
      // whose absence is the whole answer.
      //
      // Reachable only by losing a race: `adopt-imports` builds its candidate
      // list from `list("approved")`, so a claim adopted by a concurrent run
      // between the listing and the call arrives here. That it is rare is why
      // it drifted; it is not why it may be wrong.
      let message: string | null = null
      try {
        await store.adoptImport("no-such-claim")
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(unknownClaimMessage("no-such-claim"))
    },
  },
  {
    name: "two adoptions of one claim produce one document, and the loser is told so",
    async run(store, expect) {
      // The guard read and the write are not one operation on
      // either store, so both callers used to pass the guard and both then
      // wrote: TWO documents from one claim, identical in title, text and
      // hash, with both callers told it worked and nothing anywhere reporting
      // a number that looked wrong. Silent duplication of team knowledge, and
      // on the hosted store "two concurrent runs" is two teammates.
      //
      // `Promise.all` interleaves these at their awaits deterministically —
      // both reach their guard before either writes — so this needs no timing
      // trick and cannot flake on a slow machine.
      const { claim } = await store.importClaim(proposal("Using MinerU", { body: "It wants Python 3.10." }))
      const settle = (p: Promise<{ id: string }>) =>
        p.then((doc) => ({ doc, message: null }), (err: Error) => ({ doc: null, message: err.message }))
      const results = await Promise.all([
        settle(store.adoptImport(claim.id)),
        settle(store.adoptImport(claim.id)),
      ])

      const won = results.filter((r) => r.doc !== null)
      const lost = results.filter((r) => r.doc === null)
      expect(won.length).toBe(1)
      expect(lost.length).toBe(1)
      // The loser is refused in the words BOTH stores refuse a missing claim
      // with, which already say what happened here: another run
      // adopted it, which removes the claim and leaves the document behind.
      expect(lost[0]!.message).toBe(unknownClaimMessage(claim.id))
      // The assertion the whole case exists for. Asserting only that one call
      // threw would pass on a store that threw AFTER writing the second
      // document, which is the defect in its most dangerous form.
      expect((await store.listDocuments()).length).toBe(1)
      expect(await store.get(claim.id)).toBeNull()
    },
  },
  {
    name: "an imported claim an agent has read is still adoptable",
    async run(store, expect, log) {
      const { claim } = await store.importClaim(proposal("Using MinerU", { body: "Python 3.10." }))
      // The event that used to disqualify it. `read` carries the claim's id on
      // both stores, so an allow-list guard saw an event it did not recognise
      // and refused — permanently, for exactly the material `adopt-imports`
      // exists to convert, since agents are instructed to read it.
      await log.read(claim.id)
      const doc = await store.adoptImport(claim.id)
      expect(doc.title).toBe("Using MinerU")
      expect(await store.get(claim.id)).toBeNull()
    },
  },
  {
    name: "an adopted document is claimed by a later import of the same text",
    async run(store, expect) {
      const { claim } = await store.importClaim(proposal("Using MinerU", { body: "It wants Python 3.10." }))
      const adopted = await store.adoptImport(claim.id)
      const reimported = await store.importDocument({
        title: "Using MinerU", text: "It wants Python 3.10.", source: "tools/mineru.md",
      })
      // Same id: adopt-then-reimport must not leave two copies of everything.
      expect(reimported.document.id).toBe(adopted.id)
      expect(reimported.document.source).toBe("tools/mineru.md")
      expect((await store.listDocuments()).length).toBe(1)
    },
  },
  {
    name: "an approved claim can gain a citation without a duplicate being created",
    async run(store, expect, log) {
      const { document } = await store.importDocument({
        title: "MinerU", text: "MinerU installs with pip install mineru[core].", source: "m.md",
      })
      const claim = await store.propose(proposal("MinerU installs from pip"))
      await store.review(claim.id, "approve")
      // Cited through `log.citeAs`, not `store.cite` — a genuinely different
      // actor from whoever proposed and approved it. See `ContractLog`.
      const cited = await log.citeAs(claim.id, { doc: document.id, supports: "the install command" })
      expect(cited!.status).toBe("approved")
      expect(cited!.cites.length).toBe(1)
      expect(cited!.cites[0]!.supports).toBe("the install command")
      expect(cited!.cites[0]!.hash).toBe(document.hash)
      // The acting identity — not the claim's author, not the agent that
      // proposed it, and not a name the caller invented. Meaningful only
      // because the citer above is a different actor from the proposer.
      expect(cited!.cites[0]!.by).toBe(log.citeActorId)
      // Nothing was proposed and nothing was reviewed.
      expect((await store.list("approved")).length).toBe(1)
    },
  },
  {
    name: "citing an unknown claim is null, and citing an unknown document is refused by name",
    async run(store, expect) {
      expect(await store.cite("no-such-claim", { doc: "doc-x", supports: "x" }, "cursor")).toBeNull()
      const claim = await store.propose(proposal("something"))
      let message = ""
      try {
        await store.cite(claim.id, { doc: "doc-nope", supports: "x" }, "cursor")
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(notCitableMessage(claim.id, "doc-nope", "unknown-document"))
    },
  },
  {
    name: "citing a document the claim already cites is refused, not silently ignored",
    async run(store, expect) {
      const { document } = await store.importDocument({ title: "d", text: "text", source: "d.md" })
      const claim = await store.propose(proposal("something", { cites: [{ doc: document.id, supports: "first" }] }))
      let message = ""
      try {
        await store.cite(claim.id, { doc: document.id, supports: "second" }, "cursor")
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(notCitableMessage(claim.id, document.id, "already-cited"))
      // The first scope stands: a silent overwrite would discard the account
      // somebody already gave of this document.
      expect((await store.get(claim.id))!.cites[0]!.supports).toBe("first")
    },
  },
  {
    name: "unciting removes the citation from the claim and refuses a document it never cited",
    async run(store, expect) {
      const { document } = await store.importDocument({ title: "d", text: "text", source: "d.md" })
      const claim = await store.propose(proposal("something", { cites: [{ doc: document.id, supports: "first" }] }))
      const after = await store.uncite(claim.id, document.id)
      expect(after!.cites).toEqual([])
      expect(await store.uncite("no-such-claim", document.id)).toBeNull()
      let message = ""
      try {
        await store.uncite(claim.id, document.id)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(notUncitableMessage(claim.id, document.id))
    },
  },
  {
    // `provenance` is honoured for a human principal so a migration
    // can copy what a citation recorded rather than let this store recompute
    // it — recomputing stamps today's hash on a check somebody ran days ago.
    // That left `hash` stored verbatim and unchecked, and every later "the
    // document has changed since it was cited" is a comparison against it. A
    // value that was never a digest decides that comparison forever.
    //
    // A SHAPE check, not a recomputation: the text the hash was taken from is
    // whatever the source space held, not what this one has. And nothing here
    // touches `by` — migration has to carry an original citer's name.
    name: "a citation may not record a hash that could not be a digest",
    async run(store, expect) {
      const { document } = await store.importDocument({ title: "d", text: "text", source: "d.md" })
      let message = ""
      try {
        await store.propose(
          proposal("something", {
            cites: [
              {
                doc: document.id,
                supports: "the detail",
                provenance: { hash: "deadbeef", absent: [], by: "someone-else" },
              },
            ],
          }),
        )
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(IMPOSSIBLE_HASH)
    },
  },
  {
    // The control, and it is load-bearing rather than decorative: `null` means
    // "no hash was recorded", older citations carry it, and they are exactly the pre-0.6.4 ones a migration exists to
    // move. A check that refused `null` alongside "deadbeef" would refuse
    // `cairn init --team` on the only spaces that need it — and would look
    // identical in every test that only asserts the refusal.
    name: "a citation may record no hash at all, which is not the same as a bad one",
    async run(store, expect) {
      const { document } = await store.importDocument({ title: "d", text: "text", source: "d.md" })
      const claim = await store.propose(
        proposal("something", {
          cites: [
            {
              doc: document.id,
              supports: "the detail",
              provenance: { hash: null, absent: null, by: "someone-else" },
            },
          ],
        }),
      )
      const stored = (await store.get(claim.id))!.cites[0]!
      expect(stored.hash).toBe(null)
      // Carried, not recomputed — the whole point of the mechanism.
      expect(stored.absent).toBe(null)
      expect(stored.by).toBe("someone-else")
    },
  },
  {
    name: "a citation must say what it supports",
    async run(store, expect) {
      const { document } = await store.importDocument({ title: "d", text: "text", source: "d.md" })
      const claim = await store.propose(proposal("something"))
      let message = ""
      try {
        await store.cite(claim.id, { doc: document.id, supports: "   " }, "cursor")
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(EMPTY_SUPPORTS)
    },
  },
  {
    // The parity gap this closes was real and shipped: `FileStore.propose`
    // ACCEPTED an empty `supports` and stored it, while the hosted store
    // refused it with a generic error. Only `cite`
    // had the guard on both stores, and no case exercised `propose` — so the
    // one refusal the two stores disagreed about was the one nothing asked
    // about. Both halves now ask `statesNoScope`, and both answer in the same
    // words.
    name: "a citation offered at propose time must say what it supports too",
    async run(store, expect) {
      const { document } = await store.importDocument({ title: "d", text: "text", source: "d.md" })
      let message = ""
      try {
        await store.propose(proposal("something", { cites: [{ doc: document.id, supports: "   " }] }))
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toBe(EMPTY_SUPPORTS)
      // Refused, not stored scope-less: a claim on disk (or a hosted row)
      // citing a document with nothing said about what it grounds, and
      // "the propose call threw" would be satisfied by
      // a store that wrote the claim first and complained afterwards.
      expect((await store.list("pending")).length).toBe(0)
    },
  },
  {
    // The exception `statesNoScope` exists for, held as a contract because it
    // is what `cairn init --team` depends on: a pre-0.6.4 citation parses to
    // `supports: ""` (src/claims.ts), and older spaces hold them on APPROVED
    // claims. Refusing those refuses the migration itself,
    // permanently and identically on every re-run. A scope-less citation may
    // be COPIED forward — that is what `provenance` marks — and may not be
    // created.
    name: "a scope-less citation carrying its recorded facts is copied, not refused",
    async run(store, expect) {
      const { document } = await store.importDocument({ title: "d", text: "text", source: "d.md" })
      const claim = await store.propose(
        proposal("something", {
          cites: [
            {
              doc: document.id,
              supports: "",
              // Exactly what `parseCites` reads a bare-string citation back
              // as: no hash, no absence check, nobody named.
              provenance: { hash: null, absent: null, by: "unknown" },
            },
          ],
        }),
      )
      const stored = (await store.get(claim.id))!.cites[0]!
      expect(stored.doc).toBe(document.id)
      expect(stored.supports).toBe("")
      // The three facts that must arrive as themselves. A store that
      // recomputed would put the document's current hash here and an array in
      // `absent` — a check nobody ran, rendered on both human surfaces as one
      // that did.
      expect(stored.hash).toBeNull()
      expect(stored.absent).toBeNull()
      expect(stored.by).toBe("unknown")
    },
  },
  // --- A source-less document migrates as source-less -----------------------
  //
  // `adoptImport` turns a legacy imported claim into a document with no file
  // behind it. Migration used to invent one — `source: doc.source ?? doc.id` —
  // which put a document id where a path belongs, and cost a duplicate the
  // first time the same corpus was imported into the team space. These run
  // against BOTH stores, which is the point: the two halves have to agree
  // about what a null source does, and they reach it by different mechanics
  // (`null === null` is true in JS and false in SQL).
  {
    name: "a document with no source imports as source-less rather than inventing one",
    async run(store, expect) {
      const { document, outcome } = await store.importDocument({
        title: "Adopted", text: "text with no file behind it", source: null,
      })
      expect(outcome).toBe("created")
      expect(document.source).toBeNull()
      expect(await store.getDocument(document.id)).toEqual(document)
    },
  },
  {
    name: "the file whose text matches a source-less document claims it instead of duplicating it",
    async run(store, expect) {
      // The whole of the migration guarantee in three calls: adopt (here, a source-less
      // import), migrate, then import the original corpus.
      const adopted = await store.importDocument({
        title: "Adopted", text: "It wants Python 3.10.", source: null,
      })
      expect(adopted.document.source).toBeNull()

      const reimported = await store.importDocument({
        title: "Using MinerU", text: "It wants Python 3.10.", source: "tools/mineru.md",
      })
      // Same document, now carrying the path. A new id here would orphan every
      // citation pointing at the adopted one.
      expect(reimported.document.id).toBe(adopted.document.id)
      expect(reimported.document.source).toBe("tools/mineru.md")
      expect(reimported.outcome).toBe("updated")
      expect((await store.listDocuments()).length).toBe(1)
    },
  },
  {
    name: "a generated document reads back generated, with its repo",
    async run(store, expect) {
      const { document } = await store.importDocument({
        title: "Generated",
        text: "machine-written text",
        source: "gen.md",
        generated: true,
        repo: "app",
      })
      expect(document.generated).toBe(true)
      expect(document.repo).toBe("app")
      expect(await store.getDocument(document.id)).toEqual(document)
      const hits = await store.searchDocuments("machine-written")
      expect(hits.map((d) => d.id)).toEqual([document.id])
      expect(hits[0]!.generated).toBe(true)
      expect(hits[0]!.repo).toBe("app")
    },
  },
  {
    name: "a document imported without the fields reads back without them",
    async run(store, expect) {
      const { document } = await store.importDocument({
        title: "Human", text: "human-written text", source: "human.md",
      })
      expect("generated" in document).toBe(false)
      expect("repo" in document).toBe(false)
      const fetched = await store.getDocument(document.id)
      expect("generated" in fetched!).toBe(false)
      expect("repo" in fetched!).toBe(false)
    },
  },
  {
    name: "one source-less document does not claim another with different text",
    async run(store, expect) {
      // The control, and the trap the fix had to avoid: matching by source
      // with a null input is `null === null` in JS, which would claim whatever
      // source-less document happened to be first REGARDLESS of its text. Two
      // adopted documents migrating in the same run is the ordinary case, so
      // this is not hypothetical.
      const first = await store.importDocument({ title: "One", text: "the first text", source: null })
      const second = await store.importDocument({ title: "Two", text: "the second text", source: null })
      expect(second.outcome).toBe("created")
      // `ExpectFn` is the subset both runners share and has no `.not`, so the
      // comparison is the value.
      expect(second.document.id === first.document.id).toBe(false)
      expect((await store.listDocuments()).length).toBe(2)
      // And each kept its own text, rather than one overwriting the other.
      expect((await store.getDocument(first.document.id))?.text).toBe("the first text")
      expect((await store.getDocument(second.document.id))?.text).toBe("the second text")
    },
  },
]

// --- Passages ----------------------------------------------------------------
//
// Search answers with the passage of a document that matches, not the whole
// document. Both stores cut documents with the same chunker, so headings and
// offsets are the same on both, and an offset one hands out is a JavaScript
// string index into `Document.text` that a read at that offset lands on.

/** A body long enough to stay its own section (the chunker merges short ones). */
const body = (words: string): string =>
  [
    `This part is about ${words}.`,
    `Everything said here concerns ${words} and nothing else.`,
    `A reader looking for ${words} should land on this part.`,
    `It runs on for a few sentences so it is not merged into a neighbour.`,
    `That keeps ${words} in a passage of its own.`,
  ].join(" ")

/**
 * Three sections under one title. The first carries characters outside the
 * Basic Multilingual Plane and accents, so an offset counted in bytes or in
 * code points lands somewhere other than one counted in UTF-16 units.
 */
const runbook = (sections: ("billing" | "deploys" | "alerts")[]): string => {
  const parts: Record<string, string> = {
    billing: `## Billing\n\nCafé crème 🚀🚀 — ${body("invoices and stripe refunds")}`,
    deploys: `## Deploys\n\n${body("wrangler rollouts")}`,
    alerts: `## Alerts\n\n${body("pager escalation")}`,
  }
  return sections.map((s) => parts[s]).join("\n\n")
}

export const PASSAGE_CONTRACT_CASES: ContractCase[] = [
  {
    name: "a passage hit points at its span",
    async run(store, expect) {
      const { document } = await store.importDocument({
        title: "Runbook", text: runbook(["billing", "deploys", "alerts"]), source: "runbook.md",
      })
      const { hits } = await store.searchPassages("wrangler rollouts")
      const hit = hits[0]!
      expect(hit.doc).toBe(document.id)
      expect(hit.heading).toBe("Runbook › Deploys")
      expect(hit.title).toBe("Runbook")
      expect(hit.source).toBe("runbook.md")
      const doc = await store.getDocument(hit.doc)
      expect(doc!.text.slice(hit.offset, hit.offset + hit.length)).toBe(hit.text)
      expect(hit.text.startsWith("This part is about wrangler rollouts.")).toBe(true)
    },
  },
  {
    name: "read at a passage's offset starts on it",
    async run(store, expect) {
      await store.importDocument({
        title: "Runbook", text: runbook(["billing", "deploys", "alerts"]), source: "runbook.md",
      })
      const { hits } = await store.searchPassages("pager escalation")
      const hit = hits[0]!
      const doc = await store.getDocument(hit.doc)
      // What a read at `offset` returns: the text from that string index on.
      // A store counting offsets in bytes or code points would land past the
      // passage here, because the first section holds an emoji and accents.
      expect(doc!.text.slice(hit.offset).startsWith(hit.text.slice(0, 50))).toBe(true)
    },
  },
  {
    name: "re-import replaces passages",
    async run(store, expect) {
      const { document } = await store.importDocument({
        title: "Runbook", text: runbook(["billing", "deploys", "alerts"]), source: "runbook.md",
      })
      expect((await store.searchPassages("pager escalation")).hits.some((h) => h.doc === document.id)).toBe(true)
      const second = await store.importDocument({
        title: "Runbook", text: runbook(["billing", "deploys"]), source: "runbook.md",
      })
      expect(second.document.id).toBe(document.id)
      const { hits } = await store.searchPassages("pager escalation")
      expect(hits.some((h) => h.doc === document.id)).toBe(false)
      // The sections that stayed are still found.
      expect((await store.searchPassages("wrangler rollouts")).hits[0]!.doc).toBe(document.id)
    },
  },
  {
    name: "at most two passages per document",
    async run(store, expect) {
      const text = ["One", "Two", "Three", "Four"]
        .map((h) => `## ${h}\n\n${body(`zebra crossings, part ${h.toLowerCase()}`)}`)
        .join("\n\n")
      const { document } = await store.importDocument({ title: "Zebras", text, source: "zebras.md" })
      const { hits } = await store.searchPassages("zebra")
      expect(hits.filter((h) => h.doc === document.id).length).toBe(2)
    },
  },
  {
    name: "one long document does not crowd out the others",
    async run(store, expect) {
      // Sixty sections dense with the word outrank every other document's
      // single mention. Capping each document only after a fixed depth of
      // rows lets this one fill the whole depth and leave the rest unseen.
      const text = Array.from({ length: 60 }, (_, i) =>
        `## Part ${i}\n\n` + "zebra zebra zebra stripes. ".repeat(10) + `More words for part ${i}.`).join("\n\n")
      const big = await store.importDocument({ title: "Zebra manual", text, source: "big.md" })
      for (let i = 0; i < 6; i++) {
        await store.importDocument({ title: `Note ${i}`, text: `A note that mentions a zebra once, item ${i}.`, source: `n${i}.md` })
      }
      const { hits } = await store.searchPassages("zebra")
      expect(hits.length).toBe(6)
      expect(hits.filter((h) => h.doc === big.document.id).length).toBe(2)
      expect(new Set(hits.filter((h) => h.doc !== big.document.id).map((h) => h.doc)).size).toBe(4)
    },
  },
  {
    name: "limit bounds the hits",
    async run(store, expect) {
      await store.importDocument({ title: "A", text: body("quokka habitats"), source: "a.md" })
      await store.importDocument({ title: "B", text: body("quokka diets"), source: "b.md" })
      expect((await store.searchPassages("quokka")).hits.length).toBe(2)
      expect((await store.searchPassages("quokka", { limit: 1 })).hits.length).toBe(1)
    },
  },
  {
    name: "a blank query has no hits",
    async run(store, expect) {
      await store.importDocument({ title: "A", text: body("anything at all"), source: "a.md" })
      expect(await store.searchPassages("   ")).toEqual({ hits: [] })
    },
  },
  {
    name: "generated and repo ride on the hit",
    async run(store, expect) {
      const gen = await store.importDocument({
        title: "Overview", text: body("ocelot overview"), source: "gen.md", generated: true, repo: "app",
      })
      const human = await store.importDocument({ title: "Notes", text: body("ocelot notes"), source: "notes.md" })
      const { hits } = await store.searchPassages("ocelot")
      const g = hits.find((h) => h.doc === gen.document.id)!
      const h = hits.find((x) => x.doc === human.document.id)!
      expect(g.generated).toBe(true)
      expect(g.repo).toBe("app")
      expect(h.generated).toBe(false)
      expect(h.repo).toBeNull()
    },
  },
  {
    name: "searchDocuments still finds whole documents",
    async run(store, expect) {
      // The document-ranking case, now answered through passages: X matches
      // both "deploy" and "wrangler", Z only "wrangler", Y neither. What comes
      // back is each whole document, not the passage that matched.
      const { document: x } = await store.importDocument({
        title: "Deploy",
        text: "The deploy uses wrangler. Run wrangler deploy from the api folder.",
        source: "x.md",
      })
      const { document: z } = await store.importDocument({
        title: "Wrangler version",
        text: "Wrangler is pinned. Pinned to one version.",
        source: "z.md",
      })
      await store.importDocument({ title: "Staging", text: "Staging is separate. Unrelated.", source: "y.md" })
      const hits = await store.searchDocuments("how do we deploy with wrangler?")
      expect(hits.map((d) => d.id)).toEqual([x.id, z.id])
      expect(hits[0]).toEqual(await store.getDocument(x.id))
    },
  },
]
