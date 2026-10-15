/**
 * A line-by-line pattern scan over a source tree, plus gitleaks.
 *
 *   bun scripts/scrub-check.ts <root> [--patterns <file>] [--gitleaks]
 *
 * The scan carries no patterns of its own: they come from a file, given by
 * `--patterns <file>` or the SCRUB_PATTERNS environment variable. One
 * JavaScript regular expression per line, written either bare (`foo\d+`) or
 * with flags (`/foo\d+/i`). Blank lines and lines starting with `#` are
 * ignored. With no pattern file, only gitleaks runs.
 *
 * Fails closed: an unknown flag (including `--patterns=<file>`) exits 2, and a
 * pattern file holding no patterns is an error. Either would otherwise run
 * with fewer patterns than asked for and report clean.
 *
 * A line containing `scrub-allow` is skipped — visible in review, which is
 * the point.
 */
import { readdirSync, readFileSync } from "node:fs"
import { extname, join, relative } from "node:path"

export interface Finding { file: string; line: number; rule: string; text: string }
export interface Rule { name: string; re: RegExp }

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"])
const BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".wasm"])

/** Parses a pattern file's text. The rule's name is the line as written. */
export function parsePatterns(text: string): Rule[] {
  const rules: Rule[] = []
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) return
    const literal = line.match(/^\/(.*)\/([a-z]*)$/)
    try {
      const re = literal ? new RegExp(literal[1]!, literal[2]) : new RegExp(line)
      rules.push({ name: line, re })
    } catch (e) {
      // A pattern that does not compile must fail loudly: skipping it would
      // report clean for exactly the leak it was written to catch.
      throw new Error(`pattern on line ${i + 1} is not a valid regular expression: ${(e as Error).message}`)
    }
  })
  return rules
}

/** Reads a pattern file. One with no patterns is an error, never a pass. */
export function loadPatterns(path: string): Rule[] {
  const rules = parsePatterns(readFileSync(path, "utf-8"))
  if (rules.length === 0) throw new Error(`${path} holds no patterns`)
  return rules
}

export interface Args { root: string; patternFile?: string; gitleaks: boolean }

/** Null for anything it does not understand, so the caller can refuse. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): Args | null {
  let root: string | undefined
  let patternFile = env.SCRUB_PATTERNS || undefined
  let gitleaks = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--patterns") {
      const next = argv[++i]
      if (next === undefined || next.startsWith("--")) return null
      patternFile = next
    } else if (a === "--gitleaks") gitleaks = true
    else if (a.startsWith("-")) return null
    else if (root === undefined) root = a
    else return null
  }
  return root === undefined ? null : { root, patternFile, gitleaks }
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name)) }
    else if (!BINARY.has(extname(e.name).toLowerCase())) yield join(dir, e.name)
  }
}

export function scan(root: string, rules: readonly Rule[]): Finding[] {
  const out: Finding[] = []
  for (const path of walk(root)) {
    const lines = readFileSync(path, "utf-8").split("\n")
    lines.forEach((text, i) => {
      if (text.includes("scrub-allow")) return
      for (const { name, re } of rules) {
        if (re.test(text)) out.push({ file: relative(root, path), line: i + 1, rule: name, text: text.trim() })
      }
    })
  }
  return out
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2), process.env)
  if (!args) {
    console.error("usage: scrub-check <root> [--patterns <file>] [--gitleaks]")
    process.exit(2)
  }
  const { root, patternFile } = args
  let rules: Rule[] = []
  if (patternFile) {
    try {
      rules = loadPatterns(patternFile)
    } catch (e) {
      console.error(`scrub-check: ${(e as Error).message}`)
      process.exit(2)
    }
  }
  const findings = scan(root, rules)
  for (const f of findings) console.log(`${f.file}:${f.line}: [${f.rule}] ${f.text}`)
  let failed = findings.length > 0
  if (args.gitleaks) {
    // Asked for and absent is a failure, not a skip: a missing scanner
    // reporting nothing is exactly the clean result this gate must not trust.
    const proc = Bun.spawnSync(["gitleaks", "dir", root, "--no-banner", "--redact", "--exit-code", "1"], { stdout: "inherit", stderr: "inherit" })
    if (proc.exitCode !== 0) failed = true
  }
  console.log(`scrub-check: ${rules.length} patterns${patternFile ? ` from ${patternFile}` : ""}`)
  console.log(failed ? `scrub-check: FAILED (${findings.length} findings)` : "scrub-check: clean")
  process.exit(failed ? 1 : 0)
}
