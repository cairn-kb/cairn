import { expect, test } from "bun:test"
import matter from "gray-matter"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog } from "../src/events"
import { orderForMigration, planMigration, runMigration } from "../src/migrate"
import { FileStore } from "../src/store"
import { absentTerms } from "@cairn-kb/protocol/absence"
import { proposal, sample } from "./store-contract"
import type { Claim, Status, Store } from "@cairn-kb/protocol/types"

/** `sample(id, text)` builds a pending claim; migration cares about status, so
 *  give the fixture one rather than reaching past the helper. */
const at = (id: string, status: Status): Claim => ({ ...sample(id, `claim ${id}`), status })

/**
 * A double that implements the real seam rather than being cast past it.
 * Every method the migration has no business calling throws with its own
 * name, so a test that starts calling one fails loudly instead of returning
 * an `undefined` the assertions then quietly agree with.
 *
 * Modelled on `test/review-tui.test.ts`'s `unsupported()`/`fakeStore()`.
 */
function unsupported(name: string): never {
  throw new Error(`a migration must not call Store.${name}`)
}

function fakeStore(over: Partial<Store>): Store {
  return {
    list: async () => unsupported("list"),
    get: async () => unsupported("get"),
    put: async () => unsupported("put"),
    move: async () => unsupported("move"),
    search: async () => unsupported("search"),
    propose: async () => unsupported("propose"),
    review: async () => unsupported("review"),
    retract: async () => unsupported("retract"),
    cite: async () => unsupported("cite"),
    uncite: async () => unsupported("uncite"),
    importClaim: async () => unsupported("importClaim"),
    stats: async () => unsupported("stats"),
    // Not `unsupported`, unlike everything else here: a migration now reads
    // `from.listDocuments()` unconditionally, before it knows whether there
    // is anything to move. A double built for these claim-only fixtures
    // legitimately has none, so the default answer is "no documents", not a
    // thrown "must not call" — that guard stays reserved for methods a
    // migration truly has no business touching (`review`, `put`, `search`,
    // `get`, `move`, `stats`, `getDocument`, `searchDocuments`, `adoptImport`).
    listDocuments: async () => [],
    getDocument: async () => unsupported("getDocument"),
    searchDocuments: async () => unsupported("searchDocuments"),
    importDocument: async () => unsupported("importDocument"),
    adoptImport: async () => unsupported("adoptImport"),
    ...over,
  }
}

/** A read-only source double: `list(status)` returns the claims of that
 *  status, and nothing else on the seam is reachable from a migration read
 *  out of a local store. */
function storeHolding(claims: Claim[]): Store {
  return fakeStore({
    list: async (status) => claims.filter((c) => c.status === status),
  })
}

test("approved claims are imported, pending ones proposed", () => {
  const plan = planMigration([
    at("a", "approved"),
    at("p", "pending"),
  ])
  expect(plan.toImport.map((c) => c.id)).toEqual(["a"])
  expect(plan.toPropose.map((c) => c.id)).toEqual(["p"])
})

test("rejected claims are left behind rather than replayed", () => {
  // THE row that matters. Re-proposing resurrects a decision already made, and
  // proposing-then-rejecting fabricates a review nobody performed — adding to
  // both `proposed` and `rejected` and moving the approve rate by an action no
  // human took.
  const plan = planMigration([at("r", "rejected")])
  expect(plan.toImport).toEqual([])
  expect(plan.toPropose).toEqual([])
  expect(plan.leftBehind.map((c) => c.id)).toEqual(["r"])
})

test("every claim lands in exactly one bucket", () => {
  // A claim silently in neither is knowledge lost in a migration the operator
  // was told succeeded.
  const claims = [
    at("a", "approved"),
    at("p", "pending"),
    at("r", "rejected"),
  ]
  const plan = planMigration(claims)
  const total = plan.toImport.length + plan.toPropose.length + plan.leftBehind.length
  expect(total).toBe(claims.length)
})

// --- runMigration -----------------------------------------------------------

