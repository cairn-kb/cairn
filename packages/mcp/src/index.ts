export { ALL_SCOPES, createMcpServer, type Scope, type ServerOptions } from "./server"
export {
  ABSTRACT_GUIDANCE,
  CITE_DESCRIPTION,
  createTools,
  DEFAULT_MAP_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  GENERATED_NOTE,
  MAP_DESCRIPTION,
  PROPOSE_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  WRITE_DOCUMENT_DESCRIPTION,
  type EventInput,
  type KbTools,
  type MapContext,
  type MapEntry,
  type MapResult,
  type ProposeInput,
  type ReadDocument,
  type SearchHit,
  type SearchResult,
  type Tombstone,
  type ToolSink,
  type ToolStore,
  type Via,
} from "./tools"
export { SEARCH_GUIDANCE } from "./guidance"
export { findOverlaps, similarity, trigrams } from "./overlap"
export { PREVIEW_CHARS, READ_WINDOW, previewOf, windowOf } from "./view"
