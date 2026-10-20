import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newConfig, writeConfig } from "../src/config"
import { EventLog } from "../src/events"
import { CairnHttpError, HttpStore } from "../src/http-store"
import {
  editClaim,
  renderAbstract,
  renderClaim,
  resolveEditor,
  runCurate,
  runReview,
  type CurateAnswer,
  type Decision,
} from "../src/review-tui"
import { statsFromEvents } from "@cairn-kb/protocol/stats"
import { WORDMARK_COLUMNS, wordmark } from "../src/wordmark"
import { FileStore } from "../src/store"
import type { Claim, Store } from "@cairn-kb/protocol/types"
import { proposal, sample } from "./store-contract"

/**
 * A double that implements the real seam rather than being cast past it.
 * Every method the review loop has no business calling throws with its own
 * name, so a test that starts calling one fails loudly instead of returning
 * an `undefined` the assertions then quietly agree with.
 */
function unsupported(name: string): never {
  throw new Error(`the review loop must not call Store.${name}`)
}

function fakeStore(over: Partial<Store>): Store {
  return {
    list: async () => unsupported("list"),
    get: async () => unsupported("get"),
    put: async () => unsupported("put"),
    move: async () => unsupported("move"),
    search: async () => unsupported("search"),
    propose: async () => unsupported("propose"),
    review: async () => unsupported("review"),
    retract: async () => unsupported("retract"),
    cite: async () => unsupported("cite"),
    uncite: async () => unsupported("uncite"),
    importClaim: async () => unsupported("importClaim"),
    stats: async () => unsupported("stats"),
    listDocuments: async () => unsupported("listDocuments"),
    getDocument: async () => unsupported("getDocument"),
    searchDocuments: async () => unsupported("searchDocuments"),
    searchPassages: async () => unsupported("searchPassages"),
    importDocument: async () => unsupported("importDocument"),
    adoptImport: async () => unsupported("adoptImport"),
    ...over,
  }
}

/** Answers the same decision every time, which is all any of these need. */
const always = (decision: Decision) => async () => decision

const noEdit = async (): Promise<{ claim: string; body: string; abstract: string }> =>
  unsupported("edit — this test never chooses it")

// --- renderClaim ----------------------------------------------------------

test("a claim renders its sentence, body, abstract and overlaps", () => {
  const out = renderClaim(
    {
      ...sample("c1", "bun test does not typecheck"),
      abstract: "Settles X.",
      abstractBy: "generated",
      overlaps: ["c9"],
    },
    1,
    7,
    new Map([["c9", sample("c9", "the one it overlaps")]]),
  )
  expect(out).toContain("1 of 7")
  expect(out).toContain("bun test does not typecheck")
  expect(out).toContain("Settles X.")
  expect(out).toContain("generated")
  // Named, not counted, and with the status it has NOW. This used
  // to read `overlaps with 1 approved claim(s)` — a label the renderer cannot
  // check, since `findOverlaps` computes the list against approved claims at
  // write time and an id stays put when its claim is retracted afterwards.
  expect(out).toContain("overlaps")
  expect(out).toContain("the one it overlaps")
  expect(out).toContain("c9")
  expect(out).not.toContain("approved claim(s)")
})

test("the rendered claim names who proposed it and where", () => {
  const out = renderClaim({ ...sample("c1", "one"), source: { author: "r", agent: "cursor", repo: "cairn", session: null } }, 2, 3, new Map())
  expect(out).toContain("cursor")
  expect(out).toContain("cairn")
})

test("a claim that is no longer pending renders its actual status", () => {
  // This is the only way a resolved claim reaches the renderer: another
  // reviewer got there first, and the whole point of showing it again is the
  // status, so guessing "pending" would be the lie the re-render exists to
  // avoid.
  const out = renderClaim({ ...sample("c1", "one"), status: "approved" }, 1, 1, new Map())
  expect(out).toContain("approved")
  expect(out).not.toContain("1 of 1 pending")
})

test("plain rendering emits no escape sequences", () => {
  // renderClaim returns a string precisely so it can be asserted on; a
  // caller that wants colour hands its own Ui in.
  expect(renderClaim(sample("c1", "one"), 1, 1, new Map())).not.toContain("\x1b")
})

