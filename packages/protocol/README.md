# @cairn-kb/protocol

The types and pure functions a cairn CLI and a cairn team space must agree on:
claim and document shapes, event kinds, the stats arithmetic, absence framing,
content hashing, document titles and provenance.

Shipped as TypeScript source with no runtime dependencies and no Node
builtins, because it runs in the hosted service as well as in the CLI.

Some contracts are pinned by behaviour rather than by a shared import, and a
change to one of them must be mirrored by the hosted service:

- `hashText` — the service fingerprints text with the same SHA-256-hex rule.
- The CLI's PKCE challenge (`src/login.ts`) — S256 over the verifier, as in RFC 7636.
- The CLI's loopback port parsing during `cairn login`.
