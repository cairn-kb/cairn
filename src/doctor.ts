import { access, readFile, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { readConfig } from "./config"
import { TELEMETRY_URL, TIMEOUT_MS } from "./telemetry"
import { resolveGeneration } from "./generate"
import { detectAgents } from "./init"
import { desktopConfigPath } from "./agents"
import { readCodexEntry } from "./codex-config"
import { findRepo } from "./repo"
import type { GitRunner } from "./repo"
import type { McpServerEntry } from "./init"
import { keyProvenance, resolveBaseUrl } from "./providers"
import { HttpStore } from "./http-store"
import { FileStore } from "./store"
import type { Claim } from "@cairn-kb/protocol/types"
import { COMPILED, versionLine } from "./version"

export type CheckStatus = "ok" | "warn" | "fail"

export interface CheckResult {
  name: string
  group: string
  status: CheckStatus
  detail: string
  /** A command or edit that resolves it. Present whenever we know one. */
  fix?: string
}

export interface DoctorDeps {
  home: string
  cwd: string
  root: string
  execPath: string
  /** Spawn the configured command and return the tool names it advertises. */
  handshake: (entry: McpServerEntry) => Promise<string[]>
  env: Record<string, string | undefined>
  /**
   * Injected so the account check can be exercised without a network, the same
   * seam HttpStore uses. Defaults to the real one.
   *
   * Narrower than `typeof fetch` on purpose: this check only ever calls it one
   * way, and the full type drags in `preconnect`, which every test stub would
   * then have to cast its way past.
   */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
  /** Which platform's Claude Desktop config path to look at. Defaults to this one. */
  platform?: NodeJS.Platform
  /** `%APPDATA%`, which Claude Desktop's config path is under on Windows. */
  appData?: string
  /** Runs git, to find the repository containing `cwd`. Defaults to the real one. */
  git?: GitRunner
}

export const EXPECTED_TOOLS = [
  "team_knowledge_map",
  "team_knowledge_propose",
  "team_knowledge_read",
  "team_knowledge_search",
  "team_knowledge_write_document",
]

/** How much of a child's stderr is worth keeping for one line of a report. */
const STDERR_KEEP = 2_000

/**
 * A child's stderr, flattened to fit inside a report line. Newlines collapse
 * because a multi-line crash banner would break the grouped layout it is being
 * folded into, and the head is kept because that is where the error is — the
 * runtime version and stack frames underneath it are not the news.
 */
function summariseStderr(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * Launch the agent's own configured command and complete an MCP handshake.
 *
 * Inspecting the config only proves it looks right. This proves it runs — the
 * distinction that matters for this project's recurring defect class, where a
 * config that is correct in a shell fails under the editor that actually
 * spawns it.
 */
export async function spawnHandshake(
  entry: McpServerEntry,
  timeoutMs = 10_000,
): Promise<string[]> {
  const client = new Client({ name: "cairn-doctor", version: "1" }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    // Inherit, then overlay: the child needs a real PATH to run at all.
    //
    // `CAIRN_TELEMETRY: "0"` last, so it cannot be overridden by the config's
    // own env: this child is a full `cairn mcp` run against the AGENT's root,
    // and without it a `doctor` run sent a telemetry ping from a config the
    // invocation never named. doctor reports state; it must not write
    // to a root it was only asked to look at.
    env: {
      ...(process.env as Record<string, string>),
      ...(entry.env ?? {}),
      CAIRN_TELEMETRY: "0",
    },
    // Capture the child's stderr rather than letting it inherit ours (the
    // SDK's default). A server that dies at startup prints a raw crash banner,
    // and inherited it lands in the middle of doctor's own grouped report —
    // so the report a tester pastes looks like DOCTOR crashed, when in fact
    // the check caught it. Piped, the same text becomes the handshake check's
    // detail: attributed to the command that produced it, and contained.
    stderr: "pipe",
  })

  // Bounded on purpose: this ends up on one line of a report, and a chatty or
  // looping server must not be able to grow it without limit.
  let said = ""
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    if (said.length < STDERR_KEEP) said += String(chunk)
  })

  // Definite assignment is safe: the Promise executor below runs
  // synchronously, so `timer` is set before this function reads it.
  let timer!: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handshake timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  try {
    await Promise.race([client.connect(transport), timeout])
    const listed = await Promise.race([client.listTools(), timeout])
    return listed.tools.map((t) => t.name)
  } catch (err) {
    // Why it failed is usually only in what the child printed on its way out —
    // "handshake timed out" or "Connection closed" alone tells a tester
    // nothing. Carry it in the message so the check's detail can say it.
    const quoted = summariseStderr(said)
    const message = (err as Error).message
    throw new Error(quoted ? `${message} — the command's stderr said: ${quoted}` : message)
  } finally {
    // Every path clears the timer and closes the child, including timeout —
    // an uncleared timer holds the event loop open for up to timeoutMs after
    // the handshake has already settled, and a doctor that leaks processes
    // (or hangs the process that ran it) is worse than the problem it reports.
    clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

/**
 * Project config wins over global, matching the order agents themselves
 * resolve. The project files are looked for in `cwd` and then at the top of
 * the repository containing it, which is where an interactive `cairn init`
 * writes them — so doctor run from a subfolder still finds them. Codex and
 * Claude Desktop have one machine-wide config each, so they come last.
 */
export async function findMcpConfig(
  deps: DoctorDeps,
): Promise<{ path: string; entry: McpServerEntry } | null> {
  const fromJson = (text: string) =>
    (JSON.parse(text) as { mcpServers?: Record<string, McpServerEntry> }).mcpServers?.cairn ?? null
  const repoRoot = (await findRepo(deps.cwd, deps.git))?.root
  const projectDirs = repoRoot && repoRoot !== deps.cwd ? [deps.cwd, repoRoot] : [deps.cwd]
  const desktop = desktopConfigPath(deps.home, deps.platform ?? process.platform, deps.appData)
  const candidates: [string, (text: string) => McpServerEntry | null][] = [
    ...projectDirs.flatMap((dir) => [
      [join(dir, ".mcp.json"), fromJson],
      [join(dir, ".cursor", "mcp.json"), fromJson],
    ] as [string, typeof fromJson][]),
    [join(deps.home, ".claude.json"), fromJson],
    [join(deps.home, ".cursor", "mcp.json"), fromJson],
    [join(deps.home, ".codex", "config.toml"), readCodexEntry],
    ...(desktop ? [[desktop, fromJson] as [string, typeof fromJson]] : []),
  ]
  for (const [path, read] of candidates) {
    try {
      const entry = read(await readFile(path, "utf-8"))
      if (entry) return { path, entry }
    } catch {
      // Unreadable or unparseable: keep looking. checkConfig reports the miss.
    }
  }
  return null
}

export async function checkBinary(deps: DoctorDeps): Promise<CheckResult> {
  return {
    name: "binary", group: "Binary", status: "ok",
    detail: `${versionLine()} at ${deps.execPath}`,
  }
}

/**
 * The remedy for a machine with no agent on it.
 *
 * `cairn init` is the right advice only when there is an agent to configure.
 * On a bare machine it writes nothing, so prescribing it from a failing check
 * sends the reader in a circle. Named once, so the two checks that can land in this state say
 * the same thing.
 */
const NO_AGENT_FIX = "install Claude Code, Cursor, Codex or Claude Desktop, or cairn init --project"

export async function checkConfig(deps: DoctorDeps): Promise<CheckResult> {
  const found = await findMcpConfig(deps)
  if (!found) {
    if ((await detectAgents(deps.home)).length === 0) {
      return {
        name: "config", group: "Agent config", status: "fail",
        detail: `no supported agent found — looked for ~/.claude, ~/.cursor, ~/.codex and Claude Desktop in ${deps.home}`,
        fix: NO_AGENT_FIX,
      }
    }
    return {
      name: "config", group: "Agent config", status: "fail",
      detail: "no MCP config with a cairn server found",
      fix: "cairn init",
    }
  }
  return {
    name: "config", group: "Agent config", status: "ok",
    detail: `${found.path} — parses, cairn server present`,
  }
}

export async function checkCommandMatches(
  deps: DoctorDeps,
  entry: McpServerEntry,
): Promise<CheckResult> {
  try {
    await access(entry.command, constants.X_OK)
  } catch {
    return {
      name: "command-matches", group: "Agent config", status: "fail",
      detail: `configured command does not exist or is not executable: ${entry.command}`,
      fix: "cairn init",
    }
  }
  // A config that launches a source checkout is `checkSourceLaunch`'s to
  // diagnose, and comparing paths here would say nothing useful about it: both
  // sides are the bun executable, so this passes for any checkout on the
  // machine — and on a binary install it fails with "the path is wrong", which
  // is a second sentence and a second problem for the one `cairn init` that
  // fixes both. The handshake check is what catches a moved or renamed
  // checkout.
  if (entry.args.some((a) => a.endsWith(".ts"))) {
    return {
      name: "command-matches", group: "Agent config", status: "ok",
      detail: "command launches a source checkout — see the source-launch check",
    }
  }
  if (entry.command !== deps.execPath) {
    return {
      name: "command-matches", group: "Agent config", status: "fail",
      detail: `configured command is ${entry.command}, but this is ${deps.execPath}`,
      fix: "cairn init",
    }
  }
  return {
    name: "command-matches", group: "Agent config", status: "ok",
    detail: "command points at this same binary",
  }
}

/**
 * A config that launches cairn out of a source checkout, on a machine whose
 * cairn is a compiled binary.
 *
 * An editor starts an MCP server once and leaves it running. A machine can
 * collect several `bun …/src/cli.ts mcp` processes, days old, every one of
 * them pinned to a checkout whose contents have changed underneath it. What came out was worse than a crash:
 * claims were written to disk while the SQLite index write failed and the
 * propose events were never recorded — a half-completed write that reported
 * success. This is the guard against the
 * machine state that keeps producing it.
 *
 * The CONFIG is the signal, deliberately — not the running processes. Listing
 * those is platform-specific and fragile, and a config that no longer launches
 * a checkout is a machine that stops producing them after the next restart.
 * The cost of reading only the config is that servers already running are
 * invisible here: this says the machine will keep making them, not that any
 * exist right now.
 *
 * `compiled` is passed in rather than read from ./version so a test can
 * exercise both machines; the caller supplies the real COMPILED.
 */
export function checkSourceLaunch(entry: McpServerEntry, compiled: boolean): CheckResult {
  const name = "source-launch"
  const group = "Agent config"
  // `cairnServerEntry` writes `{ command: bun, args: [<checkout>/src/cli.ts,
  // "mcp"] }` for a source checkout and `{ command: cairn, args: ["mcp"] }`
  // for a binary, so a TypeScript entry point in the args is what tells the
  // two apart — regardless of where bun itself lives on this machine.
  const source = entry.args.find((a) => a.endsWith(".ts"))
  if (!compiled) {
    return {
      name, group, status: "ok",
      detail: "this cairn runs from a source checkout, so launching one is correct",
    }
  }
  if (!source) {
    return { name, group, status: "ok", detail: "the config launches this binary, not a checkout" }
  }
  return {
    name, group, status: "fail",
    detail:
      `the config launches cairn from ${source}, but this cairn is a compiled binary — ` +
      `your editor will keep starting MCP servers from that checkout and leaving them ` +
      `running against whatever it contains later`,
    fix: "cairn init",
  }
}

export async function checkCairnRoot(
  deps: DoctorDeps,
  entry: McpServerEntry,
): Promise<CheckResult> {
  const configured = entry.env?.CAIRN_ROOT
  if (!configured) {
    return {
      name: "cairn-root", group: "Agent config", status: "fail",
      detail: "CAIRN_ROOT is not set in the MCP config, so the agent will use ~/.cairn",
      fix: "cairn init",
    }
  }
  try {
    await access(configured, constants.R_OK | constants.W_OK)
  } catch {
    return {
      name: "cairn-root", group: "Agent config", status: "fail",
      detail: `CAIRN_ROOT is ${configured}, which is not readable and writable`,
    }
  }
  return {
    name: "cairn-root", group: "Agent config", status: "ok",
    detail: `CAIRN_ROOT set to ${configured}`,
  }
}

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false)

