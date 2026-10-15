import type { Citation, CiteInput, Claim, ProposeInput, Status, Store } from "@cairn-kb/protocol/types"

/**
 * Which local claims move into a team space, and how.
 *
 * Pure, and separate from the writing, because this is the function that can
 * corrupt the approve rate, the number this product measures. A rejected claim replayed
 * as propose-then-reject adds one to both halves of the approve rate for a
 * decision no human made in the team space.
 */
export interface MigrationPlan {
  toImport: Claim[]
  toPropose: Claim[]
  leftBehind: Claim[]
}

/**
 * Route local claims for migration into a team space.
 */
export function planMigration(claims: Claim[]): MigrationPlan {
  return {
    toImport: claims.filter((c) => c.status === "approved"),
    toPropose: claims.filter((c) => c.status === "pending"),
    // Rejected AND retracted. Both are claims a human decided against; neither
    // belongs in a new space, and a status matching none of the three buckets
    // would be dropped from the plan without appearing in any total.
    leftBehind: claims.filter((c) => c.status === "rejected" || c.status === "retracted"),
  }
}

/** Every status a local store can hold. Migration reads all four — there is
 *  no `list("all")` on the seam — and hands the union to `planMigration`. */
const ALL_STATUSES: readonly Status[] = ["approved", "pending", "rejected", "retracted"]

/**
 * A claim's content, restated as the input side of the seam. Everything the
 * target store must assign itself — id, status, reviewer, timestamps — is
 * left off, the same rule `proposal` in the test helpers follows.
 *
 * `overlaps` and `cites` are taken as parameters rather than read off `c`
 * directly: by the time a claim is handed to `to.propose`/`to.importClaim`,
 * both arrays have already been rewritten from source ids to target ids (see
 * `remapIds` and the loop in `runMigration`). Reading `c.overlaps`/`c.cites`
 * here would silently put the un-remapped, source-space ids back in.
 */
function toProposeInput(c: Claim, overlaps: string[], cites: CiteInput[]): ProposeInput {
  return {
    claim: c.claim,
    body: c.body,
    abstract: c.abstract ?? "",
    source: c.source,
    overlaps,
    cites,
    tags: c.tags,
  }
}

/**
 * Rewrite a list of source-space ids into target-space ids, via a map from
 * one to the other. An id with no entry is dropped rather than kept
 * un-remapped or thrown on: the one case this reaches in practice is an
 * overlap naming a claim that was rejected and so stayed behind (`planMigration`
 * never sends a rejected claim's id into either map) — nothing in the team
 * space will ever exist to resolve it, so carrying it forward would just be a
 * dangling reference with extra steps.
 */
function remapIds(ids: string[], map: Map<string, string>): string[] {
  return ids.flatMap((id) => {
    const mapped = map.get(id)
    return mapped === undefined ? [] : [mapped]
  })
}

/**
 * The same remap for citations, which are no longer bare ids.
 *
 * Everything the citation already recorded travels with it as `provenance`,
 * rather than being recomputed by the target store. A migration COPIES a
 * citation; it does not make one. Recomputing would stamp the document's
 * current hash on a check somebody ran days ago — so every "this document has
 * changed since it was cited" warning would vanish the moment a space
 * migrated, which is the one signal a staleness check leaves behind — and a legacy
 * citation's uncomputed `absent` would come out the far side looking like a
 * check that had actually run.
 */
function remapCites(cites: Citation[], map: Map<string, string>): CiteInput[] {
  return cites.flatMap((c) => {
    const mapped = map.get(c.doc)
    if (mapped === undefined) return []
    return [
      {
        doc: mapped,
        supports: c.supports,
        provenance: { hash: c.hash, absent: c.absent, by: c.by },
      },
    ]
  })
}

/**
 * The same equality `FileStore.findByContent` uses (`src/store.ts`): claim
 * text and body, nothing else. Mirrored rather than reinvented so local and
 * hosted agree on what "the same claim" means — one rule, not two.
 */
const contentKey = (c: { claim: string; body: string }): string => `${c.claim}\n${c.body}`

/** `(created, id)` as a single comparable string. Used only to break a tie
 *  between two claims that are otherwise equally ready to move — see
 *  `orderForMigration`. Never used to decide *whether* one claim must precede
 *  another; that is the dependency graph's job. */
