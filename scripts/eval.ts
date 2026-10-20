#!/usr/bin/env bun
/**
 * Retrieval evaluation: can the context a strategy gives an agent answer a
 * fixed question set, and how many tokens does reading it cost?
 *
 * Usage:
 *   bun run eval -- --questions test/eval/questions.yaml --corpus test/eval/corpus \
 *     [--corpus <dir>…] [--strategy a,b] [--split all|tuning|held-out] \
 *     [--corpus-at <sha>] [--team] [--out <file>]
 *
 * Every `--corpus` directory is imported the way `cairn import` imports one,
 * into a fresh local store that is thrown away afterwards — or, with
 * `--team`, into the signed-in team space, which must be one whose slug
 * contains "eval". A script rather than a subcommand, so the tokenizer it
 * counts with never enters the binary.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Store } from "@cairn-kb/protocol/types"
import { runImport } from "../src/cli"
import { readConfig } from "../src/config"
import { EventLog, type EventSink } from "../src/events"
import { HttpEventSink, HttpStore } from "../src/http-store"
import { FileStore } from "../src/store"
import { loadQuestions, type Question } from "./eval/questions"
import { formatTable, score, type Report } from "./eval/report"
import { STRATEGIES, type EvalEnv } from "./eval/strategies"

export type { Report, StrategyResult } from "./eval/report"

export type Split = "all" | "tuning" | "held-out"

export interface EvalOptions {
  questions: string
  corpus: string[]
  strategies: string[]
  /** Read every corpus directory as it was at this commit, rather than as
   *  it is checked out. */
  corpusAt?: string
  /** Import into the signed-in team space instead of a fresh local store. */
  team?: boolean
  split?: Split
  /** Where `--team` reads the sign-in from; defaults to the CLI's own. */
  root?: string
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd })
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() }
}

/** The full sha `rev` names in `dir`'s repository, or `rev` itself when the
 *  repository does not know it — still worth naming in a refusal. */
function resolveCommit(dir: string, rev: string): string {
  const r = git(dir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])
  return r.ok ? r.out : rev
}

/**
 * A set written against one commit of its corpus is only meaningful against
 * that commit: its facts are literal substrings, and an edit since can make a
 * question unanswerable without any retrieval change. So a pinned set refuses
 * a corpus at any other commit — naming both — unless `corpusAt` asks for the
 * corpus as it was at the pinned one.
 */
function checkCorpusCommit(dirs: string[], pinned: string | null, corpusAt: string | undefined): void {
  if (pinned === null && corpusAt === undefined) return
  for (const dir of dirs) {
    const head = git(dir, ["rev-parse", "HEAD"])
    if (!head.ok) throw new Error(`${dir} is not in a git repository, so its commit cannot be checked: ${head.err}`)
    if (pinned === null) continue
    const want = resolveCommit(dir, pinned)
    const have = corpusAt === undefined ? head.out : resolveCommit(dir, corpusAt)
    if (want !== have) {
      throw new Error(
        `the question set is pinned to corpus commit ${want}, but ${dir} is at ${have}` +
          ` — check out ${want}, or pass --corpus-at ${want}`,
      )
    }
  }
}

/** `dir` as it was at `rev`, extracted into `into`. */
async function corpusAtCommit(dir: string, rev: string, into: string): Promise<string> {
  const prefix = git(dir, ["rev-parse", "--show-prefix"]).out
  const out = join(into, "tree")
  await mkdir(out, { recursive: true })
  const tar = join(into, "corpus.tar")
  const archived = git(dir, ["archive", "--format=tar", "-o", tar, `${rev}:${prefix}`])
  if (!archived.ok) throw new Error(`cannot read ${dir} at ${rev}: ${archived.err}`)
  await Bun.$`tar -xf ${tar} -C ${out}`.quiet()
  return out
}

/** Two corpus directories holding the same relative path would import as one
 *  document — `cairn import` matches a re-import on that path — and the
 *  second would silently replace the first. */
async function refuseCollisions(dirs: string[]): Promise<void> {
  const owner = new Map<string, string>()
  for (const dir of dirs) {
    for await (const path of new Bun.Glob("**/*.md").scan({ cwd: dir })) {
      const other = owner.get(path)
      if (other !== undefined) throw new Error(`${other} and ${dir} both hold ${path}; give one corpus a subdirectory`)
      owner.set(path, dir)
    }
  }
}

