import type { EventKind } from "./stats"
import type { CiteInput } from "./types"

/**
 * An edit-then-approve IS an approval — the human read the claim, improved it
 * and let it through. Counting only `approve` understated the approve rate and,
 * worse, left every edited proposal permanently unresolved, so `pendingAgeDays`
 * accumulated residue that grew a day per day against an empty queue — a
 * growing queue manufactured by the human doing the most diligent thing the UI
 * offers.
 *
 * `edit` stays its own event kind so edits remain distinguishable from plain
 * approvals — the distinction is reported separately as `edited`.
 */
export const APPROVE_KINDS: readonly EventKind[] = ["approve", "edit"]
export const RESOLVE_KINDS: readonly EventKind[] = ["approve", "edit", "reject"]

/**
 * The event kinds that make a claim permanently un-adoptable.
 *
 * A DENY list, not an allow list, and that direction is the whole point. The
 * first version of this guard was an allow list — every event on the claim had
 * to be `import`, `generate` or `curate` — which quietly made every imported
 * claim an agent had ever READ un-adoptable, because `read` carries the
 * claim's id on both stores (`packages/mcp/src/tools.ts` logs it with the id,
 * and the hosted service records it against the claim too). The population `adopt-imports`
 * exists for is exactly the material agents are told to read, so the more the
 * tool was used the less of the knowledge base could be converted. An allow list has to be told about every observational kind
 * anyone ever adds; a deny list only has to be told about kinds that mean a
 * human was involved, and those are enumerable.
 *
 * `propose` means it arrived as a proposal; `RESOLVE_KINDS` (`approve`,
 * `edit`, `reject`) mean a human judged it. Either way adoption must refuse,
 * because this is the guard in front of the only operation in this system that
 * DELETES an approved claim. The `imported` tag is what the CLI selects
 * candidates on, but a tag can be hand-edited — it must never be what decides
 * whether material a human actually judged gets destroyed.
 *
 * `retract` is here because a retraction is a human decision about this
 * claim, and adoption DELETES the claim. A retracted claim already carries
 * an `approve` event and so is refused on that alone today — but this list
 * states what makes a claim untouchable, and it must not depend on a second
 * kind happening to be present.
 *
 * `uncite` is here and `cite` deliberately is not, and the pair is the clearest
 * statement of what this list means. Detaching evidence is human-only — there
 * is no `team_knowledge_uncite` for an agent to call — so an `uncite` event is
 * proof a person curated this claim. Attaching evidence is something an agent
 * does unattended, so `cite` is observational in exactly the way `read`,
 * `generate` and `curate` are, and admitting it would make every claim an
 * agent had ever grounded un-adoptable — the same failure the allow list
 * caused for every claim an agent had ever read.
 */
// `readonly`, like `STATUSES` in packages/protocol/src/types.ts and for a sharper reason: this
// array is the guard in front of the only operation in the system that DELETES
// an approved claim, and it was exported mutable. Nothing was
// pushing to it; the point is that an export nobody can push to cannot be
// widened from a distance, which for this particular list means "cannot be
// talked into permitting a delete". Its two neighbours above are `readonly` for
// consistency — one mutable array beside a frozen one invites someone to
// "fix" the odd one out in the wrong direction.
export const UNADOPTABLE_KINDS: readonly EventKind[] = [
  "propose",
  "retract",
  "uncite",
  ...RESOLVE_KINDS,
]

/**
 * Why a claim was refused adoption, or null if it was not.
 *
 * BOTH halves are required, and neither implies the other:
 *   - nothing in `UNADOPTABLE_KINDS` may appear — "no human proposed or judged
 *     this";
 *   - at least one `import` event must appear — positive evidence the claim
 *     really is imported material.
 *
 * The second half is what keeps a deny list from drifting open: a claim whose
 * history says nothing about how it arrived is not adoptable just because
 * nothing on it is forbidden. It also subsumes the older `events.length > 0`
 * check — a claim with no history at all has no `import` event either.
 *
 * `generate` and `curate` are silent here on purpose: `cairn abstracts` writes
 * and re-writes abstracts onto imported claims, and refusing those would
 * exclude most of the material adoption exists for. So is `read`, for the reason
 * above, and so is `adopt` itself.
 *
 * Takes plain strings because the hosted service reads `kind` from storage as
 * a string; there is nothing to gain from making it cast first.
 */