// --- editClaim ------------------------------------------------------------

test("editing round-trips a multi-line body through the editor", async () => {
  const edited = await editClaim(
    { ...sample("c1", "one"), body: "short" },
    "stub-editor",
    async (_cmd, file) => {
      const current = await Bun.file(file).text()
      expect(current).toContain("one")
      await Bun.write(file, current.replace("short", "line one\nline two"))
      return 0
    },
  )
  expect(edited.body).toBe("line one\nline two")
  expect(edited.claim).toBe("one")
})

test("the temp file is removed once the editor is done", async () => {
  let path = ""
  await editClaim(sample("c1", "one"), "stub-editor", async (_cmd, file) => {
    path = file
    return 0
  })
  expect(path).not.toBe("")
  expect(existsSync(path)).toBe(false)
})

test("an editor that exits non-zero leaves the claim untouched", async () => {
  let path = ""
  const attempt = editClaim(sample("c1", "one"), "stub-editor", async (_cmd, file) => {
    path = file
    return 1
  })
  await expect(attempt).rejects.toThrow("stub-editor")
  await attempt.catch(() => {})
  expect(existsSync(path)).toBe(false)
})

test("blanking the claim sentence is refused rather than saved", async () => {
  // A saved-but-empty claim is worse than no edit: it destroys the sentence
  // the whole record is, and does it under the word "approved".
  await expect(
    editClaim(sample("c1", "one"), "stub-editor", async (_cmd, file) => {
      await Bun.write(file, (await Bun.file(file).text()).replace("\none\n", "\n\n"))
      return 0
    }),
  ).rejects.toThrow("empty")
})

test("blanking the body is refused here, where the message can name it", async () => {
  // The hosted store refuses an empty body with "cairn could not read that request — one of the values
  // sent was empty or malformed", which does not say WHICH value; FileStore
  // accepts it outright. So the two stores disagreed, and the reviewer who
  // deleted the body in $EDITOR was told nothing they could act on.
  const attempt = editClaim(
    { ...sample("c1", "one"), body: "detail" },
    "stub-editor",
    async (_cmd, file) => {
      await Bun.write(file, (await Bun.file(file).text()).replace("\ndetail\n", "\n\n"))
      return 0
    },
  )
  await expect(attempt).rejects.toThrow(/body/)
  await expect(attempt).rejects.toThrow(/empty/)
})

test("an unchanged file round-trips to exactly what went in", async () => {
  const claim = { ...sample("c1", "one"), body: "a\n\nb", abstract: "Settles X." }
  const edited = await editClaim(claim, "stub-editor", async () => 0)
  expect(edited).toEqual({ claim: "one", body: "a\n\nb", abstract: "Settles X." })
})

// --- runReview ------------------------------------------------------------

test("skip leaves the claim pending and is counted", async () => {
  const reviewed: string[] = []
  const summary = await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one"), sample("c2", "two")],
      review: async (id) => {
        reviewed.push(id)
        return sample(id, "x")
      },
    }),
    ask: always("skip"),
    edit: noEdit,
    out: () => {},
  })
  expect(reviewed).toEqual([])
  expect(summary.skipped).toBe(2)
})

test("the closing lines name every claim left pending", async () => {
  // A skip that vanished silently would flatter the one number this tool
  // exists to measure.
  const lines: string[] = []
  await runReview({
    store: fakeStore({ list: async () => [sample("c1", "one"), sample("c2", "two")] }),
    ask: always("skip"),
    edit: noEdit,
    out: (l) => lines.push(l),
  })
  const text = lines.join("\n")
  expect(text).toContain("one")
  expect(text).toContain("two")
})

test("an edit decision records the edit kind, not approve", async () => {
  const calls: { id: string; decision: string }[] = []
  const summary = await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one")],
      review: async (id, decision) => {
        calls.push({ id, decision })
        return sample(id, "x")
      },
    }),
    ask: always("edit"),
    edit: async () => ({ claim: "improved", body: "b", abstract: "a" }),
    out: () => {},
  })
  // An edit-then-approve IS an approval, but it stays distinguishable in stats.
  expect(calls).toEqual([{ id: "c1", decision: "edit" }])
  expect(summary.edited).toBe(1)
  expect(summary.approved).toBe(0)
})