test("the approved set lands before the pending set", async () => {
  const order: string[] = []
  const to = fakeStore({
    importClaim: async (i) => { order.push(`import:${i.claim}`); return { claim: at("x", "approved"), created: true } },
    propose: async (i) => { order.push(`propose:${i.claim}`); return at("y", "pending") },
    // The target holds nothing yet, so the resumed-run dedup check (which
    // reads before the propose loop) skips nothing here.
    list: async () => [],
  })
  await runMigration(
    storeHolding([at("p", "pending"), at("a", "approved")]),
    to,
    () => {},
  )
  // `at(id, status)` builds its claim text as `claim ${id}` (see the helper
  // above), so the propagated `ProposeInput.claim` is "claim a"/"claim p",
  // not the bare id — the assertion checks the actual sentence each call
  // received, which is what proves the target store gets real content.
  expect(order).toEqual(["import:claim a", "propose:claim p"])
})

test("no approve, edit or reject event is written by a migration", async () => {
  // Asserted against the calls directly: a migration that reviews anything has
  // fabricated a decision. `review` is the only method that writes those kinds.
  const to = fakeStore({
    importClaim: async () => ({ claim: at("x", "approved"), created: true }),
    propose: async () => at("y", "pending"),
    review: async () => { throw new Error("a migration must not review anything") },
  })
  await expect(
    runMigration(storeHolding([at("a", "approved"), at("r", "rejected")]), to, () => {}),
  ).resolves.toBeDefined()
})

test("a resumed run does not duplicate what already arrived", async () => {
  // importClaim dedupes on content across every status and reports whether it
  // created anything, so a re-run recognises what landed rather than doubling it.
  const to = fakeStore({
    importClaim: async () => ({ claim: at("x", "approved"), created: false }),
    propose: async () => at("y", "pending"),
  })
  const result = await runMigration(storeHolding([at("a", "approved")]), to, () => {})
  expect(result.imported).toBe(0)
})

test("a resumed run proposes nothing when every pending claim is already present in the target", async () => {
  // `propose` has no dedup of its own, unlike `importClaim` — every call
  // mints a new id — so a resumed run has to check for itself before calling
  // it. Same content ("claim p"/"detail") as `at("p", "pending")` below,
  // under a different id: the target store owns its own ids, so id-matching
  // could never recognise a claim that already landed.
  const to = fakeStore({
    list: async (status) =>
      status === "pending" ? [{ ...sample("team-1", "claim p"), status: "pending" as const }] : [],
    propose: async () => { throw new Error("must not propose a claim already in the target") },
  })
  const result = await runMigration(storeHolding([at("p", "pending")]), to, () => {})
  expect(result.proposed).toBe(0)
})

test("a partially-resumed run proposes only the claim missing from the target", async () => {
  const proposedClaims: string[] = []
  const to = fakeStore({
    list: async (status) =>
      status === "pending" ? [{ ...sample("team-1", "claim p"), status: "pending" as const }] : [],
    propose: async (i) => { proposedClaims.push(i.claim); return at("team-2", "pending") },
  })
  const result = await runMigration(
    storeHolding([at("p", "pending"), at("q", "pending")]),
    to,
    () => {},
  )
  expect(result.proposed).toBe(1)
  expect(proposedClaims).toEqual(["claim q"])
})

test("a resumed run proposes the second of two identical pending claims", async () => {
  // `alreadyThere` was keyed by content to a single claim, so
  // membership was all it could answer. Two byte-identical local pending
  // claims and one copy already in the target meant BOTH were skipped: the
  // second never reached the team space and the migration reported success.
  //
  // Knowledge silently lost in an operation reported as complete, which is the
  // half of this that matters. It needs a partial failure and two identical
  // claims, so it is narrow — and invisible, which is why it is worth a test
  // rather than a comment.
  const proposedClaims: string[] = []
  const to = fakeStore({
    list: async (status) =>
      status === "pending" ? [{ ...sample("team-1", "claim p"), status: "pending" as const }] : [],
    propose: async (i) => {
      proposedClaims.push(i.claim)
      return at("team-2", "pending")
    },
  })
  // Two locals with the SAME content under different ids — `at` derives the
  // text from the id, so they are spelled out rather than built with it.
  const duplicate = { ...sample("p2", "claim p"), status: "pending" as const }
  const result = await runMigration(
    storeHolding([at("p", "pending"), duplicate]),
    to,
    () => {},
  )
  // The target holds one copy and the local space holds two, so exactly one is
  // still owed.
  expect(result.proposed).toBe(1)
  expect(proposedClaims).toEqual(["claim p"])
})

