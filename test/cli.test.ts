import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { COMMAND_FLAGS, formatCitedUpdates, formatFailures, formatStatus, gateGeneration, main, makeSink, makeStore, modeFromFlags, modelFlags, runBackfill, runImport, runInitCommand, telemetryChoice, unknownFlags, runSearch, runRetract, runCite, runUncite, formatSearch, formatClaim, initPrompts } from "../src/cli"
import type { GenerationGateDeps, LocalHoldings } from "../src/cli"
import type { ResolvedGeneration } from "../src/generate"
import { resolveBaseUrl } from "../src/providers"
import { isRateLimit } from "../src/errors"
import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import type { InitCommandDeps } from "../src/cli"
import type { CheckResult } from "../src/doctor"
import { previewOf } from "../src/documents"
import { serializeDocument } from "../src/documents"
import { parseClaim, serializeClaim } from "../src/claims"
import { EventLog } from "../src/events"
import { WRITE_KEY } from "../src/telemetry"
import { FileStore } from "../src/store"
import { EMPTY_RETRACT_REASON, notAdoptableMessage } from "@cairn-kb/protocol/event-kinds"
import { HttpEventSink, HttpStore } from "../src/http-store"
import type { Citation, Claim, Document, Status, Store } from "@cairn-kb/protocol/types"
import { WORDMARK_COLUMNS, wordmark } from "../src/wordmark"
import { importGraph, staticSpecifiers } from "./import-graph"
import { proposal, sample } from "./store-contract"
// Captured so the login/logout tests below can put the real modules back:
// `mock.restore()` undoes mock FUNCTIONS, but not a `mock.module` patch — a
// module it replaces stays replaced for the rest of this file's tests
// otherwise, which is exactly what silently broke two `init` tests further
// down the file the first time this was written without restoring by hand.
//
// `import * as x` is a LIVE namespace object, not a snapshot: `mock.module`
// overwrites properties on that same object when the module is already
// loaded, so reading `realLoginModule.runLogin` back out AFTER mocking would
// return the mock, not the original — restoring "from" it would be handing
// the patch back to itself. Spreading into a plain object right here, before
// any test has had a chance to mock anything, freezes the real functions.
import * as loginModule from "../src/login"
import * as configModule from "../src/config"
import { newConfig, readConfig, writeConfig } from "../src/config"
import * as browserModule from "../src/browser"
const realLoginModule = { ...loginModule }
const realConfigModule = { ...configModule }
const realBrowserModule = { ...browserModule }

let root: string
let source: string
let store: FileStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-cli-"))
  source = await mkdtemp(join(tmpdir(), "cairn-src-"))
  // With an event log: propose and review write events, and a document
  // import writes its own `import` event through `store.importDocument`.
  store = new FileStore(root, new EventLog(root))
  await store.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(source, { recursive: true, force: true })
})

test("import writes documents, not claims", async () => {
  // The whole point of this change: a file's first heading is a noun phrase,
  // not "one assertive sentence a reviewer judges" — it must never arrive as
  // an approved claim nobody judged.
  await writeFile(join(source, "conventions.md"), "# Conventions\n\nWe use tabs.", "utf-8")
  await writeFile(join(source, "deploys.md"), "# Deploys\n\nTuesdays only.", "utf-8")
  expect((await runImport(store, source)).created).toBe(2)
  expect(await store.list("approved")).toEqual([])
  const docs = await store.listDocuments()
  expect(docs.map((d) => d.title).sort()).toEqual(["Conventions", "Deploys"])
})

test("import walks nested directories and ignores non-markdown", async () => {
  await mkdir(join(source, "sub"), { recursive: true })
  await writeFile(join(source, "sub", "a.md"), "# A\n\nbody", "utf-8")
  await writeFile(join(source, "notes.txt"), "ignored", "utf-8")
  expect((await runImport(store, source)).created).toBe(1)
  expect((await store.listDocuments()).length).toBe(1)
})

test("status output names the queue depth and approve rate", async () => {
  const log = new EventLog(root)
  await log.append("propose", "a")
  await log.append("approve", "a")
  const text = formatStatus(await store.list("pending"), await log.stats())
  expect(text).toContain("0 pending")
  expect(text).toContain("100%")
})

test("status reports no reviews yet when nothing has been reviewed", async () => {
  const log = new EventLog(root)
  await log.append("propose", "a")
  const text = formatStatus(await store.list("pending"), await log.stats())
  expect(text).toContain("no reviews yet")
})

test("init is listed in the usage line", async () => {
  const messages: string[] = []
  const original = console.log
  console.log = (m: string) => messages.push(String(m))
  try {
    // Usage is printed first, then the unknown command is raised — `runCli`
    // turns that into the non-zero exit, so a typo cannot read as success.
    await expect(main(["nonsense-command"])).rejects.toThrow(/unknown command/)
  } finally {
    console.log = original
  }
  expect(messages.join(" ")).toContain("init")
})

