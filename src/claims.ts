import matter from "gray-matter"
import type { Citation, Claim, Status } from "@cairn-kb/protocol/types"

/**
 * Date + slug + a random suffix. The suffix is not decoration: without it two
 * proposals of the same sentence on the same day collide on id, and the second
 * one evicts the first — including when the first has already been approved.
 * Two proposals of the same claim are a legitimate, expected event (two
 * teammates' agents learning the same thing, or a retried propose); overlap
 * detection is what surfaces the pair to the reviewer, so both must survive.
 */
export function makeId(claimText: string, now: Date): string {
  const slug = claimText
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join("-")
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 6)
  return `${now.toISOString().slice(0, 10)}-${slug}-${suffix}`
}

export function serializeClaim(claim: Claim): string {
  const { body, ...front } = claim
  return matter.stringify(body, front)
}

/**
 * Citations as stored, in either shape they have ever had.
 *
 * A bare string is a citation written before `supports` existed, and older
 * spaces hold them on approved and rejected claims alike. They come back scope-less, unchecked and unattributed, which is
 * the honest representation of what is actually known about them.
 *
 * `absent` distinguishes an absent key (never computed -> null) from a stored
 * empty array (computed, nothing absent -> []). `?? null` on a missing key
 * rather than `?? []`, deliberately.
 */
function parseCites(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry): Citation => {
    if (typeof entry === "string") {
      return { doc: entry, supports: "", hash: null, absent: null, by: "unknown" }
    }
    const e = (entry ?? {}) as Record<string, unknown>
    return {
      doc: String(e.doc),
      supports: typeof e.supports === "string" ? e.supports : "",
      hash: typeof e.hash === "string" ? e.hash : null,
      absent: Array.isArray(e.absent) ? e.absent.map(String) : null,
      by: typeof e.by === "string" ? e.by : "unknown",
    }
  })
}

export function parseClaim(text: string): Claim {
  const { data, content } = matter(text)
  return {
    id: String(data.id),
    status: data.status as Status,
    claim: String(data.claim),
    body: content.trim(),
    source: {
      author: String(data.source?.author ?? "unknown"),
      agent: String(data.source?.agent ?? "unknown"),
      repo: data.source?.repo ?? null,
      session: data.source?.session ?? null,
    },
    // gray-matter's YAML parser coerces unquoted ISO timestamps into Date
    // objects, so both fields are normalised back to ISO strings here rather
    // than stringified with String(), which would yield a Date's toString().
    created: new Date(data.created).toISOString(),
    reviewed: data.reviewed == null ? null : new Date(data.reviewed).toISOString(),
    reviewer: data.reviewer ?? null,
    // Defaulted, never required — same rule as `cites`. `at` is normalised
    // through Date the way `created` and `reviewed` are: gray-matter's YAML
    // parser coerces an unquoted ISO timestamp into a Date, and String() on a
    // Date yields its toString(), not an ISO string.
    retracted: data.retracted
      ? {
          at: new Date(data.retracted.at).toISOString(),
          by: String(data.retracted.by),
          reason: String(data.retracted.reason),
        }
      : null,
    overlaps: data.overlaps ?? [],
    // Defaulted, never required: every claim file written before this field
    // existed still has to parse — including the ones whose cites are bare
    // document ids, written before a citation could state its scope.
    cites: parseCites(data.cites),
    abstract: data.abstract ?? null,
    abstractBy: data.abstractBy ?? null,
    tags: data.tags ?? [],
  }
}

export function trigrams(text: string): Set<string> {
  const clean = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `
  const out = new Set<string>()
  for (let i = 0; i < clean.length - 2; i++) out.add(clean.slice(i, i + 3))
  return out
}

/** Dice coefficient over trigrams: 0 (nothing shared) to 1 (identical). */
export function similarity(a: string, b: string): number {
  const ta = trigrams(a)
  const tb = trigrams(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return (2 * shared) / (ta.size + tb.size)
}

/**
 * Candidate claims this proposal may duplicate or contradict. A shared tag
 * lowers the bar, since same-topic claims are the ones worth comparing.
 */
export function findOverlaps(
  claimText: string,
  tags: string[],
  existing: Claim[],
  threshold = 0.4,
): string[] {
  return existing
    .map((c) => {
      const sharesTag = c.tags.some((t) => tags.includes(t))
      const score = similarity(claimText, c.claim)
      return { id: c.id, score, bar: sharesTag ? threshold * 0.75 : threshold }
    })
    .filter((r) => r.score >= r.bar)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.id)
}