test("two identical pending claims in a fresh space are both proposed", async () => {
  // The other direction of the same defect, and a behaviour change worth pinning
  // rather than leaving implicit. Before the fix a just-proposed claim was
  // added to the dedup pool, so the second of two identical locals matched it
  // and was skipped even against an EMPTY target — one local claim, silently,
  // never left the machine.
  //
  // A claim this run proposed is not a copy the target was already holding.
  // The asymmetry with the approved side is deliberate and harmless: `importClaim` dedupes, so approved duplicates collapse,
  // and nothing is lost either way.
  const proposedClaims: string[] = []
  const to = fakeStore({
    list: async () => [],
    propose: async (i) => {
      proposedClaims.push(i.claim)
      return at("team-1", "pending")
    },
  })
  const duplicate = { ...sample("p2", "claim p"), status: "pending" as const }
  const result = await runMigration(
    storeHolding([at("p", "pending"), duplicate]),
    to,
    () => {},
  )
  expect(result.proposed).toBe(2)
  expect(proposedClaims).toEqual(["claim p", "claim p"])
})

test("an approved claim already in the target is not counted as a second copy", async () => {
  // The same defect as above, one branch over. The approved branch pushes what
  // `importClaim` returns into the pool so a later identical PENDING claim maps
  // to it. But when `importClaim` reports `created: false` the claim it returned
  // was already in the target — and therefore already in the pool from the
  // initial listing. Pushing it again would say the target holds two copies
  // when it holds one, and skip a pending claim that is genuinely owed.
  const proposedClaims: string[] = []
  const existing = { ...sample("team-1", "claim p"), status: "approved" as const }
  const to = fakeStore({
    list: async (status) => (status === "approved" ? [existing] : []),
    importClaim: async () => ({ claim: existing, created: false }),
    propose: async (i) => {
      proposedClaims.push(i.claim)
      return at("team-2", "pending")
    },
  })
  // One approved local matching what the target holds, plus TWO pending locals
  // with that same content. The target holds one copy, so one pending claim is
  // still owed.
  const approvedLocal = { ...sample("a1", "claim p"), status: "approved" as const }
  const p1 = { ...sample("p1", "claim p"), status: "pending" as const }
  const p2 = { ...sample("p2", "claim p"), status: "pending" as const }
  const result = await runMigration(storeHolding([approvedLocal, p1, p2]), to, () => {})
  expect(result.proposed).toBe(1)
  expect(proposedClaims).toEqual(["claim p"])
})

test("a failure part-way leaves the mode alone", async () => {
  // The mode flips last, in the caller, only after this resolves. If it throws,
  // the space is still local and still works, and the command can be re-run.
  const to = fakeStore({ importClaim: async () => { throw new Error("network is down") } })
  await expect(
    runMigration(storeHolding([at("a", "approved")]), to, () => {}),
  ).rejects.toThrow("network is down")
})

// --- id remapping -------------------------------------------------------------
//
// These four run against real FileStores, not `fakeStore` doubles. That is
// load-bearing, not incidental: the whole point of a remapping test is that
// the id a claim referenced in `from` is NOT the id anything holds in `to`,
// and a hand-authored double is exactly the kind of fixture that can make
// that true by construction (same counter, same literal ids) without the
// migration code doing anything. Two independent `FileStore` instances mint
// every id through `makeId`/`makeDocId` (src/claims.ts, src/documents.ts),
// which end each id in six characters of `crypto.randomUUID()` — so `from`
// and `to` never share id state, and a source id landing in the target by
// coincidence is not a risk worth guarding against, only a bug the assertions
// below would actually catch. Each test asserts this directly (see the
// "cites something" case) rather than trusting the setup silently.

