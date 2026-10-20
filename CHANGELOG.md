# Changelog

## [Unreleased]

### Added

- cairn's MCP server now sends the same guidance as server instructions when
  an agent connects, and the search tool's description says when to use it.

### Changed

- The instructions `cairn init` writes now tell your agent to search cairn,
  and read what it finds, before answering questions about the project's
  decisions, conventions, architecture or history. Re-run `cairn init` in a
  project to update instructions written by an older version.

### Fixed

- `cairn init` now makes Claude Code read the instructions when they go into
  `AGENTS.md`, by adding an `@AGENTS.md` import to the project's `CLAUDE.md`
  or creating one. Before this, Claude Code skipped `AGENTS.md` whenever a
  `CLAUDE.md` existed in the project or any folder above it. A cairn block
  an older version left in that `CLAUDE.md` is moved out, so the
  instructions appear once. A `CLAUDE.md` linked to `AGENTS.md` (either way
  round) is left as it is, and one linked anywhere else is left alone with
  the line to add by hand. `cairn doctor` accepts a `CLAUDE.md` that imports,
  or is a link to, an `AGENTS.md` holding the instructions.
- `cairn init` no longer replaces a symlinked instructions file with a copy;
  it writes to the file the link points to.

## [0.9.0] — 2026-10-20

### Added

- `cairn init` now looks for Codex and Claude Desktop as well as Claude Code
  and Cursor, and in a terminal shows which of the four it found.
- `cairn init` now configures Codex and Claude Desktop: it adds cairn to
  `~/.codex/config.toml` (keeping your other servers and comments) and to
  Claude Desktop's config, and tells you to paste the instructions into a
  Claude project and restart Claude Desktop. Both configs are machine-wide,
  so they are written by `cairn init` in a terminal or by `--global`; a
  `--yes` or scripted project-scope run leaves them alone and says so in one
  line. If either config uses syntax cairn can't safely edit, that agent is
  skipped and `init` prints the entry to add by hand.
- Documents can be marked as machine-generated and tagged with the repository
  they came from; `cairn init --team` keeps both when moving documents.
- Agents can write overview documents into a local space with the new
  `team_knowledge_write_document` MCP tool; they are labelled generated in
  search, reads and `cairn show`, and agents are told to treat a generated
  document as inference from the code rather than a team decision.
- `cairn init` checks that each agent it configured can actually start
  cairn, and names the fix when one cannot; when none can, it ends by
  saying so instead of with the usual next steps.
- With telemetry on, cairn reports once how long it took from finishing
  `cairn init` to your agent's first search that found something, as a
  bucket (`<5m`, `5–10m`, `10–30m`, `>30m`, `never`) rather than a raw
  duration; the consent screen shows it.

### Changed

- `cairn init` in a terminal now proves each agent can start cairn, imports
  the repository's docs — and, with fewer than three, also installs a
  `cairn-import` skill so your agent can map the code — and shows a first
  answer, signing you in first when you choose a team space (a doc it
  can't read or store is named and skipped, and the rest still import); `--yes`,
  scripts and `--dry-run` work as before, and `--dry-run` now also shows what
  would be imported.
- If you already ran `cairn import` on a repository, running the new
  `cairn init` there imports its docs a second time, under new sources named
  after the repository, so each one appears twice in your space.
- `cairn init` names a repository `owner/name` from its git remote, so
  `acme/api` and `other/api` keep separate documents in one space. A
  repository with no remote is named after its directory.

### Fixed

- `cairn doctor` now finds cairn in Codex's and Claude Desktop's config, and
  finds a project's `.mcp.json` or `.cursor/mcp.json` at the top of the git
  repository when you run it from a subfolder.


## [0.8.0] — 2026-10-20

### Added

- `cairn search` now shows the top results on the terminal, with a count of
  how many more matched — pass `--json` to see all of them.

### Fixed

- `cairn search` and an agent's search now find documents and claims for a
  question in plain words, ranked by relevance, instead of only an exact
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
