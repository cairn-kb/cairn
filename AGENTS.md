# cairn — notes for coding agents

## Commands

    bun install
    bun test
    bunx tsc --noEmit
    bun run scrub          # needs gitleaks installed
    bun src/cli.ts <command>   # run the CLI from source

Bun 1.3.6 is what CI runs.

## Layout

- `src/` — the CLI, with `cli.ts` as its entry point.
- `packages/protocol` — the wire contract with hosted team spaces: no
  dependencies, no `node:` imports, enforced by `test/protocol-boundary.test.ts`.
- `test/` — the test suite.
- `install.sh` — POSIX sh, shellchecked.

## Rules

- Sign off every commit: `git commit -s`.
- If you change `src/`, describe it for someone installing the binary under
  `## [Unreleased]` in `CHANGELOG.md`. Maintainers pick release versions;
  don't edit `package.json`'s version.
- `packages/protocol` takes no `node:` builtins — it has to run wherever the
  hosted side does too.
- `scrub-check` must stay clean. Reach for `scrub-allow` only alongside a
  reason, on the line it excuses.
