/**
 * The search guidance lives with the MCP server in @cairn-kb/mcp, which sends
 * it as server instructions; `cairn init` writes the same string into the
 * instructions block, reaching it through here so neither can drift from it.
 */
export { SEARCH_GUIDANCE } from "@cairn-kb/mcp"
