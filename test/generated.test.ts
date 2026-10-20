import { expect, test } from "bun:test"
import {
  GENERATED_SOURCE_PREFIX,
  MAX_GENERATED_TEXT_BYTES,
  REPO_PATTERN,
  SLUG_PATTERN,
  generatedRefusalMessage,
  generatedSource,
  validateGenerated,
} from "@cairn-kb/protocol/generated"
import type { GeneratedDocumentInput } from "@cairn-kb/protocol/types"

const INPUT: GeneratedDocumentInput = {
  repo: "app",
  slug: "architecture",
  title: "Architecture",
  text: "a small overview",
  agent: "cursor",
}

test("generatedSource joins repo and slug under the generated: prefix", () => {
  expect(generatedSource("app", "architecture")).toBe("generated:app/architecture")
  expect(GENERATED_SOURCE_PREFIX).toBe("generated:")
})

test("validateGenerated accepts a well-formed input", () => {
  expect(validateGenerated(INPUT)).toBeNull()
})

test("validateGenerated refuses an uppercase slug", () => {
  expect(validateGenerated({ ...INPUT, slug: "Architecture" })).toBe("invalid_slug")
})

test("validateGenerated refuses a repo with more than one slash, or a space", () => {
  // Controller ruling: REPO_PATTERN is the shipped `owner/name` or `name`
  // pattern from src/mcp.ts, so a single slash (`owner/name`) is VALID — only
  // a second slash or a disallowed character is refused.
  expect(validateGenerated({ ...INPUT, repo: "a/b/c" })).toBe("invalid_repo")
  expect(validateGenerated({ ...INPUT, repo: "a b" })).toBe("invalid_repo")
})

test("owner/name and a bare name are both a valid repo", () => {
  expect(validateGenerated({ ...INPUT, repo: "owner/name" })).toBeNull()
  expect(validateGenerated({ ...INPUT, repo: "name" })).toBeNull()
})

test("validateGenerated refuses text over the byte limit, counted as UTF-8 bytes", () => {
  // "é" is two UTF-8 bytes, so 100,001 copies is 200,002 bytes — one over the
  // limit by a text whose JS string length (100,001) looks well under it.
  const text = "é".repeat(100_001)
  expect(validateGenerated({ ...INPUT, text })).toBe("document_too_large")
})

test("exactly the byte limit is not refused", () => {
  const text = "é".repeat(MAX_GENERATED_TEXT_BYTES / 2)
  expect(validateGenerated({ ...INPUT, text })).toBeNull()
})

test("SLUG_PATTERN and REPO_PATTERN are exported for callers that validate ahead of the store", () => {
  expect(SLUG_PATTERN.test("architecture")).toBe(true)
  expect(SLUG_PATTERN.test("Architecture")).toBe(false)
  expect(REPO_PATTERN.test("owner/name")).toBe(true)
  expect(REPO_PATTERN.test("a/b/c")).toBe(false)
})

test("the invalid_slug and invalid_repo sentences reuse project 1's wording, without the echoed value", () => {
  expect(generatedRefusalMessage("invalid_slug")).toBe(
    "team_knowledge_write_document: slug must be lowercase letters, digits and hyphens only, " +
      'starting with a letter or digit, at most 64 characters (no "/", ".." or uppercase).',
  )
  expect(generatedRefusalMessage("invalid_repo")).toBe(
    "team_knowledge_write_document: repo must be owner/name or name, each part letters, digits, " +
      '".", "_" or "-" only, 1 to 100 characters in all.',
  )
})

test("agent_documents_off and generated_daily_cap name no hosted internals", () => {
  const off = generatedRefusalMessage("agent_documents_off")
  const cap = generatedRefusalMessage("generated_daily_cap")
  expect(off).toContain("a team owner has turned this off")
  expect(cap).toContain("the team space's daily limit is reached; try tomorrow")
})

test("every refusal code has its own sentence", () => {
  const codes = [
    "invalid_slug",
    "invalid_repo",
    "document_too_large",
    "source_not_generated",
    "agent_documents_off",
    "generated_daily_cap",
  ] as const
  const messages = codes.map((c) => generatedRefusalMessage(c))
  expect(new Set(messages).size).toBe(codes.length)
})
