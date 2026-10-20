# @cairn-kb/protocol

The types and pure functions a cairn CLI and a cairn team space must agree on:
claim and document shapes, event kinds, the stats arithmetic, absence framing,
content hashing, document titles, provenance and retrieval.

Shipped as TypeScript source with no runtime dependencies and no Node
builtins, because it runs in the hosted service as well as in the CLI.

Some contracts are pinned by behaviour rather than by a shared import, and a
change to one of them must be mirrored by the hosted service:

- `hashText` — the service fingerprints text with the same SHA-256-hex rule.
- The CLI's PKCE challenge (`src/login.ts`) — S256 over the verifier, as in RFC 7636.
- The CLI's loopback port parsing during `cairn login`.

`Document` and `DocumentInput` also carry two optional fields:

- `generated` — a machine wrote this text; absent means false.
- `repo` — the repository label the document came from; absent means untagged.

`./retrieval` holds what both sides need to search documents the same way:

- `chunk(title, text)` cuts a document into passages, contiguous spans of its
  text under their heading breadcrumb, with offsets as JavaScript string
  indices into the text. `passageText` is what a passage is indexed and
  embedded as, and `CHUNKER_VERSION` changes whenever the chunking rules do,
  so stored passages can be recognised as stale.
- `rrf` fuses rankings by reciprocal rank, and `capPerDoc` limits how many
  passages of one document a result keeps.
- `ftsQuery` turns a question in plain words into a full-text query.
- The constants these use: chunk sizes, fusion depth and `k`, the default
  passage limit, the query embedding timeout and the keyword-only notice.

`./types` adds `Passage`, `PassageHit`, `SearchOptions`, `Embedder` and
`Store.searchPassages`.
