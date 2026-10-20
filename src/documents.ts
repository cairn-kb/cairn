import matter from "gray-matter"
import { basename, relative, sep } from "node:path"
import { makeId } from "./claims"
import { titleOf as titleFrom } from "@cairn-kb/protocol/document-title"
import type { Document } from "@cairn-kb/protocol/types"

// Moved to @cairn-kb/mcp, which shapes what read and search hand an agent on
// both transports; re-exported so every existing caller keeps working.
export { PREVIEW_CHARS, READ_WINDOW, previewOf, windowOf } from "@cairn-kb/mcp"

/** Built exactly as a claim id is, then prefixed. The prefix is load-bearing:
 *  it is how a read path tells the two nouns apart from an id alone. */
export function makeDocId(title: string, now: Date): string {
  return `doc-${makeId(title, now)}`
}

/** The CLI's fallback is the file's basename, extension included. See
 *  packages/protocol/src/document-title.ts for why the hosted service's is not. */
export function titleOf(text: string, path: string): string {
  return titleFrom(text, basename(path))
}

/** A frontmatter value cairn will use, or nothing. Anything that is not a
 *  non-empty string falls through to the next candidate rather than becoming
 *  the string "undefined" or "[object Object]" in a title. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** gray-matter throws on a fence it cannot parse. A half-written `---` in a
 *  corpus is ordinary, so such a file imports whole — worse than parsed, and
 *  far better than not imported at all. */
function readFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  try {
    const { data, content } = matter(raw)
    return { data, content }
  } catch {
    return { data: {}, content: raw }
  }
}

/**
 * What an incoming file becomes. Frontmatter is metadata, not body: imported
 * raw, a document whose fence carries its only summary reached an agent as a
 * filename and 240 characters of YAML, which is the whole surface search ranks
 * on. Import-path only — `DocumentInput` is unchanged.
 */
export function parseImport(raw: string, path: string): { title: string; text: string } {
  const { data, content } = readFrontmatter(raw)
  // A hand-written `description` is a better summary than anything cairn could
  // produce, so it leads the body rather than living in a field of its own: it
  // is then what a preview shows and what the index searches.
  const parts = [str(data.description), content.trim()].filter((p) => p !== "")
  return {
    title: str(data.title) || str(data.name) || titleOf(content, path),
    text: parts.join("\n\n"),
  }
}

/** The path a re-import matches on: relative to the directory that was
 *  imported, POSIX-separated so the same corpus imported on two machines
 *  produces the same source. */
export function normalizeSource(dir: string, path: string): string {
  return relative(dir, path).split(sep).join("/")
}

export function serializeDocument(doc: Document): string {
  // `generated` and `repo` are written only when set — never `generated:
  // false` or an absent `repo` as an explicit key — so a file untouched by
  // either field looks exactly as it did before they existed.
  const { text, generated, repo, ...front } = doc
  const tags: Partial<Pick<Document, "generated" | "repo">> = {}
  if (generated) tags.generated = true
  if (repo) tags.repo = repo
  return matter.stringify(text, { ...front, ...tags })
}

export function parseDocument(raw: string): Document {
  const { data, content } = matter(raw)
  const doc: Document = {
    id: String(data.id),
    title: String(data.title),
    text: content.trim(),
    // `?? null` and not `String(...)`: an absent source must stay null, or an
    // adopted document matches nothing and is imported a second time.
    source: data.source ?? null,
    // gray-matter's YAML parser turns unquoted ISO timestamps into Dates.
    created: new Date(data.created).toISOString(),
    updated: new Date(data.updated).toISOString(),
    hash: String(data.hash),
  }
  // Omitted rather than `false`/`null` when absent — a key present only when
  // true is what lets a file written before either field existed parse back
  // with neither key at all.
  if (data.generated === true) doc.generated = true
  if (typeof data.repo === "string") doc.repo = data.repo
  return doc
}
