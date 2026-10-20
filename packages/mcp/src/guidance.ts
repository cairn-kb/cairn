/**
 * When to look in cairn at all. Without it the instructions block only said
 * what to do at the start and the end of a session, and an agent answered
 * project questions from memory with the tools sitting unused.
 *
 * It opens the block `cairn init` writes (src/init.ts, through
 * src/guidance.ts) and the instructions the MCP server sends (./tools.ts), so
 * the two cannot drift apart. A leaf module, so the server does not load
 * init's file-writing code to read it.
 */
export const SEARCH_GUIDANCE = `This project's team knowledge lives in cairn. Before answering a question about
the project's decisions, conventions, architecture or history, call
team_knowledge_search, and read the documents it points to with
team_knowledge_read. Answer from what they return, and say so when they have
nothing.`
