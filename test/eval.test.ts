import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answerable, normalise } from "../scripts/eval/answerable"
import { loadQuestions } from "../scripts/eval/questions"
import { runEval } from "../scripts/eval"
import { STRATEGIES } from "../scripts/eval/strategies"

const EVAL = join(import.meta.dir, "eval")
const CORPUS = join(EVAL, "corpus")
const QUESTIONS = join(EVAL, "questions.yaml")

const temps: string[] = []
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "eval",
      GIT_AUTHOR_EMAIL: "eval@example.com",
      GIT_COMMITTER_NAME: "eval",
      GIT_COMMITTER_EMAIL: "eval@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

test("answerable normalises case, whitespace and emphasis", () => {
  expect(answerable("Deploys run **on Fridays**\n never", ["deploys run on fridays"])).toBe(true)
  expect(answerable("Deploys run **on Fridays**\n never", ["a", "missing"])).toBe(false)
  expect(answerable("set `deploy_window` to _two_", ["deploywindow to two"])).toBe(true)
})

test("a multi-hop question needs every fact", () => {
  const context = "The pager rotates on Mondays.\n\nTokens expire after 15 minutes."
  expect(answerable(context, ["rotates on mondays", "expire after 15 minutes"])).toBe(true)
  expect(answerable(context, ["rotates on mondays", "expire after 30 minutes"])).toBe(false)
  expect(answerable(context, ["expire after 15 minutes"])).toBe(true)
})

test("refuses a set whose corpus_commit is not the corpus HEAD", async () => {
  const repo = await temp("cairn-eval-repo-")
  git(repo, "init", "-q")
  await writeFile(join(repo, "deploys.md"), "# Deploys\n\nDeploys run on Tuesdays after the standup.\n")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "first")
  const first = git(repo, "rev-parse", "HEAD")
  await writeFile(join(repo, "deploys.md"), "# Deploys\n\nDeploys run on Thursdays now.\n")
  git(repo, "commit", "-q", "-am", "second")
  const second = git(repo, "rev-parse", "HEAD")

  const dir = await temp("cairn-eval-set-")
  const questions = join(dir, "q.yaml")
  await writeFile(
    questions,
    [
      `corpus_commit: ${first}`,
      "questions:",
      "  - id: day",
      "    question: which day do deploys run?",
      "    facts: [run on tuesdays]",
      "    hop: 1",
      "    held_out: false",
      "",
    ].join("\n"),
  )

  const refused = runEval({ questions, corpus: [repo], strategies: ["doc-bm25"] })
  await expect(refused).rejects.toThrow(first)
  await expect(runEval({ questions, corpus: [repo], strategies: ["doc-bm25"] })).rejects.toThrow(second)

  // Pinned to the first commit, it reads the corpus as it was then — the
  // answer is Tuesday, which HEAD no longer says.
  const report = await runEval({ questions, corpus: [repo], strategies: ["doc-bm25"], corpusAt: first })
  expect(report["doc-bm25"]!.answerable).toBe(1)
})

/** A repo whose corpus sits in two subdirectories, `a/` and `b/c/`, with a
 *  first commit the set is pinned to and a second that changes both answers. */
async function pinnedSubdirRepo(): Promise<{ repo: string; first: string; second: string; questions: string }> {
  const repo = await temp("cairn-eval-sub-")
  git(repo, "init", "-q")
  await mkdir(join(repo, "a"))
  await mkdir(join(repo, "b", "c"), { recursive: true })
  await writeFile(join(repo, "a", "deploys.md"), "# Deploys\n\nDeploys run on Tuesdays after the standup.\n")
  await writeFile(join(repo, "b", "c", "pager.md"), "# Pager\n\nThe pager rotates on Mondays.\n")
  await writeFile(join(repo, "outside.md"), "# Outside\n\nNot part of either corpus.\n")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "first")
  const first = git(repo, "rev-parse", "HEAD")
  await writeFile(join(repo, "a", "deploys.md"), "# Deploys\n\nDeploys run on Thursdays now.\n")
  await writeFile(join(repo, "b", "c", "pager.md"), "# Pager\n\nThe pager rotates on Fridays.\n")
  git(repo, "commit", "-q", "-am", "second")
  const second = git(repo, "rev-parse", "HEAD")
  const questions = join(await temp("cairn-eval-set-"), "q.yaml")
  await writeFile(
    questions,
    [
      `corpus_commit: ${first}`,
      "questions:",
      "  - id: day",
      "    question: which day do deploys run?",
      "    facts: [run on tuesdays]",
      "    hop: 1",
      "    held_out: false",
      "  - id: pager",
      "    question: when does the pager rotate?",
      "    facts: [rotates on mondays]",
      "    hop: 1",
      "    held_out: false",
      "",
    ].join("\n"),
  )
  return { repo, first, second, questions }
}

test("a pinned corpus is read at the pinned commit from subdirectories of its repository", async () => {
  const { repo, first, second, questions } = await pinnedSubdirRepo()
  const corpus = [join(repo, "a"), join(repo, "b", "c")]
  await expect(runEval({ questions, corpus, strategies: ["doc-bm25"] })).rejects.toThrow(second)
  // Both answers are only true at the first commit, so both being found means
  // both subdirectories were read as they were then.
  const report = await runEval({ questions, corpus, strategies: ["doc-bm25"], corpusAt: first })
  expect(report["doc-bm25"]!.answerable).toBe(2)
})