export type AdoptionRefusal = "judged" | "not-imported"

export function adoptionRefusal(kinds: readonly string[]): AdoptionRefusal | null {
  if (kinds.some((k) => (UNADOPTABLE_KINDS as readonly string[]).includes(k))) return "judged"
  if (!kinds.includes("import")) return "not-imported"
  return null
}

/**
 * The sentence both stores refuse an unadoptable claim with, word for word.
 *
 * Both `FileStore.adoptImport` (src/store.ts) and `HttpStore.adoptImport`
 * (src/http-store.ts) throw this, and the two stores must
 * refuse identically — the same convention `AlreadyResolvedError` already set
 * for this seam. Exporting it once from this dependency-free module is what makes
 * that requirement real: two copies of the same literal string in two files
 * can drift the moment either one is edited without the other, and nothing
 * would catch it short of a contract case asserting the exact text — which
 * this makes possible by giving both sides one function to call.
 *
 * One sentence per refusal, because they are different facts about the claim
 * and a person acts on them differently. The single message this replaced said
 * "was not imported — only a claim nobody proposed or reviewed can be
 * adopted. Leave it as a claim, or reject it in review." to every refusal,
 * including imported claims that had merely been read: every clause of it
 * could be false at once. Neither sentence below offers "reject it in review"
 * as a remedy — that would move the approve rate for a decision no human made,
 * which is the one number this product exists to measure.
 */
export function notAdoptableMessage(claimId: string, refusal: AdoptionRefusal): string {
  if (refusal === "judged") {
    return (
      // NOT "proposed or reviewed by a person": a `propose` event is
      // written by an AGENT, and `propose` is in UNADOPTABLE_KINDS, so the
      // commonest way to reach this sentence involves no person at all. The
      // refusal was right and only its account of itself was wrong.
      `${claimId} was proposed as a claim, or judged by a person, and adoption only removes ` +
      `material that is neither. Leave it as a claim — there is nothing here to convert.`
    )
  }
  return (
    `${claimId} carries no import event, so nothing shows it arrived through \`cairn import\` — ` +
    `only imported material can become a document. Leave it as a claim.`
  )
}

/**
 * The 409 `code` the hosted `/adopt` route answers each refusal with.
 *
 * The refusal is decided server-side, where the events are, but the SENTENCE
 * is built client-side by `HttpStore.adoptImport` so both stores speak with
 * one voice. The code is the only channel between them — `CairnHttpError`
 * carries the status and the code, not the response body — so the two
 * refusals need two codes, or the client would have to guess which one it got.
 */
export const ADOPT_REFUSAL_CODES: Record<AdoptionRefusal, string> = {
  judged: "not_adoptable_judged",
  "not-imported": "not_adoptable_not_imported",
}

/** The inverse of `ADOPT_REFUSAL_CODES`. Null for any other code, so a 409
 *  this client does not recognise surfaces as itself rather than as a
 *  fabricated adoption refusal. */
export function refusalFromCode(code: string): AdoptionRefusal | null {
  for (const [refusal, c] of Object.entries(ADOPT_REFUSAL_CODES)) {
    if (c === code) return refusal as AdoptionRefusal
  }
  return null
}

/**
 * Why a claim was refused retraction, or null if it was not.
 *
 * Only an approved claim can be withdrawn, and each refusal is a different
 * fact a person acts on differently — the same reason `AdoptionRefusal` has
 * two members rather than one message covering both. An unrecognised status
 * refuses as `already-retracted` rather than falling through to success: this
 * guard stands in front of an operation that removes a claim from every agent
 * read path, and "I do not know what state this is in" must never mean yes.
 */
export type RetractRefusal = "pending" | "rejected" | "already-retracted"

export function retractRefusal(status: string): RetractRefusal | null {
  switch (status) {
    case "approved":
      return null
    case "pending":
      return "pending"
    case "rejected":
      return "rejected"
    default:
      return "already-retracted"
  }
}

