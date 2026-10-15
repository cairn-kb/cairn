/**
 * A terminal width for a spawned CLI, which otherwise has none.
 *
 * `cairn init` writes into `$HOME` and reads `CAIRN_ROOT` at import time, so
 * the suite can only drive it as a child process — and a child process with a
 * piped stdout has `process.stdout.columns === undefined`, which is exactly the
 * condition the wordmark's width guard refuses on. Preloaded with
 * `bun --preload`, this pins a width before `src/cli.ts` runs, so the drawn
 * case is reachable without a pseudo-terminal.
 */
;(process.stdout as { columns?: number }).columns = 100