test("approve and reject are tallied separately", async () => {
  const decisions: Decision[] = ["approve", "reject"]
  const summary = await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one"), sample("c2", "two")],
      review: async (id) => sample(id, "x"),
    }),
    ask: async (_c, i) => decisions[i - 1]!,
    edit: noEdit,
    out: () => {},
  })
  expect(summary).toEqual({ approved: 1, rejected: 1, edited: 0, skipped: 0 })
})

test("quit stops the queue without reviewing what is left", async () => {
  const reviewed: string[] = []
  const summary = await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one"), sample("c2", "two"), sample("c3", "three")],
      review: async (id) => {
        reviewed.push(id)
        return sample(id, "x")
      },
    }),
    ask: async (_c, i) => (i === 1 ? "approve" : "quit"),
    edit: noEdit,
    out: () => {},
  })
  expect(reviewed).toEqual(["c1"])
  expect(summary.approved).toBe(1)
})

test("an editor that refuses records nothing and leaves the claim pending", async () => {
  const reviewed: string[] = []
  const lines: string[] = []
  const summary = await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one")],
      review: async (id) => {
        reviewed.push(id)
        return sample(id, "x")
      },
    }),
    ask: always("edit"),
    edit: async () => {
      throw new Error("the claim sentence came back empty")
    },
    out: (l) => lines.push(l),
  })
  expect(reviewed).toEqual([])
  expect(summary.edited).toBe(0)
  expect(summary.skipped).toBe(1)
  expect(lines.join("\n")).toContain("came back empty")
})

test("an editor that changes nothing records nothing", async () => {
  // Recording an `edit` here would report a human improvement that did not
  // happen, and `edited` is a reported figure.
  const reviewed: string[] = []
  const claim = { ...sample("c1", "one"), body: "detail", abstract: null }
  const summary = await runReview({
    store: fakeStore({
      list: async () => [claim],
      review: async (id) => {
        reviewed.push(id)
        return sample(id, "x")
      },
    }),
    ask: always("edit"),
    edit: async () => ({ claim: "one", body: "detail", abstract: "" }),
    out: () => {},
  })
  expect(reviewed).toEqual([])
  expect(summary.edited).toBe(0)
  expect(summary.skipped).toBe(1)
})

test("an editor that only strips whitespace is not counted as an edit", async () => {
  // editClaim returns each section trimmed, so an untouched file comes back
  // trimmed. Treating that as a human improvement would inflate `edited`.
  const reviewed: string[] = []
  const summary = await runReview({
    store: fakeStore({
      list: async () => [{ ...sample("c1", "one"), body: "detail\n\n" }],
      review: async (id) => {
        reviewed.push(id)
        return sample(id, "x")
      },
    }),
    ask: always("edit"),
    edit: async () => ({ claim: "one", body: "detail", abstract: "" }),
    out: () => {},
  })
  expect(reviewed).toEqual([])
  expect(summary.edited).toBe(0)
})

test("a claim that is gone is reported and counted as neither approved nor rejected", async () => {
  const lines: string[] = []
  const summary = await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one")],
      review: async () => null,
    }),
    ask: always("approve"),
    edit: noEdit,
    out: (l) => lines.push(l),
  })
  expect(summary.approved).toBe(0)
  expect(summary.skipped).toBe(1)
  expect(lines.join("\n")).toContain("cairn status")
})

test("a conflict re-renders the claim with the status it actually has", async () => {
  // Thrown as the hosted store really throws it, so the loop is held to the
  // real error rather than to a shape invented for the test.
  const conflict = new CairnHttpError(409, "conflict", "someone else already reviewed this claim")
  const resolved: Claim = { ...sample("c1", "one"), status: "rejected", reviewer: "someone" }
  const lines: string[] = []
  const summary = await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one")],
      review: async () => {
        throw conflict
      },
      get: async () => resolved,
    }),
    ask: always("approve"),
    edit: noEdit,
    out: (l) => lines.push(l),
  })
  const text = lines.join("\n")
  expect(text).toContain("someone else already reviewed this claim")
  expect(text).toContain("rejected")
  expect(summary.approved).toBe(0)
  expect(summary.skipped).toBe(1)
})