const readyKey = (c: Claim): string => `${c.created} ${c.id}`

/**
 * Order the claims moving in this migration so that whatever a claim
 * references is always emitted before the claim itself.
 *
 * `created` ascending is NOT the mechanism, only the tiebreak. It was tried
 * first and is wrong on its own: two claims proposed within the same
 * millisecond tie under it, and `Array.prototype.sort` is stable, so a tie
 * falls back to *input* order — which is `FileStore.list`'s newest-first
 * order, i.e. backwards. On that tie the referencing claim can be emitted
 * before its referent, `claimIds`/`docIds` won't have an entry for it yet,
 * and `remapIds` drops the reference — silently, with no error. That is
 * the same id-remapping defect again, narrowed to same-millisecond creation, and bulk or
 * scripted proposes are exactly where two writes land inside one
 * millisecond.
 *
 * The actual mechanism is a topological sort: build an edge from a claim to
 * every OTHER migrating claim its `overlaps`/`cites` names (an id outside
 * this set — a document, or a rejected claim left behind — is not a
 * dependency here; `remapIds` is what handles those, once each claim's own
 * position in the order is settled), then repeatedly emit whichever
 * currently-ready claim (no unemitted dependency left) sorts lowest by
 * `(created, id)`. `created` still does real work — it is what makes the
 * order match real-world proposal order whenever there is no tie — it has
 * just stopped being the whole algorithm.
 *
 * This is sound, and terminates, because references point strictly
 * backwards in time: `findOverlaps` (`src/claims.ts`) is called with the
 * already-`approved` list, so an overlap always names a claim that was
 * approved before this one was proposed, and a citation always names a
 * document that existed when the claim was proposed. A claim can therefore
 * never (in practice) depend on itself, directly or by a cycle back through
 * others — the dependency graph among real claims is acyclic. "In practice"
 * is doing real work in that sentence: nothing here trusts the invariant
 * blindly. If the claims being migrated ever do form a dependency cycle — a
 * hand-edited `overlaps` field, or a bug elsewhere that let one through —
 * the claims stuck in it are emitted in `(created, id)` order without
 * resolving the cycle, and `out` is told which claims that happened to. A
 * migration that stops halfway over a graph it can't fully order is a worse
 * failure than one that occasionally loses a link it can name.
 */
export function orderForMigration(claims: Claim[], out: (line: string) => void): Claim[] {
  const ids = new Set(claims.map((c) => c.id))
  const byId = new Map(claims.map((c) => [c.id, c]))

  // `remainingDeps.get(id)` shrinks as dependencies are emitted; `dependents`
  // is the reverse edge, used to find who becomes ready next.
  const remainingDeps = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  for (const c of claims) {
    const deps = new Set<string>()
    for (const ref of [...c.overlaps, ...c.cites.map((cite) => cite.doc)]) {
      if (ref !== c.id && ids.has(ref)) deps.add(ref)
    }
    remainingDeps.set(c.id, deps)
  }
  for (const c of claims) {
    for (const dep of remainingDeps.get(c.id)!) {
      if (!dependents.has(dep)) dependents.set(dep, new Set())
      dependents.get(dep)!.add(c.id)
    }
  }

  const emitted = new Set<string>()
  const order: Claim[] = []
  // The pool of claims with no unemitted dependency left. Re-sorted each
  // iteration rather than kept as a heap — migrations are not large enough
  // for that to matter, and a plain sort is what stays readable next to
  // everything else in this file.
  let ready = claims.filter((c) => remainingDeps.get(c.id)!.size === 0)

  while (ready.length > 0) {
    ready.sort((a, b) => (readyKey(a) < readyKey(b) ? -1 : readyKey(a) > readyKey(b) ? 1 : 0))
    const next = ready.shift()!
    order.push(next)
    emitted.add(next.id)
    for (const dependent of dependents.get(next.id) ?? []) {
      const deps = remainingDeps.get(dependent)!
      deps.delete(next.id)
      if (deps.size === 0) ready.push(byId.get(dependent)!)
    }
  }

  if (order.length < claims.length) {
    // Everything NOT yet emitted at this point — not only the cycle's own
    // members. A claim merely DOWNSTREAM of a cycle (it depends on a cycle
    // member, but isn't part of the cycle itself) never became ready either,
    // since the dependency it's waiting on never got emitted, so it lands in
    // `stuck` too. Sorting the whole group by `(created, id)` rather than
    // singling out the cycle means such a dependent can land before the very
    // claim it depends on, losing a link that breaking just the one real
    // cycle and resuming would have kept. Acceptable under "report and
    // continue rather than stop halfway" — but worth knowing, since it means
    // one bad cycle can cost more links than the cycle itself names.
    const stuck = claims
      .filter((c) => !emitted.has(c.id))
      .sort((a, b) => (readyKey(a) < readyKey(b) ? -1 : readyKey(a) > readyKey(b) ? 1 : 0))
    out(
      `migration found a reference cycle among ${stuck.length} claim(s), emitted in creation ` +
        `order without resolving it: ${stuck.map((c) => c.claim).join(", ")} — check these ` +
        "claims' overlaps/cites for a hand-edited or corrupted reference, clear whichever one " +
        "closes the cycle, and re-run the migration to pick up the link(s) this pass could not.",
    )
    order.push(...stuck)
  }

  return order
}