async function openTeam(root: string): Promise<{ store: Store; log: EventSink }> {
  const auth = (await readConfig(root))?.auth
  if (!auth) throw new Error("--team imports into the signed-in team space, and none is signed in: run `cairn login`")
  if (!auth.orgSlug.includes("eval")) {
    throw new Error(
      `--team imports the corpus into the signed-in space, "${auth.orgSlug}", and only a space whose slug` +
        ` contains "eval" may take it — sign in to an eval space with \`cairn org use\``,
    )
  }
  const conn = { baseUrl: auth.apiUrl, token: auth.token, orgId: auth.orgId }
  return { store: new HttpStore(conn), log: new HttpEventSink(conn) }
}

function inSplit(q: Question, split: Split): boolean {
  if (split === "tuning") return !q.held_out
  if (split === "held-out") return q.held_out
  return true
}

export async function runEval(opts: EvalOptions): Promise<Report> {
  const set = loadQuestions(opts.questions)
  const questions = set.questions.filter((q) => inSplit(q, opts.split ?? "all"))
  const unknown = opts.strategies.filter((s) => !(s in STRATEGIES))
  if (unknown.length > 0) {
    throw new Error(`unknown strategy: ${unknown.join(", ")} (known: ${Object.keys(STRATEGIES).join(", ")})`)
  }
  if (opts.corpus.length === 0) throw new Error("no corpus: pass --corpus <dir> at least once")
  const dirs = opts.corpus.map((d) => resolve(d))
  checkCorpusCommit(dirs, set.corpus_commit, opts.corpusAt)

  const scratch = await mkdtemp(join(tmpdir(), "cairn-eval-"))
  try {
    let corpora = dirs
    if (opts.corpusAt !== undefined) {
      const at = opts.corpusAt
      corpora = await Promise.all(dirs.map((d, i) => corpusAtCommit(d, at, join(scratch, `at-${i}`))))
    }
    await refuseCollisions(corpora)

    let store: Store
    let log: EventSink
    if (opts.team) {
      ;({ store, log } = await openTeam(
        opts.root ?? process.env.CAIRN_ROOT ?? join(process.env.HOME ?? ".", ".cairn"),
      ))
    } else {
      const root = join(scratch, "store")
      log = new EventLog(root)
      const local = new FileStore(root, log)
      await local.init()
      store = local
    }
    for (const dir of corpora) await runImport(store, dir)

    const memos = new Map<string, Promise<unknown>>()
    const env: EvalEnv = {
      store,
      log,
      memo<T>(key: string, build: () => Promise<T>): Promise<T> {
        if (!memos.has(key)) memos.set(key, build())
        return memos.get(key) as Promise<T>
      },
    }
    const report: Report = {}
    for (const id of opts.strategies) report[id] = await score(STRATEGIES[id]!, questions, env)
    return report
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const USAGE =
  "usage: bun scripts/eval.ts --questions <file> --corpus <dir> [--corpus <dir>…] [--strategy a,b]" +
  " [--split all|tuning|held-out] [--corpus-at <sha>] [--team] [--out <file>]"

function parseArgs(argv: string[]): EvalOptions & { out?: string } {
  const opts: EvalOptions & { out?: string } = { questions: "", corpus: [], strategies: Object.keys(STRATEGIES) }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`)
      return v
    }
    if (flag === "--questions") opts.questions = value()
    else if (flag === "--corpus") opts.corpus.push(value())
    else if (flag === "--strategy") opts.strategies = value().split(",").filter((s) => s !== "")
    else if (flag === "--corpus-at") opts.corpusAt = value()
    else if (flag === "--out") opts.out = value()
    else if (flag === "--team") opts.team = true
    else if (flag === "--split") {
      const v = value()
      if (v !== "all" && v !== "tuning" && v !== "held-out") throw new Error(`--split takes all, tuning or held-out\n${USAGE}`)
      opts.split = v
    } else throw new Error(`unknown argument: ${flag}\n${USAGE}`)
  }
  if (opts.questions === "" || opts.corpus.length === 0) throw new Error(USAGE)
  return opts
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    const report = await runEval(opts)
    const questions = loadQuestions(opts.questions).questions.filter((q) => inSplit(q, opts.split ?? "all"))
    console.log(formatTable(report, questions))
    if (opts.out) await Bun.write(opts.out, JSON.stringify(report, null, 2) + "\n")
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