test("the conflict re-render names each overlap with the status it has now", async () => {
  // The conflict re-render path is the one that made it worth fixing. It exists to
  // show a reviewer what the claim says NOW, after someone else got there
  // first — so a line asserting every overlap is "approved" is wrong in
  // exactly the place a reviewer is most entitled to trust the screen.
  //
  // `findOverlaps` computes `overlaps` against `store.list("approved")` at
  // write time. `c-gone` below was approved then and is retracted now, which
  // is the whole scenario and is not hypothetical.
  const conflict = new CairnHttpError(409, "conflict", "someone else already reviewed this claim")
  const resolved: Claim = {
    ...sample("c1", "one"),
    status: "rejected",
    reviewer: "someone",
    overlaps: ["c-stands", "c-gone", "c-missing"],
  }
  const others: Record<string, Claim> = {
    c1: resolved,
    "c-stands": { ...sample("c-stands", "the one that still stands"), status: "approved" },
    "c-gone": { ...sample("c-gone", "the one that was taken back"), status: "retracted" },
  }
  const lines: string[] = []
  await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one")],
      review: async () => {
        throw conflict
      },
      // Keyed by id, unlike the conflict test above: the renderer now asks the
      // store for each overlap, and a `get` that answered with the same claim
      // every time would make this pass without resolving anything.
      get: async (id: string) => others[id] ?? null,
    }),
    ask: always("approve"),
    edit: noEdit,
    out: (l) => lines.push(l),
  })
  const text = lines.join("\n")
  // Both sentences, so a reviewer can judge what this claim overlaps without
  // leaving the screen.
  expect(text).toContain("the one that still stands")
  expect(text).toContain("the one that was taken back")
  // The statuses differ, which is the fact the old count could not carry.
  expect(text).toContain("approved")
  expect(text).toContain("retracted")
  // An overlap whose claim is gone is still listed, never silently dropped.
  expect(text).toContain("c-missing — no longer in this space")
  // And not the old, misleading label.
  expect(text).not.toContain("approved claim(s)")
})

test("a store that fails outright says so and does not count the claim", async () => {
  const lines: string[] = []
  const summary = await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one"), sample("c2", "two")],
      review: async () => {
        throw new Error("your token was revoked or expired — run `cairn login`")
      },
    }),
    ask: always("approve"),
    edit: noEdit,
    out: (l) => lines.push(l),
  })
  expect(summary).toEqual({ approved: 0, rejected: 0, edited: 0, skipped: 2 })
  expect(lines.join("\n")).toContain("cairn login")
})

test("an empty queue reviews nothing and says nothing is pending", async () => {
  const lines: string[] = []
  const summary = await runReview({
    store: fakeStore({ list: async () => [] }),
    ask: always("approve"),
    edit: noEdit,
    out: (l) => lines.push(l),
  })
  expect(summary).toEqual({ approved: 0, rejected: 0, edited: 0, skipped: 0 })
  expect(lines.join("\n")).toContain("Nothing")
})

// --- the `cairn review` wiring --------------------------------------------
//
// `ROOT` in src/cli.ts is a module-level const fixed at first import, so the
// command is exercised by spawning the real CLI with an isolated CAIRN_ROOT.
// A spawned process has no TTY, which is exactly the condition both of these
// are about.

