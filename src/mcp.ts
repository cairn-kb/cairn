// The MCP tools and server live in @cairn-kb/mcp, so `cairn mcp` (stdio) and
// the hosted service serve one tool surface. Re-exported here so every
// existing importer keeps working; only the CLI's own team-mode refusal stays.
export * from "@cairn-kb/mcp"

/**
 * What an agent is told when it tries to write a generated document against a
 * space that talks to the hosted service. Points at the one path that works
 * today — importing by hand in the console — rather than leaving the agent to
 * guess whether this is a bug or a missing feature. `cairn mcp` passes it as
 * `teamWriteRefusal` in team mode.
 */
export const TEAM_WRITE_REFUSAL =
  "team_knowledge_write_document: agents cannot write documents to a team space yet. " +
  "Import this text as a document yourself in the console instead."