/**
 * Cursor keeps USER-level rules in its settings rather than in a file, so
 * `cairn init --global` on a Cursor-only machine deliberately prints the block
 * for the operator to paste (src/init.ts) and writes no instructions file at
 * all. There is therefore nothing on disk for this check to find, and calling
 * that a failure made the command whose job is confirming a correct setup exit
 * 1 on a correct setup. Warn instead, and say why it cannot be verified.
 *
 * Project scope is unaffected: Cursor project rules ARE a file
 * (.cursor/rules/cairn.mdc), and that stays a hard requirement.
 */
async function isCursorOnlyGlobal(deps: DoctorDeps, configPath?: string): Promise<boolean> {
  if (configPath !== join(deps.home, ".cursor", "mcp.json")) return false
  // Claude Code present means init would have written ~/.claude/CLAUDE.md, so
  // a missing block there is a genuine failure rather than the paste-only case.
  return !(await isDir(join(deps.home, ".claude")))
}

export async function checkInstructions(
  deps: DoctorDeps,
  configPath?: string,
): Promise<CheckResult> {
  const candidates = [
    join(deps.cwd, "AGENTS.md"),
    join(deps.cwd, "CLAUDE.md"),
    join(deps.cwd, ".cursor", "rules", "cairn.mdc"),
    join(deps.home, ".claude", "CLAUDE.md"),
  ]
  for (const path of candidates) {
    try {
      if ((await readFile(path, "utf-8")).includes("<!-- cairn:start -->")) {
        return {
          name: "instructions", group: "Agent config", status: "ok",
          detail: `${path} has the cairn instructions block`,
        }
      }
    } catch {
      // Missing file is not an error here; absence across all of them is.
    }
  }
  if (await isCursorOnlyGlobal(deps, configPath)) {
    return {
      name: "instructions", group: "Agent config", status: "warn",
      detail:
        "Cursor-only global install — user rules live in Cursor's settings, not a file, " +
        "so the instructions block cannot be verified from here",
      fix: "confirm the cairn block is in Cursor → Settings → Rules, or use cairn init --project",
    }
  }
  return {
    name: "instructions", group: "Agent config", status: "fail",
    detail: "no cairn instructions block found — the agent is never told to consult team knowledge",
    fix: "cairn init",
  }
}