async function spawnReview(cairnRoot: string, args: string[]) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "review", ...args], {
    env: { ...process.env, CAIRN_ROOT: cairnRoot },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

test(
  "cairn review --json prints the pending queue as claims",
  async () => {
    // A real HTTP round trip, because that is the only store there is now:
    // config.json → HttpStore → GET /claims?status=pending → stdout. A stubbed
    // fetch cannot reach a spawned process, and the point of spawning is that
    // `ROOT` is fixed at import time.
    const root = await mkdtemp(join(tmpdir(), "cairn-review-json-"))
    let asked = ""
    const api = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url)
        asked = `${url.pathname}?${url.searchParams.get("status")}`
        return Response.json({
          claims: [
            {
              id: "c1", status: "pending",
              claim: "bun test does not typecheck", body: "detail",
              source: { author: "r", agent: "cursor", repo: null, session: null },
              created: "2026-08-28T00:00:00.000Z",
              reviewed: null, reviewer: null, overlaps: [],
              abstract: null, abstractBy: null, tags: [],
            },
          ],
          cursor: null,
        })
      },
    })
    try {
      await writeConfig(root, {
        ...newConfig(false, "abc"),
        auth: {
          token: "cairn_tok_1", orgId: "org-1", orgSlug: "acme",
          apiUrl: `http://127.0.0.1:${api.port}`, user: "r",
        },
      })
      const { out, err, code } = await spawnReview(root, ["--json"])
      expect(err).not.toContain("Cannot find module")
      expect(code).toBe(0)
      // The queue came off the wire, from the org in config.json.
      expect(asked).toBe("/v1/orgs/org-1/claims?pending")
      const claims = JSON.parse(out)
      expect(claims).toHaveLength(1)
      // Whole claims, not a summary: a script deciding anything needs the
      // body, abstract and overlaps the interactive path renders.
      expect(claims[0].claim).toBe("bun test does not typecheck")
      expect(claims[0].status).toBe("pending")
      expect(claims[0].body).toBe("detail")
      expect(claims[0].overlaps).toEqual([])
    } finally {
      api.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "cairn review refuses without a terminal instead of exiting 0 having done nothing",
  async () => {
    // Deliberately signed out as well: a headless run must hear the complaint
    // that is actually about it, not "not signed in" followed by the real
    // problem on the next attempt.
    const root = await mkdtemp(join(tmpdir(), "cairn-review-tty-"))
    try {
      const { err, code } = await spawnReview(root, [])
      expect(code).toBe(1)
      expect(err).toContain("--json")
      expect(err).not.toContain("not signed in")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  20000,
)

test("the editor follows the POSIX convention rather than dropping into vi", async () => {
  // $VISUAL wins over $EDITOR; that is the convention, and cairn was reading
  // only $EDITOR. When neither is set the fallback must be an editor a person
  // can leave without knowing a modal editor's commands — dropping an
  // unsuspecting reviewer into vi is friction on the one loop this product
  // measures, and it showed up as `edited: 0` in a real session.
  expect(resolveEditor({ VISUAL: "code -w", EDITOR: "emacs" }, () => true)).toBe("code -w")
  expect(resolveEditor({ EDITOR: "emacs" }, () => true)).toBe("emacs")
  expect(resolveEditor({}, (cmd) => cmd === "nano")).toBe("nano")
  // Only if nothing friendlier exists does it fall back to what POSIX guarantees.
  expect(resolveEditor({}, () => false)).toBe("vi")
  // An empty or whitespace-only variable is not a choice.
  expect(resolveEditor({ EDITOR: "  " }, (cmd) => cmd === "nano")).toBe("nano")
})


// --- cairn curate ---------------------------------------------------------
//
// `abstractBy` has three values, and before this nothing in the CLI could
// write "human": `runReview` only ever reaches `store.list("pending")`, and
// `runBackfill` always stamps "generated". `cairn status` went on counting
// machine-written abstracts nobody had reviewed with no way to clear one.

/** An approved claim with an abstract of the given provenance. */
const curatable = (id: string, abstractBy: Claim["abstractBy"], abstract: string | null): Claim => ({
  ...sample(id, `claim ${id}`),
  status: "approved",
  abstract,
  abstractBy,
})

const writes = (abstract: string) => async (): Promise<CurateAnswer> => ({ kind: "write", abstract })

test("curate offers only the abstracts a model wrote", async () => {
  // An `agent` abstract arrived with the claim and a reviewer saw it while
  // approving; a `human` one is what this command produces; a claim with none
  // belongs to `cairn abstracts`. None of the three is waiting for anybody.
  const seen: string[] = []
  const saved: Claim[] = []
  const store = fakeStore({
    list: async (status) =>
      status === "approved"
        ? [
            curatable("a", "generated", "machine wording"),
            curatable("b", "agent", "the proposing agent wrote this"),
            curatable("c", "human", "already curated"),
            curatable("d", null, null),
          ]
        : [],
    put: async (claim) => {
      saved.push(claim)
    },
  })
  const summary = await runCurate({
    store,
    out: () => {},
    ask: async (claim) => {
      seen.push(claim.id)
      return { kind: "write", abstract: "my wording" }
    },
  })
  expect(seen).toEqual(["a"])
  expect(summary).toEqual({ written: 1, skipped: 0 })
  expect(saved).toHaveLength(1)
})

test("a curated abstract is saved as the human's, not the model's", async () => {
  // The point of the whole command: `abstractBy` is what agents navigate by,
  // and "generated" means nobody has looked.
  let saved: Claim | null = null
  const store = fakeStore({
    list: async () => [curatable("a", "generated", "machine wording")],
    put: async (claim) => {
      saved = claim
    },
  })
  await runCurate({ store, out: () => {}, ask: writes("  a human's two sentences.  ") })
  expect(saved!.abstract).toBe("a human's two sentences.")
  expect(saved!.abstractBy).toBe("human")
  // And nothing else about the claim moved — a curate is not a review.
  expect(saved!.status).toBe("approved")
  expect(saved!.claim).toBe("claim a")
})

test("an abstract that came back unchanged is not stamped as a human's", async () => {
  // Stamping "human" on text a human did not change clears the exact flag this
  // command exists to make meaningful.
  const lines: string[] = []
  const store = fakeStore({
    list: async () => [curatable("a", "generated", "machine wording")],
    put: async () => unsupported("put — nothing changed"),
  })
  const summary = await runCurate({
    store,
    out: (l) => lines.push(l),
    ask: writes("machine wording"),
  })
  expect(summary).toEqual({ written: 0, skipped: 1 })
  expect(lines.join("\n")).toContain("left as generated")
})

test("an empty abstract is refused rather than written", async () => {
  // team_knowledge_map returns the abstract in place of a summary; a blank
  // where a sentence belongs is what stops an agent looking further.
  const lines: string[] = []
  const store = fakeStore({
    list: async () => [curatable("a", "generated", "machine wording")],
    put: async () => unsupported("put — the abstract was empty"),
  })
  const summary = await runCurate({ store, out: (l) => lines.push(l), ask: writes("   ") })
  expect(summary).toEqual({ written: 0, skipped: 1 })
  expect(lines.join("\n")).toContain("cannot be empty")
})

test("nothing to curate says so instead of asking", async () => {
  const lines: string[] = []
  const store = fakeStore({ list: async () => [curatable("a", "human", "already curated")] })
  const summary = await runCurate({
    store,
    out: (l) => lines.push(l),
    ask: async () => unsupported("ask — there was nothing to offer"),
  })
  expect(summary).toEqual({ written: 0, skipped: 0 })
  expect(lines.join("\n")).toContain("No generated abstracts")
})

test("quitting stops the walk without touching what is left", async () => {
  const seen: string[] = []
  const store = fakeStore({
    list: async () => [
      curatable("a", "generated", "one"),
      curatable("b", "generated", "two"),
    ],
    put: async () => unsupported("put — the reviewer quit"),
  })
  const summary = await runCurate({
    store,
    out: () => {},
    ask: async (claim) => {
      seen.push(claim.id)
      return { kind: "quit" }
    },
  })
  expect(seen).toEqual(["a"])
  expect(summary).toEqual({ written: 0, skipped: 0 })
})

test("a save that fails is reported, and the claim keeps the generated abstract", async () => {
  // Silence here would leave an operator believing they had rewritten it while
  // every agent went on reading the model's wording.
  const lines: string[] = []
  const store = fakeStore({
    list: async () => [curatable("a", "generated", "machine wording")],
    put: async () => {
      throw new CairnHttpError(503, "unavailable", "cairn is having a bad day")
    },
  })
  const summary = await runCurate({ store, out: (l) => lines.push(l), ask: writes("mine") })
  expect(summary).toEqual({ written: 0, skipped: 1 })
  const text = lines.join("\n")
  expect(text).toContain("could not save that abstract")
  expect(text).toContain("bad day")
  expect(text).toContain("still has the generated one")
})

test("curating moves no part of the approve rate", async () => {
  // The number this product measures. `curate` is in neither
  // APPROVE_KINDS nor RESOLVE_KINDS, so a claim whose abstract was rewritten
  // is not a claim anybody reviewed again — and it must not become one.
  const at = "2026-08-28T00:00:00.000Z"
  const before = [
    { kind: "propose" as const, at, id: "a" },
    { kind: "approve" as const, at, id: "a" },
    { kind: "propose" as const, at, id: "b" },
    { kind: "reject" as const, at, id: "b" },
  ]
  const after = [...before, { kind: "curate" as const, at, id: "a" }]
  expect(statsFromEvents(after)).toEqual(statsFromEvents(before))
})

test("runCurate appends no event of its own", async () => {
  // The service records the curate inside the same request that changed the
  // claim — `store.put` sends `kind: "curate"` — so a second one from this
  // side would count one rewrite twice. runCurate takes no event sink at all,
  // which is the structural version of that guarantee; this pins that the only
  // write it makes is the put.
  const calls: string[] = []
  const store = fakeStore({
    list: async (status) => {
      calls.push(`list:${status}`)
      return status === "approved" ? [curatable("a", "generated", "machine wording")] : []
    },
    put: async () => {
      calls.push("put")
    },
  })
  await runCurate({ store, out: () => {}, ask: writes("mine") })
  expect(calls).toEqual(["list:approved", "put"])
})

// --- renderAbstract -------------------------------------------------------

test("the curation view shows the claim, its body and the abstract in force", () => {
  const out = renderAbstract(curatable("a", "generated", "Settles X. Says nothing about Y."), 2, 5)
  expect(out).toContain("2 of 5")
  expect(out).toContain("generated")
  expect(out).toContain("claim a")
  expect(out).toContain("Settles X.")
  // Not the review queue's framing: every claim here is approved on purpose,
  // and "already approved" reads as something having gone wrong.
  expect(out).not.toContain("already")
  expect(out).not.toContain("pending")
})

test("a curated abstract reaches the hosted store as a curate patch", async () => {
  // The wire format is what makes the guarantee real: `kind: "curate"` is what
  // the service records, and `curate` is in neither APPROVE_KINDS nor
  // RESOLVE_KINDS. A patch that carried any other kind would turn rewriting a
  // sentence into a review nobody performed.
  let patched: unknown = null
  let patchedPath = ""
  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "PATCH") {
        patchedPath = url.pathname
        patched = await req.json()
        return Response.json(curatable("c1", "human", "mine"))
      }
      return Response.json({
        claims: url.searchParams.get("status") === "approved"
          ? [curatable("c1", "generated", "A model wrote this.")]
          : [],
        cursor: null,
      })
    },
  })
  try {
    const store = new HttpStore({
      baseUrl: `http://127.0.0.1:${api.port}`,
      token: "cairn_tok_1",
      orgId: "org-1",
    })
    const summary = await runCurate({ store, out: () => {}, ask: writes("mine") })
    expect(summary).toEqual({ written: 1, skipped: 0 })
    expect(patchedPath).toBe("/v1/orgs/org-1/claims/c1")
    expect(patched).toEqual({
      abstract: "mine",
      abstractBy: "human",
      // Carried through untouched — curating an abstract is not a retagging.
      tags: ["architecture"],
      kind: "curate",
    })
  } finally {
    api.stop(true)
  }
})