/** The sentence both stores refuse an unretractable claim with, word for word.
 *  Exported once from this dependency-free module for the reason
 *  `notAdoptableMessage` is: two copies of a literal in two files drift the
 *  moment either is edited alone. */
export function notRetractableMessage(claimId: string, refusal: RetractRefusal): string {
  if (refusal === "pending") {
    return (
      `${claimId} is still pending, so there is no approval to withdraw. ` +
      `Reject it in review instead — that is the decision this claim is waiting for.`
    )
  }
  if (refusal === "rejected") {
    return (
      `${claimId} was rejected, so it never entered the corpus and there is nothing to withdraw. ` +
      `Leave it as it is.`
    )
  }
  return (
    `${claimId} was already retracted. Retracting it again would record a second withdrawal ` +
    `nobody made — the first one still stands, with its own reason.`
  )
}

/**
 * The sentence both stores refuse a citation of an unknown document with.
 *
 * Shared for the reason `notAdoptableMessage` is: two copies of a literal in
 * two files drift the moment either is edited alone. A citation must name a
 * document the space actually holds, because that document is where the
 * citation's `hash` and its absence report both come from.
 */
export function unknownDocumentMessage(docId: string): string {
  return (
    `${docId} is not a document in this space, so there is nothing to cite. ` +
    `Check the id came from a search or read result and is a document id, not a claim id.`
  )
}

/**
 * The sentence both stores refuse an adoption of a claim that is not there
 * with.
 *
 * Shared for the reason `notAdoptableMessage` is, and it was the one outcome of
 * `adoptImport` that had NOT been made to agree: only 409 parity was mandated,
 * so `FileStore` threw `claim not found: <id>` while `HttpStore` fell through
 * to the generic 404 sentence — "that claim is not in this space — it may have
 * been reviewed or removed already; run `cairn status` to see what is there".
 * True of every other 404 and wrong here: `adopt-imports` reaches this only by
 * losing a race, and "run `cairn status`" sends somebody to look for a claim
 * whose disappearance is the answer rather than the question.
 *
 * Narrow on purpose. `FileStore.move` still throws the terse form for its own
 * 404, where the client returns null rather than a message, so there is no
 * second voice to agree with.
 */
export function unknownClaimMessage(claimId: string): string {
  return (
    `${claimId} is not a claim in this space, so there is nothing to adopt — ` +
    `another run may have adopted it already, which removes the claim and leaves the document behind. ` +
    `Check \`cairn search\` for the document before proposing it again.`
  )
}

/** A retraction with no stated grounds is a
 *  decision nobody can reconstruct. Refused rather than defaulted. */
export const EMPTY_RETRACT_REASON =
  "a retraction needs a reason — say why the approval was wrong, so the next reader knows what changed."

/** The 409 `code` the hosted `/retract` route answers each refusal with. The
 *  refusal is decided server-side, where the status is; the SENTENCE is built
 *  client-side so both stores speak with one voice, and the code is the only
 *  channel between them. */
export const RETRACT_REFUSAL_CODES: Record<RetractRefusal, string> = {
  pending: "not_retractable_pending",
  rejected: "not_retractable_rejected",
  "already-retracted": "not_retractable_already_retracted",
}

/** The inverse of `RETRACT_REFUSAL_CODES`. Null for any other code, so an
 *  unrecognised 409 surfaces as itself rather than as a fabricated refusal. */
export function retractRefusalFromCode(code: string): RetractRefusal | null {
  for (const [refusal, c] of Object.entries(RETRACT_REFUSAL_CODES)) {
    if (c === code) return refusal as RetractRefusal
  }
  return null
}

/**
 * Why a citation was refused, or null if it was not.
 *
 * Two members because they are different facts a person acts on differently —
 * the same reason `AdoptionRefusal` has two rather than one message covering
 * both. Neither is a status: a claim in ANY status may gain evidence, so what
 * can be refused is the citation, never the claim.
 */
export type CiteRefusal = "unknown-document" | "already-cited"