/**
 * Run every check, isolating each one. A check that throws becomes a failing
 * result rather than ending the run: a doctor that dies halfway is worse than
 * no doctor, because it hides the checks it never reached.
 */
export async function runDoctor(deps: DoctorDeps): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const run = async (name: string, group: string, fn: () => Promise<CheckResult>) => {
    try {
      results.push(await fn())
    } catch (err) {
      results.push({
        name, group, status: "fail",
        detail: `check failed to run: ${(err as Error).message}`,
      })
    }
  }

  await run("binary", "Binary", () => checkBinary(deps))
  await run("config", "Agent config", () => checkConfig(deps))

  const found = await findMcpConfig(deps)
  if (found) {
    await run("command-matches", "Agent config", () => checkCommandMatches(deps, found.entry))
    await run("source-launch", "Agent config", async () => checkSourceLaunch(found.entry, COMPILED))
    await run("cairn-root", "Agent config", () => checkCairnRoot(deps, found.entry))
    await run("instructions", "Agent config", () => checkInstructions(deps, found.path))
    // Group named `Server`, not `Connection`: this check spawns the configured
    // command ITSELF, so what it proves is that cairn is installed, runnable
    // and speaking MCP here. Whether the agent loaded it is not observable
    // from inside cairn, and a green line under `Connection` was read as the
    // stronger claim twice in one day.
    await run("handshake", "Server", async () => {
      // Caught here rather than left to `run`'s generic wrapper: a handshake
      // that fails is not "the check failed to run", and the message carries
      // what the child said on its way out (see spawnHandshake). Naming the
      // command is what keeps that text attributed instead of looking like
      // doctor's own crash.
      let tools: string[]
      try {
        tools = await deps.handshake(found.entry)
      } catch (err) {
        return {
          name: "handshake", group: "Server", status: "fail",
          detail: `${found.entry.command} did not complete an MCP handshake: ${(err as Error).message}`,
          fix: "run the configured command yourself and read what it prints",
        }
      }
      const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t))
      return missing.length
        ? { name: "handshake", group: "Server", status: "fail",
            detail: `handshake succeeded but tools are missing: ${missing.join(", ")}` }
        : { name: "handshake", group: "Server", status: "ok",
            detail: `cairn runs here and answers MCP: ${tools.length} tools listed (this does not mean your agent loaded it)` }
    })
    // The step cairn cannot check, named rather than passed over in silence.
    // Cursor gates a PROJECT-scoped MCP server behind a per-project approval
    // recorded in its own state; a global one was observed not to be gated.
    // Deliberately NOT verified by reading Cursor's SQLite: that state is
    // private and undocumented, and would be a new way to be wrong.
    if (found.path === join(deps.cwd, ".cursor", "mcp.json")) {
      results.push({
        name: "approval", group: "Server", status: "warn",
        detail:
          "Cursor asks you to approve a project MCP server before it runs one, and records that " +
          "in its own state — cairn cannot see whether you have",
        fix: "if the tools are missing in Cursor, approve cairn in its Customize panel, then check Cmd+Shift+U → MCP Logs — or install it globally, which Cursor does not gate this way",
      })
    }
  }

  // The store that matters is the one the AGENT will use — the CAIRN_ROOT baked
  // into the MCP config — not the ambient CAIRN_ROOT of whatever shell ran
  // doctor. When those differed, one report described two different stores and
  // called both fine, and a correctly-initialised install was told "consent has
  // never been asked". Fall back to the ambient root only when no config names
  // one.
  const configuredRoot = found?.entry.env?.CAIRN_ROOT
  const agentDeps = configuredRoot ? { ...deps, root: configuredRoot } : deps

  await run("auth", "Account", () => checkAuth(agentDeps))
  await run("store", "Store", () => checkStore(agentDeps))
  await run("generation", "Generation", () => checkGeneration(agentDeps))
  await run("telemetry", "Telemetry", () => checkTelemetry(agentDeps))
  return results
}