test("mine reaches the store, and an empty filtered queue says so", async () => {
  // Two facts in one loop, and they fail separately: a `mine` that never
  // reached the store would filter nothing, and "Nothing is waiting for you"
  // is false of a space whose claims are sitting in somebody else's queue.
  const asked: { mine?: boolean }[] = []
  const lines: string[] = []
  await runReview({
    store: fakeStore({
      list: async (_status, opts) => {
        asked.push({ mine: opts?.mine })
        return []
      },
    }),
    mine: true,
    ask: always("skip"),
    edit: noEdit,
    out: (l) => lines.push(l),
  })
  expect(asked).toEqual([{ mine: true }])
  expect(lines.join("\n")).toContain("in the tags you own")
})

test("without mine the queue is everybody's, and says nothing about tags", async () => {
  const asked: { mine?: boolean }[] = []
  const lines: string[] = []
  await runReview({
    store: fakeStore({
      list: async (_status, opts) => {
        asked.push({ mine: opts?.mine })
        return []
      },
    }),
    ask: always("skip"),
    edit: noEdit,
    out: (l) => lines.push(l),
  })
  expect(asked).toEqual([{ mine: undefined }])
  expect(lines.join("\n")).toContain("Nothing is waiting for you.")
})

test("clearing the queue draws the wordmark, and a narrow terminal gets the sentence alone", async () => {
  // An empty queue is a reward state printed as a bare absence, and
  // it is the one place in the reader a multi-row mark costs nothing — the
  // screen has already been torn down and nothing is competing for the rows.
  // Both halves matter: a mark nothing guards wraps into rubble on a phone-
  // width terminal, and a guard that never lets it through is a feature
  // nobody has.
  const empty = { list: async () => [] }
  const wide: string[] = []
  await runReview({
    store: fakeStore(empty),
    ask: always("skip"),
    edit: noEdit,
    out: (l) => wide.push(l),
    columns: 80,
  })
  for (const row of wordmark(80)!) expect(wide).toContain(row)
  expect(wide.at(-1)).toContain("Nothing is waiting for you.")

  const narrow: string[] = []
  await runReview({
    store: fakeStore(empty),
    ask: always("skip"),
    edit: noEdit,
    out: (l) => narrow.push(l),
    columns: WORDMARK_COLUMNS - 1,
  })
  expect(narrow).toEqual(["· Nothing is waiting for you."])
})