/**
 * Move a local space's claims and documents into a team space.
 *
 * Documents move first, and unconditionally — a document has no rejected
 * state (there is nothing about imported, unreviewed material for a reviewer
 * to have turned down), so every document `from` holds moves to `to`. That
 * builds `docIds`, a map from a document's id in `from` to its id in `to`,
 * before a single claim is looked at.
 *
 * Claims then move in ONE pass across both the approved and pending sets
 * together, ordered by `orderForMigration` — not two separate batches, and
 * not a plain `created` sort; see that function for why a sort alone is not
 * enough. This is the id-remapping fix: `overlaps` and `cites`
 * on a claim name ids from `from`'s space, and `to` mints its own ids, so
 * those arrays are rewritten (via `docIds` and `claimIds`, the latter built
 * claim-by-claim as this loop runs) at the moment each claim is created —
 * there is no second pass that goes back and patches them in afterwards,
 * because there is nowhere on the seam that could carry them: `HttpStore.put`
 * cannot send `overlaps` or `cites` to the hosted store (see the KNOWN LIMIT
 * documented in `HttpStore.put`): the server accepts three fields there,
 * and neither is one of them.
 *
 * An id with no entry in either map — the target of an overlap that was
 * itself rejected, and so left behind by `planMigration` rather than moved —
 * is dropped, not carried through un-remapped and not thrown on: see
 * `remapIds`.
 *
 * Nothing here calls `to.review`; replaying a rejection as propose-then-reject
 * would fabricate a decision no human made in the team space and move the
 * approve rate, the one number this product exists to measure.
 *
 * Does not touch `from` at all beyond reading it — local files are never
 * deleted, so a failure part-way (or a deliberate re-run) always has the
 * original claims and documents to work from.
 *
 * The mode flip belongs to the caller, and only after this resolves: a
 * partial migration must leave the config still `local`, so the space keeps
 * working and the command can be re-run.
 */