/** A fresh, empty, real store rooted in its own temp directory. */
async function realStore(): Promise<{ store: Store; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "cairn-migrate-"))
  const store = new FileStore(root, new EventLog(root))
  await store.init()
  return { store, root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Runs `run` against two independent real stores, then tears both down.
 *  `fromRoot` is the source store's directory on disk, which the legacy-shape
 *  case below needs: the only way to have a pre-0.6.4 claim is to have one
 *  written the way that version wrote it. */
async function withRealStores(
  run: (from: Store, to: Store, fromRoot: string) => Promise<void>,
): Promise<void> {
  const from = await realStore()
  const to = await realStore()
  try {
    await run(from.store, to.store, from.root)
  } finally {
    await from.cleanup()
    await to.cleanup()
  }
}

/**
 * Rewrite a claim's `cites` on disk to the shape a pre-0.6.4 cairn wrote: a
 * bare document id, with no scope, no hash, no absence report and nobody named.
 *
 * Written through the file rather than constructed in memory because that is
 * the only place this shape can come from — `Citation` has had four required
 * fields since 0.6.4, so a fixture built in TypeScript cannot express what is
 * actually sitting in older spaces. `parseCites` (src/claims.ts) is what
 * turns it back into a `Citation`, and pinning migration against its real
 * output is the point: such citations exist, mostly on APPROVED claims, and
 * every one of those goes through `to.importClaim`.
 */
async function makeCitationsLegacy(root: string, dir: string, id: string): Promise<void> {
  const file = join(root, dir, `${id}.md`)
  const parsed = matter(await readFile(file, "utf-8"))
  const cites = (parsed.data.cites as { doc: string }[]).map((c) => c.doc)
  await writeFile(file, matter.stringify(parsed.content, { ...parsed.data, cites }), "utf-8")
}

test("migration carries documents into the team space", async () => {
  await withRealStores(async (from, to) => {
    await from.importDocument({ title: "T", text: "text", source: "a.md" })
    await runMigration(from, to, () => {})
    // Without this, `cairn init --team` from a local space drops the entire
    // imported corpus and reports success.
    expect((await to.listDocuments()).length).toBe(1)
  })
})

test("migrated claims cite documents by their id in the TARGET space", async () => {
  await withRealStores(async (from, to) => {
    const { document } = await from.importDocument({ title: "T", text: "text", source: "a.md" })
    await from.propose(proposal("cites something", { cites: [{ doc: document.id, supports: "the detail" }] }))
    await runMigration(from, to, () => {})
    const moved = (await to.list("pending")).find((c) => c.claim === "cites something")!
    const target = (await to.listDocuments())[0]!
    expect(moved.cites.map((c) => c.doc)).toEqual([target.id])
    // The scope travels with the id. A remap that rebuilt the citation from
    // the document alone would drop it and nothing else would notice.
    expect(moved.cites[0]!.supports).toBe("the detail")
    // The assertion only means something because the two stores assign
    // different ids. A fixture where they coincide passes without the fix.
    expect(document.id === target.id).toBe(false)
  })
})

test("a citation's recorded hash and absences survive migration, not the target's fresh ones", async () => {
  // The case the whole `provenance` mechanism exists for, and the one no test
  // reached: a citation whose recorded hash DIFFERS from the current hash of
  // the document it names. A migration COPIES a citation; if the target store
  // re-derives it, the copy is stamped with today's hash and "this document
  // has changed since it was cited" — the one signal a staleness check leaves behind —
  // disappears at exactly the moment a space moves to a team.
  //
  // The divergence is made the way it happens in life: the document is
  // re-imported with new text after the citation was attached. Nothing here
  // hand-writes a hash, so the mismatch is one the real code produced.
  await withRealStores(async (from, to) => {
    const { document } = await from.importDocument({
      title: "T", text: "alpha beta gamma matters", source: "a.md",
    })
    await from.propose(proposal("gamma matters", { cites: [{ doc: document.id, supports: "the detail" }] }))
    const recorded = (await from.list("pending"))[0]!.cites[0]!
    // Checked when it was attached, against text that held both terms.
    expect(recorded.absent).toEqual([])
    // The document then changes under the citation — neither term survives.
    await from.importDocument({ title: "T", text: "delta epsilon", source: "a.md" })

    await runMigration(from, to, () => {})

    const moved = (await to.list("pending"))[0]!
    const target = (await to.listDocuments())[0]!
    // Without this the assertions below pass against a store that recomputed
    // everything, because there would be nothing to tell the two apart.
    expect(target.hash === recorded.hash).toBe(false)
    expect(moved.cites[0]!.hash).toBe(recorded.hash)
    // And the absence report is the one that was actually run. Recomputing
    // against the target's copy would give ["gamma", "matters"] — a check
    // dated today, contradicting the one a person may already have read.
    expect(moved.cites[0]!.absent).toEqual([])
    expect(absentTerms("gamma matters", target.text)).toEqual(["gamma", "matters"])
  })
})

test("a legacy citation migrates as legacy, not as a check nobody ran", async () => {
  // Both failures together, on the exact on-disk shape older spaces hold. A
  // pre-0.6.4 citation is a bare document id: no scope, no hash, no absence
  // check, nobody named. Refusing its empty `supports` fails `cairn init
  // --team` permanently — and re-deriving its facts turns `absent: null`
  // ("never checked") into an array ("checked, nothing missing"), which both
  // human surfaces render as a citation somebody verified. Neither may happen.
  await withRealStores(async (from, to, fromRoot) => {
    const { document } = await from.importDocument({ title: "T", text: "alpha", source: "a.md" })
    const claim = await from.propose(proposal("legacy", { cites: [{ doc: document.id, supports: "x" }] }))
    // Approved, because that is where most real ones are, and
    // approved claims migrate through `importClaim` rather than `propose`.
    await from.review(claim.id, "approve")
    await makeCitationsLegacy(fromRoot, "approved", claim.id)
    const legacy = (await from.list("approved"))[0]!.cites[0]!
    expect(legacy).toEqual({ doc: document.id, supports: "", hash: null, absent: null, by: "unknown" })

    await runMigration(from, to, () => {})

    const moved = (await to.list("approved"))[0]!
    const target = (await to.listDocuments())[0]!
    expect(moved.cites.length).toBe(1)
    expect(moved.cites[0]!.doc).toBe(target.id)
    expect(moved.cites[0]!.supports).toBe("")
    // `null`, not the document's hash and not an empty array. The renderers
    // branch on exactly this to say "no hash recorded" and "never checked for
    // absent terms" rather than showing a verification that never happened.
    expect(moved.cites[0]!.hash).toBeNull()
    expect(moved.cites[0]!.absent).toBeNull()
    expect(moved.cites[0]!.by).toBe("unknown")
  })
})

test("migrated claims overlap claims that exist in the target space", async () => {
  // Overlaps were carried through unremapped, so every migrated
  // claim pointed at ids that exist only in the space it came from.
  await withRealStores(async (from, to) => {
    const a = await from.propose(proposal("first"))
    await from.propose(proposal("second", { overlaps: [a.id] }))
    await runMigration(from, to, () => {})
    const moved = (await to.list("pending")).find((c) => c.claim === "second")!
    const first = (await to.list("pending")).find((c) => c.claim === "first")!
    expect(moved.overlaps).toEqual([first.id])
    expect(a.id === first.id).toBe(false)
  })
})

test("an overlap pointing at a claim left behind is dropped, not carried", async () => {
  await withRealStores(async (from, to) => {
    const rejected = await from.propose(proposal("rejected one"))
    await from.review(rejected.id, "reject")
    await from.propose(proposal("survivor", { overlaps: [rejected.id] }))
    await runMigration(from, to, () => {})
    const moved = (await to.list("pending")).find((c) => c.claim === "survivor")!
    // Nothing in the team space will ever resolve it.
    expect(moved.overlaps).toEqual([])
  })
})

// --- documents: the returned count, and resumability -----------------------

test("runMigration reports how many documents moved", async () => {
  await withRealStores(async (from, to) => {
    await from.importDocument({ title: "T", text: "text", source: "a.md" })
    const result = await runMigration(from, to, () => {})
    expect(result.documents).toBe(1)
  })
})

test("a resumed migration does not duplicate documents", async () => {
  await withRealStores(async (from, to) => {
    await from.importDocument({ title: "T", text: "text", source: "a.md" })
    const first = await runMigration(from, to, () => {})
    // Second run over the same `from`: `to.importDocument` matches the
    // document it already holds by source path (see `FileStore
    // .importDocument`), so nothing new is created and `documents` reports
    // that — the same convention `imported` already follows for claims.
    const second = await runMigration(from, to, () => {})
    expect(first.documents).toBe(1)
    expect(second.documents).toBe(0)
    expect((await to.listDocuments()).length).toBe(1)
  })
})

// --- An adopted document has no path, and must not be given one ------------

test("a source-less document migrates as source-less rather than carrying a fabricated path", async () => {
  await withRealStores(async (from, to) => {
    // What `adoptImport` leaves behind: a document with no file behind it.
    await from.importDocument({ title: "Adopted", text: "text", source: null })
    await runMigration(from, to, () => {})
    const target = (await to.listDocuments())[0]!
    // It used to arrive carrying `doc.source ?? doc.id` — a document id where
    // a file path belongs, which matched neither branch of `importDocument`
    // afterwards.
    expect(target.source).toBeNull()
  })
})

test("the original file claims the migrated adopted document instead of duplicating it", async () => {
  await withRealStores(async (from, to) => {
    // The whole of the migration guarantee, in the order a person upgrading actually hits it:
    // adopt locally, migrate to a team space, then import the same corpus
    // there. The third step used to create a SECOND document holding the same
    // text, with both agent-visible through search and no delete path.
    await from.importDocument({ title: "Adopted", text: "It wants Python 3.10.", source: null })
    await runMigration(from, to, () => {})

    const reimported = await to.importDocument({
      title: "Using MinerU", text: "It wants Python 3.10.", source: "tools/mineru.md",
    })
    const migrated = (await to.listDocuments()).find((d) => d.id === reimported.document.id)

    expect((await to.listDocuments()).length).toBe(1)
    expect(migrated?.source).toBe("tools/mineru.md")
  })
})

test("a resumed migration does not duplicate a source-less document either", async () => {
  await withRealStores(async (from, to) => {
    // Resume used to work for these by accident: `doc.source ?? doc.id` was
    // stable across runs, so the second pass matched by "source". With a real
    // null it matches by content hash instead — the branch that exists for
    // exactly this — so the property has to be re-proved rather than assumed.
    await from.importDocument({ title: "Adopted", text: "text", source: null })
    const first = await runMigration(from, to, () => {})
    const second = await runMigration(from, to, () => {})
    expect(first.documents).toBe(1)
    expect(second.documents).toBe(0)
    expect((await to.listDocuments()).length).toBe(1)
  })
})

test("a claim skipped as already-migrated still resolves overlaps referencing it", async () => {
  // Defends src/migrate.ts's `alreadyThere.get(contentKey(claim))` branch:
  // when a resumed run recognises a pending claim as already present in the
  // target and skips proposing it again, `claimIds` still has to gain an
  // entry for it — otherwise a claim that overlaps it, added locally after
  // the first run, silently loses the reference on the second run. This is
  // the one thing worth a regression test directly: nothing else in this suite exercises the skip-but-still-map
  // path end to end.
  await withRealStores(async (from, to) => {
    const first = await from.propose(proposal("first"))
    await runMigration(from, to, () => {}) // run 1: "first" migrates
    await from.propose(proposal("second", { overlaps: [first.id] }))
    await runMigration(from, to, () => {}) // run 2 (resumed): "first" is skipped as a duplicate
    const migratedFirst = (await to.list("pending")).find((c) => c.claim === "first")!
    const migratedSecond = (await to.list("pending")).find((c) => c.claim === "second")!
    expect(migratedSecond.overlaps).toEqual([migratedFirst.id])
  })
})

// --- ordering on a `created` tie -------------------------------------------
//
// A plain `created`-ascending sort is not actually enough: `Array.prototype
// .sort` is stable, so two claims sharing a `created` value fall back to
// INPUT order on the tie, and the input here is `FileStore.list`'s newest-
// first order — the exact wrong direction. `orderForMigration` replaces the
// sort with a topological order (dependency first, `(created, id)` only as
// the tiebreak among claims that are equally ready), so these tests fix the
// timestamp by hand rather than hoping two real `propose` calls land in one
// millisecond — a test that depends on timing to reproduce is exactly what a
// tie-break bug should never be proven by.

test("a tie in created is broken by dependency order, not list order", async () => {
  // Fixed, IDENTICAL `created` on both claims. A real millisecond tie is
  // rare but not impossible — bulk or scripted proposes are where two writes
  // land inside one millisecond — and a hardcoded timestamp makes the tie
  // deterministic instead of relying on that timing.
  const tied = "2026-09-01T00:00:00.000Z"
  const first: Claim = { ...sample("src-first", "first"), created: tied }
  const second: Claim = { ...sample("src-second", "second"), created: tied, overlaps: ["src-first"] }
  // Listed referencer-first: the order `FileStore.list` would hand back if
  // these two ties resolved in the wrong direction. A plain `created`-
  // ascending sort is stable, so a tie falls back to exactly this (wrong)
  // input order; only ordering by dependency, not time, gets `first` emitted
  // before `second` regardless of which one the source list handed back first.
  const from = storeHolding([second, first])

  const proposedInOrder: { claim: string; id: string; overlaps: string[] }[] = []
  let n = 0
  const to = fakeStore({
    list: async () => [],
    propose: async (input) => {
      n++
      const created = {
        ...sample(`target-${n}`, input.claim),
        overlaps: input.overlaps,
        // This double copies `provenance` because a real store does, and it
        // asserts NOTHING about that: these fixtures cite nothing, and the
        // fallbacks below are precisely the values a legacy citation carries,
        // so deleting `provenance` from `remapCites` would not disturb it.
        // The two tests above are where that mechanism is actually pinned,
        // against real stores that mint their own ids and hashes.
        cites: input.cites.map((c) => ({
          doc: c.doc,
          supports: c.supports,
          hash: c.provenance?.hash ?? null,
          absent: c.provenance?.absent ?? null,
          by: c.provenance?.by ?? "unknown",
        })),
      }
      proposedInOrder.push({ claim: created.claim, id: created.id, overlaps: created.overlaps })
      return created
    },
  })

  await runMigration(from, to, () => {})

  const firstTarget = proposedInOrder.find((c) => c.claim === "first")!
  const secondTarget = proposedInOrder.find((c) => c.claim === "second")!
  // `first` must be proposed to the target BEFORE `second` despite being
  // listed second by `from` — otherwise `first`'s target id does not exist
  // yet when `second`'s overlap is remapped, and the same remapping defect
  // reopens for same-millisecond creation.
  expect(proposedInOrder.indexOf(firstTarget)).toBeLessThan(proposedInOrder.indexOf(secondTarget))
  expect(secondTarget.overlaps).toEqual([firstTarget.id])
})

test("orderForMigration produces the same order every run given the same input", () => {
  // Every claim shares one `created` value, so nothing here is orderable by
  // time at all — the only thing that CAN produce a stable order is the
  // dependency graph (plus the `(created, id)` tiebreak among claims with no
  // dependency between them), so a passing run here proves the algorithm is
  // deterministic, not merely that timestamps happened to differ.
  const tied = "2026-09-01T00:00:00.000Z"
  const build = (): Claim[] => [
    { ...sample("c", "c"), created: tied, overlaps: ["a", "b"] },
    { ...sample("a", "a"), created: tied },
    { ...sample("d", "d"), created: tied, overlaps: ["c"] },
    { ...sample("b", "b"), created: tied },
  ]
  const firstRun = orderForMigration(build(), () => {}).map((c) => c.id)
  const secondRun = orderForMigration(build(), () => {}).map((c) => c.id)
  expect(firstRun).toEqual(secondRun)
  // Not just repeatable — actually respects the graph: every dependency
  // appears before its dependent.
  expect(firstRun.indexOf("a")).toBeLessThan(firstRun.indexOf("c"))
  expect(firstRun.indexOf("b")).toBeLessThan(firstRun.indexOf("c"))
  expect(firstRun.indexOf("c")).toBeLessThan(firstRun.indexOf("d"))
})

test("a dependency cycle is reported and both claims still move, unresolved", () => {
  // Cannot arise from real `overlaps` — `findOverlaps` only ever names a
  // claim already approved before this one was proposed, which is what
  // makes the real graph acyclic — but a hand-edited `overlaps` field could
  // still produce one, and the fallback this exercises is the difference
  // between reporting that and refusing to migrate anything at all.
  const tied = "2026-09-01T00:00:00.000Z"
  const x: Claim = { ...sample("x", "x"), created: tied, overlaps: ["y"] }
  const y: Claim = { ...sample("y", "y"), created: tied, overlaps: ["x"] }
  const messages: string[] = []
  const order = orderForMigration([x, y], (line) => messages.push(line))
  // Both still move — a migration that stops halfway over a graph it can't
  // fully order is a worse failure than one that can't resolve one link.
  expect(order.map((c) => c.id).sort()).toEqual(["x", "y"])
  expect(messages.length).toBe(1)
  expect(messages[0]).toContain("cycle")
})

test("a retracted claim is left behind, not silently dropped", () => {
  // planMigration routes into three buckets by status. A fourth status that
  // matches none of them vanishes from the plan entirely — migrated to
  // nothing, reported as nothing.
  const claim = { ...sample("c1", "a sentence"), status: "retracted" as const }
  const plan = planMigration([claim])
  expect(plan.toImport).toEqual([])
  expect(plan.toPropose).toEqual([])
  expect(plan.leftBehind).toEqual([claim])
})
