import { ABSTRACT_GUIDANCE } from "./mcp"
import type { Claim } from "@cairn-kb/protocol/types"

/**
 * One definition of what an abstract is, shared with the propose tool. A second
 * prompt here would let generated and agent-written abstracts drift apart, and
 * the map would mix two standards with no way to tell which is which.
 */
export function buildPrompt(claim: Claim): string {
  return [
    ABSTRACT_GUIDANCE,
    "",
    `CLAIM: ${claim.claim}`,
    "",
    `DETAIL:`,
    claim.body || "(none)",
  ].join("\n")
}
