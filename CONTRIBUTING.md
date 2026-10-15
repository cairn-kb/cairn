# Contributing to cairn

Thanks for helping. cairn is Apache-2.0 licensed.

## Sign off your commits (DCO)

Every commit must carry a `Signed-off-by:` line, certifying the
[Developer Certificate of Origin](https://developercertificate.org/):
`git commit -s`. CI checks that every commit in a pull request has a sign-off
line.

## Develop

Install [Bun](https://bun.sh) (1.3.6 is what CI runs), then:

    bun install
    bun test
    bunx tsc --noEmit
    bun run scrub          # needs gitleaks installed
    shellcheck -s sh install.sh   # CI runs this too, if you touch install.sh

Run the CLI from source with `bun src/cli.ts <command>`, for example
`bun src/cli.ts doctor`.

To build a binary:

    bun build --compile --minify src/cli.ts --outfile dist/cairn

A binary built this way knows it is compiled, so `cairn init` points your
agents at it directly. Its `--version` reads `0.0.0-dev (source …)` unless
you first stamp `src/build-info.ts` the way `.github/workflows/release.yml`
does; don't commit the stamped file.

`web-tree-sitter` in `package.json` is not imported by `src/`: it is a peer
dependency of `@opentui/core` (the review screen's markdown highlighting),
pinned to the exact version OpenTUI asks for. Keep it in step with OpenTUI
rather than removing it.

`bun run scrub` runs gitleaks over the tree. `scripts/scrub-check.ts` also
takes extra patterns to refuse, one regular expression per line, with
`--patterns <file>` or the `SCRUB_PATTERNS` variable.

## Pull requests

- One change per pull request.
- If you change `src/`, describe it for someone installing the binary under
  `## [Unreleased]` in `CHANGELOG.md`. Maintainers pick release versions;
  don't edit `package.json`'s version.
- A change to `src/` that ships nothing a user would notice (a refactor, a
  comment) can skip the changelog with the `no-release` label. Contributors
  from a fork cannot set labels: say so in the description and a maintainer
  will add it.
- Changing anything in `packages/protocol` changes the contract with hosted
  team spaces. Say so in the description; it needs a maintainer's review.

## Refresh a pinned action

Workflows pin every action to a full commit SHA, with its version tag in a
comment: `uses: owner/action@<sha> # vX.Y.Z`. A tag can be moved; a commit
cannot. To move a pin to a newer release:

    gh api repos/<owner>/<action>/git/ref/tags/<vX.Y.Z> --jq .object

If `type` is `commit`, `sha` is the pin. If it is `tag`, the tag is annotated
and that `sha` is the tag object, not the commit — dereference it until you
reach a commit:

    gh api repos/<owner>/<action>/git/tags/<sha> --jq .object

Update the SHA and the `# vX.Y.Z` comment together, and commit with
`git commit -s` like any other change.

Dependabot is not enabled: its commits carry no sign-off, so its pull requests
cannot pass the DCO check.
