# @cairn-kb/mcp

The cairn MCP tools — `team_knowledge_map`, `team_knowledge_read`,
`team_knowledge_search`, `team_knowledge_propose`, `team_knowledge_cite` and
`team_knowledge_write_document` — as one tool surface. The cairn CLI serves it
over stdio (`cairn mcp`); the hosted service serves the same surface over
Streamable HTTP.

Shipped as TypeScript source with no Node builtins, so it runs wherever the
hosted service does as well as in the CLI.

- `createMcpServer(store, log, opts)` builds an `McpServer` from any `ToolStore`
  (the subset of `@cairn-kb/protocol`'s `Store` the tools call) and `ToolSink`
  (somewhere to append events). `opts.version` is reported in the handshake;
  `opts.via` (`"stdio"` or `"connector"`) is recorded as `meta.via` on the
  map, read and search events the tools append; `opts.scopes` limits which tools are registered —
  `knowledge:read` for map, read and search, `knowledge:write` for propose,
  cite and write_document; `ALL_SCOPES` is the default.
- `createTools(store, log, via)` is the same tools without a server, for an
  in-process caller.

`zod` is a peer dependency, so a consumer that already has it never loads a
second copy.