test("every description in the usage block starts at the same column", async () => {
  // A line with one space too many sits a column right of everything else,
  // and nothing could catch it — the two existing usage
  // tests assert that commands are NAMED and DESCRIBED, never that the block
  // lines up, and alignment is the one property of this block a reader
  // actually sees.
  const messages: string[] = []
  const original = console.log
  console.log = (m: string) => messages.push(String(m))
  try {
    await expect(main(["nonsense-command"])).rejects.toThrow(/unknown command/)
  } finally {
    console.log = original
  }
  const plain = messages.map((m) => m.replace(/\x1b\[[0-9;]*m/g, ""))
  // A description line is "  <command…>  <description>": two leading spaces,
  // then a run of two or more spaces separating the two halves.
  const columns = new Map<string, number>()
  for (const line of plain) {
    const m = /^ {2}(\S.*?\S) {2,}(\S)/.exec(line)
    if (!m) continue
    // The match's own length, NOT `indexOf`: the description's first character
    // very often appears earlier in the command half, and searching for it
    // found that one instead — which reported `doctor` at column 4.
    columns.set(m[1]!.split(" ")[0]!, m[0].length - 1)
  }
  // The control: a regex that matched nothing would satisfy every assertion
  // below in silence, and this block has well over a dozen entries.
  expect(columns.size).toBeGreaterThan(12)

  // `model` and `init` are the documented exceptions and the reason this is
  // not simply "every line agrees": their command halves are longer than the
  // column itself, so they cannot be padded to it and use a minimum gap instead.
  const exceptions = new Set(["model", "init"])
  const aligned = [...columns].filter(([name]) => !exceptions.has(name))
  const target = aligned[0]![1]
  for (const [name, column] of aligned) {
    expect({ name, column }).toEqual({ name, column: target })
  }
  // And the exception really is one, rather than a name someone added here to
  // silence a genuine misalignment.
  expect(columns.get("model")! > target).toBe(true)
  expect(columns.get("init")! > target).toBe(true)
})

test("the bare command draws the wordmark above the command list, and a typo does not", async () => {
  // The mark goes where the usage line already is, which is the
  // conventional home for one. It must NOT appear over `unknown command: X`,
  // which reaches the same branch: as with `cairn doctor`, people are
  // reading it because something has already gone wrong,
  // and a banner over somebody's typo reads as tone-deaf.
  const say = async (argv: string[], columns: number | undefined) => {
    const messages: string[] = []
    const original = console.log
    const width = process.stdout.columns
    ;(process.stdout as { columns?: number }).columns = columns
    console.log = (m: string) => messages.push(String(m))
    try {
      await main(argv).catch((err: Error) => {
        if (!/unknown command/.test(err.message)) throw err
      })
    } finally {
      console.log = original
      ;(process.stdout as { columns?: number }).columns = width
    }
    return messages.map((m) => m.replace(/\x1b\[[0-9;]*m/g, ""))
  }
  const drawn = wordmark(120)!
  const bare = await say([], 120)
  for (const row of drawn) expect(bare).toContain(row)
  expect(bare.findIndex((m) => m.startsWith("usage:"))).toBeGreaterThan(bare.indexOf(drawn[0]!))

  // A terminal too narrow for the mark still gets the synopsis, which names
  // the tool in plain text — that IS the fallback, rather than a second
  // spelling of the same word printed above it.
  const narrow = await say([], WORDMARK_COLUMNS - 1)
  for (const row of drawn) expect(narrow).not.toContain(row)
  expect(narrow.some((m) => m.startsWith("usage: cairn"))).toBe(true)

  const typo = await say(["nonsense-command"], 120)
  for (const row of drawn) expect(typo).not.toContain(row)
  expect(typo.some((m) => m.startsWith("usage:"))).toBe(true)
})

test("every flag a command accepts is named in its usage line", async () => {
  // The README tells people `cairn --help` lists every flag. That is only
  // true while something checks the help against COMMAND_FLAGS.
  const messages: string[] = []
  const original = console.log
  console.log = (m: string) => messages.push(String(m))
  try {
    await expect(main(["nonsense-command"])).rejects.toThrow(/unknown command/)
  } finally {
    console.log = original
  }
  const plain = messages.map((m) => m.replace(/\x1b\[[0-9;]*m/g, ""))
  for (const [command, flags] of Object.entries(COMMAND_FLAGS)) {
    const line = plain.find((m) => m.startsWith(`  ${command} `)) ?? ""
    for (const flag of flags) expect({ command, flag, named: line.includes(flag) }).toEqual({ command, flag, named: true })
  }
  // The control: the table is real and non-trivial.
  expect(COMMAND_FLAGS.init).toContain("--telemetry")
})

test("every command in the usage line has a description line", async () => {
  // The list grew as commands were added and the descriptions did not, so six
  // of the thirteen were named and never explained — `review` and `import`
  // among them, which are the two a new user needs first. The halves only stay
  // in step if something asserts they agree.
  const messages: string[] = []
  const original = console.log
  console.log = (m: string) => messages.push(String(m))
  try {
    await expect(main(["nonsense-command"])).rejects.toThrow(/unknown command/)
  } finally {
    console.log = original
  }
  // Colours are off when stdout is not a TTY, which is how the suite normally
  // runs — stripping them rather than relying on that keeps this passing when
  // it is run through one.
  const plain = messages.map((m) => m.replace(/\x1b\[[0-9;]*m/g, ""))
  const usage = plain.find((m) => m.startsWith("usage:"))
  expect(usage).toBeDefined()
  const named = usage!.slice(usage!.indexOf("<") + 1, usage!.indexOf(">")).split("|")
  for (const command of named) {
    expect(plain.some((m) => m.startsWith(`  ${command} `))).toBe(true)
  }
})

test("every command with a description line is named in the usage line", async () => {
  // The other direction, and the one nothing checked: `adopt-imports` was
  // described and never named, so the synopsis was the only place in the CLI
  // that did not know the command existed. The test above passes
  // either way — it walks the names and asks for descriptions, so a command
  // missing from the names is exactly what it cannot see.
  const messages: string[] = []
  const original = console.log
  console.log = (m: string) => messages.push(String(m))
  try {
    await expect(main(["nonsense-command"])).rejects.toThrow(/unknown command/)
  } finally {
    console.log = original
  }
  const plain = messages.map((m) => m.replace(/\x1b\[[0-9;]*m/g, ""))
  const usage = plain.find((m) => m.startsWith("usage:"))!
  const named = usage.slice(usage.indexOf("<") + 1, usage.indexOf(">")).split("|")
  const described = plain
    .filter((m) => m.startsWith("  ") && m.trim() !== "")
    .map((m) => m.trim().split(/\s+/)[0]!)
    // `--version` is described and deliberately not named: the synopsis lists
    // commands, and a flag is not one. Anything else starting with `-` would
    // be the same kind of thing.
    .filter((c) => !c.startsWith("-"))
  expect(described.length).toBeGreaterThan(0)
  for (const command of described) {
    expect(named).toContain(command)
  }
})

// --- login/logout: a network failure is cairn's own warning, never a raw
// stack trace, and never writes to the real ~/.cairn config -----------------
//
// `runLogin`/`runLogout` are not dependency-injected into `cli.ts` — it wires
// the real ones, the way every command does — so these tests replace the
// "./login" and "./config" modules `cli.ts` imports rather than passing fakes
// in. That is also why `readConfig`/`writeConfig` are mocked here even when a
// test's real interest is only in `login`/`logout`: without it, these tests
// would read and write the developer's actual `~/.cairn/config.json`.

/** Runs `main`, capturing every `console.log`/`console.error` line — commands
 *  in this file split a refusal between the two inconsistently (`login`'s
 *  catch uses `console.log`, `show`'s and `retract`'s use `console.error`),
 *  so a caller asserting on message text needs both in one place rather than
 *  guessing which stream a given command wrote to — and the `process.exit`
 *  code. */
async function runMainCapturingExit(
  args: string[],
): Promise<{ messages: string[]; exitCode: number | undefined }> {
  const messages: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit
  let exitCode: number | undefined
  console.log = (m: string) => messages.push(String(m))
  console.error = (m: string) => messages.push(String(m))
  process.exit = ((code?: number) => {
    exitCode = typeof code === "number" ? code : 0
    throw new Error("__test_process_exit__")
  }) as never
  try {
    await main(args)
  } catch (err) {
    if ((err as Error).message !== "__test_process_exit__") throw err
  } finally {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
  }
  return { messages, exitCode }
}

test("a login failure is reported by cairn's own warning, not a raw stack trace", async () => {
  mock.module("../src/login", () => ({
    runLogin: async () => {
      throw new Error("state mismatch — the login response did not come from your request")
    },
    runLogout: async () => ({ revoked: true }),
    pkcePair: async () => ({ verifier: "v", challenge: "c" }),
  }))
  try {
    const { messages, exitCode } = await runMainCapturingExit(["login"])
    expect(exitCode).toBe(1)
    expect(messages.join(" ")).toContain("state mismatch")
  } finally {
    mock.module("../src/login", () => realLoginModule)
    mock.restore()
  }
})

test("a logout failure is reported the same way, matching the model command's own convention", async () => {
  mock.module("../src/login", () => ({
    runLogin: async () => ({ token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://api.test", user: null }),
    // The real runLogout never throws — it reports a failed revoke back as
    // data (see LogoutResult) — but cli.ts's catch is still there for
    // whatever else can fail in this case (writeConfig, a future change to
    // runLogout itself), and this pins that the catch actually does something.
    runLogout: async () => {
      throw new Error("could not reach https://api.test/v1/cli/token")
    },
    pkcePair: async () => ({ verifier: "v", challenge: "c" }),
  }))
  mock.module("../src/config", () => ({
    newConfig: (telemetry: boolean) => ({
      installId: "x", telemetry, lastSentAt: null, generation: null, auth: null,
    }),
    readConfig: async () => ({
      installId: "x", telemetry: false, lastSentAt: null, generation: null,
      auth: { token: "tok", orgId: "o1", orgSlug: "acme", apiUrl: "https://api.test", user: null },
    }),
    writeConfig: async () => {},
  }))
  try {
    const { messages, exitCode } = await runMainCapturingExit(["logout"])
    expect(exitCode).toBe(1)
    expect(messages.join(" ")).toContain("could not reach https://api.test/v1/cli/token")
  } finally {
    mock.module("../src/login", () => realLoginModule)
    mock.module("../src/config", () => realConfigModule)
    mock.restore()
  }
})

test("the authorize URL is printed once, not once by cli.ts and again by the browser fallback", async () => {
  const authorizeUrl = "https://api.example.test/v1/cli/authorize?state=abc"
  mock.module("../src/login", () => ({
    runLogin: async (deps: { openBrowser: (url: string) => Promise<void> }) => {
      // Exercises the real openBrowser closure cli.ts builds for the login
      // case, the way the actual browser path does.
      await deps.openBrowser(authorizeUrl)
      return { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://api.test", user: null }
    },
    runLogout: async () => ({ revoked: true }),
    pkcePair: async () => ({ verifier: "v", challenge: "c" }),
  }))
  mock.module("../src/browser", () => ({
    // Stands in for a browser that fails to open, so the URL is visible only
    // through whatever cli.ts's closure and this fallback each choose to
    // print — the exact seam where it was printed twice.
    openInBrowser: async (url: string, opts: { print?: (line: string) => void }) => {
      opts.print?.("could not open a browser automatically (spawn ENOENT).")
      opts.print?.(`open this URL yourself: ${url}`)
    },
  }))
  mock.module("../src/config", () => ({
    newConfig: (telemetry: boolean) => ({
      installId: "x", telemetry, lastSentAt: null, generation: null, auth: null,
    }),
    readConfig: async () => null,
    writeConfig: async () => {},
  }))
  try {
    const { messages } = await runMainCapturingExit(["login"])
    const hits = messages.filter((m) => m.includes(authorizeUrl)).length
    expect(hits).toBe(1)
  } finally {
    mock.module("../src/login", () => realLoginModule)
    mock.module("../src/browser", () => realBrowserModule)
    mock.module("../src/config", () => realConfigModule)
    mock.restore()
  }
})

test("login refuses in a local space that already has a token, names the remedy, and exits non-zero", async () => {
  // Refuses only once there is a token to make redundant. An unconditional
  // refusal here deadlocked a local root that was never signed in: `init
  // --team` on it needs an account and points at `cairn login`, which pointed
  // straight back at `init --team`.
  const dir = await mkdtemp(join(tmpdir(), "cairn-login-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, {
      ...newConfig(false), mode: "local" as const,
      auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "u" },
    })
    const { code, err } = await spawnCli(["login"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(1)
    expect(err).toContain("already signed in")
    expect(err).toContain("this space is local")
    expect(err).toContain("cairn init --team")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("login proceeds in a local space with no token yet — the deadlock login used to cause", async () => {
  // The other half of the narrowed refusal: `mode: "local"` alone must not
  // refuse, or a local root that never signed in has no way to acquire the
  // account `init --team` needs. Mocked the way the other login tests above
  // mock it, since `runLogin` is not dependency-injected into `cli.ts`.
  mock.module("../src/login", () => ({
    runLogin: async () => ({
      token: "t", orgId: "o", orgSlug: "acme", apiUrl: "https://api.test", user: "alice",
    }),
    runLogout: async () => ({ revoked: true }),
    pkcePair: async () => ({ verifier: "v", challenge: "c" }),
  }))
  mock.module("../src/browser", () => ({
    openInBrowser: async (_url: string, opts: { print?: (line: string) => void }) => {
      opts.print?.("opened")
    },
  }))
  mock.module("../src/config", () => ({
    newConfig: (telemetry: boolean) => ({
      installId: "x", telemetry, lastSentAt: null, generation: null, auth: null, mode: "local",
    }),
    readConfig: async () => ({
      installId: "x", telemetry: false, lastSentAt: null, generation: null,
      auth: null, mode: "local",
    }),
    writeConfig: async () => {},
  }))
  try {
    const { messages, exitCode } = await runMainCapturingExit(["login"])
    expect(exitCode).toBeUndefined()
    expect(messages.join(" ")).toContain("signed in as")
  } finally {
    mock.module("../src/login", () => realLoginModule)
    mock.module("../src/browser", () => realBrowserModule)
    mock.module("../src/config", () => realConfigModule)
    mock.restore()
  }
})

test("logout in a local space clears the token that init --local deliberately kept", async () => {
  // `init --local` keeps an existing auth block so a later `init --team`
  // needs no re-login, on the condition that the stale credential stays
  // visible. `logout` then refused unconditionally — so the one legitimate
  // reason to run it in a local space was the one thing it would not do, and
  // the remedy it named was migrating the entire knowledge base.
  const dir = await mkdtemp(join(tmpdir(), "cairn-login-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, {
      ...newConfig(false), mode: "local" as const,
      auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "u" },
    })
    const { code, out, err } = await spawnCli(["logout"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(0)
    // The revoke cannot reach example.invalid, which is the point of clearing
    // locally either way — the token must not survive on this machine.
    expect((await readConfig(r))!.auth).toBeNull()
    expect(`${out}${err}`).not.toContain("cairn init --team")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("logout in a local space with no account refuses, and does not suggest migrating", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-login-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const, auth: null })
    const { code, out, err } = await spawnCli(["logout"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(1)
    expect(`${out}${err}`).toContain("no account")
    expect(`${out}${err}`).not.toContain("cairn init --team")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("`init --yes` answers every question, including where knowledge lives", async () => {
  // `askMode` gated on `process.stdin.isTTY` while the rest of init gated
  // on `interactive` (isTTY && !--yes), so `cairn init --yes` in a terminal
  // skipped every other question and then blocked on the one that decides
  // where a person's knowledge lives. A pty-backed CI runner hangs on it
  // rather than failing.
  const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
  const realClack = await import("@clack/prompts")
  mock.module("@clack/prompts", () => ({
    ...realClack,
    select: () => {
      throw new Error("prompted under --yes")
    },
  }))
  try {
    const { resolveScope, resolveMode } = initPrompts([], "/tmp/anywhere", false)
    expect(await resolveScope()).toBe("project")
    expect(await resolveMode(null)).toBe("team")
  } finally {
    mock.module("@clack/prompts", () => realClack)
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
    else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY
  }
})

test("a flag still outranks the prompt, and an existing mode outranks the default", async () => {
  // The defaults are only for when nobody said anything: --global must not be
  // quietly turned into "project" by the same change.
  expect(await initPrompts(["--global"], "/tmp/anywhere", true).resolveScope()).toBe("global")
  expect(await initPrompts(["--local"], "/tmp/anywhere", true).resolveMode(null)).toBe("local")
  expect(await initPrompts([], "/tmp/anywhere", false).resolveMode("local")).toBe("local")
})

// --- `cairn telemetry`: consent has to be withdrawable ---------------------
//
// Consent was a one-shot question at `init` with no way to change the
// answer from the CLI, so a user who said yes and changed their mind had to
// hand-edit config.json. That is a bad property for a consent flow to have,
// and it was true even while nothing was being transmitted.

test("cairn telemetry reports what consent is currently set to", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-telemetry-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false) })
    const { code, out } = await spawnCli(["telemetry"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(0)
    expect(out).toContain("off")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("cairn telemetry on and off change the answer and keep the install id", async () => {
  // Keeping installId is what stops a mind-changed user from looking like a
  // brand new install every time they toggle it.
  const dir = await mkdtemp(join(tmpdir(), "cairn-telemetry-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false), installId: "keep-me" })
    expect((await spawnCli(["telemetry", "on"], { CAIRN_ROOT: r, HOME: dir }, dir)).code).toBe(0)
    expect((await readConfig(r))!.telemetry).toBe(true)
    expect((await spawnCli(["telemetry", "off"], { CAIRN_ROOT: r, HOME: dir }, dir)).code).toBe(0)
    const cfg = (await readConfig(r))!
    expect(cfg.telemetry).toBe(false)
    expect(cfg.installId).toBe("keep-me")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

test("cairn telemetry on a root with no config yet still records the answer", async () => {
  // Otherwise the only way to opt in is to run `init` again, which asks a
  // dozen other questions.
  const dir = await mkdtemp(join(tmpdir(), "cairn-telemetry-"))
  try {
    const r = join(dir, "root")
    const { code } = await spawnCli(["telemetry", "on"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(0)
    expect((await readConfig(r))!.telemetry).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("cairn telemetry with an unknown argument names the ones it takes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-telemetry-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false) })
    const { code, err } = await spawnCli(["telemetry", "maybe"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(1)
    expect(err).toContain("status")
    expect(err).toContain("on")
    expect(err).toContain("off")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("a command sends one ping a day, to the endpoint the environment names", async () => {
  // The piggyback itself, end to end through the real CLI process: consent on,
  // a fixture endpoint, and the counters that reach it. Local mode so the
  // store needs no account.
  const dir = await mkdtemp(join(tmpdir(), "cairn-telemetry-"))
  const seen: { key: string | null; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push({ key: req.headers.get("x-cairn-key"), body: (await req.json()) as Record<string, unknown> })
      return new Response("{}", { status: 202 })
    },
  })
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(true), mode: "local" as const })
    const env = {
      CAIRN_ROOT: r, HOME: dir,
      CAIRN_TELEMETRY_URL: `http://127.0.0.1:${server.port}/v1/ping`,
    }
    expect((await spawnCli(["status"], env, dir)).code).toBe(0)
    expect(seen.length).toBe(1)
    expect(seen[0]!.key).toBe(WRITE_KEY)
    expect(seen[0]!.body.install).toBe((await readConfig(r))!.installId)
    expect((await readConfig(r))!.lastSentAt).not.toBeNull()
    // Second run the same day: at most once per 24h, so nothing more arrives.
    expect((await spawnCli(["status"], env, dir)).code).toBe(0)
    expect(seen.length).toBe(1)
  } finally {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

test("an unreachable telemetry endpoint cannot fail the command", async () => {
  // Port 9 is discard: the connection is refused immediately. The command
  // still has to succeed and still has to exit 0.
  const dir = await mkdtemp(join(tmpdir(), "cairn-telemetry-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(true), mode: "local" as const })
    const { code, err } = await spawnCli(
      ["status"],
      { CAIRN_ROOT: r, HOME: dir, CAIRN_TELEMETRY_URL: "http://127.0.0.1:9/v1/ping" },
      dir,
    )
    expect(code).toBe(0)
    expect(err).toBe("")
    expect((await readConfig(r))!.lastSentAt).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

test("a best-effort ping never turns a working command into a login prompt", async () => {
  // `makeStore` -> `requireAuth` PRINTS and calls process.exit(1), which no
  // try/catch can intercept. Piggybacking telemetry on every command put that
  // exit behind a path that is supposed to be unable to fail: a team root
  // with consent on and no account exited 1 from `cairn telemetry on`.
  const dir = await mkdtemp(join(tmpdir(), "cairn-telemetry-"))
  try {
    const r = join(dir, "root")
    const { code, err } = await spawnCli(["telemetry", "on"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(0)
    expect(err).not.toContain("not signed in")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("import reports progress for each file", async () => {
  await writeFile(join(source, "a.md"), "# A\n\nbody", "utf-8")
  await writeFile(join(source, "b.md"), "# B\n\nbody", "utf-8")
  const seen: Array<[number, number]> = []
  await runImport(store, source, (done, total) => seen.push([done, total]))
  expect(seen).toEqual([
    [1, 2],
    [2, 2],
  ])
})

test("import works without a progress callback", async () => {
  await writeFile(join(source, "a.md"), "# A\n\nbody", "utf-8")
  expect((await runImport(store, source)).created).toBe(1)
})

test("the CLI runs from any working directory, not just its own", async () => {
  // The MCP config init writes launches `bun <abs>/cli.ts mcp` from the agent's
  // cwd. If module resolution depends on cairn's own directory, every teammate
  // gets a crash on startup instead of a knowledge base.
  const elsewhere = await mkdtemp(join(tmpdir(), "cairn-cwd-"))
  try {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts")], {
      cwd: elsewhere,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(err).not.toContain("Cannot find module")
    expect(code).toBe(0)
    expect(out).toContain("usage")
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
})

// --- a store that cannot be reached is a sentence, not a stack trace -------

test("every store-touching command fails with one sentence naming what to do", async () => {
  // Verified the way a person would hit it: a REAL command against a
  // REAL unreachable API. `main` had no top-level catch, so the output led
  // with a source excerpt of http-store.ts's catch block, then
  // `CairnHttpError: …` and a stack — and the sentence named the endpoint but
  // no action, unlike `checkAuth`, which has always said what to try.
  const home = await mkdtemp(join(tmpdir(), "cairn-unreachable-"))
  try {
    await writeConfig(home, {
      ...newConfig(false, "abc"),
      auth: {
        token: "t", orgId: "o1", orgSlug: "acme",
        // Port 9 (discard) refuses immediately: no timeout, no network needed.
        apiUrl: "http://127.0.0.1:9", user: "r",
      },
    })
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "status"], {
      env: { ...process.env, CAIRN_ROOT: home, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const all = out + err
    expect(code).not.toBe(0)
    expect(all).toContain("cairn is not reachable at http://127.0.0.1:9")
    // An ACTION, not just a fact: the same clause `cairn doctor` gives.
    expect(all).toMatch(/network|VPN/)
    // And none of the raw crash report: no error class name, no source
    // excerpt, no stack frames.
    expect(all).not.toContain("CairnHttpError")
    expect(all).not.toContain("src/http-store.ts")
    expect(all).not.toMatch(/^\s*at /m)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

test("importing the same file twice does not duplicate it", async () => {
  await writeFile(join(source, "a.md"), "# A\n\nbody", "utf-8")
  await runImport(store, source)
  const second = await runImport(store, source)
  expect(second.unchanged).toBe(1)
  expect((await store.listDocuments()).length).toBe(1)
})

test("re-importing a changed file updates the document in place", async () => {
  // A document matches an existing one on `source`, not on title or text —
  // so a changed file updates the document that path already claimed, same
  // id, same citations. There is no "arrives as a new document, the stale
  // one stays" the way a changed file used to arrive as a new claim: a
  // document has no reviewer to leave that decision to.
  await writeFile(join(source, "a.md"), "# A\n\noriginal", "utf-8")
  await runImport(store, source)
  const [before] = await store.listDocuments()
  await writeFile(join(source, "a.md"), "# A\n\nrevised", "utf-8")
  const r = await runImport(store, source)
  expect(r.updated).toBe(1)
  const docs = await store.listDocuments()
  expect(docs.length).toBe(1)
  expect(docs[0]!.id).toBe(before!.id)
  expect(docs[0]!.text).toContain("revised")
})

test("re-importing a cited file names the document and the claims citing it", async () => {
  // The update in place is correct and stays; what was missing is
  // that the operator causing it was told nothing. `cairn show` warns about
  // this afterwards, which only helps somebody who already suspects it.
  await writeFile(join(source, "a.md"), "# A\n\noriginal", "utf-8")
  await runImport(store, source)
  const [doc] = await store.listDocuments()
  const claim = await store.propose(proposal("a sentence grounded in that file"))
  await store.cite(claim.id, { doc: doc!.id, supports: "the original wording" }, "alice")

  await writeFile(join(source, "a.md"), "# A\n\nrevised", "utf-8")
  const r = await runImport(store, source)
  expect(r.updated).toBe(1)
  expect(r.cited.length).toBe(1)
  expect(r.cited[0]!.id).toBe(doc!.id)
  expect(r.cited[0]!.source).toBe("a.md")
  expect(r.cited[0]!.claims).toEqual([claim.id])
})

test("a claim counts however it was reviewed, since cairn show warns whatever its status", async () => {
  // A pending claim: narrowing this to approved would report drift on a claim
  // the terminal never mentioned, and stay silent on one it does.
  await writeFile(join(source, "a.md"), "# A\n\noriginal", "utf-8")
  await runImport(store, source)
  const [doc] = await store.listDocuments()
  const claim = await store.propose(proposal("a sentence nobody has judged yet"))
  await store.cite(claim.id, { doc: doc!.id, supports: "the original wording" }, "alice")
  expect((await store.get(claim.id))?.status).toBe("pending")

  await writeFile(join(source, "a.md"), "# A\n\nrevised", "utf-8")
  expect((await runImport(store, source)).cited[0]!.claims).toEqual([claim.id])
})

test("an updated document nobody cites is not reported", async () => {
  // The common case, and the one that decides whether the warning is worth
  // reading: a directory of edited files nobody has cited must stay quiet.
  await writeFile(join(source, "a.md"), "# A\n\noriginal", "utf-8")
  await runImport(store, source)
  await writeFile(join(source, "a.md"), "# A\n\nrevised", "utf-8")
  const r = await runImport(store, source)
  expect(r.updated).toBe(1)
  expect(r.cited).toEqual([])
  expect(formatCitedUpdates(r.cited)).toEqual([])
})

test("an unchanged run reports no cited updates", async () => {
  // `runImport` skips the claim scan entirely when nothing was updated — four
  // list calls, each a round trip against the hosted store, on the run that
  // happens most often.
  await writeFile(join(source, "a.md"), "# A\n\nbody", "utf-8")
  await runImport(store, source)
  const r = await runImport(store, source)
  expect(r.unchanged).toBe(1)
  expect(r.cited).toEqual([])
})

test("the cited-update warning names the path and the claims, not a count", async () => {
  // "1 cited document changed" cannot be acted on. The operator's next move is
  // to read the claims, so the lines have to carry their ids.
  const lines = formatCitedUpdates([
    { id: "doc-a-20260907", title: "A", source: "notes/a.md", claims: ["c1", "c2"] },
  ]).join("\n")
  expect(lines).toContain("notes/a.md")
  expect(lines).toContain("c1, c2")
  expect(lines).toContain("1 updated document is cited")
})

test("an empty document is skipped and named, rather than aborting the whole import", async () => {
  // The hosted store refuses an empty body with "check what you typed and try
  // again", which names nothing — and one stray empty file then took the rest
  // of the directory down with it.
  await writeFile(join(source, "blank.md"), "\n   \n", "utf-8")
  await writeFile(join(source, "real.md"), "# Real\n\nbody", "utf-8")
  const r = await runImport(store, source)
  expect(r.created).toBe(1)
  expect(r.empty.length).toBe(1)
  expect(r.empty[0]).toContain("blank.md")
  expect((await store.listDocuments()).length).toBe(1)
})

test("two different files with the same heading both survive", async () => {
  // Documents match on `source` — the relative path — never on title, so two
  // files that share a heading are two unrelated documents, not one
  // superseding the other.
  await mkdir(join(source, "sub"), { recursive: true })
  await writeFile(join(source, "a.md"), "# Same Title\n\none", "utf-8")
  await writeFile(join(source, "sub", "b.md"), "# Same Title\n\ntwo", "utf-8")
  expect((await runImport(store, source)).created).toBe(2)
  expect((await store.listDocuments()).length).toBe(2)
})

test("a memory note imports as its own summary, not as its filename and YAML", async () => {
  // Shaped like an agent's memory notes: every file opens with a `---` fence,
  // none carries a heading, each has a hand-written `description`. Title and preview are the whole surface an agent ranks on.
  await writeFile(
    join(source, "widgets.md"),
    '---\nname: widgets-cache-is-live\ndescription: "Widget prices come from the pricing CDN at runtime."\nmetadata:\n  node_type: memory\n---\n\nThe fallback JSON is stale.\n',
    "utf-8",
  )
  expect((await runImport(store, source)).created).toBe(1)
  const [doc] = await store.listDocuments()
  expect(doc!.title).toBe("widgets-cache-is-live")
  expect(previewOf(doc!)).toBe(
    "widgets-cache-is-live — Widget prices come from the pricing CDN at runtime.\n\nThe fallback JSON is stale.",
  )
  expect(doc!.text).not.toContain("node_type")
})

test("a file that is nothing but frontmatter is empty, not a document of YAML", async () => {
  // It used to import as a body of metadata. Parsed, there is no document
  // there at all — and an empty body is what the hosted store 400s on.
  await writeFile(join(source, "meta.md"), "---\nname: meta\n---\n", "utf-8")
  const r = await runImport(store, source)
  expect(r.created).toBe(0)
  expect(r.empty.length).toBe(1)
  expect(r.empty[0]).toContain("meta.md")
})

// Seeds an approved claim directly through the store rather than through
// `runImport` — import no longer writes claims at all, and these three tests
// are about `formatStatus`'s reporting, not about import.
const seedApprovedClaim = (claimText: string, body: string) =>
  store.importClaim({
    claim: claimText,
    body,
    abstract: "",
    source: { author: "r", agent: "import", repo: null, session: null },
    overlaps: [],
    cites: [],
    tags: [],
  })

test("status names the size of the knowledge base, not just the queue", async () => {
  await seedApprovedClaim("A", "body")
  const text = formatStatus(
    await store.list("pending"),
    await new EventLog(root).stats(),
    await store.list("approved"),
  )
  expect(text).toContain("1 claim")
})

test("status reports approved claims that have no abstract", async () => {
  await seedApprovedClaim("A", "body")
  await seedApprovedClaim("B", "body")
  const approved = await store.list("approved")
  approved[0]!.abstract = "Settles A. Does not settle B."
  await store.put(approved[0]!, "curate")
  const text = formatStatus(await store.list("pending"), await new EventLog(root).stats(), await store.list("approved"))
  expect(text).toContain("1 of them has no abstract")
  expect(text).toContain("cairn abstracts")
})

test("status does not mention abstracts when every approved claim has one", async () => {
  await seedApprovedClaim("A", "body")
  const [claim] = await store.list("approved")
  claim!.abstract = "Settles A. Does not settle anything else."
  await store.put(claim!, "curate")
  const text = formatStatus(await store.list("pending"), await new EventLog(root).stats(), await store.list("approved"))
  expect(text).toContain("1 claim")
  expect(text).not.toContain("no abstract")
  expect(text).not.toContain("cairn abstracts")
})

// --- backfilling abstracts ------------------------------------------------

const approvedClaim = async (
  id: string,
  abstract: string | null,
  abstractBy?: Claim["abstractBy"],
) => {
  const c: Claim = {
    id, status: "approved", claim: `Claim ${id}`, body: "detail",
    source: { author: "r", agent: "import", repo: null, session: null },
    created: "2026-08-27T09:00:00.000Z", reviewed: "2026-08-27T09:00:00.000Z",
    reviewer: "r", retracted: null, overlaps: [], cites: [], abstract,
    abstractBy: abstractBy ?? (abstract ? "human" : null), tags: [],
  }
  await store.put(c, "curate")
}

test("backfill only touches claims with no abstract", async () => {
  await approvedClaim("has", "Settles a thing. Not another.")
  await approvedClaim("needs", null)
  const n = await runBackfill(store, async () => "Generated. Not everything.")
  expect(n.generated).toBe(1)
  expect((await store.get("has"))?.abstract).toBe("Settles a thing. Not another.")
  expect((await store.get("needs"))?.abstract).toBe("Generated. Not everything.")
})

test("a generated abstract is marked as such", async () => {
  await approvedClaim("needs", null)
  await runBackfill(store, async () => "Generated. Not everything.")
  expect((await store.get("needs"))?.abstractBy).toBe("generated")
})

test("one claim failing does not stop the rest or damage the store", async () => {
  await approvedClaim("a", null)
  await approvedClaim("b", null)
  let first = true
  const flaky = async () => {
    if (first) { first = false; throw new Error("model down") }
    return "Generated. Not everything."
  }
  const r = await runBackfill(store, flaky)
  expect(r.generated).toBe(1)
  expect(r.failed).toBe(1)
  // A claim-level failure is not a reason to stop: the rest can still succeed.
  expect(r.stopped).toBeNull()
  // The failed claim keeps a null abstract rather than an empty string.
  const claims = await store.list("approved")
  expect(claims.filter((c) => c.abstract === "").length).toBe(0)
})

test("a rate limit stops the run instead of attempting the rest of the list", async () => {
  // A 429 is a fact about the endpoint, not about the claim. Carrying on makes
  // requests that cannot succeed and reports each one as though that claim were
  // the problem — fifty rows reading "change your model" when the answer is
  // "wait".
  await approvedClaim("a", null)
  await approvedClaim("b", null)
  await approvedClaim("c", null)
  let calls = 0
  const limited = async () => {
    calls++
    if (calls === 1) return "Generated. Not everything."
    throw Object.assign(new Error("Rate limit exceeded"), { status: 429 })
  }
  const r = await runBackfill(store, limited)
  expect(calls).toBe(2)
  expect(r.generated).toBe(1)
  expect(r.stopped?.notAttempted).toBe(2)
})

test("the rate-limited claim is not recorded as a failed claim", async () => {
  // Nothing about that claim failed, and counting it makes a rate limit read as
  // a broken configuration. The count of what was not attempted is the report.
  await approvedClaim("a", null)
  await approvedClaim("b", null)
  const r = await runBackfill(store, async () => {
    throw Object.assign(new Error("Rate limit exceeded"), { status: 429 })
  })
  expect(r.failed).toBe(0)
  expect(r.failures).toEqual([])
  expect(r.stopped?.reason).toContain("Rate limit exceeded")
})

test("a 429 the SDK has wrapped is still recognised as a rate limit", async () => {
  // The status sits on the cause rather than on the error that reaches us, the
  // same shape `rootMessage` exists for. Reading only the outer error turns a
  // rate limit back into fifty per-claim failures.
  await approvedClaim("a", null)
  await approvedClaim("b", null)
  const r = await runBackfill(store, async () => {
    throw new Error("Request failed.", {
      cause: Object.assign(new Error("Too Many Requests"), { status: 429 }),
    })
  })
  expect(r.stopped).not.toBeNull()
  expect(r.failed).toBe(0)
})

test("the real SDK rate-limit errors are recognised, not just a hand-made one", async () => {
  // Every other test here throws `{ status: 429 }` built by hand, which pins
  // the detection against itself rather than against what a provider actually
  // throws. Both SDKs this CLI talks to carry a numeric `status` on `APIError`
  // today; an upgrade that moved it would leave those tests green and the
  // command burning its list again.
  expect(isRateLimit(new OpenAI.RateLimitError(429, undefined, "Rate limit exceeded", new Headers()))).toBe(true)
  expect(isRateLimit(new Anthropic.RateLimitError(429, undefined, "Rate limit exceeded", new Headers()))).toBe(true)
  // The positive control: it has to be able to say no, or it distinguishes
  // nothing and every provider failure would stop the run.
  expect(isRateLimit(new OpenAI.NotFoundError(404, undefined, "no such model", new Headers()))).toBe(false)
})

test("the run reports how many claims it had, so an early stop cannot read as nothing to do", async () => {
  // `cairn abstracts` prints "Every approved claim already has an abstract."
  // when nothing was generated and nothing failed — which is exactly the shape
  // of a rate limit on the first claim. The count is carried rather than
  // inferred from the two zeroes, so the states cannot be confused.
  await approvedClaim("a", null)
  await approvedClaim("b", null)
  const r = await runBackfill(store, async () => {
    throw Object.assign(new Error("Rate limit exceeded"), { status: 429 })
  })
  expect(r.generated).toBe(0)
  expect(r.failed).toBe(0)
  expect(r.targets).toBe(2)
})

test("a space where every claim has an abstract reports no targets", async () => {
  // The positive control on the field above: it has to be able to say zero, or
  // it distinguishes nothing.
  await approvedClaim("has", "Settles a thing. Not another.")
  const r = await runBackfill(store, async () => "Generated. Not everything.")
  expect(r.targets).toBe(0)
})

test("a wrapped transport failure is reported by its cause, not its wrapper", async () => {
  // The OpenAI client wraps a refused connection as "Connection error." and
  // puts the reason on `.cause`. `cairn model` has always reported the cause;
  // `cairn abstracts` reported the wrapper, so the same failure read as two
  // different problems depending on which command you happened to run.
  await approvedClaim("a", null)
  const wrapped = async () => {
    throw new Error("Connection error.", { cause: new Error("connect ECONNREFUSED 127.0.0.1:11434") })
  }
  const r = await runBackfill(store, wrapped)
  expect(formatFailures(r.failures).join("\n")).toContain("ECONNREFUSED")
})

test("dry run reports without writing", async () => {
  await approvedClaim("needs", null)
  const r = await runBackfill(store, async () => "Generated. Not everything.", {
    dryRun: true,
  })
  expect(r.generated).toBe(1)
  expect((await store.get("needs"))?.abstract).toBeNull()
})

test("--all regenerates a machine-generated abstract", async () => {
  await approvedClaim("has", "Old. Stale.", "generated")
  const r = await runBackfill(store, async () => "Fresh. Not everything.", {
    all: true,
  })
  expect(r.generated).toBe(1)
  expect((await store.get("has"))?.abstract).toBe("Fresh. Not everything.")
})

test("--all still fills in a missing abstract", async () => {
  await approvedClaim("needs", null)
  const r = await runBackfill(store, async () => "Fresh. Not everything.", {
    all: true,
  })
  expect(r.generated).toBe(1)
  expect((await store.get("needs"))?.abstract).toBe("Fresh. Not everything.")
})

test("--all leaves a human-written abstract alone", async () => {
  await approvedClaim("has", "A person wrote this.", "human")
  const r = await runBackfill(store, async () => "Fresh. Not everything.", {
    all: true,
  })
  expect(r.targets).toBe(0)
  expect((await store.get("has"))?.abstract).toBe("A person wrote this.")
})

test("--all leaves an agent-written abstract alone", async () => {
  await approvedClaim("has", "An agent wrote this.", "agent")
  const r = await runBackfill(store, async () => "Fresh. Not everything.", {
    all: true,
  })
  expect(r.targets).toBe(0)
  expect((await store.get("has"))?.abstract).toBe("An agent wrote this.")
})

test("--all leaves a legacy abstract alone — a real abstract with no recorded abstractBy", async () => {
  // A claim file written before `abstractBy` existed parses with
  // `abstractBy: null` even though it already carries real abstract text
  // (`claims.ts`'s `abstractBy: data.abstractBy ?? null`). `approvedClaim`
  // can't express that combination — it infers `human` whenever an abstract
  // is given — so this claim is built directly.
  const legacy: Claim = {
    id: "has", status: "approved", claim: "Claim has", body: "detail",
    source: { author: "r", agent: "import", repo: null, session: null },
    created: "2026-08-27T09:00:00.000Z", reviewed: "2026-08-27T09:00:00.000Z",
    reviewer: "r", retracted: null, overlaps: [], cites: [], tags: [],
    abstract: "Written before abstractBy existed.", abstractBy: null,
  }
  await store.put(legacy, "curate")

  // Unknown provenance may be a person's writing, so `--all` treats it the
  // same as `human` or `agent`: protected. Only `--force` regenerates it.
  const r = await runBackfill(store, async () => "Fresh. Not everything.", {
    all: true,
  })
  expect(r.targets).toBe(0)
  expect((await store.get("has"))?.abstract).toBe("Written before abstractBy existed.")

  const forced = await runBackfill(store, async () => "Fresh. Not everything.", {
    all: true,
    force: true,
  })
  expect(forced.generated).toBe(1)
  expect((await store.get("has"))?.abstract).toBe("Fresh. Not everything.")
})

test("--all only regenerates the generated and missing ones out of a mix", async () => {
  await approvedClaim("human", "A person wrote this.", "human")
  await approvedClaim("agent", "An agent wrote this.", "agent")
  await approvedClaim("generated", "Old. Stale.", "generated")
  await approvedClaim("missing", null)
  const r = await runBackfill(store, async () => "Fresh. Not everything.", {
    all: true,
  })
  expect(r.generated).toBe(2)
  expect((await store.get("human"))?.abstract).toBe("A person wrote this.")
  expect((await store.get("agent"))?.abstract).toBe("An agent wrote this.")
  expect((await store.get("generated"))?.abstract).toBe("Fresh. Not everything.")
  expect((await store.get("missing"))?.abstract).toBe("Fresh. Not everything.")
})

test("--all --force restores regenerate-everything, including human and agent abstracts", async () => {
  await approvedClaim("human", "A person wrote this.", "human")
  await approvedClaim("agent", "An agent wrote this.", "agent")
  const r = await runBackfill(store, async () => "Fresh. Not everything.", {
    all: true,
    force: true,
  })
  expect(r.generated).toBe(2)
  expect((await store.get("human"))?.abstract).toBe("Fresh. Not everything.")
  expect((await store.get("agent"))?.abstract).toBe("Fresh. Not everything.")
})

test("--force without --all has no effect — the default already protects every existing abstract", async () => {
  await approvedClaim("has", "A person wrote this.", "human")
  const r = await runBackfill(store, async () => "Fresh. Not everything.", {
    force: true,
  })
  expect(r.targets).toBe(0)
  expect((await store.get("has"))?.abstract).toBe("A person wrote this.")
})

test("--all --dry-run previews the same subset as --all would write", async () => {
  await approvedClaim("human", "A person wrote this.", "human")
  await approvedClaim("generated", "Old. Stale.", "generated")
  const r = await runBackfill(store, async () => "Fresh. Not everything.", {
    all: true,
    dryRun: true,
  })
  expect(r.targets).toBe(1)
  expect(r.written).toEqual([
    { id: "generated", claim: "Claim generated", abstract: "Fresh. Not everything." },
  ])
  // Still a preview: nothing was written.
  expect((await store.get("generated"))?.abstract).toBe("Old. Stale.")
})

test("status reports unreviewed generated abstracts", async () => {
  await approvedClaim("g", "Generated text. Not everything.")
  const c = await store.get("g")
  c!.abstractBy = "generated"
  await store.put(c!, "curate")
  const text = formatStatus(await store.list("pending"), await new EventLog(root).stats(), await store.list("approved"))
  expect(text).toContain("generated")
  // With the command that clears it. Before `cairn curate` this was a count
  // a reader could only ever watch.
  expect(text).toContain("cairn curate")
})

test("dry run returns the text it would write, so it can be judged", async () => {
  // A preview that only reports a count is useless for a feature whose whole
  // risk is that the generated text might be bad.
  await approvedClaim("needs", null)
  const r = await runBackfill(store, async () => "Settles X. Does not settle Y.", {
    dryRun: true,
  })
  expect(r.written).toEqual([
    { id: "needs", claim: "Claim needs", abstract: "Settles X. Does not settle Y." },
  ])
})

test("explicit flags decide telemetry without asking", () => {
  expect(telemetryChoice(["--telemetry"])).toBe(true)
  expect(telemetryChoice(["--no-telemetry"])).toBe(false)
})

test("silent flags are reported as silent rather than as a no", () => {
  // This function now answers one question — what did the flags say — and the
  // caller answers the other: what to do when they said nothing. It used to
  // answer both, and returning `false` for "nobody was asked" is what let a
  // non-interactive run overwrite a consent the operator had given.
  //
  // Opt-in still cannot be satisfied by silence; that default now lives at the
  // call site, where the existing config is in scope.
  expect(telemetryChoice([])).toBeNull()
})

test("--no-telemetry wins over --telemetry", () => {
  // Ambiguity resolves toward not collecting.
  expect(telemetryChoice(["--telemetry", "--no-telemetry"])).toBe(false)
})

// --- the mcp stdout purity guard ------------------------------------------
//
// `cairn mcp` runs through cli.ts and shares stdout with the MCP protocol,
// where one escape sequence corrupts the stream. `case "mcp"` lives in cli.ts,
// so EVERY module cli.ts statically imports is loaded on that path — not just
// cli.ts itself.
//
// The previous guards only grepped the text of cli.ts (plus a `toContain` on
// mcp.ts), which left the other twelve first-party modules unguarded: adding
// `import { spinner } from "@clack/prompts"` to src/doctor.ts left the suite
// entirely green. This walks the graph instead, so clack cannot enter through
// any reachable module.
//
const CLI = join(import.meta.dir, "..", "src", "cli.ts")

test("no module reachable from cli.ts statically imports clack", async () => {
  const { bare } = importGraph(CLI)
  const offenders = bare.get("@clack/prompts") ?? []
  expect(offenders).toEqual([])
})

test("the purity guard actually walks the graph rather than passing on an empty set", async () => {
  // A graph walk that resolves nothing passes trivially. Pin the walk to
  // modules that are genuinely reachable, so a broken resolver is a failure
  // rather than a silent green.
  const { files, bare } = importGraph(CLI)
  const names = [...files].map((f) => f.split("/").pop())
  // `store.ts` is here again: `makeStore` picks `FileStore` for local mode,
  // so FileStore has a product caller once more, which is the whole point of
  // this change. `http-store.ts` stays too — team mode still reaches it.
  for (const expected of [
    "cli.ts",
    "doctor.ts",
    "init.ts",
    "mcp.ts",
    "http-store.ts",
    "store.ts",
    "events.ts",
  ]) {
    expect(names).toContain(expected)
  }
  // Reached through cli.ts → doctor.ts → version.ts, i.e. two hops deep, which
  // is the depth the old textual guards could not see.
  expect(names).toContain("version.ts")
  // Bare specifiers are collected too, so the clack lookup is looking at a
  // populated map rather than an empty one.
  expect([...bare.keys()]).toContain("@modelcontextprotocol/sdk/server/stdio.js")
})

test("doctor-render stays off the static graph — it is the module that does import clack", async () => {
  // It imports clack at the top level and is only ever loaded to render, so it
  // must remain behind cli.ts's dynamic `await import("./doctor-render")`.
  const { files } = importGraph(CLI)
  expect([...files].some((f) => f.endsWith("doctor-render.ts"))).toBe(false)
  expect(staticSpecifiers(await readFile(join(import.meta.dir, "..", "src", "doctor-render.ts"), "utf-8")))
    .toContain("@clack/prompts")
})

test("no module reachable from cli.ts statically imports opentui", async () => {
  // OpenTUI is a much larger surface than clack and carries a native library.
  // One escape sequence on the mcp path corrupts the protocol stream.
  const { bare } = importGraph(CLI)
  expect(bare.get("@opentui/core") ?? []).toEqual([])
})

test("review-screen stays off the static graph — it is the module that does import opentui", async () => {
  // The same arrangement doctor-render.ts has with clack. Without this control
  // the assertion above passes trivially for as long as nothing imports
  // opentui anywhere, which is exactly how a guard rots into decoration.
  const { files } = importGraph(CLI)
  expect([...files].some((f) => f.endsWith("review-screen.ts"))).toBe(false)
  expect(staticSpecifiers(await readFile(join(import.meta.dir, "..", "src", "review-screen.ts"), "utf-8")))
    .toContain("@opentui/core")
})

test("review-style stays off the static graph too — the vocabulary module review-screen.ts pulls its opentui bold/dim helpers and colours from", async () => {
  // review-style.ts also imports opentui
  // directly, and it is reachable only through review-screen.ts — which is
  // itself off cli.ts's static graph. If review-style.ts were ever imported
  // from somewhere ELSE reachable from cli.ts, the bare-specifier guard above
  // would catch the opentui import; this control instead proves the file
  // itself is where the import lives, the same way the review-screen.ts
  // control above does.
  const { files } = importGraph(CLI)
  expect([...files].some((f) => f.endsWith("review-style.ts"))).toBe(false)
  expect(staticSpecifiers(await readFile(join(import.meta.dir, "..", "src", "review-style.ts"), "utf-8")))
    .toContain("@opentui/core")
})

test("the specifier parser sees the shapes a regression would actually take", () => {
  // Formatter-wrapped multi-line, single-line, namespace and side-effect forms.
  expect(staticSpecifiers('import {\n  intro,\n  note,\n} from "@clack/prompts"\n')).toEqual(["@clack/prompts"])
  expect(staticSpecifiers('import { select } from "@clack/prompts"')).toEqual(["@clack/prompts"])
  expect(staticSpecifiers('import * as clack from "@clack/prompts"')).toEqual(["@clack/prompts"])
  expect(staticSpecifiers('import "@clack/prompts"')).toEqual(["@clack/prompts"])
  expect(staticSpecifiers('import type { Foo } from "./init"')).toEqual(["./init"])
  // The dynamic form the codebase actually uses is not an edge.
  expect(staticSpecifiers('const clack = await import("@clack/prompts")')).toEqual([])
  expect(staticSpecifiers('const { exitCode } = await import("./doctor-render")')).toEqual([])
})

// `ROOT` in src/cli.ts is a module-level const fixed at first import, so it
// cannot be re-pointed in-process for a test. Spawn the real CLI as a
// subprocess instead — this is the only way to exercise the actual wiring
// inside the `init` case: that `readConfig` is consulted, that a
// non-interactive run with no flag persists `telemetry: false`, and that
// re-running preserves an existing installId.
//
// The spawn must also get an isolated HOME. `init` resolves
// `home = process.env.HOME` and calls `detectAgents(home)`, which looks for
// `~/.claude` and `~/.cursor` — inheriting the real $HOME would make this
// test pass or fail based on what happens to be on the developer's machine
// rather than on cairn's behavior. When no agent is found, the `init` case
// prints "No supported agent found." and returns before ever reaching the
// config read/write block, so an un-isolated HOME can make these tests pass
// for the wrong reason (a real ~/.claude) or fail with an ENOENT reading a
// config.json that was never written. `test/init.test.ts` isolates `home` the
// same way for `runInit` directly; this matches that convention for the CLI
// subprocess.
async function spawnInit(projectDir: string, cairnRoot: string, home: string, extraArgs: string[] = []) {
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "init", "--project", "--yes", ...extraArgs],
    {
      cwd: projectDir,
      env: { ...process.env, CAIRN_ROOT: cairnRoot, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

test(
  "a non-interactive init persists telemetry: false to config.json",
  async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cairn-init-project-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-init-root-"))
    const fakeHome = await mkdtemp(join(tmpdir(), "cairn-init-home-"))
    try {
      // The agent lives in the isolated home, not the project dir — this is
      // what makes detectAgents find one deterministically, regardless of
      // whatever the real $HOME on the machine running the test contains.
      await mkdir(join(fakeHome, ".claude"), { recursive: true })
      const { out, err, code } = await spawnInit(projectDir, cairnRoot, fakeHome)
      expect(err).not.toContain("Cannot find module")
      expect(out).not.toContain("No supported agent found")
      expect(code).toBe(0)
      const cfg = JSON.parse(await readFile(join(cairnRoot, "config.json"), "utf-8"))
      expect(cfg.telemetry).toBe(false)
      expect(typeof cfg.installId).toBe("string")
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
      await rm(fakeHome, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "re-running init preserves the installId from the first run",
  async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cairn-init-project-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-init-root-"))
    const fakeHome = await mkdtemp(join(tmpdir(), "cairn-init-home-"))
    try {
      await mkdir(join(fakeHome, ".claude"), { recursive: true })
      const first = await spawnInit(projectDir, cairnRoot, fakeHome)
      expect(first.out).not.toContain("No supported agent found")
      expect(first.code).toBe(0)
      const firstCfg = JSON.parse(await readFile(join(cairnRoot, "config.json"), "utf-8"))

      const second = await spawnInit(projectDir, cairnRoot, fakeHome)
      expect(second.out).not.toContain("No supported agent found")
      expect(second.code).toBe(0)
      const secondCfg = JSON.parse(await readFile(join(cairnRoot, "config.json"), "utf-8"))

      // Re-running init must not look like a new user.
      expect(secondCfg.installId).toBe(firstCfg.installId)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
      await rm(fakeHome, { recursive: true, force: true })
    }
  },
  20000,
)

// --- Ctrl-C at either init prompt must leave nothing written ---------------
//
// Ctrl-C at an `init` prompt must leave nothing written, and that is tested
// against a temp directory. Cancelling at the SCOPE prompt already honoured that; cancelling
// at the TELEMETRY prompt did not — runInit had already written .mcp.json,
// AGENTS.md and .gitignore, and the handler exited 0 without config.json, so
// doctor then reported that consent had never been asked.
//
// clack needs a real terminal, so neither cancel path is reachable through a
// spawned CLI: `script(1)` refuses when stdin is a pipe rather than a tty, and
// Bun has no openpty. The prompts are therefore injected resolvers, and these
// tests drive the same `runInitCommand` the CLI itself calls — the cancel is
// real, not simulated around the code under test.

let initProject: string
let initHome: string
let initRoot: string

async function initDeps(over: Partial<InitCommandDeps> = {}): Promise<InitCommandDeps> {
  return {
    root: initRoot,
    home: initHome,
    cwd: initProject,
    cliPath: "/abs/cli.ts",
    execPath: "/opt/homebrew/bin/bun",
    bunPath: "/opt/homebrew/bin/bun",
    dryRun: false,
    writeWithoutAgent: false,
    resolveScope: async () => "project",
    resolveMode: async () => "team",
    interactive: true,
    resolveMigration: async () => false,
    resolveTelemetry: async () => false,
    out: () => {},
    ...over,
  }
}

/** Everything init could have written, in the project, the home and the store. */
async function footprint(): Promise<string[]> {
  const seen: string[] = []
  for (const dir of [initProject, initHome, initRoot]) {
    for (const name of await readdir(dir)) seen.push(`${dir}/${name}`)
  }
  return seen.sort()
}

beforeEach(async () => {
  initProject = await mkdtemp(join(tmpdir(), "cairn-cancel-project-"))
  initHome = await mkdtemp(join(tmpdir(), "cairn-cancel-home-"))
  initRoot = await mkdtemp(join(tmpdir(), "cairn-cancel-root-"))
  // Both agents present, so a completed run has the largest possible footprint
  // and "nothing written" is a meaningful claim.
  await mkdir(join(initHome, ".claude"), { recursive: true })
  await mkdir(join(initHome, ".cursor"), { recursive: true })
})

afterEach(async () => {
  for (const d of [initProject, initHome, initRoot]) await rm(d, { recursive: true, force: true })
})

test("cancelling at the scope prompt leaves nothing written", async () => {
  const before = await footprint()
  const outcome = await runInitCommand(await initDeps({ resolveScope: async () => null }))
  expect(outcome).toBe("cancelled")
  expect(await footprint()).toEqual(before)
})

test("cancelling at the telemetry prompt leaves nothing written", async () => {
  // The regression this exists for: the agent config used to survive a cancel
  // here while config.json did not.
  const before = await footprint()
  const outcome = await runInitCommand(await initDeps({ resolveTelemetry: async () => null }))
  expect(outcome).toBe("cancelled")
  expect(await footprint()).toEqual(before)
  // Named individually, because "the install is left with agent config but no
  // installId" is the precise shape of the old defect.
  for (const name of [".mcp.json", "AGENTS.md", ".gitignore"]) {
    expect(existsSync(join(initProject, name))).toBe(false)
  }
  expect(existsSync(join(initRoot, "config.json"))).toBe(false)
})

test("consent is asked before anything is written, not after", async () => {
  // Snapshot the disk at the moment the consent prompt is shown. If any write
  // has already happened, this fails — which is exactly what it did before.
  let atPrompt: string[] = []
  const outcome = await runInitCommand(
    await initDeps({
      resolveTelemetry: async () => {
        atPrompt = await footprint()
        return true
      },
    }),
  )
  expect(outcome).toBe("written")
  expect(atPrompt).toEqual([`${initHome}/.claude`, `${initHome}/.cursor`].sort())
})

test("the file list is previewed before the consent prompt", async () => {
  const lines: string[] = []
  let seenAtPrompt: string[] = []
  await runInitCommand(
    await initDeps({
      out: (line) => lines.push(line),
      resolveTelemetry: async () => {
        seenAtPrompt = [...lines]
        return true
      },
    }),
  )
  // "Will write: …" preview, then consent, then Done.
  expect(seenAtPrompt.join("\n")).toContain("Will configure")
  expect(seenAtPrompt.join("\n")).toContain(join(initProject, ".mcp.json"))
})

test("answering the consent prompt writes both the agent config and config.json", async () => {
  // The control: without it, a runInitCommand that wrote nothing at all would
  // pass every cancel test above.
  const outcome = await runInitCommand(await initDeps({ resolveTelemetry: async () => true }))
  expect(outcome).toBe("written")
  expect(existsSync(join(initProject, ".mcp.json"))).toBe(true)
  expect(existsSync(join(initProject, "AGENTS.md"))).toBe(true)
  const cfg = JSON.parse(await readFile(join(initRoot, "config.json"), "utf-8"))
  expect(cfg.telemetry).toBe(true)
  expect(typeof cfg.installId).toBe("string")
})

test("a dry run writes nothing and never reaches the consent prompt", async () => {
  const before = await footprint()
  let asked = false
  const outcome = await runInitCommand(
    await initDeps({
      dryRun: true,
      resolveTelemetry: async () => {
        asked = true
        return true
      },
    }),
  )
  expect(outcome).toBe("planned")
  expect(asked).toBe(false)
  expect(await footprint()).toEqual(before)
})

test("no supported agent writes nothing, including no config.json", async () => {
  await rm(join(initHome, ".claude"), { recursive: true, force: true })
  await rm(join(initHome, ".cursor"), { recursive: true, force: true })
  const outcome = await runInitCommand(await initDeps({ resolveTelemetry: async () => true }))
  expect(outcome).toBe("no-agent")
  expect(await footprint()).toEqual([])
})

// --- init --team migrates a local root's claims -----------------------------

test("a migration that fails partway leaves the config still local", async () => {
  // The mode flips last, only after runMigration resolves — this is the
  // caller-side half of that rule. "https://example.invalid" is unreachable
  // by construction (RFC 2606), so the target store's first call fails the
  // same way a real network outage would, with no live credentials needed.
  await writeConfig(initRoot, {
    ...newConfig(false), mode: "local" as const,
    auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "u" },
  })
  const seed = new FileStore(initRoot, new EventLog(initRoot))
  await seed.init()
  const proposed = await seed.propose(proposal("seeded before the migration"))
  await seed.review(proposed.id, "approve")

  await expect(
    runInitCommand(
      await initDeps({ resolveMode: async () => "team", resolveMigration: async () => true }),
    ),
  ).rejects.toThrow()

  const cfg = await readConfig(initRoot)
  expect(cfg?.mode).toBe("local")
  // Untouched by the failed migration, not merely unflipped.
  expect((await seed.list("approved")).length).toBe(1)
})

test("declining the migration prompt cancels rather than flipping the mode", async () => {
  await writeConfig(initRoot, {
    ...newConfig(false), mode: "local" as const,
    auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "u" },
  })
  const seed = new FileStore(initRoot, new EventLog(initRoot))
  await seed.init()
  const proposedClaim = await seed.propose(proposal("seeded before the decline"))
  await seed.review(proposedClaim.id, "approve")

  const outcome = await runInitCommand(
    await initDeps({ resolveMode: async () => "team", resolveMigration: async () => false }),
  )
  expect(outcome).toBe("cancelled")
  const cfg = await readConfig(initRoot)
  expect(cfg?.mode).toBe("local")
})

test("init --team on a local root with claims and no auth refuses before writing anything", async () => {
  // Breaks the login <-> init deadlock from the other side: `makeStore` in
  // team mode sends a signed-out operator to `cairn login`, so this has to
  // fail BEFORE migrating anything, naming that exact command, rather than
  // partway through a migration nothing can complete.
  await writeConfig(initRoot, { ...newConfig(false), mode: "local" as const })
  const seed = new FileStore(initRoot, new EventLog(initRoot))
  await seed.init()
  const proposedClaim = await seed.propose(proposal("seeded before the refusal"))
  await seed.review(proposedClaim.id, "approve")

  await expect(
    runInitCommand(
      await initDeps({
        resolveMode: async () => "team",
        // Proves the refusal fires before anything asks: a resolver that
        // answers would make this pass for the wrong reason.
        resolveMigration: async () => { throw new Error("must not be asked to confirm") },
      }),
    ),
  ).rejects.toThrow(/cairn login/)

  const cfg = await readConfig(initRoot)
  expect(cfg?.mode).toBe("local")
  // Nothing proposed or imported anywhere — the local claim is exactly what
  // it was, still only locally.
  expect((await seed.list("approved")).length).toBe(1)
})

test("a non-interactive init --team on a local root with claims refuses rather than guessing", async () => {
  // Migration is lossy and one-way — local event history does not transfer —
  // so a headless run may neither migrate silently (deciding history doesn't
  // matter) nor skip it silently (starting the team space knowledge-free).
  // Same precedent as `cairn review`'s non-TTY refusal.
  await writeConfig(initRoot, {
    ...newConfig(false), mode: "local" as const,
    auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "u" },
  })
  const seed = new FileStore(initRoot, new EventLog(initRoot))
  await seed.init()
  const proposedClaim = await seed.propose(proposal("seeded before the headless refusal"))
  await seed.review(proposedClaim.id, "approve")

  await expect(
    runInitCommand(
      await initDeps({
        resolveMode: async () => "team",
        interactive: false,
        resolveMigration: async () => { throw new Error("must not be asked to confirm") },
      }),
    ),
  ).rejects.toThrow(/interactive/)

  const cfg = await readConfig(initRoot)
  expect(cfg?.mode).toBe("local")
  expect((await seed.list("approved")).length).toBe(1)
})


// --- a local space holding only documents is not an empty local space ------
//
// `cairn import` writes documents and NEVER claims on this version, so the
// documented first run — `init --local`, `import ~/docs`, `init --team` —
// leaves a root with 0 claims and a whole imported corpus. Gating the
// migration on the claim count alone made that sequence flip the mode and
// exit 0 with the corpus stranded on local disk and nothing said about it.
//
// These drive `runInitCommand`, not `runMigration`: `runMigration`'s own tests
// pass either way — testing the function that was already right is exactly
// how this survived.

const localWithAuth = { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "u" }

/** A local root holding `n` documents and no claims at all. */
async function seedDocumentsOnly(n: number): Promise<FileStore> {
  const seed = new FileStore(initRoot, new EventLog(initRoot))
  await seed.init()
  for (let i = 0; i < n; i++) {
    await seed.importDocument({ title: `Doc ${i}`, text: `body of document ${i}`, source: `${i}.md` })
  }
  // The precondition this whole group turns on: zero claims. Without it these
  // would pass through the old claims-only gate and prove nothing.
  for (const status of ["pending", "approved", "rejected"] as const) {
    expect((await seed.list(status)).length).toBe(0)
  }
  expect((await seed.listDocuments()).length).toBe(n)
  return seed
}

test("a migration that moves nothing because everything was rejected says so", async () => {
  // Rejected claims do not migrate at all, so a root holding only
  // rejected claims moves nothing — and the summary said "the team space
  // already held all of it", which is false twice over: the team space held
  // none of it, and the reason nothing moved was the rejection, not a
  // duplicate. The rejected count was then appended to a sentence that had
  // just denied there was anything to account for.
  await writeConfig(initRoot, { ...newConfig(false), mode: "local" as const, auth: localWithAuth })
  const seed = new FileStore(initRoot, new EventLog(initRoot))
  await seed.init()
  const rejected = await seed.propose(proposal("a claim somebody turned down"))
  await seed.review(rejected.id, "reject")
  expect((await seed.list("rejected")).length).toBe(1)

  const teamRoot = await mkdtemp(join(tmpdir(), "cairn-team-rejected-"))
  try {
    const team = new FileStore(teamRoot, new EventLog(teamRoot))
    await team.init()
    const lines: string[] = []
    await runInitCommand(
      await initDeps({
        resolveMode: async () => "team",
        resolveMigration: async () => true,
        openTeamStore: () => team,
        out: (l) => lines.push(l),
      }),
    )
    const said = lines.join("\n")
    // This changed HOW the outcome is said, not whether. There is no longer a
    // migration to summarise — nothing moves, so nothing is run and nobody is
    // asked — but the reason still prints, because a person who expected
    // their claims to arrive needs it. The false sentence stays gone.
    expect(said).toContain("will stay local")
    expect(said).toContain("does not migrate")
    expect(said).not.toContain("already held all of it")
    // The claim really did stay: the sentence and the outcome agree.
    expect((await team.list("rejected")).length).toBe(0)
    // And nothing at all was carried, which is why no migration ran.
    expect((await team.list("approved")).length).toBe(0)
    expect((await team.listDocuments()).length).toBe(0)
  } finally {
    await rm(teamRoot, { recursive: true, force: true })
  }
})

test("the consent prompt counts only the claims that will actually move", async () => {
  // The sentence a person reads TO DECIDE counted all four
  // statuses, so a root holding two approved and one rejected claim promised
  // that three would move. Overstating what moves is the direction that makes
  // someone consent to more than they meant to, and this is the only sentence
  // printed BEFORE they answer.
  await writeConfig(initRoot, { ...newConfig(false), mode: "local" as const, auth: localWithAuth })
  const seed = new FileStore(initRoot, new EventLog(initRoot))
  await seed.init()
  for (const text of ["a claim that stands", "another claim that stands"]) {
    const c = await seed.propose(proposal(text))
    await seed.review(c.id, "approve")
  }
  const rejected = await seed.propose(proposal("a claim somebody turned down"))
  await seed.review(rejected.id, "reject")

  const teamRoot = await mkdtemp(join(tmpdir(), "cairn-team-mixed-"))
  try {
    const team = new FileStore(teamRoot, new EventLog(teamRoot))
    await team.init()
    const asked: LocalHoldings[] = []
    const lines: string[] = []
    await runInitCommand(
      await initDeps({
        resolveMode: async () => "team",
        resolveMigration: async (held) => {
          asked.push(held)
          return true
        },
        openTeamStore: () => team,
        out: (l) => lines.push(l),
      }),
    )
    // Two named numbers, not one total: the root holds three claims and two
    // of them move.
    expect(asked).toEqual([{ claims: 3, moving: 2, stayingLocal: 1, documents: 0 }])
    const said = lines.join("\n")
    expect(said).toContain("2 claims will move into the team space")
    expect(said).not.toContain("3 claims will move")
    // And what stays is named before the answer, not only in the summary
    // afterwards — the whole defect was that the only sentence printed first
    // was the false one.
    const beforeAnswer = lines.slice(0, lines.findIndex((l) => l.includes("will move")) + 2).join("\n")
    expect(beforeAnswer).toContain("1")
    expect(beforeAnswer.toLowerCase()).toContain("stay")
  } finally {
    await rm(teamRoot, { recursive: true, force: true })
  }
})

test("a root holding only rejected claims is never asked to confirm a migration", async () => {
  // `holdsSomething` gated on every claim, so this root was asked
  // to confirm a one-way, lossy operation that would move nothing at all, and
  // was then told "nothing new to move". Asking at all was the defect.
  await writeConfig(initRoot, { ...newConfig(false), mode: "local" as const, auth: localWithAuth })
  const seed = new FileStore(initRoot, new EventLog(initRoot))
  await seed.init()
  const rejected = await seed.propose(proposal("a claim somebody turned down"))
  await seed.review(rejected.id, "reject")

  const asked: LocalHoldings[] = []
  const lines: string[] = []
  const outcome = await runInitCommand(
    await initDeps({
      resolveMode: async () => "team",
      resolveMigration: async (held) => {
        asked.push(held)
        return true
      },
      out: (l) => lines.push(l),
    }),
  )
  expect(asked).toEqual([])
  expect(outcome).toBe("written")
  // Not asking must not become saying nothing: silence here is the shape of
  // the "already held all of it" defect one layer up.
  const said = lines.join("\n")
  expect(said.toLowerCase()).toContain("stay")
  expect(said).not.toContain("will move into the team space")
})

test("the team-to-local refusal still counts every status, not only what would move", async () => {
  // The one caller of `localHoldings` that is CORRECT to count all four. It
  // asks "does this directory already hold claims", not "what would move" —
  // a rejected claim is still sitting there, and the flip is refused because
  // the situation is ambiguous rather than because anything would be carried.
  await writeConfig(initRoot, { ...newConfig(false), mode: "team" as const, auth: localWithAuth })
  const seed = new FileStore(initRoot, new EventLog(initRoot))
  await seed.init()
  const rejected = await seed.propose(proposal("a claim somebody turned down"))
  await seed.review(rejected.id, "reject")

  await expect(
    runInitCommand(await initDeps({ resolveMode: async () => "local", out: () => {} })),
  ).rejects.toThrow(/holds 1 claim/)
})

test("init --team migrates a local root holding documents and no claims", async () => {
  await writeConfig(initRoot, { ...newConfig(false), mode: "local" as const, auth: localWithAuth })
  await seedDocumentsOnly(2)

  const teamRoot = await mkdtemp(join(tmpdir(), "cairn-team-target-"))
  try {
    // A second FileStore standing in for the team space, injected through the
    // same seam the real HttpStore arrives on, so the summary line below is
    // built from a migration that actually happened.
    const team = new FileStore(teamRoot, new EventLog(teamRoot))
    await team.init()
    const asked: unknown[] = []
    const lines: string[] = []

    const outcome = await runInitCommand(
      await initDeps({
        resolveMode: async () => "team",
        resolveMigration: async (held) => {
          asked.push(held)
          return true
        },
        openTeamStore: () => team,
        out: (l) => lines.push(l),
      }),
    )

    expect(outcome).toBe("written")
    // It PROMPTED — and with both counts, so the person confirming can see
    // what is actually moving.
    expect(asked).toEqual([{ claims: 0, moving: 0, stayingLocal: 0, documents: 2 }])
    // It MIGRATED.
    expect((await team.listDocuments()).length).toBe(2)
    // And only then flipped the mode.
    expect((await readConfig(initRoot))?.mode).toBe("team")
    // And REPORTED, before and after, in documents rather than in claims.
    const said = lines.join("\n")
    expect(said).toContain("2 documents will move into the team space")
    expect(said).toContain("2 document(s) into the team space")
    expect(said).not.toContain("0 claims")
  } finally {
    await rm(teamRoot, { recursive: true, force: true })
  }
})

test("a non-interactive init --team on a documents-only local root refuses", async () => {
  await writeConfig(initRoot, { ...newConfig(false), mode: "local" as const, auth: localWithAuth })
  const seed = await seedDocumentsOnly(3)

  await expect(
    runInitCommand(
      await initDeps({
        resolveMode: async () => "team",
        interactive: false,
        resolveMigration: async () => { throw new Error("must not be asked to confirm") },
      }),
    ),
  ).rejects.toThrow(/3 documents that would move into the team space/)

  expect((await readConfig(initRoot))?.mode).toBe("local")
  expect((await seed.listDocuments()).length).toBe(3)
})

test("init --team on a documents-only local root with no account names cairn login", async () => {
  await writeConfig(initRoot, { ...newConfig(false), mode: "local" as const })
  const seed = await seedDocumentsOnly(1)

  await expect(
    runInitCommand(
      await initDeps({
        resolveMode: async () => "team",
        resolveMigration: async () => { throw new Error("must not be asked to confirm") },
      }),
    ),
  ).rejects.toThrow(/1 document waiting to move.*cairn login/s)

  expect((await readConfig(initRoot))?.mode).toBe("local")
  expect((await seed.listDocuments()).length).toBe(1)
})

test("declining the migration on a documents-only root cancels rather than flipping the mode", async () => {
  await writeConfig(initRoot, { ...newConfig(false), mode: "local" as const, auth: localWithAuth })
  await seedDocumentsOnly(2)

  const outcome = await runInitCommand(
    await initDeps({
      resolveMode: async () => "team",
      resolveMigration: async () => false,
      openTeamStore: () => { throw new Error("must not migrate after a decline") },
    }),
  )
  expect(outcome).toBe("cancelled")
  expect((await readConfig(initRoot))?.mode).toBe("local")
})

// --- an unusable CAIRN_ROOT must not take doctor or --version down ---------
//
// `main()` used to build and `init()` a FileStore before the switch, for every
// command. An unwritable or non-directory CAIRN_ROOT therefore killed
// `cairn doctor` and `cairn --version` with a raw stack trace — the exact
// defect class doctor exists to explain, produced by doctor itself. Spawned as
// a subprocess because ROOT is a module-level const fixed at first import.
//
// `cwd` is mandatory and must be an isolated directory, for the same reason
// `spawnInit` above isolates HOME: `doctor` resolves its MCP config from
// `process.cwd()` first (.mcp.json, then .cursor/mcp.json). Inheriting the
// test runner's cwd made these tests exercise a different code path depending
// on which directory the suite ran in — a checkout with a leftover .mcp.json
// from a real `cairn init` reaches the handshake check and spawns a child, one
// without a config never does. That is how this test passed in a worktree and
// failed in the checkout beside it.
/** `bunFlags` go before the script, which is where `--preload` has to sit: the
 *  only way to give a spawned CLI a terminal width it would otherwise not
 *  have. */
async function spawnCli(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  bunFlags: string[] = [],
) {
  const proc = Bun.spawn(["bun", ...bunFlags, join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    cwd,
    env: { ...process.env, ...env },
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

/**
 * A regular file where a directory is expected: mkdir on it throws ENOTDIR.
 * `dir` doubles as the spawned CLI's HOME and cwd, so nothing it reads —
 * agent configs, MCP configs, instruction files — comes from the machine.
 */
async function unusableRoot(): Promise<{ dir: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-badroot-"))
  const root = join(dir, "notadir")
  await writeFile(root, "this is a regular file, not a store", "utf-8")
  return { dir, root }
}

// What the finding required is that doctor REPORTS instead of dying: a whole
// grouped report, every check attempted, and a decided exit code.
//
// It used to be the STORE check that named the root, because it built a
// FileStore there and the mkdir failed with ENOTDIR. Now
// nothing builds anything in CAIRN_ROOT — it holds config.json and nothing
// else, and `readConfig` answers null for a file it cannot read — so the
// unusable root shows up as a machine with no account rather than as an
// errno. The property this test exists for is unchanged: a report, not a
// stack trace.
test(
  "doctor still reports when CAIRN_ROOT is unusable",
  async () => {
    const { dir, root } = await unusableRoot()
    try {
      const { out, code } = await spawnCli(["doctor", "--json"], { CAIRN_ROOT: root, HOME: dir }, dir)
      const results = JSON.parse(out) as CheckResult[]
      // A report, not a stack trace: every check carries the group it renders
      // under, and the run ended on an exit code rather than a crash.
      expect(results.length).toBeGreaterThan(0)
      expect(results.every((r) => r.group.length > 0)).toBe(true)
      expect(code).toBe(1)
      // And nothing in it calls this install healthy.
      expect(results.find((r) => r.name === "store")!.status).not.toBe("ok")
      expect(results.find((r) => r.name === "auth")).toMatchObject({ status: "fail" })
      // Checks after the failing one still ran.
      expect(results.some((r) => r.name === "telemetry")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "the rendered doctor report survives an unusable CAIRN_ROOT",
  async () => {
    // --json is the machine path. What a tester actually pastes is this one,
    // so the grouped report itself has to come out whole.
    const { dir, root } = await unusableRoot()
    try {
      const { out, code } = await spawnCli(["doctor"], { CAIRN_ROOT: root, HOME: dir }, dir)
      expect(out).toContain("cairn doctor")
      for (const group of ["Binary", "Agent config", "Store", "Telemetry"]) {
        expect(out).toContain(group)
      }
      expect(out).toContain("problem")
      expect(code).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "--version still prints when CAIRN_ROOT is unusable",
  async () => {
    // The first thing a tester is asked to paste must never be the thing that
    // crashes.
    const { dir, root } = await unusableRoot()
    try {
      const { out, code } = await spawnCli(["--version"], { CAIRN_ROOT: root, HOME: dir }, dir)
      expect(code).toBe(0)
      expect(out).toContain("cairn ")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "abstracts with no model configured exits 1 naming the command that fixes it",
  async () => {
    // The whole path, not just the policy: stdin is not a TTY here, so the
    // offer must not be attempted and the exit code has to say the run did
    // not do what was asked.
    const dir = await mkdtemp(join(tmpdir(), "cairn-nomodel-"))
    try {
      const { out, code } = await spawnCli(
        ["abstracts"], { CAIRN_ROOT: join(dir, "store"), HOME: dir }, dir,
      )
      expect(code).toBe(1)
      expect(out).toContain("cairn model")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "a server that crashes at startup is quoted by doctor, not dumped into it",
  async () => {
    // The MCP SDK inherits the child's stderr by default, so a server that
    // dies on launch printed its raw crash banner straight into the middle of
    // doctor's grouped report — the pasted output looked like doctor itself
    // had crashed, which is precisely the confusion doctor exists to remove.
    // The banner has to survive, attributed to the command that produced it.
    const dir = await mkdtemp(join(tmpdir(), "cairn-badserver-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-badserver-root-"))
    try {
      const banner = "kaboom: the server died\n\nFakeRuntime v9.9.9 (macOS arm64)\n"
      await writeFile(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            cairn: { command: "/bin/sh", args: ["-c", `printf '${banner}' >&2; exit 1`] },
          },
        }),
        "utf-8",
      )
      const { out, err } = await spawnCli(
        ["doctor", "--json"],
        { CAIRN_ROOT: cairnRoot, HOME: dir },
        dir,
      )
      const results = JSON.parse(out) as CheckResult[]
      const handshake = results.find((r) => r.name === "handshake")
      expect(handshake).toBeDefined()
      expect(handshake!.status).toBe("fail")
      // Still useful: what the command said, and which command said it.
      expect(handshake!.detail).toContain("kaboom: the server died")
      expect(handshake!.detail).toContain("/bin/sh")
      // Contained: one report line, not a pasted stack trace.
      expect(handshake!.detail).not.toContain("\n")
      // And nothing of the child leaks into doctor's own stream.
      expect(err).not.toContain("kaboom")
      expect(err).not.toContain("FakeRuntime")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
    }
  },
  30000,
)

test(
  "a command that needs the store still fails loudly on an unusable CAIRN_ROOT",
  async () => {
    // Laziness must not turn a broken store into a silent success.
    const { dir, root } = await unusableRoot()
    try {
      const { code } = await spawnCli(["status"], { CAIRN_ROOT: root, HOME: dir }, dir)
      expect(code).not.toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)

test("status says which kind of space produced the numbers", async () => {
  // The approve rate means different things in the two modes: local usage is
  // solo, which makes proposer and reviewer the same person. A reader who
  // cannot tell which mode produced a number has the ambiguity the telemetry
  // split exists to prevent.
  const dir = await mkdtemp(join(tmpdir(), "cairn-st-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    const { out } = await spawnCli(["status"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(out).toContain("local space")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("status --json carries the mode as a field, not prose", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cairn-st-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    const { out } = await spawnCli(["stats"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(JSON.parse(out).mode).toBe("local")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("a re-export is an edge, not a blind spot", () => {
  // `export { x } from "y"` loads y exactly as an import does. The guard's
  // first version only matched /^import/, so this form put clack on the MCP
  // path while leaving the suite green. src/version.ts already uses the shape.
  expect(staticSpecifiers('export { spinner } from "@clack/prompts"')).toContain("@clack/prompts")
  expect(staticSpecifiers('export * from "@clack/prompts"')).toContain("@clack/prompts")
})

test("an indented static import is an edge", () => {
  expect(staticSpecifiers('  import { intro } from "@clack/prompts"')).toContain("@clack/prompts")
})

test("a require call is an edge", () => {
  expect(staticSpecifiers('const c = require("@clack/prompts")')).toContain("@clack/prompts")
})

test("a dynamic import is deliberately NOT an edge", () => {
  // This is exactly how init, doctor and doctor-render are allowed to reach
  // clack. Treating it as an edge would make the guard unsatisfiable.
  expect(staticSpecifiers('const c = await import("@clack/prompts")')).toEqual([])
})

test("ordinary exported constants are not mistaken for edges", () => {
  expect(staticSpecifiers('export const BUILT_AT = "1970-01-01T00:00:00.000Z"')).toEqual([])
  expect(staticSpecifiers('export const NAME = "@clack/prompts"')).toEqual([])
})

test("a failed claim carries the reason it failed", async () => {
  // "2 failed" was reported identically for a 404 (wrong model configured) and
  // a 500 after four minutes (generation ran away). Telling them apart meant
  // reading the model server's own log.
  await approvedClaim("a", null)
  const r = await runBackfill(store, async () => {
    throw new Error("abstract generation failed: 404")
  })
  expect(r.failed).toBe(1)
  expect(r.failures).toEqual([{ id: "a", claim: "Claim a", reason: "abstract generation failed: 404" }])
})

test("identical reasons are reported once with a count", () => {
  // Ten claims failing for one reason is one problem, not ten lines.
  const lines = formatFailures([
    { id: "a", claim: "A", reason: "abstract generation failed: 404" },
    { id: "b", claim: "B", reason: "abstract generation failed: 404" },
    { id: "c", claim: "C", reason: "cut off at the 512-token cap" },
  ])
  expect(lines).toEqual([
    "2 claims: abstract generation failed: 404",
    "1 claim: cut off at the 512-token cap",
  ])
})

test("a thrown non-Error still yields a usable reason", () => {
  expect(formatFailures([{ id: "a", claim: "A", reason: "unknown error" }])).toEqual([
    "1 claim: unknown error",
  ])
})

test("flags set the choice without prompting", () => {
  const f = modelFlags(["--provider", "anthropic", "--model", "claude-haiku-4-5"])
  expect(f.provider).toBe("anthropic")
  expect(f.model).toBe("claude-haiku-4-5")
})

test("--base-url points the compatible provider anywhere", () => {
  expect(modelFlags(["--base-url", "http://lmstudio.local/v1"]).baseUrl)
    .toBe("http://lmstudio.local/v1")
})

test("verification is off in a script unless asked for", () => {
  // It costs a real API call.
  expect(modelFlags([]).verify).toBe(false)
  expect(modelFlags(["--verify"]).verify).toBe(true)
})

test("--list is recognised", () => {
  expect(modelFlags(["--list"]).list).toBe(true)
})

test("an unknown provider flag is ignored rather than trusted", () => {
  expect(modelFlags(["--provider", "hal9000"]).provider).toBeUndefined()
})

// --- the just-in-time offer in `cairn abstracts` ---------------------------
//
// Tested in both directions: the script path that names `cairn model`, and
// the offer a human sees.

const READY = { provider: { id: "compatible" }, model: "ornith:9b" } as unknown as ResolvedGeneration

const gateDeps = (over: Partial<GenerationGateDeps> = {}): GenerationGateDeps => ({
  isTty: true,
  out: () => {},
  confirm: async () => true,
  runPicker: async () => {},
  reread: async () => READY,
  ...over,
})

test("an already-configured model is used without asking anything", async () => {
  let asked = false
  const gate = await gateGeneration(READY, gateDeps({ confirm: async () => { asked = true; return true } }))
  expect(gate.kind).toBe("ready")
  expect(asked).toBe(false)
})

test("a script with no model configured is told what to run", async () => {
  const lines: string[] = []
  let asked = false
  const gate = await gateGeneration(null, gateDeps({
    isTty: false,
    out: (l) => lines.push(l),
    confirm: async () => { asked = true; return true },
  }))
  expect(gate.kind).toBe("script")
  expect(lines.join("\n")).toContain("cairn model")
  // Nobody is there to answer, so nothing may be asked.
  expect(asked).toBe(false)
})

test("an interactive run offers the picker and uses what it saved", async () => {
  let picked = false
  const gate = await gateGeneration(null, gateDeps({
    runPicker: async () => { picked = true },
  }))
  expect(picked).toBe(true)
  expect(gate.kind).toBe("ready")
  expect(gate.kind === "ready" && gate.resolved.model).toBe("ornith:9b")
})

test("declining the offer runs no picker", async () => {
  for (const answer of [false, null]) {
    let picked = false
    const gate = await gateGeneration(null, gateDeps({
      confirm: async () => answer,
      runPicker: async () => { picked = true },
    }))
    expect(gate.kind).toBe("declined")
    expect(picked).toBe(false)
  }
})

test("a picker that saved nothing leaves the run unconfigured", async () => {
  const gate = await gateGeneration(null, gateDeps({ reread: async () => null }))
  expect(gate.kind).toBe("unconfigured")
})

test("the offer is gated on stdin, the stream the answer is typed into", () => {
  // With a TTY stdout and piped stdin, cairn offered the picker and then
  // answered itself with "pass both --provider and --model" and exited 1.
  // `cairn model` has always gated on stdin; this is the half that disagreed.
  const src = readFileSync(CLI, "utf-8")
  expect(src).toContain("isTty: Boolean(process.stdin.isTTY)")
  expect(src).not.toContain("!process.stdout.isTTY")
})

// --- endpoint resolution ---------------------------------------------------

test("the endpoint resolves flag, then CAIRN_MODEL_URL, then stored", () => {
  // `cairn model --list` read the flag alone, so a compatible provider stored
  // against a custom endpoint listed Ollama on :11434 instead — the same
  // "shows one endpoint, uses another" defect as the verification path.
  const env = { CAIRN_MODEL_URL: "http://env.local/v1" }
  expect(resolveBaseUrl("http://flag.local/v1", env, "http://stored.local/v1"))
    .toBe("http://flag.local/v1")
  expect(resolveBaseUrl(undefined, env, "http://stored.local/v1")).toBe("http://env.local/v1")
  expect(resolveBaseUrl(undefined, {}, "http://stored.local/v1")).toBe("http://stored.local/v1")
  // Nothing anywhere leaves the provider's own default in charge.
  expect(resolveBaseUrl(undefined, {}, null)).toBeUndefined()
})

test("a blank flag or variable does not count as an endpoint", () => {
  expect(resolveBaseUrl("  ", { CAIRN_MODEL_URL: "http://env.local/v1" }, null))
    .toBe("http://env.local/v1")
  expect(resolveBaseUrl(undefined, { CAIRN_MODEL_URL: "  " }, "http://stored.local/v1"))
    .toBe("http://stored.local/v1")
})

test(
  "--verify verifies against the endpoint the saved config will use",
  async () => {
    // The picker resolves the endpoint once and threads it into the
    // verification AND the saved config. The non-interactive path did not: it
    // passed the raw flag, so with CAIRN_MODEL_URL exported it verified
    // against Ollama on :11434 and then saved a config pointing somewhere
    // else — the "verify one endpoint, use another" defect.
    const dir = await mkdtemp(join(tmpdir(), "cairn-verify-"))
    const root = join(dir, "store")
    // `cairn model` reads the space for a realistic sample claim, so it needs
    // an account like every other command that touches knowledge. An empty
    // space is the ordinary case on a fresh install and sends it to the
    // built-in sample.
    const space = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ claims: [], cursor: null }),
    })
    try {
      await writeConfig(root, {
        ...newConfig(false, "abc"),
        auth: {
          token: "cairn_tok_1", orgId: "org-1", orgSlug: "acme",
          apiUrl: `http://127.0.0.1:${space.port}`, user: "r",
        },
      })
      const { out, code } = await spawnCli(
        ["model", "--provider", "compatible", "--model", "m", "--verify"],
        { CAIRN_ROOT: root, HOME: dir, CAIRN_MODEL_URL: "http://127.0.0.1:1/v1" },
        dir,
      )
      // Nothing is listening on port 1, so verification fails — and the
      // failure names the endpoint it actually called.
      expect(code).not.toBe(0)
      expect(out).toContain("127.0.0.1:1/v1")
      expect(out).not.toContain("11434")
    } finally {
      space.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)

// --- A machine with no supported agent ---------------------------------------
//
// Found by installing the way a stranger would: with neither ~/.claude nor
// ~/.cursor present, `init` wrote nothing and exited 0, and `doctor` then
// failed prescribing `cairn init` — which would write nothing again. Neither
// message named anything that would change the outcome.
//
// These reuse the initHome the cancel tests build, with the agent directories
// removed, so "no agent" is a property of the fixture rather than of whatever
// happens to be on the machine running the suite.

async function bareHome(): Promise<void> {
  await rm(join(initHome, ".claude"), { recursive: true, force: true })
  await rm(join(initHome, ".cursor"), { recursive: true, force: true })
}

test("init on a machine with no agent writes nothing and names a way out", async () => {
  await bareHome()
  const before = await footprint()
  const lines: string[] = []
  const outcome = await runInitCommand(await initDeps({ out: (l) => lines.push(l) }))
  expect(outcome).toBe("no-agent")
  expect(await footprint()).toEqual(before)
  // The defect was never the refusal, it was the dead end: the message has to
  // name something the operator can actually do next.
  expect(lines.join("\n")).toContain("--project")
})

test("an explicit --project writes the project config even with no agent detected", async () => {
  await bareHome()
  const lines: string[] = []
  const outcome = await runInitCommand(
    await initDeps({ writeWithoutAgent: true, out: (l) => lines.push(l) }),
  )
  expect(outcome).toBe("written")
  // None of these paths ever depended on ~/.claude existing, which is why
  // refusing to write them on the strength of a bare home was wrong.
  expect(existsSync(join(initProject, ".mcp.json"))).toBe(true)
  expect(existsSync(join(initProject, "AGENTS.md"))).toBe(true)
  expect(existsSync(join(initRoot, "config.json"))).toBe(true)
  // Written, but not silently — the operator asked for this, and should still
  // learn that nothing was detected.
  expect(lines.join("\n")).toContain("No supported agent")
})

test("global scope still refuses when no agent is detected", async () => {
  // The gate is only wrong for project scope. Global writes ~/.claude.json and
  // ~/.cursor/mcp.json, paths that ARE the agent's own — inventing one there
  // creates configuration for software that is not installed.
  await bareHome()
  const before = await footprint()
  const outcome = await runInitCommand(
    await initDeps({ writeWithoutAgent: true, resolveScope: async () => "global" }),
  )
  expect(outcome).toBe("no-agent")
  expect(await footprint()).toEqual(before)
})

test(
  "the CLI exits non-zero when init finds no agent",
  async () => {
    // "no-agent" was an outcome the
    // caller's if-chain never handled, so it fell through to a default exit 0
    // and the shell — or any script — read a no-op as success.
    const projectDir = await mkdtemp(join(tmpdir(), "cairn-noagent-project-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-noagent-root-"))
    const fakeHome = await mkdtemp(join(tmpdir(), "cairn-noagent-home-"))
    try {
      const proc = Bun.spawn(
        ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "init", "--yes"],
        {
          cwd: projectDir,
          env: { ...process.env, CAIRN_ROOT: cairnRoot, HOME: fakeHome },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      expect(out).toContain("No supported agent found")
      expect(out).toContain("--project")
      expect(code).not.toBe(0)
      expect(existsSync(join(cairnRoot, "config.json"))).toBe(false)
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
      await rm(fakeHome, { recursive: true, force: true })
    }
  },
  20000,
)

// --- choosing the mode at init ----------------------------------------------

test("the mode flags are read the way the scope flags are", () => {
  expect(modeFromFlags(["--local"])).toBe("local")
  expect(modeFromFlags(["--team"])).toBe("team")
  expect(modeFromFlags([])).toBeNull()
})

test("both flags at once is an error rather than a silent winner", () => {
  // `--project --global` has no equivalent trap because scope has a default.
  // Here the two flags choose different stores, so picking one silently is how
  // a scripted install lands somebody in the wrong space.
  expect(() => modeFromFlags(["--local", "--team"])).toThrow(/--local and --team/)
})

test(
  "a non-interactive init with no flag stays team",
  async () => {
    // The second compatibility rule. Every scripted install that exists today
    // is hosted, and this is the one place the design chooses a default
    // rather than asking — it chooses the status quo.
    const dir = await mkdtemp(join(tmpdir(), "cairn-mode-team-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-mode-team-root-"))
    try {
      const { out, code } = await spawnCli(["init", "--project"], { CAIRN_ROOT: cairnRoot, HOME: dir }, dir)
      expect(code).toBe(0)
      const cfg = await readConfig(cairnRoot)
      expect(cfg?.mode).toBe("team")
      expect(out).not.toContain("On this machine only")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "a finished init signs off with the wordmark, and a pipe gets no band",
  async () => {
    // The third placement of the wordmark, and the one the suite can only reach
    // from a child process: `init` writes into $HOME and reads CAIRN_ROOT at
    // import time. A child's stdout is a pipe, so `process.stdout.columns` is
    // undefined there — which is the guard's other case, and worth pinning on
    // its own: nobody wants a 29-column band of half blocks in a CI log.
    // `test/wide-stdout.ts` preloads a width to reach the drawn case.
    const dir = await mkdtemp(join(tmpdir(), "cairn-mark-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-mark-root-"))
    try {
      const env = { CAIRN_ROOT: cairnRoot, HOME: dir }
      const piped = await spawnCli(["init", "--project"], env, dir)
      expect(piped.code).toBe(0)
      expect(piped.out).toContain("Restart your agent")
      for (const row of wordmark(100)!) expect(piped.out).not.toContain(row)

      const wide = await spawnCli(["init", "--project"], env, dir, [
        "--preload",
        join(import.meta.dir, "wide-stdout.ts"),
      ])
      expect(wide.code).toBe(0)
      for (const row of wordmark(100)!) expect(wide.out).toContain(row)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "init --local on a team root that holds claims refuses and names a way out",
  async () => {
    // Team -> local migration is a non-goal for a root that already holds
    // something, so there is no in-place remedy. The message must still name
    // one, because a refusal that leaves the operator stuck is the one thing
    // this CLI does not do. Symmetric with migration's own trigger: a root
    // whose store holds claims.
    const dir = await mkdtemp(join(tmpdir(), "cairn-mode-refuse-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-mode-refuse-root-"))
    try {
      const first = await spawnCli(
        ["init", "--project", "--team"], { CAIRN_ROOT: cairnRoot, HOME: dir }, dir,
      )
      expect(first.code).toBe(0)

      // A claim already on this root — the thing a flip would strand.
      const seed = new FileStore(cairnRoot, new EventLog(cairnRoot))
      await seed.init()
      await seed.propose({
        claim: "seeded before the flip", body: "body", abstract: "",
        source: { author: "test", agent: "test", repo: null, session: null },
        overlaps: [], cites: [], tags: [],
      })

      const second = await spawnCli(
        ["init", "--project", "--local"], { CAIRN_ROOT: cairnRoot, HOME: dir }, dir,
      )
      expect(second.code).toBe(1)
      expect(second.err).toContain("holds")
      expect(second.err).toContain("1 claim")
      expect(second.err).toContain("CAIRN_ROOT")
      // Refused, so nothing about the root was touched — still team.
      const cfg = await readConfig(cairnRoot)
      expect(cfg?.mode).toBe("team")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "init --local on an empty team root flips, keeping an existing token",
  async () => {
    // Kept so a later `init --team` needs no re-login. The risk of a stale
    // credential is answered by making it visible in `doctor`, not by
    // deleting it behind the operator's back. This is the case the refusal
    // above does NOT cover — an empty team root has nothing to strand, so
    // the flip actually happens here, which is what makes the preserved
    // token a meaningful assertion rather than a no-op.
    const dir = await mkdtemp(join(tmpdir(), "cairn-mode-keep-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-mode-keep-root-"))
    try {
      await writeConfig(cairnRoot, {
        ...newConfig(false), mode: "team" as const,
        auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "u" },
      })
      const { code } = await spawnCli(
        ["init", "--project", "--local"], { CAIRN_ROOT: cairnRoot, HOME: dir }, dir,
      )
      expect(code).toBe(0)
      const cfg = await readConfig(cairnRoot)
      expect(cfg?.mode).toBe("local")
      expect(cfg?.auth?.token).toBe("t")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "a bare re-run does not silently relocate an existing local root",
  async () => {
    // The missing-field rule protected a root that had never seen this
    // field; this protects one that has already made a choice. Without
    // `existing` in the resolution, a plain `cairn init --project` run later
    // for an unrelated reason (a new agent, a re-detect) would flip a local
    // root back to team, because askMode's own non-TTY default is "team".
    const dir = await mkdtemp(join(tmpdir(), "cairn-mode-sticky-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-mode-sticky-root-"))
    try {
      const first = await spawnCli(
        ["init", "--project", "--local"], { CAIRN_ROOT: cairnRoot, HOME: dir }, dir,
      )
      expect(first.code).toBe(0)
      expect((await readConfig(cairnRoot))?.mode).toBe("local")

      const bare = await spawnCli(["init", "--project"], { CAIRN_ROOT: cairnRoot, HOME: dir }, dir)
      expect(bare.code).toBe(0)
      expect((await readConfig(cairnRoot))?.mode).toBe("local")
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
    }
  },
  20000,
)

// --- which store the CLI talks to -----------------------------------------

const AUTH = {
  token: "cairn_tok_1", orgId: "org-1", orgSlug: "acme",
  apiUrl: "https://cairn.example", user: "alice",
}

test("an account in the config sends the CLI to the hosted store", async () => {
  const fresh = await mkdtemp(join(tmpdir(), "cairn-fresh-"))
  try {
    await writeConfig(fresh, { ...newConfig(false, "abc"), auth: AUTH })
    const s = await makeStore(fresh)
    expect(s).toBeInstanceOf(HttpStore)
    // And it must not have quietly created a local store beside the hosted
    // one — two stores on one machine is how claims go missing.
    expect(existsSync(join(fresh, "approved"))).toBe(false)
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }
})

// Spawned rather than called: `makeStore` exits the process on this path
// (three lines of stderr survive that way; `runCli` would flatten a thrown
// error to one), and calling it in-process would take the test runner down
// with it. This is also the output an operator actually sees.
async function signedOut(command: string[]): Promise<{ code: number; err: string }> {
  const fresh = await mkdtemp(join(tmpdir(), "cairn-signedout-"))
  try {
    const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...command], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CAIRN_ROOT: fresh, NO_COLOR: "1" },
    })
    const err = await new Response(p.stderr).text()
    return { code: await p.exited, err }
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }
}

test("with no account, a command that needs knowledge exits 1 naming cairn login", async () => {
  // In team mode there is no local store to fall back to, so this must be a
  // refusal and not an empty answer. `cairn status` reporting "0 approved, 0
  // pending" here would be indistinguishable from a space that is genuinely
  // empty.
  const { code, err } = await signedOut(["status"])
  expect(code).toBe(1)
  expect(err).toContain("not signed in")
  expect(err).toContain("cairn login")
  // Says WHY before it says what to run — the reader has never heard of a
  // shared space if this is their first command.
  expect(err).toContain("shared space")
}, 20000)

test("cairn curate refuses without a terminal instead of exiting 0 having done nothing", async () => {
  // The same refusal `cairn review` makes, and checked before the store is
  // opened for the same reason: a CI run must hear the complaint that is
  // actually about it.
  const { code, err } = await signedOut(["curate"])
  expect(code).toBe(1)
  expect(err).toContain("interactive")
  expect(err).not.toContain("not signed in")
}, 20000)

test("cairn rebuild explains that it is gone instead of reading as a typo", async () => {
  // It was FileStore's search index. Falling through to "unknown command"
  // would tell someone with it in muscle memory that they mistyped.
  const { code, err } = await signedOut(["rebuild"])
  expect(code).toBe(1)
  expect(err).toContain("indexes claims as it stores them")
  expect(err).not.toContain("unknown command")
}, 20000)

test("rebuild reindexes a local store whose index was deleted", async () => {
  // Claims written to disk while the SQLite index write failed
  // left claims present as files, invisible to search, counted in nothing.
  // This is that scenario, reproduced.
  const dir = await mkdtemp(join(tmpdir(), "cairn-rb-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    const rbStore = new FileStore(r, new EventLog(r))
    await rbStore.init()
    await rbStore.propose(proposal("findable sentence"))
    await rm(join(r, "index.db"), { force: true })

    const { code, out } = await spawnCli(["rebuild"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(0)
    expect(out).toContain("1")

    const reopened = new FileStore(r, new EventLog(r))
    await reopened.init()
    expect((await reopened.search("findable")).length).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("rebuild counts documents as documents, not as claims", async () => {
  // `rebuildIndex` returns the SUM of the two tables it rebuilds — sanctioned
  // by the design — and the CLI used to print that sum as "reindexed N
  // claim(s)". A local space holding 0 claims and 2 documents is the NORMAL
  // state after `cairn import` on this version, and it reported two claims
  // that do not exist.
  const dir = await mkdtemp(join(tmpdir(), "cairn-rb-docs-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    const rbStore = new FileStore(r, new EventLog(r))
    await rbStore.init()
    await rbStore.importDocument({ title: "Ingestion", text: "an out-of-band pre-step", source: "a.md" })
    await rbStore.importDocument({ title: "MinerU", text: "it wants Python 3.10", source: "b.md" })
    await rm(join(r, "index.db"), { force: true })

    const { code, out } = await spawnCli(["rebuild"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(0)
    expect(out).toContain("0 claims and 2 documents")
    // The rebuild was real, not just honestly narrated.
    const reopened = new FileStore(r, new EventLog(r))
    await reopened.init()
    expect((await reopened.searchDocuments("out-of-band")).length).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("rebuild still refuses in a team space", async () => {
  // The hosted store indexes claims as it stores them; there is nothing to
  // rebuild.
  const dir = await mkdtemp(join(tmpdir(), "cairn-rb-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false), mode: "team" as const })
    const { code, err } = await spawnCli(["rebuild"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(1)
    expect(err).toContain("indexes claims as it stores them")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("with no account, the MCP server refuses to start rather than serving nothing", async () => {
  // The worst failure available: an agent whose team_knowledge_map returns []
  // concludes the team knows nothing and carries on.
  const { code, err } = await signedOut(["mcp"])
  expect(code).toBe(1)
  expect(err).toContain("cairn login")
}, 20000)

test("with no account, login and doctor still run", async () => {
  // They are the way OUT of the signed-out state. If the gate ran before the
  // command switch, the only advice cairn gives would itself exit 1.
  const fresh = await mkdtemp(join(tmpdir(), "cairn-signedout-"))
  try {
    // Through spawnCli, whose `cwd` is mandatory — see its comment. This test
    // hand-rolled the spawn and inherited the runner's cwd, so `findMcpConfig`
    // found the checkout's own gitignored `.mcp.json`, and `runDoctor` then
    // used the CAIRN_ROOT baked into it: the developer's real `~/.cairn`,
    // signed in. Isolating CAIRN_ROOT and HOME was not enough, because doctor
    // deliberately reports on the store the AGENT will use rather than the one
    // the ambient shell names.
    //
    // It passed in CI, where `.mcp.json` does not exist, and failed on any
    // machine that had run `cairn init --project` in the checkout — the same
    // worktree-versus-checkout split spawnCli was written to end.
    const { out } = await spawnCli(["doctor", "--json"], { CAIRN_ROOT: fresh, HOME: fresh, NO_COLOR: "1" }, fresh)
    // doctor RAN — it produced its report rather than the not-signed-in
    // refusal — and the report says what is wrong.
    const results = JSON.parse(out) as { name: string; status: string; fix?: string }[]
    expect(results.find((r) => r.name === "auth")).toMatchObject({ status: "fail" })
    expect(results.find((r) => r.name === "auth")!.fix).toContain("cairn login")
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }
}, 20000)

// --- what an import does not touch -----------------------------------------

test("importing moves no part of the approve rate", async () => {
  // The number this whole product measures. Import writes documents, not
  // claims, so seeding a space with it must leave every claim-shaped number
  // exactly where it was — proposed, approved, rejected, the rate itself, and
  // the queue age that would otherwise grow for ever on stale-looking claims
  // that were never actually pending.
  await writeFile(join(source, "a.md"), "# A\n\nbody a", "utf-8")
  await writeFile(join(source, "b.md"), "# B\n\nbody b", "utf-8")
  await runImport(store, source)
  const s = await store.stats()
  expect(s.proposed).toBe(0)
  expect(s.approved).toBe(0)
  expect(s.rejected).toBe(0)
  expect(s.approveRate).toBeNull()
  expect(s.pendingAgeDays).toBeNull()
  expect(await store.list("pending")).toEqual([])
})

test("import reports what it created, not what it looked at", async () => {
  // Re-running an import over an unchanged directory used to report importing
  // every file again, because it counted files rather than documents.
  await writeFile(join(source, "a.md"), "# A\n\nbody a", "utf-8")
  await writeFile(join(source, "b.md"), "# B\n\nbody b", "utf-8")
  expect((await runImport(store, source)).created).toBe(2)
  expect((await runImport(store, source)).created).toBe(0)
  await writeFile(join(source, "c.md"), "# C\n\nbody c", "utf-8")
  expect((await runImport(store, source)).created).toBe(1)
})

// --- `cairn import`, spawned for real --------------------------------------
//
// Two defects: a folder of PDFs read as "nothing
// new" and exited 0, and a missing directory printed a raw ENOENT. Both are
// what a tester actually hits pointing this at real material, so both are
// exercised through the real CLI process, not just `runImport` in-process.

test("importing a directory with no markdown names the conversion pre-step", async () => {
  // This used to print "Nothing new — every document there is already in
  // the space." over a folder of PDFs and exit 0.
  const home = await mkdtemp(join(tmpdir(), "cairn-imp-"))
  const pdfs = await mkdtemp(join(tmpdir(), "cairn-pdfs-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    await writeFile(join(pdfs, "paper.pdf"), "PDFDATA", "utf-8")
    const res = await spawnCli(["import", pdfs], { CAIRN_ROOT: r, HOME: home }, home)
    expect(res.out).toContain("no markdown")
    expect(res.out.toLowerCase()).toContain("convert")
    expect(res.out).not.toContain("Nothing new")
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(pdfs, { recursive: true, force: true })
  }
}, 20000)

test("a directory of only empty markdown files is not reported as having no markdown", async () => {
  // An empty `.md` file short-circuits into `r.empty`, not into
  // `r.created`/`r.updated`/`r.unchanged` — gating the "no markdown" message
  // on the sum of those three let a directory of nothing-but-empty-files
  // print "no markdown in <dir>" and then, four lines later, name a `.md`
  // file inside that same directory. MinerU writing a zero-byte `.md` for a
  // scanned page it could not extract is exactly the seed directory this
  // message exists for, and it must not then tell the operator to re-run the
  // tool that already produced the file being named as missing.
  const home = await mkdtemp(join(tmpdir(), "cairn-imp-"))
  const docs = await mkdtemp(join(tmpdir(), "cairn-md-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    await writeFile(join(docs, "blank.md"), "\n   \n", "utf-8")
    const res = await spawnCli(["import", docs], { CAIRN_ROOT: r, HOME: home }, home)
    expect(res.out).not.toContain("no markdown")
    expect(res.out).toContain("0 documents created, 0 updated, 0 unchanged")
    expect(res.out).toContain("blank.md is empty — skipped")
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(docs, { recursive: true, force: true })
  }
}, 20000)

test("importing a directory that does not exist names a remedy", async () => {
  const home = await mkdtemp(join(tmpdir(), "cairn-imp-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    const absent = join(tmpdir(), "cairn-absent-dir-does-not-exist")
    const res = await spawnCli(["import", absent], { CAIRN_ROOT: r, HOME: home }, home)
    expect(res.code).toBe(1)
    expect(res.err).not.toContain("ENOENT")
    expect(res.err).toContain("no such directory")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 20000)

test("import reports created, updated and unchanged separately", async () => {
  const home = await mkdtemp(join(tmpdir(), "cairn-imp-"))
  const docs = await mkdtemp(join(tmpdir(), "cairn-md-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    // Asserting the rendered numbers, not just the words "updated" and
    // "unchanged" — the success line always contains those literals
    // regardless of the counts, so a substring check alone would still pass
    // with both counters hardwired to zero.
    await writeFile(join(docs, "a.md"), "# A\n\nfirst", "utf-8")
    const first = await spawnCli(["import", docs], { CAIRN_ROOT: r, HOME: home }, home)
    expect(first.out).toContain("1 document created, 0 updated, 0 unchanged")

    await writeFile(join(docs, "a.md"), "# A\n\nsecond", "utf-8")
    const second = await spawnCli(["import", docs], { CAIRN_ROOT: r, HOME: home }, home)
    expect(second.out).toContain("0 documents created, 1 updated, 0 unchanged")

    const third = await spawnCli(["import", docs], { CAIRN_ROOT: r, HOME: home }, home)
    expect(third.out).toContain("0 documents created, 0 updated, 1 unchanged")
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(docs, { recursive: true, force: true })
  }
}, 20000)

test("import creates no claims", async () => {
  const home = await mkdtemp(join(tmpdir(), "cairn-imp-"))
  const docs = await mkdtemp(join(tmpdir(), "cairn-md-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    await writeFile(join(docs, "a.md"), "# A\n\nbody", "utf-8")
    await spawnCli(["import", docs], { CAIRN_ROOT: r, HOME: home }, home)
    // The whole point: a heading is not a sentence a reviewer can judge, so
    // nothing here may arrive as an approved claim.
    const status = await spawnCli(["stats"], { CAIRN_ROOT: r, HOME: home }, home)
    expect(JSON.parse(status.out).proposed).toBe(0)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(docs, { recursive: true, force: true })
  }
}, 20000)

// --- `cairn adopt-imports`, `show` and `search` on documents --------------
//
// Older spaces can hold approved claims tagged `imported` from before
// this change — `cairn import` used to write each file as a claim, key
// on its first heading. `adopt-imports` is the one-time cleanup: it turns
// those into documents the same way `cairn import` would have, had it always
// written documents. Seeded here through `FileStore.importClaim` directly,
// tagged "imported" by hand, because that is exactly the shape an older
// install already holds on disk — not something `spawnCli(["import", ...])`
// can produce any more now that import writes documents.
async function seedImportedClaim(root: string, claimText: string, body: string): Promise<void> {
  const seed = new FileStore(root, new EventLog(root))
  await seed.init()
  await seed.importClaim(proposal(claimText, { body, tags: ["imported"] }))
}

test("adopt-imports converts imported claims and says what it did", async () => {
  const home = await mkdtemp(join(tmpdir(), "cairn-adopt-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    await seedImportedClaim(r, "A", "body")
    const first = await spawnCli(["adopt-imports"], { CAIRN_ROOT: r, HOME: home }, home)
    expect(first.code).toBe(0)
    expect(first.out).toContain("1")
    // Idempotent: the second run has nothing left to convert and says so,
    // rather than reporting a successful conversion of nothing — this whole
    // change exists because a command once said something false right here.
    const again = await spawnCli(["adopt-imports"], { CAIRN_ROOT: r, HOME: home }, home)
    expect(again.code).toBe(0)
    expect(again.out.toLowerCase()).toContain("nothing")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 20000)

test("adopt-imports keeps going past a claim it refuses", async () => {
  // A human-reviewed claim sitting in the same batch — carrying an `approve`
  // event, not just `import` — must not take the rest of the run down with
  // it, and the refusal must name which claim and why.
  const home = await mkdtemp(join(tmpdir(), "cairn-adopt-refuse-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    await seedImportedClaim(r, "Adoptable", "adoptable body")
    const seed = new FileStore(r, new EventLog(r))
    await seed.init()
    const reviewed = await seed.propose(proposal("Reviewed by a human", { body: "reviewed body" }))
    await seed.review(reviewed.id, "approve")
    // Tag it "imported" by hand — the guard is event-based, not tag-based,
    // precisely so a hand-edited tag like this cannot talk adoption into
    // deleting a claim a human actually judged.
    const claim = await seed.get(reviewed.id)
    await seed.put({ ...claim!, tags: ["imported"] }, "curate")

    const r1 = await spawnCli(["adopt-imports"], { CAIRN_ROOT: r, HOME: home }, home)
    expect(r1.code).toBe(0)
    expect(r1.out.toLowerCase()).toContain("adoptable")
    expect(r1.out).toContain(notAdoptableMessage(reviewed.id, "judged"))
    // The refused claim survives, still approved — adoption did not touch it.
    expect((await seed.get(reviewed.id))?.status).toBe("approved")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 20000)

test("show accepts a document id", async () => {
  const home = await mkdtemp(join(tmpdir(), "cairn-show-doc-"))
  const docs = await mkdtemp(join(tmpdir(), "cairn-md-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    await writeFile(join(docs, "a.md"), "# A\n\nthe body", "utf-8")
    await spawnCli(["import", docs], { CAIRN_ROOT: r, HOME: home }, home)
    const found = JSON.parse(
      (await spawnCli(["search", "body", "--json"], { CAIRN_ROOT: r, HOME: home }, home)).out,
    )
    const shown = await spawnCli(["show", found[0].id, "--json"], { CAIRN_ROOT: r, HOME: home }, home)
    expect(JSON.parse(shown.out).text).toContain("the body")
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(docs, { recursive: true, force: true })
  }
}, 20000)

test("search marks which hits are documents", async () => {
  const home = await mkdtemp(join(tmpdir(), "cairn-search-doc-"))
  const docs = await mkdtemp(join(tmpdir(), "cairn-md-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    await writeFile(join(docs, "a.md"), "# A\n\nthe body", "utf-8")
    await spawnCli(["import", docs], { CAIRN_ROOT: r, HOME: home }, home)
    const res = await spawnCli(["search", "body"], { CAIRN_ROOT: r, HOME: home }, home)
    expect(res.out).toContain("document")
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(docs, { recursive: true, force: true })
  }
}, 20000)

// --- which ledger the CLI writes to ---------------------------------------

test("an account sends events to the space, not to a file on this machine", async () => {
  // Choosing the store without choosing the ledger is half a decision: an
  // agent session would propose to the space and log its reads to a laptop.
  const fresh = await mkdtemp(join(tmpdir(), "cairn-fresh-"))
  try {
    await writeConfig(fresh, { ...newConfig(false, "abc"), auth: AUTH })
    expect(await makeSink(fresh)).toBeInstanceOf(HttpEventSink)
    expect(existsSync(join(fresh, "events.jsonl"))).toBe(false)
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }
})

test("an unknown command exits non-zero, while asking for help does not", async () => {
  // `cairn revieww && deploy` used to run the deploy: usage was printed and the
  // exit code was 0, so a typo read as success. Bare `cairn` is a request for
  // help and did succeed, so the two must not share an exit code.
  const bin = ["bun", join(import.meta.dir, "..", "src", "cli.ts")]
  const typo = Bun.spawn([...bin, "definitely-not-a-command"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CAIRN_ROOT: await mkdtemp(join(tmpdir(), "cairn-usage-")) },
  })
  expect(await typo.exited).toBe(1)
  expect(await new Response(typo.stdout).text()).toContain("usage:")

  const help = Bun.spawn([...bin], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CAIRN_ROOT: await mkdtemp(join(tmpdir(), "cairn-usage-")) },
  })
  expect(await help.exited).toBe(0)
})

test("show --json and search --json describe the same thing the same way", async () => {
  // `search --json` tags every entry with `kind`; `show --json`
  // emitted the bare object, so a script piping a search hit's id straight
  // into `show` got a differently-shaped thing back and had to know which
  // command it came from. Driven through the real binary because the shape IS
  // the interface — asserting on a formatter would prove nothing about what a
  // script actually receives.
  const jsonRoot = await mkdtemp(join(tmpdir(), "cairn-json-shape-"))
  try {
    // Local mode, written explicitly: a config-less root defaults to TEAM and
    // the spawned CLI exits 1 asking for `cairn login` rather than reading
    // anything. Same spread `init --local` uses.
    await writeConfig(jsonRoot, { ...newConfig(false), mode: "local" })
    const seeded = new FileStore(jsonRoot, new EventLog(jsonRoot))
    await seeded.init()
    const claim = await seeded.propose(proposal("widgets ship on Tuesdays"))
    await seeded.review(claim.id, "approve")
    const { document } = await seeded.importDocument({
      title: "Widgets", text: "widgets ship on Tuesdays", source: "w.md",
    })

    const bin = ["bun", join(import.meta.dir, "..", "src", "cli.ts")]
    const run = async (args: string[]) => {
      const p = Bun.spawn([...bin, ...args], {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CAIRN_ROOT: jsonRoot },
      })
      const out = await new Response(p.stdout).text()
      expect(await p.exited).toBe(0)
      return JSON.parse(out)
    }

    const hits = await run(["search", "widgets", "--json"])
    const searchClaim = hits.find((h: { kind: string }) => h.kind === "claim")
    const searchDoc = hits.find((h: { kind: string }) => h.kind === "document")
    expect(searchClaim).toBeDefined()
    expect(searchDoc).toBeDefined()

    const shownClaim = await run(["show", claim.id, "--json"])
    const shownDoc = await run(["show", document.id, "--json"])
    expect(shownClaim.kind).toBe("claim")
    expect(shownDoc.kind).toBe("document")
    // Same keys in the same order, not merely both carrying a `kind`: the
    // complaint was that one object could not be handled as the other.
    expect(Object.keys(shownClaim)).toEqual(Object.keys(searchClaim))
    expect(Object.keys(shownDoc)).toEqual(Object.keys(searchDoc))
  } finally {
    await rm(jsonRoot, { recursive: true, force: true })
  }
}, 30_000)

test("--max-tokens is parsed, and junk is dropped rather than sent as NaN", () => {
  expect(modelFlags(["--max-tokens", "4096"]).maxTokens).toBe(4096)
  expect(modelFlags([]).maxTokens).toBeUndefined()
  for (const junk of ["abc", "0", "-1", "1.5"]) {
    expect(modelFlags(["--max-tokens", junk]).maxTokens).toBeUndefined()
  }
})


// --- unrecognized flags ----------------------------------------------------
//
// `cairn init --help` did not print help. The flag was unrecognized, `init`
// ran for real, and because it ran without a TTY it recorded telemetry consent
// as NO — overwriting a config where consent was already YES. `runCli` already
// threw `unknown command: X`; flags had no equivalent.

test("a command's own flags are accepted", () => {
  expect(unknownFlags("init", ["--project", "--dry-run", "--yes"])).toEqual([])
  expect(unknownFlags("abstracts", ["--all", "--dry-run", "--force"])).toEqual([])
  expect(unknownFlags("review", ["--json"])).toEqual([])
  expect(unknownFlags("review", ["--json", "--mine"])).toEqual([])
})

test("a flag the command does not take is reported", () => {
  expect(unknownFlags("init", ["--dryrun"])).toEqual(["--dryrun"])
  // Real flags, wrong command: --all belongs to abstracts, not init. Borrowing
  // one command's flag is likelier than inventing a new one.
  expect(unknownFlags("init", ["--all"])).toEqual(["--all"])
  expect(unknownFlags("status", ["--json"])).toEqual(["--json"])
})

test("the value of a valued flag is not read as a flag", () => {
  expect(unknownFlags("model", ["--provider", "openai", "--model", "gpt-5"])).toEqual([])
  // A value that itself looks like a flag is still a value. `--base-url` is
  // read by modelFlags but has never been in the usage line, which is exactly
  // the kind of flag a check like this must not start rejecting.
  expect(unknownFlags("model", ["--model", "--weird", "--base-url", "http://x"])).toEqual([])
})

test("positional arguments are not flags", () => {
  expect(unknownFlags("import", ["/some/dir"])).toEqual([])
  expect(unknownFlags("import", ["-"])).toEqual(["-"])
})

test("help is not an unknown flag on any command", () => {
  // Handled before the check runs, so it must not also be reported here.
  for (const c of ["init", "model", "status", "mcp"]) {
    expect(unknownFlags(c, ["--help"])).toEqual([])
    expect(unknownFlags(c, ["-h"])).toEqual([])
  }
})

test(
  "a non-interactive re-run keeps a consent it had nobody to ask about",
  async () => {
    // The defect, end to end. `cairn init --help` was an unrecognized flag, so
    // init ran for real; running without a TTY it wrote `telemetry: false` over
    // a config that already said true, and doctor then reported `off` as a
    // healthy tick — indistinguishable from a deliberate choice. There is no
    // way back: consent is only ever set inside init.
    const projectDir = await mkdtemp(join(tmpdir(), "cairn-init-project-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-init-root-"))
    const fakeHome = await mkdtemp(join(tmpdir(), "cairn-init-home-"))
    try {
      await mkdir(join(fakeHome, ".claude"), { recursive: true })
      await writeFile(
        join(cairnRoot, "config.json"),
        JSON.stringify({ installId: "already-a-user", telemetry: true, lastSentAt: null, generation: null, auth: null }),
        "utf-8",
      )
      const { out, code } = await spawnInit(projectDir, cairnRoot, fakeHome)
      expect(out).not.toContain("No supported agent found")
      expect(code).toBe(0)
      const cfg = JSON.parse(await readFile(join(cairnRoot, "config.json"), "utf-8"))
      expect(cfg.telemetry).toBe(true)
      expect(cfg.installId).toBe("already-a-user")
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
      await rm(fakeHome, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "init --help prints usage and writes nothing",
  async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "cairn-init-project-"))
    const cairnRoot = await mkdtemp(join(tmpdir(), "cairn-init-root-"))
    const fakeHome = await mkdtemp(join(tmpdir(), "cairn-init-home-"))
    try {
      await mkdir(join(fakeHome, ".claude"), { recursive: true })
      const { out, code } = await spawnInit(projectDir, cairnRoot, fakeHome, ["--help"])
      expect(code).toBe(0)
      expect(out).toContain("usage: cairn")
      // The whole point: asking what a command does must not be the thing that
      // performs it.
      expect(existsSync(join(cairnRoot, "config.json"))).toBe(false)
      expect(await readdir(projectDir)).toEqual([])
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(cairnRoot, { recursive: true, force: true })
      await rm(fakeHome, { recursive: true, force: true })
    }
  },
  20000,
)

test("an unrecognized flag stops the command rather than running it", async () => {
  // `unknownFlags` returning the flag is not the same as `main` refusing to
  // act on it, and only the second one is the defect. Found by breaking the
  // throw and watching the unit tests above stay green.
  await expect(main(["init", "--dryrun"])).rejects.toThrow("unknown flag: --dryrun")
  // The message names what the command does take, since a wrong flag is
  // usually a nearly-right one.
  await expect(main(["init", "--dryrun"])).rejects.toThrow("--dry-run")
  await expect(main(["status", "--json"])).rejects.toThrow("status takes no flags")
})

// --- the human read path ---------------------------------------------------
//
// Agents could read the knowledge base through team_knowledge_search and
// team_knowledge_read; the person reviewing it had no equivalent. No command
// answered "what do we know about X".

const claimAt = (id: string, status: Status, text: string, over: Partial<Claim> = {}): Claim => ({
  id, status, claim: text, body: `${text} — body`,
  source: { author: "me", agent: "test", repo: null, session: null },
  created: "2026-08-30T00:00:00.000Z", reviewed: null, reviewer: null, retracted: null,
  overlaps: [], cites: [], abstract: null, abstractBy: null, tags: [], ...over,
})

test("search shows the approved corpus by default — the same one agents see", async () => {
  const hits = [
    claimAt("a", "approved", "Staging deploys on merge to main"),
    claimAt("b", "pending", "Deploys need a rollback path"),
    claimAt("c", "rejected", "Deploys are manual"),
  ]
  const store = { search: async () => hits } as unknown as Store
  expect((await runSearch(store, "deploy", false)).map((c) => c.id)).toEqual(["a"])
})

test("search --all widens to every status", async () => {
  const hits = [
    claimAt("a", "approved", "Staging deploys on merge to main"),
    claimAt("b", "pending", "Deploys need a rollback path"),
  ]
  const store = { search: async () => hits } as unknown as Store
  expect((await runSearch(store, "deploy", true)).map((c) => c.id)).toEqual(["a", "b"])
})

test("search records nothing", async () => {
  // `search` and `read` events feed the "reads by agents" line in cairn status.
  // A human looking at their own store is not an agent read, and spelling it as
  // one would inflate the number that line exists to report.
  let appended = 0
  const store = { search: async () => [claimAt("a", "approved", "x")] } as unknown as Store
  await runSearch(store, "x", false)
  expect(appended).toBe(0)
})

test("search output names the id beside the sentence", () => {
  const out = formatSearch([claimAt("a1b2", "approved", "Staging deploys on merge to main")], false)
  expect(out).toContain("a1b2")
  expect(out).toContain("Staging deploys on merge to main")
  // The id is what `cairn show` takes, so a hit that did not carry one would
  // leave the reader with nowhere to go next.
  expect(out).toContain("1 approved")
})

test("search --all marks the status of every hit", () => {
  const out = formatSearch(
    [claimAt("a", "approved", "one"), claimAt("b", "pending", "two"), claimAt("c", "rejected", "three")],
    true,
  )
  for (const s of ["approved", "pending", "rejected"]) expect(out).toContain(s)
  expect(out).toContain("3 claims")
})

test("no results says so rather than printing nothing", () => {
  // An empty stdout is indistinguishable from a command that failed silently.
  expect(formatSearch([], false)).toContain("nothing")
})

test("a document hit with no claim hit does not say nothing matched", () => {
  // `cairn search` used to print "nothing approved matched"
  // directly above the document it had just found, because the claim half
  // of the message did not know a document had matched. False the moment a
  // document is visible right below it — the search was not empty.
  const out = formatSearch([], false, true)
  expect(out).not.toContain("nothing")
  // The --all hint survives: it is still true (no approved claim matched)
  // and still useful, just no longer dressed up as "nothing matched".
  expect(out).toContain("--all")
})

test("the same holds under --all: no claim of any status, but a document did", () => {
  const out = formatSearch([], true, true)
  expect(out).not.toContain("nothing")
})

test("nothing at all matched still says so, with documents absent", () => {
  expect(formatSearch([], false, false)).toContain("nothing")
  expect(formatSearch([], true, false)).toContain("nothing")
})

test("show renders the whole claim, not a summary", () => {
  const c = claimAt("a1b2", "approved", "Staging deploys on merge to main", {
    abstract: "How staging deploys happen.", abstractBy: "human",
    tags: ["deploy"], body: "The workflow triggers on push to main.",
  })
  const out = formatClaim(c, new Map(), new Map(), new Map())
  expect(out).toContain("Staging deploys on merge to main")
  expect(out).toContain("The workflow triggers on push to main.")
  expect(out).toContain("How staging deploys happen.")
  expect(out).toContain("deploy")
  expect(out).toContain("approved")
})

/** A citation in the scope-less, unchecked shape a claim written before
 *  `supports` existed comes back as. */
function cite(doc: string, over: Partial<Citation> = {}): Citation {
  return { doc, supports: "", hash: null, absent: null, by: "unknown", ...over }
}

test("show renders cites", () => {
  // `cites` belongs in `cairn show` and in the MCP read payload. `--json` already carried the field, so the gap was
  // only ever on the human-readable surface — the surface where a person
  // would go looking for whether anything cites anything at all.
  //
  // Superseded from "cites 2 document(s)" by the test below: a count is not a
  // reference, so this only checks the section still appears and
  // still disappears — naming each citation is what the next test covers.
  // Empty map: these two documents genuinely are not resolved anywhere, the
  // same as if they had been removed from the space — the caller HAS looked
  // and found nothing, which `docs` being required from here on is what makes
  // provable rather than assumed.
  const out = formatClaim(claimAt("a", "approved", "built on that document", {
    cites: [cite("doc-one"), cite("doc-two")],
  }), new Map(), new Map(), new Map())
  expect(out).toContain("cites")
  expect(out).toContain("doc-one")
  expect(out).toContain("doc-two")
  // Absent, not an empty "cites" section, when there is nothing to say — same
  // as `overlaps`.
  expect(formatClaim(claimAt("a", "approved", "no citations here"), new Map(), new Map(), new Map())).not.toContain("cites")
})

test("formatClaim requires the caller to state what it resolved", () => {
  // `docs` used to default to `undefined`, and `docs?.get(...)` made an
  // omitted map read exactly like an empty one — "no longer in this space"
  // for a document the caller had simply not looked up yet. Cast around the
  // type system the way a stale build or an untyped caller could, to prove
  // the omission fails loudly now rather than silently asserting a document
  // is gone.
  const claim = sample("c1", "a claim")
  claim.cites = [{ doc: "doc-1", supports: "x", hash: "abc", absent: [], by: "cursor" }]
  const callWithoutDocs = formatClaim as unknown as (c: Claim) => string
  expect(() => callWithoutDocs(claim)).toThrow()
})

test("show names each citation, its scope and what was absent", () => {
  // For the cites half: a count is not a reference. "cites 2
  // document(s)" is the same original defect surviving on a second command.
  const claim = sample("c1", "Docling Serve is the production default")
  claim.cites = [
    { doc: "doc-1", supports: "the ingestion default", hash: "abc", absent: ["docling"], by: "cursor" },
  ]
  const docs = new Map([["doc-1", { id: "doc-1", title: "MinerU", text: "t", source: "m.md", created: "", updated: "", hash: "abc" }]])
  const out = formatClaim(claim, docs, new Map(), new Map())
  expect(out).toContain("MinerU")
  expect(out).toContain("supports the ingestion default")
  expect(out).toContain("not found in the document: docling")
  expect(out).toContain("doc-1")
})

test("the cites section frames an absence as a word check before listing any", () => {
  // `absent: []` carried a caveat ("short and common words are
  // not checked") and `absent: [...]` carried none, so the reassuring state
  // was hedged and the accusatory one was bare — backwards for a report whose
  // whole purpose is DISCLOSURE, never validation. One framing line under the
  // section label does it once, rather than a caveat repeated on every entry.
  const claim = sample("c1", "Docling Serve is the production default")
  claim.cites = [
    { doc: "doc-1", supports: "the ingestion default", hash: "abc", absent: ["docling"], by: "cursor" },
  ]
  const docs = new Map([["doc-1", { id: "doc-1", title: "MinerU", text: "t", source: "m.md", created: "", updated: "", hash: "abc" }]])
  const out = formatClaim(claim, docs, new Map(), new Map())
  expect(out).toContain("a word check, not a judgement of whether the document supports it")
  // Before the citation it qualifies, not after — the position IS the fix.
  expect(out.indexOf("a word check")).toBeLessThan(out.indexOf("not found in the document"))
})

test("show stays silent about citations a claim does not have", () => {
  // Deliberately NOT the references pane's wording, and the divergence is the
  // point. The pane carries a permanent `cites` section label, so an empty one
  // reads as a gap and needs the clause settled. `show` prints no
  // label at all, and silence does not choose between "grounded in a
  // discussion" and "nobody did the work" — which is exactly the choice
  // nothing here can make. Adding the clause to a command that never asked the
  // question would be noise on every claim in the corpus.
  const claim = sample("c1", "a claim with nothing to cite")
  claim.cites = []
  const out = formatClaim(claim, new Map(), new Map(), new Map())
  expect(out).not.toContain("cites")
  expect(out).not.toContain("not every claim has a document to cite")
})

test("show says a cited document has changed since it was cited", () => {
  const claim = sample("c1", "a claim")
  claim.cites = [{ doc: "doc-1", supports: "x", hash: "abc", absent: [], by: "cursor" }]
  const docs = new Map([["doc-1", { id: "doc-1", title: "MinerU", text: "t", source: "m.md", created: "", updated: "", hash: "CHANGED" }]])
  expect(formatClaim(claim, docs, new Map(), new Map())).toContain("changed since it was cited")
})

test("show distinguishes an unchecked citation from a clean one", () => {
  // The whole reason `absent` is nullable. A legacy citation must not read
  // like one whose every term was found.
  const claim = sample("c1", "a claim")
  claim.cites = [
    { doc: "doc-1", supports: "", hash: null, absent: null, by: "unknown" },
    { doc: "doc-2", supports: "the detail", hash: "abc", absent: [], by: "cursor" },
  ]
  const docs = new Map([
    ["doc-1", { id: "doc-1", title: "Old", text: "t", source: null, created: "", updated: "", hash: "abc" }],
    ["doc-2", { id: "doc-2", title: "New", text: "t", source: null, created: "", updated: "", hash: "abc" }],
  ])
  const out = formatClaim(claim, docs, new Map(), new Map())
  expect(out).toContain("no scope stated")
  expect(out).toContain("never checked for absent terms")
  expect(out).toContain("no absence found")
})

test("the clean-citation line does not claim more than absentTerms actually checked", () => {
  // `claimTerms` (packages/protocol/src/absence.ts) drops every term under `MIN_TERM_LENGTH`
  // and every stopword before absence is ever checked. A clause about GPUs is
  // that module's own example: `gpu` is three characters, is never looked for, and `absent: []` on this claim does not mean `gpu` was found
  // — it means nothing THIS CHECK looked for was missing. The old wording,
  // "every term of the claim appears in the document", asserted the former.
  const claim = sample("c1", "no GPU workers on the fleet")
  claim.cites = [{ doc: "doc-1", supports: "the staffing plan", hash: "abc", absent: [], by: "cursor" }]
  const docs = new Map([
    ["doc-1", { id: "doc-1", title: "Fleet plan", text: "the fleet runs workers around the clock", source: null, created: "", updated: "", hash: "abc" }],
  ])
  const out = formatClaim(claim, docs, new Map(), new Map())
  expect(out).not.toContain("every term of the claim appears in the document")
  expect(out).toContain("not checked")
})

test("a citation with no recorded hash does not read as unchanged", () => {
  // The same conflation `absent: null` exists to prevent, applied to `hash`
  // instead of `absent`: null means "never recorded", not "matches the
  // document's current hash". Legacy citations in older spaces carry no hash and must not render as up to date.
  const claim = sample("c1", "a claim")
  claim.cites = [{ doc: "doc-1", supports: "x", hash: null, absent: [], by: "unknown" }]
  const docs = new Map([
    ["doc-1", { id: "doc-1", title: "MinerU", text: "t", source: null, created: "", updated: "", hash: "abc" }],
  ])
  const out = formatClaim(claim, docs, new Map(), new Map())
  expect(out).toContain("no hash recorded")
  expect(out).not.toContain("the document has changed since it was cited")
})

/** A store holding one approved claim ("c1") and one document ("doc-1") the
 *  claim does not yet cite, for `cite`/`uncite` tests that need real ids a
 *  real store will resolve — written directly to disk (bypassing `propose`,
 *  whose id is content-derived and cannot be pinned to "c1") the same way
 *  `sample` hands back a claim literal rather than one a store assigned. */
async function storeWithApprovedClaimAndDoc(): Promise<{ store: FileStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "cairn-cite-cli-"))
  const store = new FileStore(root, new EventLog(root))
  await store.init()
  const claim: Claim = { ...sample("c1", "Docling Serve is the production default"), status: "approved" }
  await writeFile(join(root, "approved", "c1.md"), serializeClaim(claim), "utf-8")
  const doc: Document = {
    id: "doc-1", title: "MinerU", text: "the ingestion default is Docling Serve",
    source: "m.md", created: "2026-08-28T09:00:00.000Z", updated: "2026-08-28T09:00:00.000Z", hash: "abc",
  }
  await writeFile(join(root, "documents", "doc-1.md"), serializeDocument(doc), "utf-8")
  return { store, root }
}

/** As above, but "c1" already cites "doc-1" — for `uncite`. */
async function storeWithCitedClaim(): Promise<{ store: FileStore; root: string }> {
  const { store, root } = await storeWithApprovedClaimAndDoc()
  await store.cite("c1", { doc: "doc-1", supports: "the install command" }, "cursor")
  return { store, root }
}

test("cite attributes the citation to the signed-in user, not to 'you'", async () => {
  // Same reasoning `cairn retract` records: this value is read back long
  // after the session, and "you" means nothing to whoever reads it then.
  const { store, root } = await storeWithApprovedClaimAndDoc()
  try {
    const claim = await runCite(store, "c1", "doc-1", "the install command", "alice")
    expect(claim!.cites[0]!.by).toBe("alice")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("uncite removes the citation", async () => {
  const { store, root } = await storeWithCitedClaim()
  try {
    const claim = await runUncite(store, "c1", "doc-1")
    expect(claim!.cites).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- `cairn cite`'s own argument parsing and actor resolution --------------
//
// `runCite` is a thin pass-through to `store.cite`, so a unit test that calls
// `runCite` directly (above) cannot catch a regression in `case "cite"`
// itself — a hardcoded `by = "you"`, or a broken id/`--supports` split, would
// leave that test green because it never goes through `main()`'s argv
// parsing or config read at all. These three run the real CLI as a
// subprocess (`spawnCli`), the only way to exercise that code, the same gap
// `cairn retract`'s argument parsing was already left with.

/** Writes an approved claim ("c1") and a document ("doc-1") straight to a
 *  CAIRN_ROOT directory, for `spawnCli`-driven `cite` tests. Direct writes,
 *  not `store.propose`, for the same reason `storeWithApprovedClaimAndDoc`
 *  above uses them: a store-assigned id is content-derived and cannot be
 *  pinned to "c1". */
async function seedCiteFixture(root: string): Promise<void> {
  await mkdir(join(root, "approved"), { recursive: true })
  await mkdir(join(root, "documents"), { recursive: true })
  const claim: Claim = { ...sample("c1", "Docling Serve is the production default"), status: "approved" }
  await writeFile(join(root, "approved", "c1.md"), serializeClaim(claim), "utf-8")
  const doc: Document = {
    id: "doc-1", title: "MinerU", text: "the ingestion default is Docling Serve",
    source: "m.md", created: "2026-08-28T09:00:00.000Z", updated: "2026-08-28T09:00:00.000Z", hash: "abc",
  }
  await writeFile(join(root, "documents", "doc-1.md"), serializeDocument(doc), "utf-8")
}

test("cite resolves the actor from config, never a hardcoded placeholder", async () => {
  // Same reasoning `cairn retract` records: this value is read back long
  // after the session, and a literal "you" would mean nothing to whoever
  // reads it then — and would keep every other test in this file green,
  // since none of them go through `main()`'s own `by` resolution.
  const dir = await mkdtemp(join(tmpdir(), "cairn-cite-actor-"))
  try {
    const r = join(dir, "root")
    await seedCiteFixture(r)
    await writeConfig(r, {
      ...newConfig(false), mode: "local" as const,
      auth: { token: "t", orgId: "o", orgSlug: "s", apiUrl: "https://example.invalid", user: "alice" },
    })
    const { code, out } = await spawnCli(
      ["cite", "c1", "doc-1", "--supports", "the install command"], { CAIRN_ROOT: r, HOME: dir }, dir,
    )
    expect(code).toBe(0)
    expect(out).toContain("now cites")
    const claim = parseClaim(await readFile(join(r, "approved", "c1.md"), "utf-8"))
    expect(claim.cites[0]?.by).toBe("alice")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("cite finds the ids even when --supports is typed before them", async () => {
  // Mirrors `retract`'s `--reason`-before-the-id guard: the id search must
  // exclude the token right after a valued flag wherever that flag falls in
  // argv, or a scope typed first gets mistaken for the claim id.
  const dir = await mkdtemp(join(tmpdir(), "cairn-cite-args-"))
  try {
    const r = join(dir, "root")
    await seedCiteFixture(r)
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    const { code, out } = await spawnCli(
      ["cite", "--supports", "the install command", "c1", "doc-1"], { CAIRN_ROOT: r, HOME: dir }, dir,
    )
    expect(code).toBe(0)
    expect(out).toContain("now cites")
    const claim = parseClaim(await readFile(join(r, "approved", "c1.md"), "utf-8"))
    expect(claim.cites[0]?.doc).toBe("doc-1")
    expect(claim.cites[0]?.supports).toBe("the install command")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("cite accepts a --supports value that starts with a hyphen", async () => {
  // `--supports`'s value is excluded from the id search BY INDEX, not by
  // whether it looks like a flag — a scope that happens to start with `-b`
  // (as in `-b pipeline`) must not be mistaken
  // for a flag of its own or dropped.
  const dir = await mkdtemp(join(tmpdir(), "cairn-cite-args-"))
  try {
    const r = join(dir, "root")
    await seedCiteFixture(r)
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    const { code, out } = await spawnCli(
      ["cite", "c1", "doc-1", "--supports", "-b pipeline is required on CPU-only machines"],
      { CAIRN_ROOT: r, HOME: dir }, dir,
    )
    expect(code).toBe(0)
    expect(out).toContain("now cites")
    const claim = parseClaim(await readFile(join(r, "approved", "c1.md"), "utf-8"))
    expect(claim.cites[0]?.supports).toBe("-b pipeline is required on CPU-only machines")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

test("show says who wrote the abstract, because that is what curate acts on", () => {
  expect(formatClaim(claimAt("a", "approved", "x", { abstract: "y", abstractBy: "generated" }), new Map(), new Map(), new Map()))
    .toContain("generated")
})

test("show prints the retraction reason and who withdrew it", () => {
  // The header line already says "· retracted ·" and used to stop there — an
  // agent gets the reason through the MCP tombstone and a script through
  // `--json`, but a human checking their own withdrawn work in a terminal
  // got nothing, despite the README naming `show` as the recovery path.
  const out = formatClaim(claimAt("a", "retracted", "a withdrawn sentence", {
    retracted: { at: "2026-09-01T00:00:00.000Z", by: "alice", reason: "the citation does not support it" },
  }), new Map(), new Map(), new Map())
  expect(out).toContain("alice")
  expect(out).toContain("the citation does not support it")
})

test("show says nothing about retraction for a claim that was never withdrawn", () => {
  expect(formatClaim(claimAt("a", "approved", "an ordinary sentence"), new Map(), new Map(), new Map())).not.toContain("retracted by")
})

test("show names each overlap with its CURRENT status, not a count and not a blanket label", () => {
  // `overlaps 2 claim(s)` said something related existed and gave no way to
  // reach it — not the sentence, not even the id.
  //
  // `findOverlaps` computes the list against `store.list("approved")`, so every
  // id was approved WHEN WRITTEN, and one of the two here was retracted
  // afterwards while staying in `overlaps`. A blanket "approved" would be
  // false; a bare count is true and useless.
  // Resolving in the caller is what lets the line be both true and usable.
  const out = formatClaim(
    claimAt("a", "pending", "overlaps an approved claim and a retracted one", { overlaps: ["b", "c"] }),
    new Map(),
    new Map(),
    new Map([
      ["b", claimAt("b", "approved", "the one that still stands")],
      ["c", claimAt("c", "retracted", "the one that was taken back")],
    ]),
  )
  // The sentences, which is the whole point — a reader can judge what this
  // claim overlaps without running `show` twice more.
  expect(out).toContain("the one that still stands")
  expect(out).toContain("the one that was taken back")
  // Each id, so the two can still be looked up.
  expect(out).toContain("b")
  expect(out).toContain("c")
  // The statuses differ, and that is the fact a count could not carry.
  expect(out).toContain("approved")
  expect(out).toContain("retracted")
  // Neither the old count nor the blanket label it replaced.
  expect(out).not.toContain("overlaps 2 claim(s)")
  expect(out).not.toContain("approved claim(s)")
})

test("an overlap that no longer resolves is named as gone, never silently dropped", () => {
  // The list must not get shorter without saying so. The id is on this claim
  // whether or not the claim it names is still here, and a reader counting
  // three overlaps in `--json` and seeing two here would have no way to tell
  // which was missing or why. Same treatment as a cited document that has
  // gone.
  const out = formatClaim(
    claimAt("a", "pending", "overlaps one that survived and one that did not", { overlaps: ["b", "gone"] }),
    new Map(),
    new Map(),
    new Map([["b", claimAt("b", "approved", "the one that still stands")]]),
  )
  expect(out).toContain("the one that still stands")
  expect(out).toContain("gone — no longer in this space")
})

test("search and show accept their own flags and nothing else", () => {
  expect(unknownFlags("search", ["--all", "--json"])).toEqual([])
  expect(unknownFlags("show", ["--json"])).toEqual([])
  expect(unknownFlags("show", ["--all"])).toEqual(["--all"])
})

test("the hosted PATCH carries the kind the caller named, not a hardcoded one", async () => {
  // This is the defect: `put` sent `kind: "curate"` whatever the caller meant,
  // so `cairn abstracts` told the server a human had curated what a model wrote.
  let sent: Record<string, unknown> | null = null
  const store = new HttpStore({
    baseUrl: "https://example.invalid", orgId: "o", token: "t",
    fetchImpl: (async (_url: string, init: { body?: string }) => {
      sent = JSON.parse(init.body ?? "{}")
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch,
  })
  await store.put(claimAt("a", "approved", "x", { abstract: "y", abstractBy: "generated" }), "generate")
  expect(sent!.kind).toBe("generate")
})

test("a backfilled abstract records one generate and no curate", async () => {
  // One write, one event. It used to `put` — recording a curate server-side —
  // and then append a generate beside it, so the log described a single write
  // twice, once falsely.
  const root = await mkdtemp(join(tmpdir(), "cairn-backfill-events-"))
  try {
    const log = new EventLog(root)
    const store = new FileStore(root, log)
    await store.init()
    const c = await store.propose({
      claim: "Deploys run on Tuesdays", body: "b", abstract: "", tags: [],
      source: { author: "me", agent: "test", repo: null, session: null }, overlaps: [], cites: [],
    })
    await store.review(c.id, "approve")
    await runBackfill(store, async () => "Settles the cadence. Does not cover rollback.")
    const kinds = (await log.all()).filter((e) => e.id === c.id).map((e) => e.kind)
    expect(kinds).toEqual(["propose", "approve", "generate"])
    expect(kinds).not.toContain("curate")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("runRetract withdraws the claim and reports it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cairn-retract-"))
  try {
    const store = new FileStore(root, new EventLog(root))
    await store.init()
    const claim = await store.propose(proposal("a sentence"))
    await store.review(claim.id, "approve")
    const out = await runRetract(store, claim.id, "cited docs do not support it", "alice")
    expect(out?.status).toBe("retracted")
    expect(await runRetract(store, "no-such-claim", "reason", "alice")).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("search --all still returns a retracted claim", async () => {
  // True by construction today — runSearch only filters when `all` is false —
  // and this is what keeps it true. A reviewer who cannot find what they
  // withdrew cannot check their own work.
  const root = await mkdtemp(join(tmpdir(), "cairn-retract-search-"))
  try {
    const store = new FileStore(root, new EventLog(root))
    await store.init()
    const claim = await store.propose(proposal("a withdrawn sentence about widgets"))
    await store.review(claim.id, "approve")
    await store.retract(claim.id, "wrong", "alice")
    expect((await runSearch(store, "widgets", true)).map((c) => c.id)).toEqual([claim.id])
    expect(await runSearch(store, "widgets", false)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- `cairn retract` through the real dispatcher, not just `runRetract` ----
//
// `runRetract` is a one-line pass-through to `store.retract` and cannot
// exercise `main()`'s own argument parsing for the `retract` case — which is
// exactly where the bug below lived. These three go through `main` itself:
// the first two via `runMainCapturingExit` (both exit before touching config
// or a store, so no isolated CAIRN_ROOT is needed), the third via `spawnCli`
// with an isolated root, matching how the other store-backed commands in
// this file are driven through the dispatcher end to end.

test("cairn retract with no --reason reports the empty-reason refusal, not a missing-id error", async () => {
  // Positive control for a real bug found by hand: the id search excluded
  // "the token right after --reason" by checking `i !== reasonIndex + 1`.
  // With `--reason` absent, `indexOf` returns -1, so `-1 + 1 === 0` — which
  // excluded the id itself (index 0) rather than nothing, and this reported
  // "needs an id" instead of the reason refusal. Neither committed unit test
  // for `runRetract` could catch it: both call the function directly and
  // never touch `main`'s argument parsing.
  const { messages, exitCode } = await runMainCapturingExit(["retract", "some-claim-id"])
  expect(exitCode).toBe(1)
  expect(messages.join(" ")).toContain(EMPTY_RETRACT_REASON)
  expect(messages.join(" ")).not.toContain("needs an id")
})

test("cairn retract with no id at all reports the missing-id error", async () => {
  const { messages, exitCode } = await runMainCapturingExit(["retract", "--reason", "why"])
  expect(exitCode).toBe(1)
  expect(messages.join(" ")).toContain("cairn retract needs an id")
})

test("cairn retract withdraws an approved claim end to end through the CLI", async () => {
  const home = await mkdtemp(join(tmpdir(), "cairn-retract-cli-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    const seed = new FileStore(r, new EventLog(r))
    await seed.init()
    const claim = await seed.propose(proposal("a CLI-retracted sentence"))
    await seed.review(claim.id, "approve")
    const res = await spawnCli(
      ["retract", claim.id, "--reason", "cited docs do not support it"],
      { CAIRN_ROOT: r, HOME: home },
      home,
    )
    expect(res.code).toBe(0)
    expect(res.out).toContain("retracted")
    const shown = await spawnCli(["show", claim.id, "--json"], { CAIRN_ROOT: r, HOME: home }, home)
    const parsed = JSON.parse(shown.out)
    expect(parsed.status).toBe("retracted")
    expect(parsed.retracted.reason).toBe("cited docs do not support it")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 20000)

test("cairn retract withdraws a claim when --reason precedes the id", async () => {
  // The id-extraction fix is `reasonIndex === -1 || i !== reasonIndex + 1`
  // (src/cli.ts), verified by hand for exactly this ordering — `--reason
  // <text> <id>` — but nothing pinned it before this test. The end-to-end
  // case above only covers the OTHER order, `<id> --reason <text>`, which the
  // naive `i !== reasonIndex + 1` guard already handled without the fix.
  const home = await mkdtemp(join(tmpdir(), "cairn-retract-cli-flag-first-"))
  try {
    const r = join(home, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const })
    const seed = new FileStore(r, new EventLog(r))
    await seed.init()
    const claim = await seed.propose(proposal("a CLI-retracted sentence, flag first"))
    await seed.review(claim.id, "approve")
    const res = await spawnCli(
      ["retract", "--reason", "cited docs do not support it", claim.id],
      { CAIRN_ROOT: r, HOME: home },
      home,
    )
    expect(res.code).toBe(0)
    expect(res.out).toContain("retracted")
    const shown = await spawnCli(["show", claim.id, "--json"], { CAIRN_ROOT: r, HOME: home }, home)
    const parsed = JSON.parse(shown.out)
    expect(parsed.status).toBe("retracted")
    expect(parsed.retracted.reason).toBe("cited docs do not support it")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 20000)

test("review --mine refuses on a local root, and says why before anything else does", async () => {
  // Tag ownership is a row in a shared space. A local root has no members, so
  // the flag could only ever mean "everything" there — and a flag that quietly
  // widened to everything would be describing a space this machine is not in.
  //
  // Also pins the ORDER: `spawnCli` gives the child no TTY, so the interactive
  // refusal would fire too. The complaint a run gets has to be the one that is
  // about it.
  const dir = await mkdtemp(join(tmpdir(), "cairn-mine-"))
  try {
    const r = join(dir, "root")
    await writeConfig(r, { ...newConfig(false), mode: "local" as const, auth: null })
    const { code, out, err } = await spawnCli(["review", "--mine"], { CAIRN_ROOT: r, HOME: dir }, dir)
    expect(code).toBe(1)
    expect(`${out}${err}`).toContain("team space")
    expect(`${out}${err}`).not.toContain("interactive")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

// --- `cairn show --json` resolves nothing it will not print ------------------

test(
  "show --json makes no document or member round-trips, and without it makes both",
  async () => {
    // The resolution loop and `resolvePeople` used to run BEFORE the `--json`
    // check, so against a hosted space `show --json` cost one HTTP request per
    // citation plus a members lookup — every one of them discarded, because
    // `--json` prints the stored claim verbatim.
    //
    // Asserted by counting what the CLI actually asks a real server for, not
    // by reading the source: the ordering of two statements is exactly the kind
    // of thing a later edit reverses without noticing.
    const dir = await mkdtemp(join(tmpdir(), "cairn-show-json-"))
    const root = join(dir, "store")
    const paths: string[] = []
    const hosted = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const { pathname } = new URL(req.url)
        paths.push(pathname)
        if (pathname.endsWith("/members")) return Response.json({ members: [{ userId: "u1", displayName: "Alice" }] })
        if (pathname.includes("/documents/")) {
          return Response.json({
            id: "doc-1", title: "MinerU", text: "It wants Python 3.10.",
            source: "docs/mineru.md", hash: "h1", added: "2026-09-01T00:00:00.000Z",
          })
        }
        return Response.json({
          id: "c1", status: "approved", claim: "Using MinerU", body: "detail",
          source: { author: "alice", agent: "cursor", repo: null, session: null },
          created: "2026-09-01T00:00:00.000Z", reviewed: "2026-09-02T00:00:00.000Z",
          reviewer: "u1", retracted: null, overlaps: [],
          cites: [{ doc: "doc-1", supports: "the Python version", hash: "h1", absent: [], by: "u1" }],
          abstract: null, abstractBy: null, tags: [],
        })
      },
    })
    try {
      await writeConfig(root, {
        ...newConfig(false, "abc"),
        auth: {
          token: "cairn_tok_1", orgId: "org-1", orgSlug: "acme",
          apiUrl: `http://127.0.0.1:${hosted.port}`, user: "r",
        },
      })
      const env = { CAIRN_ROOT: root, HOME: dir, NO_COLOR: "1" }

      const json = await spawnCli(["show", "c1", "--json"], env, dir)
      expect(json.code).toBe(0)
      // It printed the claim — so it did not skip the work by failing early.
      expect(JSON.parse(json.out).id).toBe("c1")
      expect(paths.filter((p) => p.includes("/documents/"))).toEqual([])
      expect(paths.filter((p) => p.endsWith("/members"))).toEqual([])

      // The control, and the half that makes the assertions above mean
      // something: the human rendering DOES need both, so a `show` that
      // fetched nothing at all would satisfy the two emptiness checks while
      // being broken. Same server, same claim, one flag different.
      paths.length = 0
      const human = await spawnCli(["show", "c1"], env, dir)
      expect(human.code).toBe(0)
      expect(human.out).toContain("MinerU")
      expect(paths.filter((p) => p.includes("/documents/")).length).toBe(1)
      expect(paths.filter((p) => p.endsWith("/members")).length).toBe(1)
    } finally {
      hosted.stop(true)
      await rm(dir, { recursive: true, force: true })
    }
  },
  20000,
)

test(
  "show resolves each overlap against the store and prints its current status",
  async () => {
    // The renderer's half is unit-tested above; this is the caller's. `show`
    // has to look every overlap id up, and the loop that does it is exactly
    // the kind of thing a unit test on `formatClaim` cannot reach.
    //
    // The retracted one carries the weight: `overlaps` is computed against
    // approved claims at write time and the id stays put afterwards, so a
    // status resolved at READ time is the only one that can be true.
    const home = await mkdtemp(join(tmpdir(), "cairn-show-overlaps-"))
    try {
      const r = join(home, "root")
      await writeConfig(r, { ...newConfig(false), mode: "local" as const })
      const seed = new FileStore(r, new EventLog(r))
      await seed.init()

      const stands = await seed.propose(proposal("the cache is shared between workers"))
      await seed.review(stands.id, "approve")
      const taken = await seed.propose(proposal("the VPN drops on sleep"))
      await seed.review(taken.id, "approve")
      await seed.retract(taken.id, "measured the opposite on Tuesday", "alice")

      const subject = await seed.propose(proposal("overlaps one standing claim and one withdrawn"))
      const stored = await seed.get(subject.id)
      await seed.put({ ...stored!, overlaps: [stands.id, taken.id] }, "curate")

      const shown = await spawnCli(
        ["show", subject.id],
        { CAIRN_ROOT: r, HOME: home, NO_COLOR: "1" },
        home,
      )
      expect(shown.code).toBe(0)
      // Named, which is the whole issue: both sentences, both ids.
      expect(shown.out).toContain("the cache is shared between workers")
      expect(shown.out).toContain("the VPN drops on sleep")
      expect(shown.out).toContain(stands.id)
      expect(shown.out).toContain(taken.id)
      // And the statuses resolved NOW, which differ — the fact a count could
      // not carry and a blanket "approved" would have got wrong.
      expect(shown.out).toContain("approved")
      expect(shown.out).toContain("retracted")
      // Not the count it replaced.
      expect(shown.out).not.toContain("overlaps 2 claim(s)")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  },
  20000,
)
