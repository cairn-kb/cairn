# Changelog

## [Unreleased]

### Fixed

- `cairn search` and an agent's search now find documents and claims for a
  question in plain words, best match first, instead of only an exact
  phrase.
- `cairn abstracts --all` no longer overwrites an abstract a person wrote in
  `cairn curate` or an agent wrote directly. It now regenerates only
  machine-generated and missing abstracts; pass `--force` alongside `--all`
  to also regenerate the ones a human or an agent wrote — or an older
  abstract with no recorded provenance at all, which is also left alone by
  default since unknown provenance may be a person's writing.

## [0.7.0] — 2026-10-15

- First open-source release, under Apache-2.0. Install with
  `curl -fsSL https://raw.githubusercontent.com/cairn-kb/cairn/main/install.sh | sh`.

### Added

- Telemetry now also stays off for a run when DO_NOT_TRACK is set (any value except empty, 0 or false).
- The CLI now talks to api.cairn-kb.dev and telemetry.cairn-kb.dev. Existing logins keep working.
- `cairn --help` now lists every flag each command accepts — `init --local/--team/--yes/--telemetry/--no-telemetry`,
  `model --base-url/--yes` and the `--provider` ids were missing.

### Fixed

- A cairn binary you compile yourself (`bun build --compile`) now writes an agent config that
  launches it directly. It used to write a `bun` command pointing at a path that exists only
  inside the binary, so the agent's MCP server failed to start.
- The installer's closing hint now points at `cairn init`, which needs no account for a local
  space, rather than telling every new user to sign in first.
- `cairn model --verify` no longer accepts any non-empty reply as an abstract. A
  model that answered with a bare label — a safety classifier's `User Safety: safe`,
  say — was reported as verified and saved to your configuration. The verification
  now rejects empty replies, bare labels, and replies far over the 40-word limit,
  and says which one it was. Abstracts from `cairn abstracts` are held to the same
  check, so a reply that fails it is reported against its claim and that claim is
  left without an abstract.
- `cairn init --team` no longer promises to move claims that will not move. The
  sentence you read to confirm the migration counted every claim on the root,
  including the rejected and retracted ones, which do not migrate at all — so a
  root holding two approved claims and one rejected one said three would move.
  It now names what moves, and names what stays **before** you answer rather
  than only in the summary afterwards. A root holding nothing but rejected or
  retracted claims is no longer asked to confirm a migration at all: nothing
  would move, so nothing is asked — and it says so instead of going quiet.
- `cairn login` no longer makes you wait out the timeout when the browser
  cannot reach your terminal. The paste prompt is now open for the whole wait
  instead of being offered only after it expires, so if your browser is on
  another machine — the case the fallback exists for, where the loopback is
  unreachable in principle — you can paste the code from its address bar
  straight away rather than sitting out fifteen minutes or pressing Ctrl-C and
  starting again with `--no-browser`. If the browser gets through first, the
  prompt closes by itself and the login carries on as before.

## [0.6.10] — 2026-09-09

The last release before the source was opened. Earlier history is not part of this repository.
