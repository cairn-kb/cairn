import type { GeneratedDocumentInput } from "./types"

/**
 * The prefix every generated document's `source` carries, so a store can
 * tell a machine-written document's slot apart from a file path on sight —
 * no file ever imports to a source starting this way, since `cairn import`
 * sources are relative file paths.
 */
export const GENERATED_SOURCE_PREFIX = "generated:"

/**
 * The synthetic `source` a generated document lives at: `repo` and `slug`
 * together name the slot, the same way a file's path names an imported
 * document's. Writing again with the same pair reaches the same document —
 * `Store.importDocument`'s source-matching already does that for `cairn
 * import`, and `Store.writeGenerated` relies on it rather than re-deriving
 * the rule.
 */
export function generatedSource(repo: string, slug: string): string {
  return `${GENERATED_SOURCE_PREFIX}${repo}/${slug}`
}

/**
 * `slug` ends up as a path-like segment inside `generatedSource`, so it is
 * held to the shape that alone rules out "/" and ".." without a second,
 * separate traversal check that could drift from it: lowercase letters,
 * digits and hyphens, starting with a letter or digit, at most 64
 * characters. The shipped pattern from `assertSlug` (src/mcp.ts).
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * `repo` is a label an agent was handed, not a path segment it invents, and
 * ends up on the right of `generatedSource(repo, ...)` — compared by string
 * equality, never split apart or joined onto a filesystem path. So it is
 * allowed the shape of an actual repository name, `owner/name` or just
 * `name`: each part letters of either case, digits, ".", "_" and "-", at
 * most one "/", 1 to 100 characters in all. The shipped pattern from
 * `assertRepo` (src/mcp.ts).
 */
export const REPO_PATTERN = /^(?=.{1,100}$)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/

/**
 * The most a generated document's text may be, in UTF-8 bytes — not JS
 * string length, which undercounts anything outside the BMP's low code
 * points. An agent's own overview is meant to stay a small, readable
 * document; this is the backstop against one that is not.
 */
export const MAX_GENERATED_TEXT_BYTES = 200_000

/**
 * Why a generated-document write was refused, or null if it was not.
 *
 * Six codes because a person acts on each differently, the same reasoning
 * `AdoptionRefusal` and `RetractRefusal` already follow. Only the first
 * three are decided by `validateGenerated` — shape checks on the input alone,
 * so both stores ask the same function and agree without either knowing
 * about the other's storage. The remaining three are decided by whichever
 * store is asked: `source_not_generated` by looking up what is already at
 * that source, `agent_documents_off` and `generated_daily_cap` only by the
 * hosted store, which is the one with a team setting and a daily count to
 * consult. `generatedRefusalMessage` gives every code its own sentence,
 * which is what lets both stores refuse a write in one voice.
 */
export type GeneratedRefusalCode =
  | "invalid_slug"
  | "invalid_repo"
  | "document_too_large"
  | "source_not_generated"
  | "agent_documents_off"
  | "generated_daily_cap"

/**
 * The shape checks on a `GeneratedDocumentInput` that need nothing from
 * storage to decide — `slug`, `repo` and the size of `text`. Asked by both
 * stores before either one touches a document, so a bad slug or an
 * oversized write is refused identically whichever one is asked.
 *
 * `source_not_generated`, `agent_documents_off` and `generated_daily_cap`
 * are NOT decided here: the first needs the document already at that
 * source, and the other two need a team setting and a daily count neither
 * store can answer from the input alone.
 */
export function validateGenerated(input: GeneratedDocumentInput): GeneratedRefusalCode | null {
  if (!SLUG_PATTERN.test(input.slug)) return "invalid_slug"
  if (!REPO_PATTERN.test(input.repo)) return "invalid_repo"
  // UTF-8 bytes, not `.length`: a string of astral or accented characters can
  // sit well under the byte limit in JS string length while being over it on
  // the wire, which is what a byte limit exists to bound in the first place.
  if (new TextEncoder().encode(input.text).length > MAX_GENERATED_TEXT_BYTES) return "document_too_large"
  return null
}

/**
 * The sentence both stores refuse a generated-document write with, one per
 * code and word for word — the same convention `notAdoptableMessage` and
 * `notRetractableMessage` (packages/protocol/src/event-kinds.ts) already set
 * for this seam. Exporting it once from this dependency-free module is what
 * keeps two copies of the same literal in two files from drifting the
 * moment either is edited alone.
 *
 * `invalid_slug` and `invalid_repo` reuse project 1's wording from
 * `assertSlug`/`assertRepo` (src/mcp.ts) verbatim, less the echoed `got
 * "<value>"` — this function takes only the code, never the value that
 * failed. `agent_documents_off` and `generated_daily_cap` name no hosted
 * numbers or internals: a team owner turned writes off, or the team space's
 * daily limit is reached, is the whole of what an agent needs to act on
 * either.
 */
export function generatedRefusalMessage(code: GeneratedRefusalCode): string {
  switch (code) {
    case "invalid_slug":
      return (
        `team_knowledge_write_document: slug must be lowercase letters, digits and hyphens only, ` +
        `starting with a letter or digit, at most 64 characters (no "/", ".." or uppercase).`
      )
    case "invalid_repo":
      return (
        `team_knowledge_write_document: repo must be owner/name or name, each part letters, digits, ` +
        `".", "_" or "-" only, 1 to 100 characters in all.`
      )
    case "document_too_large":
      return (
        `team_knowledge_write_document: text must be at most ${MAX_GENERATED_TEXT_BYTES} bytes (UTF-8) — ` +
        `this document is larger.`
      )
    case "source_not_generated":
      return (
        `team_knowledge_write_document: a document already exists at this repo and slug, and it was not ` +
        `machine-generated — writing here would silently replace a human document. Pick a different slug.`
      )
    case "agent_documents_off":
      return `team_knowledge_write_document: a team owner has turned this off.`
    case "generated_daily_cap":
      return `team_knowledge_write_document: the team space's daily limit is reached; try tomorrow.`
  }
}