test("a pinned corpus with uncommitted changes is refused, naming the directory", async () => {
  const { repo, first, questions } = await pinnedSubdirRepo()
  git(repo, "checkout", "-q", first)
  const corpus = [join(repo, "a"), join(repo, "b", "c")]
  // Clean at the pinned commit: it runs.
  expect((await runEval({ questions, corpus, strategies: ["doc-bm25"] }))["doc-bm25"]!.answerable).toBe(2)
  // An edit outside the corpus directories does not matter.
  await writeFile(join(repo, "outside.md"), "# Outside\n\nEdited.\n")
  expect((await runEval({ questions, corpus, strategies: ["doc-bm25"] }))["doc-bm25"]!.answerable).toBe(2)
  // An untracked file inside one does.
  await writeFile(join(repo, "b", "c", "extra.md"), "# Extra\n\nNot committed.\n")
  await expect(runEval({ questions, corpus, strategies: ["doc-bm25"] })).rejects.toThrow(
    `${join(repo, "b", "c")} has uncommitted changes`,
  )
  // --corpus-at reads the commit, not the working tree, so it still runs.
  const report = await runEval({ questions, corpus, strategies: ["doc-bm25"], corpusAt: first })
  expect(report["doc-bm25"]!.answerable).toBe(2)
})

test("--team refuses a space whose slug does not name it an eval space", async () => {
  const root = await temp("cairn-eval-root-")
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      installId: "x",
      telemetry: false,
      mode: "team",
      auth: { token: "t", orgId: "o", orgSlug: "acme", apiUrl: "http://127.0.0.1:9", user: null },
    }),
  )
  await expect(
    runEval({ questions: QUESTIONS, corpus: [CORPUS], strategies: ["doc-bm25"], team: true, root }),
  ).rejects.toThrow(/acme/)
})

test("the public set is well formed and every fact is in the corpus", async () => {
  const set = loadQuestions(QUESTIONS)
  expect(set.corpus_commit).toBeNull()
  expect(set.questions).toHaveLength(30)
  expect(set.questions.every((q) => !q.held_out)).toBe(true)
  expect(set.questions.filter((q) => q.hop === 2).length).toBeGreaterThanOrEqual(10)
  expect(new Set(set.questions.map((q) => q.id)).size).toBe(30)

  const files = (await readdir(CORPUS)).filter((f) => f.endsWith(".md"))
  expect(files.length).toBe(15)
  const docs = await Promise.all(files.map(async (f) => normalise(await readFile(join(CORPUS, f), "utf-8"))))
  const missing: string[] = []
  for (const q of set.questions) {
    const holders = q.facts.map((f) => docs.filter((d) => d.includes(normalise(f))).length)
    holders.forEach((n, i) => n === 0 && missing.push(`${q.id}: ${q.facts[i]}`))
    // Two hops means two documents: no single document holds every fact.
    if (q.hop === 2) {
      const together = docs.some((d) => q.facts.every((f) => d.includes(normalise(f))))
      if (together) missing.push(`${q.id}: all facts in one document`)
    }
  }
  expect(missing).toEqual([])
})

test('the "Cutting a version" section shares no word with "how do we ship"', async () => {
  const files = (await readdir(CORPUS)).filter((f) => f.endsWith(".md"))
  const holders: string[] = []
  for (const f of files) {
    const text = await readFile(join(CORPUS, f), "utf-8")
    if (!/^#+ Cutting a version$/m.test(text)) continue
    holders.push(f)
    const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/))
    expect(["how", "do", "we", "ship"].filter((w) => words.has(w))).toEqual([])
  }
  expect(holders).toHaveLength(1)
})

test("the public set does not fall below the baseline", async () => {
  const baseline = JSON.parse(await readFile(join(EVAL, "baseline.json"), "utf-8")) as Record<
    string,
    { answerable: number }
  >
  const strategies = Object.keys(baseline)
  // Every strategy is gated: one added without a baseline entry fails here.
  expect(Object.keys(STRATEGIES).filter((s) => !(s in baseline))).toEqual([])
  const report = await runEval({ questions: QUESTIONS, corpus: [CORPUS], strategies })
  for (const s of strategies) expect(report[s]!.answerable).toBeGreaterThanOrEqual(baseline[s]!.answerable)
})

test("an unknown strategy is named, not skipped", async () => {
  const dir = await temp("cairn-eval-empty-")
  await mkdir(join(dir, "c"))
  await expect(runEval({ questions: QUESTIONS, corpus: [join(dir, "c")], strategies: ["nope"] })).rejects.toThrow(
    /nope/,
  )
})

test("the tokenizer stays out of the binary: nothing under src/ imports js-tiktoken", async () => {
  const src = join(import.meta.dir, "..", "src")
  const importers: string[] = []
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: src })) {
    if ((await readFile(join(src, path), "utf-8")).includes("js-tiktoken")) importers.push(path)
  }
  expect(importers).toEqual([])
})