/** The sentence both stores refuse a citation with, word for word. Exported
 *  once from this dependency-free module for the reason `notAdoptableMessage` is:
 *  two copies of a literal in two files drift the moment either is edited
 *  alone. The unknown-document half DELEGATES to `unknownDocumentMessage`
 *  rather than restating it — a citation attached after the fact and one
 *  offered at propose time are refused for the identical reason, and two
 *  sentences for one fact is the drift this module exists to prevent. */
export function notCitableMessage(claimId: string, docId: string, refusal: CiteRefusal): string {
  if (refusal === "unknown-document") return unknownDocumentMessage(docId)
  return (
    `${claimId} already cites ${docId}, with its own account of what that document supports. ` +
    `Detach the existing citation with \`cairn uncite\` if that account is wrong — a second one ` +
    `would silently replace it.`
  )
}

/** One member today, and a type rather than a bare boolean so a second reason
 *  to refuse a detachment arrives as a new sentence rather than as a reused
 *  one — the shape `RetractRefusal` already has. */
export type UnciteRefusal = "not-cited"

export function notUncitableMessage(claimId: string, docId: string): string {
  return (
    `${claimId} does not cite ${docId}, so there is nothing to detach. ` +
    `\`cairn show ${claimId}\` lists what it does cite.`
  )
}

/** A citation with no stated scope is evidence
 *  whose relevance lives only in the citer's head. Refused rather than
 *  defaulted, exactly as `EMPTY_RETRACT_REASON` is. */
export const EMPTY_SUPPORTS =
  "a citation needs to say what it supports — name the part of the claim this document grounds, so the next reader can check it."

/**
 * The shape every hash this system records actually has: `hashText`
 * (packages/protocol/src/hash.ts) is SHA-256 rendered as lowercase hex, and so
 * is the hosted service's equivalent. Every recorded hash checked before this
 * was introduced conformed; the rest carried `null`.
 */
export const RECORDED_HASH = /^[0-9a-f]{64}$/

/** The sentence a citation carrying an impossible hash is refused with. */
export const IMPOSSIBLE_HASH =
  "a citation's recorded hash must be the SHA-256 of the document it was read from, in lowercase hex. A value that is not a digest cannot be compared with one, so every later \"the document has changed since it was cited\" would be decided by it without ever having been a hash."

/**
 * Whether a citation's carried-over hash could not have come from `hashText`,
 * and so must be refused.
 *
 * `provenance` exists so a migration can COPY what a citation recorded rather
 * than let the target store recompute it — recomputing stamps today's hash on
 * a check somebody ran days ago. It is honoured only for a human principal and
 * refused by name for an agent token (`AGENT_CANNOT_ASSERT_PROVENANCE`), so
 * the trust boundary is the CLI token rather than the data. This closes the one
 * place that let a rendering surface state something as checked without
 * anything having established it: `hash: "deadbeef"` was stored verbatim, and
 * every staleness warning is a comparison against it.
 *
 * **`null` stays legal and must.** It is a fact — "no hash was recorded" — and
 * older citations carry it; refusing it would refuse `cairn init --team`
 * on the only spaces that need the migration. This rejects a STRING that could
 * not be a digest, nothing else.
 *
 * Deliberately a shape check and not a recomputation. Recomputing is what
 * erases staleness warnings, and it cannot be done here anyway: the text the
 * hash was taken from is whatever the source space held, not what this one has.
 * It also says nothing about `by`: migration has to carry an original citer's
 * recorded facts, so `by` must stay settable.
 */
export function statesImpossibleHash(input: CiteInput): boolean {
  const hash = input.provenance?.hash
  return hash !== undefined && hash !== null && !RECORDED_HASH.test(hash)
}