// --- time-to-decision ------------------------------------------------------
//
// The terminal's half. This chose a CLIENT-measured interval over one the
// server derives from a `read` event, and comparability is the reason: only a
// client measurement is one both surfaces can send, so this is what makes the
// browser's numbers and the terminal's readable against each other. Derived
// server-side, `cairn review` could not have contributed at all.

test("the interval spans reading and deciding, and reaches the store", async () => {
  const calls: (number | undefined)[] = []
  // A clock that advances 1200ms between every reading. `runReview` reads it
  // once before `ask` and once when the decision is recorded, so one claim
  // costs exactly one tick.
  let t = 0
  await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one")],
      review: async (_id, _decision, _edits, elapsedMs) => {
        calls.push(elapsedMs)
        return sample("c1", "one")
      },
    }),
    ask: always("approve"),
    edit: noEdit,
    out: () => {},
    now: () => {
      t += 1200
      return t
    },
  })
  expect(calls).toEqual([1200])
})

test("the clock covers the editor round trip, not just the keystroke", async () => {
  // An `edit` spends its time in $EDITOR between the keystroke and the write,
  // and that is the most expensive reviewing there is. An interval read before
  // `edit` rather than after it would report only how long pressing `e` took —
  // and would make edits look like the cheapest decision on the list, which is
  // the opposite of true.
  const calls: (number | undefined)[] = []
  let t = 0
  const tick = () => {
    t += 1000
    return t
  }
  await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one")],
      review: async (_id, _decision, _edits, elapsedMs) => {
        calls.push(elapsedMs)
        return sample("c1", "one")
      },
    }),
    ask: always("edit"),
    // The editor itself burns two ticks. Without them this test would pass
    // against a clock read before the edit, which is the thing it is for.
    edit: async () => {
      tick()
      tick()
      return { claim: "rewritten", body: "b", abstract: "" }
    },
    out: () => {},
    now: tick,
  })
  // 1 tick before `ask`, 2 inside the editor, 1 at the write: 4000 - 1000.
  expect(calls).toEqual([3000])
})

test("a skipped claim records no interval, because it records nothing", async () => {
  // A skip is not a decision and must not enter the series. Measuring how long
  // somebody looked at a claim before declining to judge it would put
  // non-decisions in the column that argues review is happening.
  const calls: unknown[] = []
  await runReview({
    store: fakeStore({
      list: async () => [sample("c1", "one")],
      review: async (...args) => {
        calls.push(args)
        return sample("c1", "one")
      },
    }),
    ask: always("skip"),
    edit: noEdit,
    out: () => {},
    now: () => 1000,
  })
  expect(calls).toEqual([])
})
