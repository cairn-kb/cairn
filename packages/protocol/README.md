# @cairn-kb/protocol

The types and pure functions a cairn CLI and a cairn team space must agree on:
claim and document shapes, event kinds, the stats arithmetic, absence framing,
content hashing, document titles, provenance and generated-document rules.

Shipped as TypeScript source with no runtime dependencies and no Node
builtins, because it runs in the hosted service as well as in the CLI.

Some contracts are pinned by behaviour rather than by a shared import, and a
change to one of them must be mirrored by the hosted service:

- `hashText` — the service fingerprints text with the same SHA-256-hex rule.
- The CLI's PKCE challenge (`src/login.ts`) — S256 over the verifier, as in RFC 7636.
- The CLI's loopback port parsing during `cairn login`.
- `generatedRefusalMessage` (`./generated`) — the sentence a generated-document
  write is refused with, one per `GeneratedRefusalCode`; both stores must
  refuse the same way in the same words.

`Document` and `DocumentInput` also carry two optional fields:

- `generated` — a machine wrote this text; absent means false.
- `repo` — the repository label the document came from; absent means untagged.

`./generated` is where a generated document's rules live: the synthetic
`source` it is written to (`GENERATED_SOURCE_PREFIX`, `generatedSource`), the
shape a `repo` and `slug` must have (`REPO_PATTERN`, `SLUG_PATTERN`), the byte
limit on its text (`MAX_GENERATED_TEXT_BYTES`), and `validateGenerated` plus
`generatedRefusalMessage` above for deciding and voicing a refusal.
`Store.writeGenerated` is the write itself.
