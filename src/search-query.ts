/**
 * The FTS5 query builder now lives in the protocol, so the hosted service
 * builds the same query from the same question. Re-exported here so callers
 * in the CLI keep importing it from where they always have.
 */
export { ftsQuery } from "@cairn-kb/protocol/retrieval"