export async function runMigration(
  from: Store,
  to: Store,
  out: (line: string) => void,
): Promise<{ imported: number; proposed: number; documents: number; leftBehind: number }> {
  const docIds = new Map<string, string>()
  let documents = 0
  for (const doc of await from.listDocuments()) {
    // `importDocument` dedupes by source path (or, for an adopted document,
    // by content hash — see `FileStore.importDocument`), so a resumed
    // migration recognises a document that already arrived and reports it
    // `updated`/`unchanged` rather than creating a duplicate. Only a genuinely
    // new document counts toward `documents`, the same convention `imported`
    // already follows for claims.
    //
    // `doc.source` straight through, INCLUDING null. This used to send
    // `doc.source ?? doc.id` because `DocumentInput.source` was a required
    // string, which put a document id where a file path belongs and cost a
    // duplicate the first time the same corpus was imported into the team
    // space, and the reason that field is nullable now.
    const { document, outcome } = await to.importDocument({
      title: doc.title,
      text: doc.text,
      source: doc.source,
    })
    docIds.set(doc.id, document.id)
    if (outcome === "created") documents++
  }

  const lists = await Promise.all(ALL_STATUSES.map((status) => from.list(status)))
  const plan = planMigration(lists.flat())

  // `propose` has no dedup of its own — unlike `importClaim`, every call
  // mints a new id — so a resumed run has to check for itself. Fetched once,
  // not per claim: this runs against a hosted store over the network, and a
  // request per pending claim would be slow and would fail in a new way.
  // Keyed by content to the target claims themselves, not to a boolean: when
  // a pending claim turns out to already be present, its `to`-space id still
  // has to enter `claimIds` below, so a later claim overlapping it resolves
  // instead of silently dropping the reference. Skipped entirely when there
  // is nothing to propose — an empty local space should cost the target store
  // no reads at all.
  //
  // A LIST per key, and consumed one at a time. It used to hold one
  // claim per key, so all it could answer was "is this content present". Two
  // byte-identical local pending claims against a target already holding one
  // therefore skipped BOTH: the second never arrived and the migration
  // reported success. Counting instead means the Nth identical claim is only
  // skipped if the target already holds N of them.
  const alreadyThere = new Map<string, Claim[]>()
  if (plan.toPropose.length > 0) {
    for (const c of (await Promise.all(ALL_STATUSES.map((status) => to.list(status)))).flat()) {
      const key = contentKey(c)
      const queue = alreadyThere.get(key)
      if (queue) queue.push(c)
      else alreadyThere.set(key, [c])
    }
  }

  // The approved and pending sets are merged and dependency-ordered here —
  // see `orderForMigration` for why dependency order, not a plain `created`
  // sort, is what makes the remap below correct.
  const claims = orderForMigration([...plan.toImport, ...plan.toPropose], out)

  const claimIds = new Map<string, string>()
  let imported = 0
  let proposed = 0
  for (const claim of claims) {
    const overlaps = remapIds(claim.overlaps, claimIds)
    const cites = remapCites(claim.cites, docIds)

    if (claim.status === "approved") {
      // `importClaim` dedupes on content across every status and reports
      // whether it actually created anything, so a resumed run recognises
      // what already arrived instead of doubling it.
      const { claim: created, created: wasCreated } = await to.importClaim(
        toProposeInput(claim, overlaps, cites),
      )
      claimIds.set(claim.id, created.id)
      if (wasCreated) imported++
      // So a pending claim later in this same pass, whose content matches a
      // claim just imported here, is recognised by the dedup check below
      // instead of being proposed as a duplicate. Pushed rather than assigned,
      // for the same counting reason as above.
      //
      // Only when it was actually CREATED. `importClaim` dedupes, so a
      // `created: false` names a claim that was already in the target — and
      // therefore already in the pool from the listing above. Pushing it again
      // would claim the target holds two copies where it holds one, and skip a
      // pending claim that is genuinely still owed. That is the same defect, one
      // branch over, and it does not announce itself: both counts are
      // plausible and only the pending claim that never arrives is evidence.
      if (wasCreated) {
        const key = contentKey(claim)
        const queue = alreadyThere.get(key)
        if (queue) queue.push(created)
        else alreadyThere.set(key, [created])
      }
      continue
    }

    // `shift`, not `get`: this claim CONSUMES one of the target's copies, so
    // the next identical local claim has to find one fewer waiting for it.
    const existing = alreadyThere.get(contentKey(claim))?.shift()
    if (existing) {
      claimIds.set(claim.id, existing.id)
      continue
    }
    const created = await to.propose(toProposeInput(claim, overlaps, cites))
    claimIds.set(claim.id, created.id)
    // Deliberately NOT added to the pool. A claim this run just proposed is
    // not a copy the target was already holding, and adding it would make the
    // next identical local claim consume it and be skipped — which would
    // rebuild the same defect one line further down. Two identical pending claims in
    // one local space are both proposed, asymmetric with the approved side
    // but harmless: nothing is lost, and
    // `importClaim`'s own dedup is what collapses the approved case.
    proposed++
  }

  for (const claim of plan.leftBehind) {
    out(`left behind (rejected or retracted, stays local): ${claim.claim}`)
  }

  return { imported, proposed, documents, leftBehind: plan.leftBehind.length }
}