/**
 * Whether this machine can actually reach the shared store.
 *
 * Four failures, four answers. They look identical from the outside — nothing
 * works — and they need completely different things done about them, so
 * collapsing any pair of them sends the reader to fix something that is fine:
 * signing in again cannot cure a 503, and checking a network cannot cure a
 * token an owner revoked.
 */
export async function checkAuth(deps: DoctorDeps): Promise<CheckResult> {
  const name = "auth"
  const group = "Account"
  const cfg = await readConfig(deps.root)
  if (cfg?.mode === "local") {
    // An absent account is correct here, not a failure. `doctor` must name the
    // space it is describing: with two modes in play, a report that does not
    // say which store it read is a report the reader has to guess at.
    //
    // `cairn init --local` deliberately keeps an existing `auth` block rather
    // than clearing it, so a stale token is possible by design. Surfacing it
    // here — rather than hiding it because it is unused — is the entire
    // mitigation for that: a credential the CLI will never use is fine, a
    // credential nobody knows is there is not.
    const stale = cfg.auth ? " — signed in, but this space is local, so the token is unused" : ""
    return {
      name, group, status: "ok",
      detail: `local space at ${deps.root} — no account needed${stale}`,
    }
  }
  if (!cfg?.auth) {
    return {
      name, group,
      // A FAILURE. This was a warning while `makeStore`
      // still fell back to the local files, because doctor must not call a
      // configuration cairn itself supports "broken" — but there is no local
      // store to fall back to now: every command that touches knowledge, and
      // the MCP server the agent spawns, exit 1 on this exact state. A doctor
      // reporting "no problems" on an install where nothing works is the same
      // lie in the other direction.
      status: "fail",
      detail: "not signed in — cairn reads and writes nothing until this machine is connected",
      fix: "cairn login",
    }
  }
  const { apiUrl, token, orgSlug, user } = cfg.auth
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(`${apiUrl}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    })
  } catch (err) {
    // Only the request is inside the try. Wrapping the branches below as well
    // reported a bug in this function as a network problem, which sends the
    // reader to check a network that is fine.
    return {
      name, group, status: "fail",
      // Name the endpoint AND what stopped us: "it doesn't work" should be one
      // paste long. A timeout and a refused connection want different next
      // steps, and only the underlying message tells them apart.
      detail: `cairn is not reachable at ${apiUrl} (${(err as Error).message})`,
      fix: "check your network or VPN, then run cairn doctor again",
    }
  }
  if (res.status === 401) {
    return {
      name, group, status: "fail",
      detail: `your token was revoked or has expired (${apiUrl})`,
      fix: "cairn login",
    }
  }
  if (!res.ok) {
    return {
      name, group, status: "fail",
      // The service is up and refusing or failing. Nothing local fixes that,
      // so the fix says what CAN be done rather than repeating `cairn login`.
      detail: `cairn answered ${res.status} at ${apiUrl}`,
      fix: `try again shortly; if it persists, check ${apiUrl}/v1/health`,
    }
  }
  return {
    name, group, status: "ok",
    detail: `signed in as ${user ?? "you"} — space ${orgSlug} at ${apiUrl}`,
  }
}

/**
 * The store the CLI ACTUALLY uses — chosen the same way `makeStore` chooses it,
 * from the same `auth` block.
 *
 * Building a FileStore unconditionally here reported a local directory as
 * healthy while every command talked to the hosted space: someone signed into
 * a space of dozens of approved claims read "0 approved, 0 pending" one line under a
 * failing Account check, and any missing-abstract warning it raised could
 * never clear, because `cairn abstracts` was already running against the
 * hosted store. It also created ~/.cairn/{inbox,approved,rejected} and
 * index.db on a machine that will never read them.
 *
 * This is the same class `runDoctor`'s CAIRN_ROOT comment describes — one
 * report describing two different stores and calling both fine — arriving
 * through a different door.
 */
export async function checkStore(deps: DoctorDeps): Promise<CheckResult> {
  const name = "store"
  const group = "Store"
  const cfg = await readConfig(deps.root)

  const report = (where: string, approved: Claim[], pending: Claim[]): CheckResult => {
    const missing = approved.filter((c) => !c.abstract?.trim()).length
    const base = `${where} — ${approved.length} approved, ${pending.length} pending`
    if (missing > 0) {
      return {
        name, group, status: "warn",
        detail: `${base}; ${missing} approved claim(s) have no abstract`,
        fix: "cairn abstracts",
      }
    }
    return { name, group, status: "ok", detail: base }
  }

  // Mode, before auth — same rule `makeStore` follows, and for the same
  // reason: `cairn init --local` keeps an existing `auth` block rather than
  // clearing it, so building an HttpStore whenever `auth` is present would
  // report on a hosted space the CLI will never read once `mode` is local.
  if (cfg?.mode === "local") {
    const store = new FileStore(deps.root)
    await store.init()
    return report(`local space at ${deps.root}`, await store.list("approved"), await store.list("pending"))
  }

  if (cfg?.auth) {
    const { apiUrl, orgId, orgSlug, token } = cfg.auth
    // The same injected seam checkAuth uses, for the same reason: this check
    // must be exercisable without a network. The cast is the one the rest of
    // the codebase already makes — DoctorDeps narrows fetch to the single
    // shape these checks call it with.
    const store = new HttpStore({
      baseUrl: apiUrl,
      orgId,
      token,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl as unknown as typeof fetch } : {}),
    })
    try {
      return report(
        `space ${orgSlug} at ${apiUrl}`,
        await store.list("approved"),
        await store.list("pending"),
      )
    } catch (err) {
      // NOT "0 approved, 0 pending", and not a second copy of the Account
      // check's diagnosis: an unread space and an empty one look identical in
      // a count, and the reader has already been told what is wrong one group
      // above. Warn, and point at it.
      return {
        name, group, status: "warn",
        // Not the network diagnosis a second time — the Account check one group
        // above already gave it, with the fix. What this line has to say is the
        // thing only it knows: the counts are UNKNOWN, not zero.
        detail: `could not read space ${orgSlug} at ${apiUrl} — its contents are unknown, not zero`,
        fix: "see the Account check above",
      }
    }
  }

  // Signed out there is no store to describe, and describing the old local
  // directory instead would be the very defect above: a healthy-looking report
  // for files nothing reads. Counts are UNKNOWN, not zero. Warn rather than
  // fail a second time — the Account check one group up already failed, with
  // the fix, and repeating a diagnosis does not make it clearer.
  return {
    name, group, status: "warn",
    detail: "no space to read — this machine is not connected to one",
    fix: "see the Account check above",
  }
}

/**
 * Reports the EFFECTIVE configuration — what `cairn abstracts` would actually
 * send — and WHERE the key came from, never the key itself.
 *
 * Effective, not stored: with CAIRN_MODEL exported this printed the stored
 * model while every abstract went out under the overriding one, so a doctor
 * that said ✔ and a run that failed every claim disagreed with nothing to
 * explain the gap. Both the value in use and the variable that changed it are
 * named, because either alone leaves the reader guessing.
 *
 * The provenance earns its place on its own: a stored key silently shadowed by
 * an environment variable is otherwise a twenty-minute debugging session.
 */
export async function checkGeneration(deps: DoctorDeps): Promise<CheckResult> {
  const cfg = await readConfig(deps.root)
  const stored = cfg?.generation ?? null
  // Resolved exactly the way generation resolves it, rather than re-read here:
  // a second reading of the same environment is a second thing to keep in step.
  const resolved = resolveGeneration(stored, deps.env)
  if (!stored || !resolved) {
    return {
      name: "generation", group: "Generation", status: "warn",
      detail: "no usable model configured — config.json is missing a generation " +
        "block, or names a provider cairn does not know",
      fix: "cairn model",
    }
  }
  // No unknown-provider branch here: readConfig (src/config.ts) already
  // validates stored.provider against the same id list providerById's
  // registry holds, and drops the whole generation block rather than keep a
  // half-valid one. By the time stored is non-null, its provider is always
  // one providerById recognises.
  const { provider } = resolved

  const { source } = keyProvenance(provider, deps.env, stored.apiKey)
  // The vocabulary: set (from ANTHROPIC_API_KEY) / set (stored) / not
  // set. "no key needed" belongs to a provider with no key variable at all —
  // giving it to a provider that needs one made a working key and a missing
  // one read identically.
  const key =
    source === "none"
      ? provider.keyEnvVar === null ? "no key needed" : "key not set"
      : source === "stored" ? "key set (stored)" : `key set (from ${source})`

  const overrides: string[] = []
  if (resolved.model !== stored.model) {
    overrides.push(`CAIRN_MODEL overrides the stored ${stored.model}`)
  }
  // Compared against the NORMALISED stored value: readConfig keeps "" verbatim
  // while resolveBaseUrl drops it, and comparing the raw pair reported an
  // override nobody had set.
  if (resolved.baseUrl !== resolveBaseUrl(undefined, {}, stored.baseUrl)) {
    overrides.push(`CAIRN_MODEL_URL overrides the stored endpoint with ${resolved.baseUrl}`)
  }

  // A key the provider requires and cannot find is not "fine": every abstract
  // this configuration writes would come back 401.
  const missing = provider.keyEnvVar !== null && source === "none"
  return {
    name: "generation", group: "Generation",
    status: missing ? "warn" : "ok",
    detail: `${resolved.model} via ${provider.label} — ${key}` +
      (overrides.length ? ` (${overrides.join("; ")})` : ""),
    ...(missing ? { fix: "cairn model" } : {}),
  }
}

export async function checkTelemetry(deps: DoctorDeps): Promise<CheckResult> {
  const cfg = await readConfig(deps.root)
  if (!cfg) {
    return {
      name: "telemetry", group: "Telemetry", status: "warn",
      // Name the root: a pasted report must say WHICH store was looked in.
      detail: `no config yet in ${deps.root} — consent has never been asked`,
      // Consent is only recorded by an init run that gets as far as writing,
      // so on a bare machine the plain command is the same dead end again.
      fix: (await detectAgents(deps.home)).length === 0 ? NO_AGENT_FIX : "cairn init",
    }
  }
  if (!cfg.telemetry) {
    // No probe on this path, deliberately: consent covers the reachability
    // check as much as the ping. An opted-out install makes no request to the
    // telemetry endpoint for any reason.
    return { name: "telemetry", group: "Telemetry", status: "ok", detail: "off" }
  }
  const last = cfg.lastSentAt ? `last sent ${cfg.lastSentAt}` : "nothing sent yet"
  // The check exists to catch silent signal loss — consent given and nothing
  // arriving — which is indistinguishable from a quiet week unless something
  // actually probes. `sendTelemetry` swallows its own failures by design, so
  // this is the only place the operator can learn of them.
  const url = new URL(deps.env?.CAIRN_TELEMETRY_URL ?? TELEMETRY_URL)
  url.pathname = "/v1/health"
  try {
    const res = await (deps.fetchImpl ?? fetch)(url.toString(), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`status ${res.status}`)
  } catch (err) {
    return {
      name: "telemetry", group: "Telemetry", status: "warn",
      // A warning rather than a failure: doctor's exit code answers "is this
      // install broken", and a telemetry outage does not break anything the
      // operator is trying to do.
      detail: `enabled, ${last} — but ${url.host} is unreachable (${(err as Error).message}), so nothing is being recorded`,
      fix: "`cairn telemetry off` if you would rather it stopped trying",
    }
  }
  return { name: "telemetry", group: "Telemetry", status: "ok", detail: `enabled, ${last}` }
}