/**
 * Whether a citation states no scope and so must be refused. THE one place
 * that rule is written down: `FileStore.citations` and `FileStore.cite`
 * (src/store.ts) and the hosted service all ask this function, rather than
 * each keeping a copy of the rule — a second copy was exactly how one side
 * came not to know about `provenance`.
 *
 * The exception is the whole reason this is a function rather than a
 * `.min(1)`: a citation carrying `provenance` is a COPY of one recorded
 * before `supports` existed, made by a migration (see `CiteInput.provenance`).
 * `parseCites` (src/claims.ts) reads a pre-0.6.4 bare-string citation back as
 * `supports: ""`, so refusing every empty scope refuses `cairn init --team`
 * itself, permanently, for any space holding one — and older approved claims
 * carry them. A scope-less citation may be COPIED
 * forward; it may not be CREATED. That distinction is exactly what
 * `provenance` marks.
 *
 * Trimmed, not just checked for `""`: `"   "` states no scope either, and the
 * value that gets stored is trimmed too, so the check has to be made against
 * the same string the store will keep.
 */
export function statesNoScope(input: CiteInput): boolean {
  return input.provenance === undefined && input.supports.trim() === ""
}

/**
 * The sentence a citation's recorded facts are refused with when the caller is
 * an agent token.
 *
 * `provenance` travels on the wire because a migration must COPY what a
 * citation recorded rather than let the target store recompute it — a
 * recomputed hash is today's hash, so every "this document has changed since
 * it was cited" warning would vanish the moment a space migrated. But the
 * reason it was originally kept OFF the wire is just as real: a caller able to
 * set `hash`, `absent` and `by` can assert a check it never ran — claim
 * `absent: []` against a current hash and manufacture a verification.
 *
 * Both are served by honouring `provenance` only for a HUMAN principal
 * (a browser session, or a `cli` token a named person minted by clicking
 * Approve), which is what `cairn init --team`
 * runs as, and refusing it BY NAME for an agent token. Refused, never quietly
 * ignored: a caller whose recorded facts were silently dropped would believe
 * they had been stored, which is the same false-verification this guards
 * against, arrived at from the other direction.
 */
export const AGENT_CANNOT_ASSERT_PROVENANCE =
  "a citation's hash, its absent terms and who attached it are established by the store that read the document — an agent token cannot supply them. They travel only on a migration a person is running (`cairn init --team`). Send `doc` and `supports` and let the store record the rest."

/** The 403 `code` the hosted create routes answer that refusal with. The
 *  SENTENCE is built client-side from this code, the arrangement
 *  `notAdoptableMessage` set, so both halves refuse in one voice. */
export const AGENT_PROVENANCE_CODE = "agent_cannot_assert_provenance"

/** The `code` the hosted cite route answers each refusal with. The refusal is
 *  decided server-side, where the documents and the existing citations are; the
 *  SENTENCE is built client-side so both stores speak with one voice, and the
 *  code is the only channel between them.
 *
 *  `cite_unknown_document` is the code `POST /claims` already answers a
 *  proposal's dangling citation with: deliberately the same code for the same
 *  fact, and this is where it now lives. */
export const CITE_REFUSAL_CODES: Record<CiteRefusal, string> = {
  "unknown-document": "cite_unknown_document",
  "already-cited": "cite_already_cited",
}
export const UNCITE_REFUSAL_CODES: Record<UnciteRefusal, string> = { "not-cited": "uncite_not_cited" }

/** The inverses. Null for any other code, so a refusal this client does not
 *  recognise surfaces as itself rather than as a fabricated citation refusal. */
export function citeRefusalFromCode(code: string): CiteRefusal | null {
  for (const [refusal, c] of Object.entries(CITE_REFUSAL_CODES)) {
    if (c === code) return refusal as CiteRefusal
  }
  return null
}

export function unciteRefusalFromCode(code: string): UnciteRefusal | null {
  return code === UNCITE_REFUSAL_CODES["not-cited"] ? "not-cited" : null
}

/**
 * What a content PATCH can mean. A claim's text is edited through `review`, so
 * the only writes that reach `put` are the two ways an abstract gets written:
 * a model wrote it, or a human did.
 *
 * Lives here so the CLI and the hosted service count the same thing. While
 * the server kept its own copy, the client hardcoded `"curate"` for both —
 * which is how `cairn abstracts` came to record a human curating what a model
 * had written.
 */
export const PATCH_KINDS = ["generate", "curate"] as const
export type PatchKind = (typeof PATCH_KINDS)[number]
