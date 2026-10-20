#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { EventSink, Stats } from "./events"
import { createMcpServer, DEFAULT_SEARCH_LIMIT } from "./mcp"
import { ABSENCE_FRAMING } from "@cairn-kb/protocol/absence"
import { isRateLimit, rootMessage } from "./errors"
import { generateAbstract, resolveGeneration } from "./generate"
import type { ResolvedGeneration } from "./generate"
import { runDoctor, spawnHandshake } from "./doctor"
import { applyInit, planInit, type InitPlan, type McpServerEntry, type Scope } from "./init"
import { AGENT_LABEL, detectAgents, formatAgents, INIT_AGENTS, parseAgentsFlag, type Agent } from "./agents"
import { findRepo, repoLabel, scanDocs, topFolders, type RepoInfo } from "./repo"
import { applyFill, CODE_SCAN_THRESHOLD, planFill, type FillPlan } from "./fill"
import { codeScanPrompt } from "./import-skill"
import { firstAnswer, suggestQuestion } from "./first-answer"
import { proveAgents, RESTART_NOTE, UNOBSERVABLE, type AgentProof } from "./prove"
import { planMigration, runMigration } from "./migrate"
import { openInBrowser } from "./browser"
import { runLogin, runLogout } from "./login"
import { listOrgs, useOrg } from "./orgs"
import { runModelCommand, verificationSubject } from "./model"
import { allProviders, providerById, PROVIDER_IDS, resolveBaseUrl, resolveKey } from "./providers"
import type { ProviderId } from "./providers"
import { EventLog } from "./events"
import { HttpEventSink, HttpStore } from "./http-store"
import { FileStore } from "./store"
import { normalizeSource } from "./documents"
import { finishTally, importFile, newTally, tally, type CitedUpdate, type ImportSummary } from "./import-file"
import { EMPTY_RETRACT_REASON, EMPTY_SUPPORTS } from "@cairn-kb/protocol/event-kinds"
import type { Claim, Document, Store } from "@cairn-kb/protocol/types"
import { colorsEnabled, createUi, progressLine } from "./ui"
import { wordmark } from "./wordmark"
import { newConfig, readConfig, updateConfig, writeConfig } from "./config"
import { listMembers } from "./orgs"
import { provenanceOf, renderProvenance } from "@cairn-kb/protocol/provenance"
import type { AuthConfig, Mode } from "./config"
import { consentPreview, sendTelemetry } from "./telemetry"
import { recordSearchHit } from "./first-answer-metric"
import { VERSION, versionLine } from "./version"

const ROOT = process.env.CAIRN_ROOT ?? join(process.env.HOME ?? ".", ".cairn")

/** The hosted service. Overridable the same way CAIRN_MODEL_URL overrides a provider endpoint. */
export const DEFAULT_API_URL = "https://api.cairn-kb.dev"

function flagValue(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : undefined
}

/** Parsed once so the policy is testable without a TTY. */
export function modelFlags(rest: string[]): {
  provider?: ProviderId
  model?: string
  baseUrl?: string
  maxTokens?: number
  list: boolean
  verify: boolean
} {
  const p = flagValue(rest, "--provider")
  const max = Number(flagValue(rest, "--max-tokens"))
  return {
    provider: PROVIDER_IDS.includes(p as ProviderId) ? (p as ProviderId) : undefined,
    model: flagValue(rest, "--model"),
    baseUrl: flagValue(rest, "--base-url"),
    // Anything that is not a positive integer is dropped rather than passed on.
    // `--max-tokens abc` would otherwise reach the API as NaN and fail every
    // call with an error naming neither the flag nor the value.
    maxTokens: Number.isInteger(max) && max > 0 ? max : undefined,
    list: rest.includes("--list"),
    // Costs a real API call, so a script opts in rather than out.
    verify: rest.includes("--verify"),
  }
}

const ui = createUi(colorsEnabled(process.env, Boolean(process.stdout.isTTY)))

/**
 * Whether telemetry is on, or null when we should ask. Kept separate from the
 * prompt so the policy is testable without a TTY.
 *
 * Opt-in means off unless someone said yes, so a non-interactive run with no
 * flag is off — silence is not consent.
 */
/**
 * What the flags said, and nothing else. Null means they said nothing.
 *
 * This used to also decide what silence meant, returning `false` when there was
 * no TTY — which is right for a first run on a bare machine and wrong for a
 * machine that already answered. Consent is the one field where "I could not
 * ask, so I assumed no" discards an answer the operator gave deliberately, and
 * there is no way back: consent is only ever set inside `init`. The default now
 * lives at the call site, where the existing config is in scope.
 */
export function telemetryChoice(rest: string[]): boolean | null {
  if (rest.includes("--no-telemetry")) return false
  if (rest.includes("--telemetry")) return true
  return null
}

/**
 * What the flags said about where knowledge should live, and nothing else.
 * Null means neither flag was passed.
 *
 * Both at once throws rather than picking one: scope has a default to fall
 * back on when both `--project` and `--global` show up, but mode does not —
 * `--local` and `--team` choose different stores, so silently picking a
 * winner is how a scripted install lands somebody in the wrong space.
 */
export function modeFromFlags(rest: readonly string[]): Mode | null {
  const local = rest.includes("--local")
  const team = rest.includes("--team")
  if (local && team) {
    throw new Error("--local and --team choose different stores — pass one")
  }
  return local ? "local" : team ? "team" : null
}

/**
 * Every flag each command accepts. A command with no flags is present with an
 * empty list rather than absent — absent means "not a command", which is a
 * different error and a better message.
 */
export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  init: [
    "--global", "--project", "--dry-run", "--yes", "--telemetry", "--no-telemetry",
    "--local", "--team", "--agents",
  ],
  model: ["--provider", "--model", "--base-url", "--max-tokens", "--list", "--verify", "--yes"],
  doctor: ["--json"],
  import: [],
  "adopt-imports": [],
  abstracts: ["--all", "--dry-run", "--force"],
  status: [],
  stats: [],
  review: ["--json", "--mine"],
  search: ["--all", "--json"],
  show: ["--json"],
  retract: ["--reason"],
  cite: ["--supports"],
  uncite: [],
  curate: [],
  mcp: [],
  rebuild: [],
  login: ["--no-browser"],
  logout: [],
  org: [],
  telemetry: [],
}

/** Flags whose value is the next argument, so that value is not itself a flag. */
const VALUED_FLAGS = new Set([
  "--provider", "--model", "--base-url", "--max-tokens", "--reason", "--supports", "--agents",
])

/** Flags this command does not take. Empty for a command that does not exist —
 *  `unknown command` is the better error, and it already exists. */
export function unknownFlags(command: string, rest: string[]): string[] {
  const allowed = COMMAND_FLAGS[command]
  if (allowed === undefined) return []
  const bad: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    // Skip the value, so `--model --weird` reports nothing: a value that looks
    // like a flag is still a value.
    if (VALUED_FLAGS.has(arg)) {
      i++
      continue
    }
    if (!arg.startsWith("-")) continue
    // Handled before this runs, and reporting it here would turn the one thing
    // a confused person types into an error twice over.
    if (arg === "--help" || arg === "-h") continue
    if (!allowed.includes(arg)) bad.push(arg)
  }
  return bad
}

/** The flags a command takes, for the message when one of them is wrong. */
export function flagsFor(command: string): readonly string[] {
  return COMMAND_FLAGS[command] ?? []
}

type Clack = typeof import("@clack/prompts")

/**
 * Ask only when someone is there to answer AND wants to be asked. Scripted
 * onboarding and CI pass a flag; a run with nobody to answer defaults to
 * project scope rather than silently editing files in the user's home
 * directory.
 *
 * `interactive` rather than `isTTY`, because `--yes` in a terminal is somebody
 * saying "take the defaults" — gating on the terminal alone made `--yes` mean
 * "skip most questions" and then stop at the rest.
 *
 * Null means cancelled. Cancellation is returned rather than exited on, so the
 * decision of what a cancel means lives with the caller — and so the cancel
 * path is reachable in a test without a pty.
 */
async function askScope(cwd: string, interactive: boolean, repo: RepoInfo | null): Promise<Scope | null> {
  if (!interactive) return "project"
  const { isCancel, select } = await import("@clack/prompts")
  const answer = await select({
    message: "Configure this project or your whole machine?",
    options: [
      // Named by its repository when there is one: that is what project
      // scope connects in a terminal, wherever inside it `init` was run.
      repo
        ? { value: "project" as const, label: `This project (${repo.label})`, hint: repo.root }
        : { value: "project" as const, label: "This project", hint: cwd },
      { value: "global" as const, label: "Globally" },
    ],
    initialValue: "project" as const,
  })
  return isCancel(answer) ? null : answer
}

/**
 * Mirrors askScope: asks only when someone is there to answer and wants to be
 * asked, and returns null for a cancel so the caller decides what a cancel
 * means.
 *
 * The unasked default is "team" unconditionally — not derived from an
 * existing config — because this is the one compatibility rule: every
 * scripted install that predates local mode is hosted, and a bare
 * `cairn init` with no flag on such a script must keep behaving exactly as
 * it always has.
 */
async function askMode(interactive: boolean): Promise<Mode | null> {
  if (!interactive) return "team"
  const { isCancel, select } = await import("@clack/prompts")
  const answer = await select({
    message: "Where should this knowledge live?",
    // Local leads on purpose: cairn works alone, and a team space is the upgrade.
    options: [
      { value: "local" as const, label: "On this machine only", hint: "solo — no account needed" },
      { value: "team" as const, label: "In a shared team space", hint: "needs an account" },
    ],
  })
  return isCancel(answer) ? null : answer
}

/**
 * The two resolvers `init` hands to `runInitCommand`, built from the flags and
 * from whether anyone is there to answer. Extracted from the command body so
 * the wiring itself is testable: the prompts are unreachable without a pty,
 * but which of them runs is exactly what `--yes` decides.
 */
export function initPrompts(
  rest: readonly string[],
  cwd: string,
  interactive: boolean,
  repo: RepoInfo | null = null,
): { resolveScope: () => Promise<Scope | null>; resolveMode: (existing: Mode | null) => Promise<Mode | null> } {
  return {
    resolveScope: async () =>
      rest.includes("--global")
        ? "global"
        : rest.includes("--project")
          ? "project"
          : askScope(cwd, interactive, repo),
    resolveMode: async (existing) => modeFromFlags(rest) ?? existing ?? (await askMode(interactive)),
  }
}

/**
 * Confirms moving a local root's claims AND documents into a team space.
 * Declines rather than guessing when nobody is there to answer: this is a
 * lossy, one-way move — local event history does not follow it — and that is
 * a judgment call for the person at the keyboard, not a default this command
 * gets to pick for a scripted install.
 */
async function askMigration(clack: Clack | null, held: LocalHoldings): Promise<boolean | null> {
  if (!clack) return false
  const answer = await clack.confirm({
    message: `Move ${describeHoldings(held)} into the team space?`,
    initialValue: true,
  })
  return clack.isCancel(answer) ? null : answer
}

/**
 * The consent screen renders the actual payload, not a description of it —
 * opt-in is only meaningful if the bytes are visible. Null means cancelled.
 */
async function askTelemetry(clack: Clack): Promise<boolean | null> {
  clack.note(consentPreview(), "Exactly what would be sent")
  const answer = await clack.confirm({
    message: "Send anonymous usage counts to help improve cairn?",
    initialValue: false,
  })
  return clack.isCancel(answer) ? null : answer
}

export type InitOutcome = "no-agent" | "cancelled" | "planned" | "written"

/**
 * What this root already holds locally — claims AND documents — regardless of
 * what the config's `mode` currently says. Used to decide whether a mode flip
 * would strand anything: a root that has never held local files has nothing
 * to strand, however long it has been signed in.
 *
 * Both numbers, from one store, because counting only claims is precisely how
 * `init --team` came to skip the migration outright for a root holding
 * nothing but an imported corpus — `cairn import` writes documents and never
 * claims on this version, so the documented first-run sequence produces a
 * local space with 0 claims and everything else.
 *
 * Deliberately the local `FileStore`, never `makeStore`: on a team root
 * `makeStore` builds an `HttpStore` and requires auth, which would make this
 * check hit the network — or fail outright on a team root nobody has signed
 * into yet. The question here is "does this directory already hold files",
 * and only local files can be stranded by this command.
 */
async function localHoldings(root: string): Promise<LocalHoldings> {
  const store = new FileStore(root)
  await store.init()
  const lists = await Promise.all(
    (["pending", "approved", "rejected", "retracted"] as const).map((status) => store.list(status)),
  )
  const all = lists.flat()
  // `planMigration` OWNS the definition of what moves, and asking it here is
  // the whole point: the consent sentence and the migration cannot disagree
  // about what will happen, because one function decides. Counting the
  // statuses again in this file is what made the prompt promise that a
  // rejected claim would move.
  //
  // No extra I/O — the claims are already loaded to be counted.
  const plan = planMigration(all)
  return {
    claims: all.length,
    moving: plan.toImport.length + plan.toPropose.length,
    stayingLocal: plan.leftBehind.length,
    documents: (await store.listDocuments()).length,
  }
}

/** What a local root holds that a mode change could strand. The numbers
 *  travel together everywhere below, because any one alone can be zero while
 *  the root is far from empty. */
export interface LocalHoldings {
  /**
   * Every claim on the root, whatever its status. This is the question the
   * team -> local refusal asks — "does this directory already hold claims" —
   * and it is NOT `moving`: a rejected claim is still sitting there.
   */
  claims: number
  /** Of those, the ones a migration would carry. From `planMigration`. */
  moving: number
  /**
   * Of those, the ones it would leave behind. From `planMigration`, and
   * deliberately NOT derived by subtracting `moving` from `claims`: a status
   * matching none of that function's three buckets belongs to neither number,
   * and subtraction would silently assign it to this one.
   */
  stayingLocal: number
  /** Documents. All of them move; the migration leaves none behind. */
  documents: number
}

/** True when this root holds anything a migration would have to carry — what
 *  MOVES, not what is present. A root holding nothing but rejected claims was
 *  asked to confirm a one-way, lossy operation that would carry nothing, and
 *  then told "nothing new to move". Asking at all was the defect. */
const holdsSomething = (held: LocalHoldings): boolean => held.moving + held.documents > 0

/**
 * "3 claims and 22 documents", "22 documents", "3 claims".
 *
 * One phrase builder for the prompt, both refusals and the warning, so they
 * cannot disagree about what is on the root. Zero counts are omitted rather
 * than printed: after `cairn import` on this version a local space holds 0
 * claims and 22 documents, and "0 claims and 22 documents" reads like a bug
 * report. Never called with both at zero — `holdsSomething` gates every use.
 */
function describeHoldings(held: LocalHoldings): string {
  const parts: string[] = []
  // `moving`, never `claims`: every caller of this builder is describing what
  // a migration would carry, and the one caller that means "what is present"
  // (the team -> local refusal) writes its own sentence from `claims`.
  if (held.moving > 0) parts.push(`${held.moving} claim${held.moving === 1 ? "" : "s"}`)
  if (held.documents > 0) {
    parts.push(`${held.documents} document${held.documents === 1 ? "" : "s"}`)
  }
  return parts.join(" and ")
}

export interface InitCommandDeps {
  root: string
  home: string
  cwd: string
  cliPath: string
  execPath: string
  bunPath: string
  dryRun: boolean
  /** True when the operator named `--project` themselves. See planInit. */
  writeWithoutAgent: boolean
  /** The chosen scope, or null when the operator cancelled. */
  resolveScope: () => Promise<Scope | null>
  /** Consent, or null when the operator cancelled. Receives the consent already
   *  on disk, so a run with nobody to ask can keep it rather than assume. */
  resolveTelemetry: (existing: boolean | null) => Promise<boolean | null>
  /** The chosen mode, or null when the operator cancelled. Receives the mode
   *  already on disk, the same way resolveTelemetry receives existing
   *  consent — a run with no flag and nobody to ask keeps it rather than
   *  silently relocating a root that was already local. A fresh root
   *  (existing null) still lands on the compatibility default. */
  resolveMode: (existing: Mode | null) => Promise<Mode | null>
  /**
   * Whether there is a human at a terminal to ask. Gates the local -> team
   * migration prompt specifically: migration is a one-way, lossy decision —
   * the hosted store owns ids and timestamps, so who proposed and reviewed
   * each claim, and when, does not transfer — and the person mid-migration is
   * the only one who can decide whether that matters. A script cannot make
   * that call either way, so a non-interactive `init --team` on a local root
   * that holds anything — claims, documents, or both — REFUSES rather than
   * migrating silently or silently doing nothing, the same precedent `cairn
   * review` sets for a headless run of an interactive command.
   *
   * Not derived from `resolveMigration` itself: a resolver that just returns
   * `false` when nobody is there to ask cannot be told apart from a human who
   * typed "no", and those two need different outcomes here — one is
   * "cancelled", the other is "exit 1, try again from a terminal".
   */
  interactive: boolean
  /**
   * Confirms moving a local root's claims and documents into a team space,
   * given how many of each there are. Only ever called when `interactive` is
   * true. False or null both mean "don't" — a decline and a Ctrl-C have the
   * same effect here, since either way nothing may be migrated and the mode
   * must not flip.
   *
   * Only asked when there is something to move. "Something" is claims OR
   * documents: a root holding 22 documents and no claims is not an empty
   * root, and treating it as one is how `init --team` came to flip the mode
   * and leave an entire imported corpus stranded on local disk without
   * printing a word about it.
   */
  resolveMigration: (held: LocalHoldings) => Promise<boolean | null>
  /**
   * The team store a confirmed migration writes into, built from the `auth`
   * block already on disk. Injected — with the real `HttpStore` as the
   * default, so nothing about a real run changes — only so a test can drive
   * this whole path, gate through summary, against a store it can then read
   * back. The defect this exists to cover survived precisely because the only
   * migration test called `runMigration` directly and never came through
   * here.
   */
  openTeamStore?: (auth: AuthConfig) => Store
  out: (line: string) => void

  // Everything below drives the first-run steps an interactive run adds after
  // the config is written: prove, fill and first answer. Each is optional so a
  // caller that leaves one out keeps today's behaviour for that step — no
  // confirmation asked, nothing signed in, no folders added.

  /** `--agents`, parsed: the agents to configure, and whether the other MCP
   *  client was named. Null or absent when the flag was not given. */
  agentsFlag?: { agents: Agent[]; other: boolean } | null
  /**
   * Which agents to configure, asked with the detected ones pre-selected.
   * Only asked in a terminal, without `--agents`, and not on a dry run. Null
   * means cancelled, and so does choosing nothing at all.
   */
  chooseAgents?: (found: Agent[]) => Promise<{ agents: Agent[]; other: boolean } | null>
  /** The git repository containing `cwd`, or null. In a terminal, project
   *  scope configures its root and its docs are what fill offers. */
  repo?: RepoInfo | null
  /** Asked before the config is written and again before the fill writes
   *  anything. False or null both mean "don't". */
  confirmWrite?: (what: string) => Promise<boolean | null>
  /** Which of the repository's top folders to import from. Null skips the import. */
  selectFolders?: (folders: { folder: string; count: number }[]) => Promise<string[] | null>
  /** One more folder to import from; null (or blank) stops asking. */
  addFolder?: () => Promise<string | null>
  /** Confirms importing `n` documents into the team space `space`. Render it
   *  with `teamImportMessage`. */
  confirmTeamImport?: (n: number, space: string) => Promise<boolean | null>
  /** The `cairn login` flow, run when team mode is chosen with no session. */
  signIn?: () => Promise<AuthConfig>
  /** The mode named on the command line, which is all a dry run looks at. */
  modeFlag?: Mode | null
  /** Defaults to doctor's `spawnHandshake`. */
  handshake?: (e: McpServerEntry) => Promise<string[]>
  /** Defaults to `makeStore`. */
  openStore?: (root: string) => Promise<Store>
  /** Hands the code scan to the user's agent. The CLI asks first and starts
   *  it once `init` has finished printing. */
  launchAgent?: (prompt: string, cwd: string) => Promise<void>
  /** Whether Claude Code's `claude` command is on PATH. */
  agentOnPath?: () => boolean
  now?: () => number
  /** The closing line of an interactive run. Defaults to `out`. */
  outro?: (line: string) => void
}

/** The picker's name for "a client cairn does not know", and the preview's. */
const OTHER_CLIENT_LABEL = "Other MCP client"

/** How an interactive run ends when at least one agent proved it can start cairn. */
export const INIT_OUTRO = "Restart your agent, then run `cairn doctor`"
/**
 * How a run of the other MCP client alone ends, in a terminal or not. Doctor
 * knows only the configs cairn writes, so pointing this run at it would fail
 * and send the person back to `cairn init`.
 */
export const OTHER_OUTRO = "Add the server config above to your MCP client, then restart it"
/** How it ends when none could: a success line there would be false. */
export const INIT_OUTRO_UNPROVEN =
  "None of your agents could start cairn — fix the ✗ above, then run cairn doctor"

/** The team-mode fill confirmation, word for word. */
export function teamImportMessage(n: number, space: string): string {
  return `these ${n} documents will be visible to everyone in ${space}`
}

/** What to say when no agent init offers is installed. */
function printNoAgent(d: InitCommandDeps): void {
  d.out(ui.warn("No supported agent found."))
  d.out(ui.dim(`  Looked for ~/.claude, ~/.cursor and ~/.codex in ${d.home}.`))
  // Naming the escape is the whole point: this used to stop here, and
  // doctor's remedy was `cairn init`, which arrives back at this line.
  d.out(ui.dim("  Install Claude Code, Cursor or Codex, or run `cairn init --project`"))
  d.out(ui.dim("  to write a project config anyway, or `cairn init --agents <agent>` to name one."))
}

/** "A", "A and B", "A, B and C". */
function listJoin(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

/**
 * The `init` flow, with both prompts behind injected resolvers.
 *
 * The ordering is the point: the plan is computed, previewed and consented to
 * BEFORE `applyInit` touches the disk. Cancelling at either prompt therefore
 * leaves nothing written, which is what a cancelled `init` must guarantee. The old ordering wrote .mcp.json, AGENTS.md and .gitignore first
 * and then asked, so a Ctrl-C at the telemetry prompt left an agent config with
 * no config.json — and doctor went on to report consent had never been asked.
 *
 * The resolvers are a seam, not decoration: clack needs a real terminal, so
 * without them neither cancel path is reachable from a test at all.
 */
export async function runInitCommand(d: InitCommandDeps): Promise<InitOutcome> {
  const scope = await d.resolveScope()
  if (scope === null) return "cancelled"

  // Independent of plan.agents, which can hold an assumed agent nothing was
  // actually detected for (see planInit's --project fallback) — the operator
  // should still be told the truth about what is on disk. Only the agents
  // init offers: a detected Claude Desktop is not one of them.
  const found = (await detectAgents(d.home)).filter((a) => INIT_AGENTS.includes(a))

  // Asked before anything is planned, so the preview names only what was
  // chosen. A dry run asks nothing and shows the default, as it always has.
  let choice = d.agentsFlag ?? null
  const picked = d.interactive && !choice && !d.dryRun && d.chooseAgents !== undefined
  if (picked) {
    choice = await d.chooseAgents!(found)
    if (choice === null) return "cancelled"
    if (choice.agents.length === 0 && !choice.other) {
      // With nothing found, choosing nothing is a dead end rather than a
      // decision — so say what would get past it.
      if (found.length === 0) printNoAgent(d)
      return "cancelled"
    }
  }

  const repo = d.repo ?? null
  // In a terminal, project scope means the repository, wherever inside it
  // `init` was run — `.mcp.json` in `src/` is a config no agent opens.
  // Scripts keep targeting the current directory, as they always have.
  const projectDir = d.interactive && scope === "project" && repo ? repo.root : d.cwd
  const plan = await planInit({
    home: d.home, cwd: projectDir, cliPath: d.cliPath, scope,
    dryRun: d.dryRun, bunPath: d.bunPath, execPath: d.execPath, cairnRoot: d.root,
    writeWithoutAgent: d.writeWithoutAgent, interactive: d.interactive,
    ...(choice ? { agents: choice.agents, otherClient: choice.other } : {}),
  })

  for (const w of plan.warnings) d.out(`${ui.warn(w)}\n`)
  // One line, and only when there is something to say: a script's output is
  // otherwise exactly what it was before cairn knew about either agent.
  if (plan.notConfigured.length > 0) {
    const names = listJoin(plan.notConfigured.map((a) => AGENT_LABEL[a]))
    const them = plan.notConfigured.length === 1 ? "it" : "them"
    d.out(
      ui.warn(
        `Found ${names}, whose config is machine-wide — run \`cairn init\` in a terminal, ` +
          `or with \`--global\` or \`--agents ${plan.notConfigured.join(",")}\`, to configure ${them}.`,
      ),
    )
  }

  if (plan.agents.length === 0 && !plan.otherClient) {
    // Something was found, or chosen, and what is left to say about it is
    // said above.
    if (found.length > 0 || choice) return "no-agent"
    printNoAgent(d)
    return "no-agent"
  }

  // Only meaningful with a human watching — a script reading stdout gets the
  // same bytes it always has. The picker already showed the same list.
  if (d.interactive && !picked) {
    for (const line of formatAgents(found, ui)) d.out(`${line}\n`)
  }

  // "Will write: …" — named before consent is asked.
  // Names for a person; a script reading stdout keeps the ids it always got.
  const configuring = d.interactive
    ? listJoin([...plan.agents.map((a) => AGENT_LABEL[a]), ...(plan.otherClient ? [OTHER_CLIENT_LABEL] : [])])
    : [...plan.agents, ...(plan.otherClient ? ["other"] : [])].join(" and ")
  d.out(
    `${ui.bold(d.dryRun ? "Would configure" : "Will configure")} ` +
      `${ui.cyan(configuring)} — ${plan.scope}\n`,
  )
  for (const c of plan.changes) d.out(`  ${ui.skip(ui.dim(c.path))}`)

  // Every note, then the block the paste notes point at — once, not once per note.
  plan.printOnly.forEach((note, i) => {
    d.out(`\n${ui.warn(note)}${i === plan.printOnly.length - 1 ? "\n" : ""}`)
  })
  if (plan.pasteRules) d.out(plan.instructions.replace(/^/gm, "    "))

  const existing = await readConfig(d.root)

  if (d.dryRun) {
    // Never prompts: the mode is whatever was named or already chosen.
    await printFillDryRun(d, repo, plan, d.modeFlag ?? existing?.mode ?? null)
    return "planned"
  }

  if (d.interactive && d.confirmWrite) {
    if ((await d.confirmWrite("Write these files?")) !== true) return "cancelled"
  }

  const mode = await d.resolveMode(existing?.mode ?? null)
  if (mode === null) return "cancelled"
  // Team -> local only refuses when there is something on this root a flip
  // would strand. Symmetry with migration's own trigger: a root whose store
  // holds claims. An empty team root — signed in or not — has nothing local
  // to lose, so it simply flips, and that is the case that makes preserving
  // `auth` below actually matter.
  if (existing?.mode === "team" && mode === "local") {
    const n = (await localHoldings(d.root)).claims
    if (n > 0) {
      throw new Error(
        `this CAIRN_ROOT holds ${n} claim${n === 1 ? "" : "s"} — switching a team root that ` +
          "already holds claims to local isn't supported here. Point CAIRN_ROOT at a new, " +
          "empty directory to start a local space instead.",
      )
    }
  }

  // Signed in before anything is written, not after: `cairn mcp` opens its
  // store at startup and a team store needs a session, so an agent configured
  // on a root nobody has signed into fails its handshake below.
  let auth = existing?.auth ?? null
  if (d.interactive && mode === "team" && !auth && d.signIn) {
    try {
      auth = await d.signIn()
    } catch (err) {
      d.out(ui.warn(`could not sign in: ${rootMessage(err)}`))
      return "cancelled"
    }
    d.out(ui.ok(`signed in as ${auth.user ?? "you"} — space ${ui.bold(auth.orgSlug)}`))
  }

  // Local -> team is the opposite move: nothing refuses it, but a root that
  // already holds knowledge needs it carried over rather than silently left
  // behind. "Holds knowledge" means claims OR documents: `cairn import` writes
  // documents and never claims on this version, so gating on the claim count
  // alone made the documented first-run sequence — init --local, import, init
  // --team — flip the mode and exit 0 with the entire imported corpus stranded
  // on local disk and nothing said about it. Runs — and must finish — before
  // `mode` is written below: a cancelled confirmation or a migration that
  // throws partway both leave the config still `local`, so the space keeps
  // working and the command can be re-run.
  if (existing?.mode === "local" && mode === "team") {
    const held = await localHoldings(d.root)
    // Nothing to carry, but something is here. Not prompting must not become
    // saying nothing: a person who expected their claims to arrive needs the
    // reason, and silence is the shape of the "already held all of it" defect
    // this same command had one layer down.
    if (!holdsSomething(held) && held.stayingLocal > 0) {
      const n = held.stayingLocal
      d.out(
        `Nothing needs to move: ${n} rejected or retracted claim${n === 1 ? "" : "s"} will ` +
          "stay local, and a claim somebody decided against does not migrate.",
      )
    }
    if (holdsSomething(held)) {
      const what = describeHoldings(held)
      if (!auth) {
        throw new Error(
          `this CAIRN_ROOT holds ${what} waiting to move, but no team account is connected — ` +
            "run `cairn login` first, then `cairn init --team` again.",
        )
      }
      // Refusing beats guessing in either direction: migrating silently
      // decides "the history doesn't matter" on the operator's behalf, and
      // skipping the migration silently decides "start the team space
      // knowledge-free" just as unilaterally. Neither is this command's call
      // to make, so a script with nobody to ask gets told to come back from a
      // terminal — the same precedent `cairn review` sets for a headless run
      // of an interactive command.
      if (!d.interactive) {
        throw new Error(
          `this CAIRN_ROOT holds ${what} that would move into the team space, and that is a ` +
            "one-way, lossy decision only a person can make — run `cairn init --team` from an " +
            "interactive terminal (no `--yes`) to confirm.",
        )
      }
      // Stated here, not in docs: the person about to confirm is the only one
      // who can decide whether losing it matters. Documents are named
      // alongside claims — not folded silently into "claims" — because a
      // migration that moved them without saying so was the first defect
      // found once they were added: an operator approving a one-way, lossy operation
      // has to know the imported corpus is part of what moves too.
      d.out(
        `${what} will move into the team space. The hosted store assigns its own ids and ` +
          "timestamps, so local event history — who proposed each claim, who reviewed it, and " +
          "when — will not transfer.",
      )
      // BEFORE the answer, not only in the summary afterwards. The summary
      // already said this and was judged cosmetic because the truth printed
      // directly above it; here the sentence above is the one being corrected,
      // and this is the only chance the person has to read it while deciding.
      if (held.stayingLocal > 0) {
        const n = held.stayingLocal
        d.out(
          `${n} rejected or retracted claim${n === 1 ? "" : "s"} will stay local — a claim ` +
            "somebody decided against does not migrate.",
        )
      }
      const proceed = await d.resolveMigration(held)
      if (proceed !== true) return "cancelled"

      const from = new FileStore(d.root, new EventLog(d.root))
      await from.init()
      const to = d.openTeamStore
        ? d.openTeamStore(auth)
        : new HttpStore({ baseUrl: auth.apiUrl, token: auth.token, orgId: auth.orgId })
      const r = await runMigration(from, to, d.out)
      // Only the non-zero parts, for the same reason the prompt above drops
      // them: after `cairn import` this run moves 0 approved claims, 0 pending
      // claims and 22 documents, and reciting the two zeroes buries the one
      // number that happened. All three zero is a real outcome too — a
      // re-run over a migration that already completed — and it gets its own
      // sentence rather than "moved  into the team space".
      const moved: string[] = []
      if (r.imported > 0) moved.push(`${r.imported} approved claim(s)`)
      if (r.proposed > 0) moved.push(`${r.proposed} pending claim(s)`)
      if (r.documents > 0) moved.push(`${r.documents} document(s)`)
      const behind = r.leftBehind > 0 ? `; ${r.leftBehind} rejected claim(s) stayed local` : ""
      // Three outcomes, not two. "The team space already held all of
      // it" is FALSE when every local claim was rejected: nothing was held —
      // rejected claims do not migrate at all, which is a different fact and
      // the one the operator needs if they were expecting their claims to
      // arrive. The old wording appended the rejected count to a sentence that
      // had just denied there was anything to account for.
      const nothingMoved =
        r.leftBehind > 0
          ? `nothing moved — rejected claims stay local, and the team space already held everything else${behind}`
          : `nothing new to move — the team space already held all of it`
      d.out(
        ui.ok(moved.length === 0 ? nothingMoved : `moved ${moved.join(", ")} into the team space${behind}`),
      )
    }
  }

  const telemetry = await d.resolveTelemetry(existing?.telemetry ?? null)
  if (telemetry === null) return "cancelled"

  // Only now does anything touch the disk. The paths were already listed in
  // the preview above, so confirm the write rather than repeating all of them.
  const r = await applyInit(plan)
  d.out(`\n${ui.ok(`wrote ${ui.bold(String(r.written.length))} file(s)`)}`)
  // After the write, not before it: these are what is left for the operator
  // once the files exist — including the one step cairn can neither take nor
  // check, Cursor's per-project approval.
  for (const step of plan.nextSteps) d.out(`  ${ui.dim("→")} ${step}`)
  // Keep an existing install id, and an existing auth block: re-running init
  // must not look like a new user, and switching mode must not sign anyone
  // out. The stale-credential risk that leaves is answered by making it
  // visible in `doctor`, not by deleting it behind the operator's back.
  await writeConfig(
    d.root,
    existing ? { ...existing, telemetry, mode, auth } : { ...newConfig(telemetry), mode, auth },
  )
  // Nothing init wrote is something doctor can check for the other MCP
  // client alone, so that run gets a step that works instead.
  const otherOnly = plan.configs.length === 0 && plan.otherClient
  if (!d.interactive) {
    d.out(otherOnly ? `\n${OTHER_OUTRO}` : `\n${ui.dim("Restart your agent, then")} cairn doctor`)
    return "written"
  }

  const proofs = await printProofs(d, plan)
  // Launching Claude Code is only worth offering once it has shown it can
  // start cairn; with a failed proof the prompt is still printed, for later.
  const claudeProven = proofs.some((p) => p.agent === "claude" && p.ok)
  const anyProven = proofs.some((p) => p.ok)
  await firstFill(d, repo, plan, mode, auth, claudeProven, anyProven)

  // The baseline the first-answer metric measures from — with consent only,
  // and set once: a re-run of init is not a new first run. Patched rather
  // than written whole, so a concurrent ping's own fields survive.
  const now = d.now ?? Date.now
  await updateConfig(d.root, (latest) =>
    latest.telemetry && latest.initCompletedAt === null
      ? { initCompletedAt: new Date(now()).toISOString() }
      : null,
  )
  // Still "written", and still exit 0: the files are on disk and correct as
  // far as cairn can tell. But a run whose every agent failed to start cairn
  // must not close the way a working one does. A run of the other MCP client
  // alone had nothing to prove, which is not the same as failing to.
  ;(d.outro ?? d.out)(otherOnly ? OTHER_OUTRO : anyProven ? INIT_OUTRO : INIT_OUTRO_UNPROVEN)
  return "written"
}

/** The fill step's half of a dry run: what would be imported, and whether
 *  the code scan would be offered. Reads the disk, writes and asks nothing. */
async function printFillDryRun(
  d: InitCommandDeps,
  repo: RepoInfo | null,
  plan: InitPlan,
  mode: Mode | null,
): Promise<void> {
  if (!repo) {
    d.out(
      d.interactive
        ? `\n${ui.bold("Would import")} nothing yet — no git repository here, so init would ask for folders.`
        : `\n${ui.bold("In a terminal, init would also import:")} nothing yet — no git repository here, so it would ask for folders.`,
    )
    return
  }
  // Always the repository root: that is where an interactive run imports
  // from. A script never imports, so its plan is labelled as what a terminal
  // run would add, not as part of what this run would do.
  const fill = await planFill(repo, await scanDocs(repo.root), plan.agents, plan.scope, d.home, mode)
  if (!d.interactive) d.out(`\n${ui.bold("In a terminal, init would also import:")}`)
  printFillPreview(d, fill, d.interactive ? "Would" : null)
  if (fill.codeScan === null) {
    d.out(ui.dim("  Too few documents for a first import; whether to offer a code scan: mode not chosen yet."))
  } else if (fill.codeScan) {
    d.out(ui.dim(`  Too few documents — init would offer a code scan: ${codeScanPrompt(repo.label)}`))
  }
}

/** The import set and every skill file it writes, before either happens. */
function printFillPreview(d: InitCommandDeps, fill: FillPlan, verb: "Will" | "Would" | null): void {
  const n = fill.files.length
  // Null: already headed by the caller, so the count stands on its own line.
  const lead = verb ? `\n${ui.bold(`${verb} import`)} ` : "  "
  d.out(`${lead}${plural(n, "document")} from ${ui.cyan(fill.repo.label)} — ${fill.repo.root}`)
  for (const { folder, count } of topFolders(fill.repo.root, fill.files).slice(0, 5)) {
    d.out(`  ${ui.skip(`${folder === "." ? "(top level)" : `${folder}/`} ${ui.dim(String(count))}`)}`)
  }
  if (fill.skills.length > 0) {
    d.out(`${ui.bold(`${verb ?? "Would"} write`)} the cairn-import skill, so your agent can map the code:`)
    for (const skill of fill.skills) d.out(`  ${ui.skip(ui.dim(skill.path))}`)
  }
}

/** Read each agent's cairn entry back from disk and start it, the way the
 *  agent will. A failure is reported with its fix and the run carries on. */
async function printProofs(d: InitCommandDeps, plan: InitPlan): Promise<AgentProof[]> {
  const proofs = await proveAgents(plan.configs, d.handshake ?? spawnHandshake)
  d.out("")
  for (const p of proofs) {
    const line = `${AGENT_LABEL[p.agent]} — ${p.detail}`
    d.out(p.ok ? ui.ok(line) : `${ui.red("✗")} ${line}`)
    if (p.fix) d.out(`  ${ui.dim("fix:")} ${p.fix}`)
  }
  for (const agent of plan.agents) {
    // Cursor's approval is only asked for a project server.
    if (agent === "cursor" && plan.scope !== "project") continue
    const unseen = UNOBSERVABLE[agent]
    if (unseen) d.out(`  ${ui.dim("→")} ${AGENT_LABEL[agent]}: ${unseen}`)
  }
  d.out(ui.dim(RESTART_NOTE))
  return proofs
}

function isInside(root: string, dir: string): boolean {
  const rel = relative(root, dir)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const CONSOLE_IMPORT = "To bring in more, use the console's Import."

/**
 * Fill the space and show it answering: the repository's docs (or, with too
 * few, the code-scan skill), each write previewed and confirmed first, then
 * one real search over what arrived.
 */
async function firstFill(
  d: InitCommandDeps,
  repo: RepoInfo | null,
  plan: InitPlan,
  mode: Mode,
  auth: AuthConfig | null,
  claudeProven: boolean,
  anyProven: boolean,
): Promise<void> {
  let target = repo
  let files = target ? await scanDocs(target.root) : []

  if (target && files.length > 0 && d.selectFolders) {
    const root = target.root
    const picked = await d.selectFolders(topFolders(root, files))
    if (picked === null) {
      d.out(ui.warn("Nothing was imported."))
      return
    }
    files = files.filter((f) => picked.includes(topFolders(root, [f])[0]!.folder))
  }

  while (d.addFolder) {
    const answer = (await d.addFolder())?.trim()
    if (!answer) break
    const dir = resolve(d.cwd, answer.replace(/^~(?=$|\/)/, d.home))
    if (!target) {
      target = { root: dir, label: repoLabel(null, dir) }
    } else if (!isInside(target.root, dir)) {
      d.out(ui.warn(`${dir} is outside ${target.root} — import it on its own with \`cairn import ${dir}\`.`))
      continue
    }
    const found = await scanDocs(dir).catch(() => null)
    if (found === null) {
      d.out(ui.warn(`could not read ${dir}`))
      continue
    }
    files = [...new Set([...files, ...found])].sort()
  }

  if (!target) {
    d.out(`\n${ui.dim("No documents to import.")}${mode === "team" ? ` ${CONSOLE_IMPORT}` : ""}`)
    return
  }

  const fill = await planFill(target, files, plan.agents, plan.scope, d.home, mode)
  if (fill.files.length === 0 && fill.skills.length === 0) {
    d.out(`\n${ui.dim(`No documents to import in ${target.root}.`)}${mode === "team" ? ` ${CONSOLE_IMPORT}` : ""}`)
    return
  }

  printFillPreview(d, fill, "Will")
  const ask = fill.files.length > 0 ? "Import these documents?" : "Write the skill files?"
  if (d.confirmWrite && (await d.confirmWrite(ask)) !== true) {
    d.out(ui.warn("Nothing was imported."))
    return
  }
  if (mode === "team" && fill.files.length > 0 && d.confirmTeamImport) {
    if ((await d.confirmTeamImport(fill.files.length, auth?.orgSlug ?? "the team space")) !== true) {
      d.out(ui.warn("Nothing was imported."))
      return
    }
  }

  const store = await (d.openStore ?? makeStore)(d.root)
  const result = await applyFill(store, fill)
  for (const { path, error } of result.failed) d.out(ui.warn(`could not import ${path}: ${error}`))
  if (fill.files.length > 0) {
    const failed = result.failed.length > 0 ? ` — ${result.failed.length} could not be imported` : ""
    d.out(ui.ok(`imported ${plural(result.titles.length, "document")} from ${fill.repo.label}${failed}`))
  }
  for (const skill of fill.skills) d.out(ui.ok(`wrote ${skill.path}`))
  if (mode === "team" && fill.files.length < CODE_SCAN_THRESHOLD) {
    d.out(ui.dim(`Little documentation here to import. ${CONSOLE_IMPORT}`))
  }

  if (result.titles.length > 0) {
    const { query, question } = suggestQuestion(result.titles, fill.repo.label)
    const found = await firstAnswer(store, query)
    d.out(`\n${ui.bold("First answer")} ${ui.dim(`— searching "${query}"`)}`)
    if (found.hits.length === 0) {
      // Said plainly: a demonstration that hides an empty result is the false
      // success this step exists to rule out.
      d.out(ui.warn(`The search found nothing for "${query}" — your agent would see the same.`))
    } else {
      for (const hit of found.hits) {
        const text = hit.kind === "claim" ? hit.claim : hit.title
        const generated = hit.kind === "document" && hit.generated ? ` ${ui.dim("(generated)")}` : ""
        d.out(`  ${ui.skip(`${text}${generated}`)}`)
      }
      // Only once some agent has shown it can start cairn — otherwise the
      // question has nobody to answer it.
      if (anyProven) d.out(`Ask your agent: ${ui.cyan(question)}`)
    }
  }

  if (fill.codeScan === true && fill.skills.length > 0) {
    const prompt = codeScanPrompt(fill.repo.label)
    d.out(`\nTo have your agent map the code, tell it: ${ui.cyan(prompt)}`)
    if (claudeProven && d.launchAgent && d.agentOnPath?.()) {
      await d.launchAgent(prompt, fill.repo.root)
    }
  }
}

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    const path = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await markdownFiles(path)))
    else if (e.name.endsWith(".md")) out.push(path)
  }
  return out
}

/** `readdir`'s rejection for a path that is not there. Checked on `.code`,
 *  not `instanceof` — Node's fs errors are plain `Error`s with an errno code
 *  attached, not a distinct class. */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
}

export type { CitedUpdate, ImportSummary } from "./import-file"

/**
 * `cairn import <dir>`: every `.md` under `dir`, sourced relative to it and
 * tagged with no repo. See `importFile` for what each file becomes, and
 * `ImportSummary` for what is counted.
 */
export async function runImport(
  store: Store,
  dir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportSummary> {
  // `markdownFiles` throws Node's raw ENOENT for a directory that does not
  // exist — a sentence with no remedy in it. Named here, once, rather than
  // at every call site: a missing directory is the first thing a tester
  // hits pointing this at the wrong path, not an edge case.
  const files = await markdownFiles(dir).catch((err: unknown) => {
    if (isEnoent(err)) {
      throw new Error(
        `no such directory: ${dir} — check the path, or convert your documents into one first`,
      )
    }
    throw err
  })
  let done = 0
  const t = newTally()
  for (const path of files) {
    tally(t, path, await importFile(store, path, normalizeSource(dir, path)))
    onProgress?.(++done, files.length)
  }
  return finishTally(store, t)
}

export interface BackfillResult {
  generated: number
  failed: number
  /**
   * How many claims the run set out to give an abstract. Carried, never derived
   * from the two counters above: a rate limit on the first claim and a space
   * where every claim already has one are the same pair of zeroes, and
   * `cairn abstracts` answers both with "Every approved claim already has an
   * abstract." Two named numbers cannot be re-conflated by arithmetic.
   */
  targets: number
  /** What was written, or would be under a dry run — so it can be judged. */
  written: { id: string; claim: string; abstract: string }[]
  /**
   * Why each failure failed. A bare count cannot be acted on: a 404 for a model
   * that is not installed and a runaway generation that timed out are the same
   * "1 failed" and completely different fixes.
   */
  failures: { id: string; claim: string; reason: string }[]
  /**
   * Set when the run stopped early because continuing could not work. Only a
   * rate limit does this today: it says every subsequent call fails too, so the
   * claims after it were never attempted and are not failures. Reporting them
   * as fifty failures reads as a broken configuration, when the answer is to
   * wait — `notAttempted` is the number that says so.
   */
  stopped: { reason: string; notAttempted: number } | null
}

/**
 * One line per distinct reason, with how many claims hit it. Ten claims failing
 * for one reason is one problem to fix, not ten lines to read.
 */
export function formatFailures(failures: BackfillResult["failures"]): string[] {
  const counts = new Map<string, number>()
  for (const f of failures) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1)
  return [...counts].map(([reason, n]) => `${n} claim${n === 1 ? "" : "s"}: ${reason}`)
}

/**
 * Give abstracts to claims that arrived without one. Offline and per-claim
 * tolerant: a model that is down leaves the abstract null and the run reports
 * it, because enrichment must never be able to damage the store.
 */
export async function runBackfill(
  store: Store,
  generate: (c: Claim) => Promise<string>,
  opts: {
    all?: boolean
    /** Only meaningful with `all`: also regenerates abstracts a human or an
     *  agent wrote. Without it, `all` stops at `"generated"` and missing —
     *  the two provenances nobody has put their name to. */
    force?: boolean
    dryRun?: boolean
    onProgress?: (done: number, total: number) => void
  } = {},
): Promise<BackfillResult> {
  const approved = await store.list("approved")
  const missing = (c: Claim) => !c.abstract?.trim()
  const targets = !opts.all
    ? approved.filter(missing)
    : opts.force
      ? approved
      : approved.filter((c) => c.abstractBy === "generated" || missing(c))
  let generated = 0
  let failed = 0
  const written: BackfillResult["written"] = []
  const failures: BackfillResult["failures"] = []
  let stopped: BackfillResult["stopped"] = null
  for (const claim of targets) {
    try {
      const text = await generate(claim)
      if (!opts.dryRun) {
        claim.abstract = text
        claim.abstractBy = "generated"
        // One event, recorded by the write itself. This used to `put` — which
        // told the server a human had curated it — and then append a `generate`
        // beside it, so one write produced two events describing it differently.
        await store.put(claim, "generate")
      }
      written.push({ id: claim.id, claim: claim.claim, abstract: text })
      generated++
    } catch (err) {
      // The one failure that is not about this claim. Recording it beside the
      // others and carrying on attempts the whole list against an endpoint that
      // has already said no, and reports the list as the problem. Stop instead,
      // and count what was never tried — including this one, which generated
      // nothing.
      if (isRateLimit(err)) {
        stopped = {
          reason: err instanceof Error ? rootMessage(err) : "rate limited",
          notAttempted: targets.length - generated - failed,
        }
        break
      }
      // Leave the abstract as it was. A null abstract is honest; an empty or
      // half-written one is worse than none, because the map shows it.
      //
      // The reason is kept, though: discarding it is what made a wrong model
      // name indistinguishable from a model that had fallen over. It is the
      // ROOT reason for the same argument: the OpenAI client's wrapper says
      // "Connection error." where the cause says "connection refused", and
      // `cairn model` has always reported the latter.
      const reason = err instanceof Error ? rootMessage(err) : "unknown error"
      failures.push({ id: claim.id, claim: claim.claim, reason })
      failed++
    }
    opts.onProgress?.(generated + failed, targets.length)
  }
  return { generated, failed, targets: targets.length, written, failures, stopped }
}

/**
 * What `cairn abstracts` does when nothing is configured. Separated from the
 * prompt so both directions are testable without a pty — the offer had no test
 * at all, in either direction, and the two arms disagree about almost
 * everything they do next.
 */
export type GenerationGate =
  | { kind: "ready"; resolved: ResolvedGeneration }
  /** Non-interactive with nothing configured: say what to run and stop. */
  | { kind: "script" }
  /** The human was asked and said no, or cancelled. Nothing is wrong. */
  | { kind: "declined" }
  /** The picker ran and still saved nothing. */
  | { kind: "unconfigured" }

export interface GenerationGateDeps {
  /**
   * stdin, not stdout. The question needs an answer typed in, so a TTY stdout
   * with piped stdin used to make cairn offer the picker and then answer
   * itself with "pass both --provider and --model".
   */
  isTty: boolean
  out: (line: string) => void
  /** Null means cancelled, which reads the same as "no" here. */
  confirm: () => Promise<boolean | null>
  runPicker: () => Promise<void>
  reread: () => Promise<ResolvedGeneration | null>
}

export async function gateGeneration(
  resolved: ResolvedGeneration | null,
  d: GenerationGateDeps,
): Promise<GenerationGate> {
  if (resolved) return { kind: "ready", resolved }
  if (!d.isTty) {
    d.out("no model configured — run `cairn model` to choose one")
    return { kind: "script" }
  }
  d.out("No model configured for abstract generation.")
  const now = await d.confirm()
  if (now !== true) return { kind: "declined" }
  await d.runPicker()
  const again = await d.reread()
  return again ? { kind: "ready", resolved: again } : { kind: "unconfigured" }
}

/**
 * The approved corpus by default — the same gate `kbSearch` applies, so a
 * person and an agent asking the same question get the same answer. `--all`
 * widens to every status for when you are asking as the reviewer.
 *
 * Deliberately records nothing. `search` and `read` events feed the "reads by
 * agents" line in `cairn status`, and a human reading their own store is not an
 * agent read — spelling it as one would move the number that line exists to
 * report. If human reads ever need counting they need a kind of their own.
 */
export async function runSearch(store: Store, query: string, all: boolean): Promise<Claim[]> {
  const hits = await store.search(query)
  return all ? hits : hits.filter((c) => c.status === "approved")
}

/**
 * Withdraw an approval. Deliberately thin: every refusal and its wording lives
 * in the store, so `cairn retract` and the hosted route explain a refusal in
 * the same sentence.
 */
export async function runRetract(
  store: Store,
  id: string,
  reason: string,
  by: string,
): Promise<Claim | null> {
  return store.retract(id, reason, by)
}

/**
 * Attach evidence. Deliberately thin: every refusal and its wording lives in
 * the store, so `cairn cite` and the hosted route explain a refusal in the
 * same sentence.
 */
export async function runCite(
  store: Store,
  claimId: string,
  doc: string,
  supports: string,
  by: string,
): Promise<Claim | null> {
  return store.cite(claimId, { doc, supports }, by)
}

/** Detach evidence. Human-only — there is no MCP tool for this, by design. */
export async function runUncite(store: Store, claimId: string, doc: string): Promise<Claim | null> {
  return store.uncite(claimId, doc)
}

/**
 * Hits as a list you can act on: every line carries the id `cairn show`
 * takes.
 *
 * `hasDocs` tells this whether a document matched too — never inferred from
 * `claims` alone. With a document in the corpus,
 * `cairn search` could print "nothing approved matched" directly above the
 * document it had just found, because this function judged only the claim
 * half of the search and had no way to know the other half was not empty.
 * The "nothing matched" wording is only true when the search matched
 * nothing at all — no claims and no documents — so it may only print then.
 */
export function formatSearch(claims: Claim[], all: boolean, hasDocs = false): string {
  if (claims.length === 0) {
    if (hasDocs) {
      // A document DID match, so "nothing matched" would be false here —
      // the search was not empty, only the claim half of it was. Say that
      // precisely instead. The `--all` hint survives in the default view,
      // since it is still true and still useful: it is about unapproved
      // claims, not about whether anything matched.
      return all ? "" : ui.dim("no approved claims — try --all")
    }
    // Never an empty stdout: that is indistinguishable from a command that
    // failed without saying so.
    return ui.dim(all ? "nothing matched" : "nothing approved matched — try --all")
  }
  const width = Math.max(...claims.map((c) => c.id.length))
  const head = all
    ? `${claims.length} claim${claims.length === 1 ? "" : "s"}`
    : `${claims.length} approved`
  const lines = claims.map((c) => {
    const status = all ? `  ${ui.dim(c.status.padEnd(8))}` : ""
    return `  ${ui.dim(c.id.padEnd(width))}${status}  ${c.claim}`
  })
  return [head, ...lines].join("\n")
}

/**
 * One claim in full — the sentence, what it is for, and the prose behind it.
 *
 * `docs` is the cited documents, resolved by the CALLER: `formatClaim` holds
 * no store, which is the same constraint that keeps `overlaps` statusless
 * above. Without it, a citation can be named but its document's current hash
 * cannot be compared against the one the citation recorded — and that
 * comparison is the detectable half of a staleness check.
 *
 * REQUIRED, not optional. An omitted map and an empty one used to render
 * identically — "no longer in this space" — so a caller that had simply not
 * looked yet said, in effect, that the document had been deleted. Forcing
 * every caller to state what it resolved (even if that is "nothing") is what
 * keeps "unresolved" and "resolved and gone" from collapsing into one
 * sentence, the same distinction `absent: null` vs `absent: []` exists to
 * hold for terms rather than documents.
 */
/**
 * User ids to display names, for the principals a claim actually names.
 *
 * NEVER THROWS, and that is the whole design. `cairn show` answers a question
 * about a claim; the members endpoint is a nicety that makes one line of the
 * answer easier to read. A space that is local, a token that has expired, an
 * API that is down — each returns an empty map here, and the reviewer renders
 * as the raw id. Failing `show` because a name could not be fetched would
 * withhold the claim over the cosmetic half of one line.
 *
 * The empty map is also the honest value: it says nothing resolved, which is
 * different from saying nobody approved this. `provenanceOf` keeps those
 * apart.
 */
async function resolvePeople(root: string, claim: Claim): Promise<ReadonlyMap<string, string>> {
  const empty = new Map<string, string>()
  if (claim.reviewer === null) return empty
  const cfg = await readConfig(root)
  if (!cfg?.auth) return empty
  try {
    const members = await listMembers({
      apiUrl: cfg.auth.apiUrl,
      token: cfg.auth.token,
      orgId: cfg.auth.orgId,
    })
    const out = new Map<string, string>()
    for (const m of members) if (m.displayName) out.set(m.userId, m.displayName)
    return out
  } catch {
    return empty
  }
}

export function formatClaim(
  claim: Claim,
  docs: Map<string, Document>,
  people: ReadonlyMap<string, string>,
  overlaps: ReadonlyMap<string, Claim>,
): string {
  const where = claim.source.repo ? ` in ${claim.source.repo}` : ""
  const lines = [
    ui.bold(claim.claim),
    ui.dim(`${claim.id} · ${claim.status} · proposed by ${claim.source.agent}${where}`),
  ]
  // The header above names the AGENT that drafted the sentence. Until now
  // nothing named the PERSON who accepted it, though every approved claim
  // records both — for a knowledge base whose premise is that a
  // human reviewed the thing, that was the wrong half to show.
  //
  // Rendered from a list rather than appended as a string, so a later
  // provenance kind lands in `provenance.ts` and not here. See that file.
  for (const line of renderProvenance(provenanceOf(claim, people))) lines.push(ui.dim(line))
  // The header line above already says "· retracted ·" and stops — an agent
  // gets the reason through the MCP tombstone (src/mcp.ts) and a script gets
  // it through `--json`, but a human running `show` on their own withdrawn
  // work in a terminal got neither, despite the README naming `show` as the
  // way to check it. `claim.retracted` is non-null exactly when `status ===
  // "retracted"` (packages/protocol/src/types.ts), so this only ever appears then.
  if (claim.retracted) {
    lines.push(ui.dim(`retracted by ${claim.retracted.by}: ${claim.retracted.reason}`))
  }
  if (claim.tags.length > 0) lines.push(ui.dim(`tags: ${claim.tags.join(", ")}`))
  if (claim.overlaps.length > 0) {
    // Named, not counted. `overlaps N
    // claim(s)` told a reader that something related existed and gave them no
    // way to reach it: not the sentence, not even the id to look it up with.
    //
    // The status is each overlap's CURRENT one, resolved by the caller, and
    // that is the whole reason this takes a map. `findOverlaps` computes the
    // list against `store.list("approved")` at write time, so every id here
    // named an approved claim *then* — and a claim can be retracted
    // afterwards while its id stays in `overlaps`. A blanket "approved" would
    // be false then, and a bare count is true and useless. Resolving is what
    // lets this be both.
    lines.push("", ui.dim("overlaps"))
    for (const id of claim.overlaps) {
      const other = overlaps.get(id)
      if (!other) {
        // Same shape and the same honesty as a cited document that has gone:
        // the id is still on this claim, so it is printed, and the reason it
        // cannot be shown is stated rather than left as a blank line.
        lines.push(`  ${id} — no longer in this space`)
        continue
      }
      lines.push(`  ${other.claim}`)
      // `warn` for a retraction, `dim` for everything else, for the reason the
      // staleness line above uses `warn`: this is not a neutral fact about a
      // related claim, it is one that has been taken back, and a reader
      // deciding what this claim rests on needs to see that without reading
      // the word.
      lines.push(
        other.status === "retracted" ? ui.warn(`    ${other.status}`) : ui.dim(`    ${other.status}`),
      )
      lines.push(ui.dim(`    ${other.id}`))
    }
  }
  // `cites` belongs in `cairn show` and in the MCP read payload; the review
  // screen renders its own references pane.
  //
  // Named, not counted. `cites 2 document(s)` was the same original defect
  // surviving on a second command — and it mattered more the day
  // `cites` stopped being empty, because a count cannot show that one of two
  // citations does not support the claim.
  if (claim.cites.length > 0) {
    lines.push("", ui.dim("cites"))
    // Once, above the citations it qualifies — the POSITION is the fix, not
    // the sentence. See `ABSENCE_FRAMING` (packages/protocol/src/absence.ts).
    lines.push(ui.dim(`  ${ABSENCE_FRAMING}`))
    for (const cite of claim.cites) {
      const doc = docs.get(cite.doc)
      lines.push(`  ${doc ? doc.title : `${cite.doc} — no longer in this space`}`)
      lines.push(
        ui.dim(cite.supports === "" ? "    no scope stated" : `    supports ${cite.supports}`),
      )
      if (cite.absent === null) {
        // Not the same as an empty list, and it must never render as one: this
        // citation was attached before the check existed and nobody has run it.
        lines.push(ui.dim("    never checked for absent terms"))
      } else if (cite.absent.length > 0) {
        lines.push(ui.dim(`    not found in the document: ${cite.absent.join(", ")}`))
      } else {
        // NOT "every term of the claim appears in the document" — `absentTerms`
        // (packages/protocol/src/absence.ts) drops every term under `MIN_TERM_LENGTH` and every
        // stopword before it ever checks anything, so `absent: []` proves only
        // that none of the CHECKED terms are missing. A clause about GPUs is
        // that module's own example of a short word this never looks for;
        // claiming "every term" would tell a reader `gpu` was verified when
        // it was silently skipped.
        lines.push(ui.dim("    no absence found — short and common words are not checked"))
      }
      if (doc) {
        if (cite.hash === null) {
          // Not the same as a matching hash, and it must not render like one:
          // this citation predates hashes and there is nothing to compare —
          // the same gap `absent: null` leaves for terms, applied to content
          // identity instead.
          lines.push(ui.dim("    no hash recorded — cannot tell whether the document has changed"))
        } else if (cite.hash !== doc.hash) {
          lines.push(ui.warn("    the document has changed since it was cited"))
        }
      }
      lines.push(ui.dim(`    ${cite.doc}`))
    }
  }
  if (claim.abstract?.trim()) {
    // Named with its provenance, because that is the field `cairn curate`
    // walks: an abstract nobody has reviewed reads exactly like one somebody
    // wrote until you are told which it is.
    lines.push("", ui.dim(`abstract (${claim.abstractBy ?? "unknown"})`), claim.abstract)
  }
  lines.push("", claim.body)
  return lines.join("\n")
}

/**
 * Printed next to a generated document's title, nowhere else: a machine
 * wrote this one and nobody on the team has, so a person deciding whether to
 * trust it needs that said beside the title, not buried in the metadata line
 * underneath. Empty for a document nobody generated.
 */
function generatedLabel(doc: Document): string {
  if (!doc.generated) return ""
  return doc.repo ? ` ${ui.dim(`(generated · ${doc.repo})`)}` : ` ${ui.dim("(generated)")}`
}

/**
 * One document in full. Deliberately thinner than `formatClaim`: a document
 * has no status, no reviewer, no abstract — it is raw imported material
 * nobody has judged, so there is nothing here to report about a review that
 * never happened.
 */
export function formatDocument(doc: Document): string {
  const where = doc.source ? `imported from ${doc.source}` : "adopted from a claim"
  return [
    `${ui.bold(doc.title)}${generatedLabel(doc)}`,
    ui.dim(`${doc.id} · document · ${where}`),
    "",
    doc.text,
  ].join("\n")
}

/**
 * Document hits, printed after claim hits and labelled per line — never
 * interleaved with them. A claim is durable knowledge a human approved; a
 * document is unreviewed source material, and the two must stay visibly
 * distinct in a list a person is about to act on the same way
 * `team_knowledge_search` (src/mcp.ts) keeps them apart for an agent.
 */
export function formatDocumentHits(docs: Document[]): string {
  if (docs.length === 0) return ""
  const width = Math.max(...docs.map((d) => d.id.length))
  const head = `${docs.length} document${docs.length === 1 ? "" : "s"}`
  const lines = docs.map(
    (d) => `  ${ui.dim(d.id.padEnd(width))}  ${ui.dim("document")}  ${d.title}${generatedLabel(d)}`,
  )
  return [head, ...lines].join("\n")
}

/**
 * The lines `cairn import` prints about documents it updated that are cited.
 * Empty for an empty list, so the caller prints nothing rather than
 * a heading with nothing under it.
 *
 * A warning and not a dim note: this is the operator's own edit having silently
 * changed what somebody else's citation points at, which is the one thing in an
 * import summary that is not routine. It names the claims because the next move
 * is to go and read them — `cairn show` on any of them now carries the same
 * fact from the other side.
 */
export function formatCitedUpdates(cited: CitedUpdate[]): string[] {
  if (cited.length === 0) return []
  const lines = [
    ui.warn(
      `${cited.length} updated document${cited.length === 1 ? " is" : "s are"} cited — ` +
        `the text those citations point at has changed`,
    ),
  ]
  for (const u of cited) {
    // The path, because that is the file the operator just edited. Falling back
    // to the id rather than printing nothing: `source` is nullable on the type
    // even though this path always has one.
    lines.push(ui.dim(`    ${u.source ?? u.id} — cited by ${u.claims.join(", ")}`))
  }
  lines.push(ui.dim("  cairn show <claim> now warns that the document has changed since it was cited."))
  return lines
}

export function formatStatus(pending: Claim[], stats: Stats, approved: Claim[] = []): string {
  const rate =
    stats.approveRate === null ? "no reviews yet" : `${Math.round(stats.approveRate * 100)}% approved`
  const oldest =
    stats.pendingAgeDays === null ? "nothing waiting" : `oldest ${stats.pendingAgeDays.toFixed(1)}d`
  const missing = approved.filter((c) => !c.abstract?.trim()).length
  const machine = approved.filter((c) => c.abstractBy === "generated").length
  const lines = [
    `${approved.length} claim${approved.length === 1 ? "" : "s"} agents can read`,
    `${pending.length} pending · ${oldest}`,
    `${stats.proposed} proposed · ${rate}`,
    `${stats.reads} reads by agents across ${stats.sessions} session(s) · ${stats.searches} searches`,
  ]
  if (machine > 0) {
    // Named with the command that clears it, the same way the missing-abstract
    // line is. A count with no remedy beside it is a number that can only ever
    // be watched — which is what it was before `cairn curate` existed.
    lines.push(
      `${machine} generated abstract${machine === 1 ? "" : "s"} nobody has reviewed — ` +
        `run ${ui.bold("cairn curate")}`,
    )
  }
  // Silent when the map is fully navigable. The count only matters when
  // part of the approved set is a title with no abstract — the population
  // that degrades team_knowledge_map.
  if (missing > 0) {
    const verb = missing === 1 ? "has" : "have"
    lines.splice(
      1,
      0,
      `${missing} of them ${verb} no abstract — run ${ui.bold("cairn abstracts")}`,
    )
  }
  return lines.join("\n")
}

/**
 * The account team-mode knowledge comes from, or a sentence and exit 1.
 *
 * Only reached in team mode — `makeStore` and `makeSink` check `mode` before
 * calling this, so local mode never lands here even when an `auth` block is
 * still sitting in the config from a previous `cairn login`. There is no
 * silent fallback to a local store on missing auth: that fallback existed
 * only to keep the old behaviour working while the hosted path was proven,
 * and keeping it past that point would mean a machine that quietly wrote to
 * a directory nobody else can read — the same "worked, changed nothing
 * anyone will see" failure the loud errors elsewhere exist to prevent. Local
 * mode is an explicit choice recorded in `mode`, not a fallback from this.
 *
 * Exits rather than throws so the three lines survive: `runCli` renders a
 * thrown error as one warning line, and the two lines under the headline are
 * what make this actionable rather than an accusation. Callers that need to
 * assert on it spawn the CLI, which is what an operator sees anyway.
 */
async function requireAuth(root: string): Promise<AuthConfig> {
  const cfg = await readConfig(root)
  if (!cfg?.auth) {
    console.error(ui.warn("not signed in."))
    console.error(ui.dim("  cairn keeps claims in your team's shared space."))
    console.error(ui.dim("  Run `cairn login` to connect this machine."))
    process.exit(1)
  }
  return cfg.auth
}

/** The browser authorize round trip, shared by `login` and `org use` — the
 *  second exists only because a token is scoped to one space. */
async function signIn(
  apiUrl: string,
  opts: { noBrowser?: boolean; org?: string },
): Promise<AuthConfig> {
  return runLogin({
    apiUrl,
    noBrowser: opts.noBrowser,
    org: opts.org,
    openBrowser: async (url) => {
      console.log(ui.dim("  opening your browser to authorize this machine…"))
      // Never fatal: if nothing opens, openInBrowser prints this same URL
      // itself for a manual paste — printing it again here on the success path
      // too would just be noise, so it is printed once, only where it is
      // actually needed.
      await openInBrowser(url, { print: (line) => console.log(ui.dim(`  ${line}`)) })
    },
    print: (line) => console.log(line),
    // Supplied on BOTH paths. --no-browser needs it to read the code off the
    // page, and the browser path falls back to it whenever the redirect does
    // not reach the loopback — a login the server already completed is
    // recoverable from the address bar, and without this it was thrown away.
    promptCode: async (signal) => {
      // Dynamic import only: this keeps clack off the static import graph
      // cli.ts pulls in on every command, `cairn mcp` included.
      const clack = await import("@clack/prompts")
      // On the browser path this prompt is open for the whole wait and is
      // aborted the moment the callback lands. `@clack/core`
      // registers an `abort` listener, cancels, and closes readline — so the
      // terminal is released rather than left holding a dead prompt.
      const answer = await clack.text({ message: "Paste the code cairn gave you", signal })
      if (clack.isCancel(answer)) {
        // Cancellation has two causes and only one of them is the operator.
        // An abort cairn asked for means some other path already delivered,
        // and runLogin has stopped reading this promise — but if that message
        // ever did surface, "login cancelled" would be a lie about a login
        // that succeeded.
        throw new Error(
          signal?.aborted ? "the paste prompt was superseded" : "login cancelled",
        )
      }
      return answer
    },
  })
}

/**
 * Where the CLI writes events. Chosen from the same block as `makeStore` —
 * and that is the point: choosing the store without choosing the ledger is
 * half a decision. `cairn status` would then read its claims from the shared
 * space and its counts from a file on one laptop, and an agent session would
 * propose to the service while its reads and searches landed on whichever
 * machine happened to run it.
 *
 * Mode picks the ledger: local mode gets the `EventLog` beside the claims on
 * disk, team mode gets the hosted sink over the same request that changes
 * the claim.
 */
export async function makeSink(root: string): Promise<EventSink> {
  const cfg = await readConfig(root)
  if (cfg?.mode === "local") return new EventLog(root)
  const { apiUrl, token, orgId } = await requireAuth(root)
  return new HttpEventSink({ baseUrl: apiUrl, token, orgId })
}

/**
 * Which store the CLI talks to: the local file store, or the team's.
 *
 * Team mode's `HttpStore` takes no event sink — the hosted store records its
 * events on the same request that changes the claim, which is the whole
 * reason `propose`, `review` and `importClaim` are on the seam. Local mode's
 * `FileStore` has no such request to piggyback on, so it takes the
 * `EventLog` `makeSink` would also build, wired up here rather than left for
 * the caller to forget.
 */
export async function makeStore(root: string): Promise<Store> {
  const cfg = await readConfig(root)
  // Mode, never `auth`. A store chosen by what happens to be missing is a
  // fallback this project removed on purpose, wearing a different hat.
  if (cfg?.mode === "local") {
    const store = new FileStore(root, new EventLog(root))
    await store.init()
    return store
  }
  const { apiUrl, token, orgId } = await requireAuth(root)
  return new HttpStore({ baseUrl: apiUrl, token, orgId })
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv

  // Help is the no-command output. Recursing into `main([])` rather than
  // extracting the usage block keeps exactly one copy of it: the default case
  // prints usage and deliberately does not throw when the command is undefined.
  if (command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    return main([])
  }

  // `unknown command: X` has existed since the init case shipped a silent
  // success; flags had no equivalent, so `cairn init --help` ran init for real
  // and — with no TTY to ask — recorded consent as no, overwriting a yes.
  const bad = unknownFlags(command ?? "", rest)
  if (bad.length > 0) {
    const takes = flagsFor(command!)
    throw new Error(
      `unknown flag${bad.length > 1 ? "s" : ""}: ${bad.join(" ")} — ` +
        `${command} takes ${takes.length > 0 ? takes.join(", ") : "no flags"}`,
    )
  }
  // Both are LAZY, and both now exit on a machine with no account — so
  // neither may run before the switch. `cairn login` is the command that
  // creates the account, and `doctor`, `init` and `--version` have to keep
  // working on the broken install `doctor` exists to explain; opening either
  // of these up front would make all four of them exit 1 with advice to run a
  // command that also exits 1. Commands that need knowledge ask for it here.
  let opened: Store | null = null
  const openStore = async (): Promise<Store> => {
    if (!opened) opened = await makeStore(ROOT)
    return opened
  }
  let sink: EventSink | null = null
  const openSink = async (): Promise<EventSink> => {
    if (!sink) sink = await makeSink(ROOT)
    return sink
  }

  switch (command) {
    case "import": {
      const dir = rest[0]
      if (!dir) throw new Error("usage: cairn import <dir>")
      const onProgress = process.stdout.isTTY
        ? (done: number, total: number) => {
            // "scanned", not "imported": the callback ticks per file read, and an
            // unchanged document is read and skipped rather than imported.
            process.stdout.write(`\r${progressLine(done, total, "scanned")}`)
          }
        : undefined
      const r = await runImport(await openStore(), dir, onProgress)
      if (onProgress) process.stdout.write("\r\x1b[K")
      // Gated on how many FILES were seen, not how many were created, updated
      // or unchanged: an empty `.md` file counts in none of those three — it
      // short-circuits into `r.empty` instead — so gating on that sum alone
      // let a directory of nothing-but-empty-files print "no markdown" and
      // then name a `.md` file four lines later. MinerU writing a zero-byte
      // `.md` for a page it could not extract is exactly the seed directory
      // this message exists for; it must not tell that operator to re-run
      // the tool that already produced the file being named as missing.
      const files = r.created + r.updated + r.unchanged + r.empty.length
      if (files === 0) {
        // Pointed at a folder of PDFs, this used to
        // print "Nothing new — every document there is already in the
        // space." and exit 0 — a false sentence, over the one kind of input a
        // tester's first run is likely to be. `cairn import` walks `.md`
        // files only, by design — converting other formats is a deliberate
        // out-of-band pre-step, not something this pulls into its own
        // dependency tree — so the fix is to say that plainly and show the
        // two commands that get there, rather than imply everything is
        // already in the space.
        console.log(ui.warn(`no markdown in ${dir} — nothing was imported.`))
        console.log(ui.dim("  cairn reads .md files. Convert first, then import the output:"))
        console.log(ui.dim("    mineru -p paper.pdf -o /tmp/seed -b pipeline && cairn import /tmp/seed"))
        console.log(ui.dim("  pandoc and markitdown work too — anything that writes markdown."))
      } else {
        console.log(
          ui.ok(
            `${r.created} document${r.created === 1 ? "" : "s"} created, ` +
              `${r.updated} updated, ${r.unchanged} unchanged`,
          ),
        )
        console.log(ui.dim("  Documents are searchable and readable by agents now,"))
        console.log(
          ui.dim("  but they never appear in the review queue or in team_knowledge_map —"),
        )
        console.log(ui.dim("  nobody reviewed them, so they count towards no reported number."))
      }
      for (const path of r.empty) {
        console.log(ui.warn(`${path} is empty — skipped`))
      }
      // Last, so it is what the eye ends on: every other line here reports
      // routine bookkeeping, and this one reports a citation whose meaning the
      // operator just changed.
      for (const line of formatCitedUpdates(r.cited)) console.log(line)
      break
    }
    case "adopt-imports": {
      // One-time cleanup for every install that predates this change: `cairn
      // import` used to write each file as an approved claim, keyed on its
      // first heading — a noun phrase, not something a reviewer can judge.
      // This turns those survivors into the documents they always were.
      // Selected by the `imported` tag, same as the old import wrote it —
      // but the tag only narrows the candidate LIST. `store.adoptImport`
      // itself guards on event history, not the tag, so a hand-edited tag
      // here can widen the list without ever widening what gets deleted.
      const store = await openStore()
      const candidates = (await store.list("approved")).filter((c) => c.tags.includes("imported"))
      if (candidates.length === 0) {
        // Not `ui.ok` — nothing was converted, so a checkmark here would be
        // the exact false success message this command exists to replace.
        // Idempotent, and it must say so: a second run over an already-clean
        // corpus reports the same "nothing to do", not "0 converted".
        console.log(ui.skip("nothing needed converting — no approved claim is tagged imported."))
        break
      }
      let converted = 0
      const refused: string[] = []
      for (const claim of candidates) {
        try {
          const doc = await store.adoptImport(claim.id)
          console.log(ui.ok(`${claim.id} adopted as ${doc.id}`))
          converted++
        } catch (err) {
          // Caught per claim, not per batch: one claim a human actually
          // reviewed — carrying a `propose` event, or one in RESOLVE_KINDS —
          // must not abort every other claim still waiting to convert. The
          // refusal names the claim and repeats the store's own sentence
          // (`notAdoptableMessage`, packages/protocol/src/event-kinds.ts) rather than a
          // generic "failed" with no remedy in it.
          //
          // **A catch-ALL, so `refused` below also counts I/O and network
          // failures** beside genuine guard refusals. Accepted
          // rather than narrowed: the printed line above carries the real
          // error either way, so nothing is hidden from the person reading —
          // only the tally conflates two things. Narrowing it would mean
          // matching on error shape across two stores, which is how the two
          // halves of a seam start disagreeing about what counts as a
          // refusal.
          console.log(ui.warn(rootMessage(err)))
          refused.push(claim.id)
        }
      }
      const summary = [
        `${converted} claim${converted === 1 ? "" : "s"} converted to document${converted === 1 ? "" : "s"}`,
      ]
      if (refused.length > 0) summary.push(`${refused.length} refused`)
      console.log(summary.join(", "))
      break
    }
    case "login": {
      const modeCfg = await readConfig(ROOT)
      // Refuses only when there is already a token: an unconditional refusal
      // here deadlocks a local root that was never signed in — `init --team`
      // on it needs an account, `makeStore`/`requireAuth` sends the operator
      // to `cairn login`, and `login` sent them right back. Once an `auth`
      // block exists there is nothing left to sign in to, so that half of the
      // refusal stays: the message matches what `doctor`'s account check
      // already reports for the same state.
      if (modeCfg?.mode === "local" && modeCfg.auth) {
        console.error(ui.warn("already signed in, but this space is local, so the token is unused."))
        console.error(ui.dim("  Run `cairn init --team` to move this root into a shared space."))
        process.exit(1)
      }
      const apiUrl = process.env.CAIRN_API_URL ?? DEFAULT_API_URL
      const noBrowser = rest.includes("--no-browser")
      let auth: AuthConfig
      try {
        auth = await signIn(apiUrl, { noBrowser })
      } catch (err) {
        console.log(ui.warn(`could not sign in: ${rootMessage(err)}`))
        process.exit(1)
      }
      const existing = (await readConfig(ROOT)) ?? newConfig(false)
      await writeConfig(ROOT, { ...existing, auth })
      console.log(ui.ok(`signed in as ${auth.user ?? "you"} — space ${ui.bold(auth.orgSlug)}`))
      break
    }
    case "logout": {
      const cfg = await readConfig(ROOT)
      // A local space refuses only once there is nothing to clear, mirroring
      // the narrowing `login` already got. `init --local` deliberately KEEPS
      // an existing token so a later `init --team` needs no re-login, so
      // removing that token is the one useful thing logout can do here — and
      // it was the one thing an unconditional refusal would not do. Migrating
      // a knowledge base is not a remedy for wanting to sign out, so the old
      // `init --team` advice is gone from both branches.
      if (cfg?.mode === "local" && !cfg.auth) {
        console.error(ui.warn("no account on this root — nothing to sign out of."))
        process.exit(1)
      }
      if (!cfg?.auth) {
        console.log(ui.warn("not signed in"))
        break
      }
      try {
        const result = await runLogout({ auth: cfg.auth })
        // Cleared locally either way: a down network must not leave the
        // operator stuck signed in on this machine.
        await writeConfig(ROOT, { ...cfg, auth: null })
        if (result.revoked) {
          console.log(ui.ok("signed out, and this machine's token was revoked"))
        } else {
          console.log(ui.ok("signed out locally"))
          console.log(ui.warn(result.warning!))
        }
      } catch (err) {
        console.log(ui.warn(`could not sign out: ${rootMessage(err)}`))
        process.exit(1)
      }
      break
    }
    case "org": {
      const cfg = await readConfig(ROOT)
      if (!cfg?.auth) {
        console.error(ui.warn("not signed in — run `cairn login` first."))
        process.exit(1)
      }
      // Same refusal as `logout`: a local space has no account, so it has no
      // team spaces to move between either.
      if (cfg.mode === "local") {
        console.error(ui.warn("this space is local — there are no team spaces to switch between."))
        process.exit(1)
      }
      const positional = rest.filter((a) => !a.startsWith("-"))
      const sub = positional[0] ?? "list"
      if (sub === "list") {
        const orgs = await listOrgs({ apiUrl: cfg.auth.apiUrl, token: cfg.auth.token })
        for (const org of orgs) {
          const here = org.slug === cfg.auth.orgSlug
          const mark = here ? ui.bold("* ") : "  "
          console.log(`${mark}${org.slug} ${ui.dim(`${org.name} — ${org.role}`)}`)
        }
        break
      }
      if (sub !== "use") {
        console.error(ui.warn(`unknown argument: ${sub} — cairn org takes list or use <slug>`))
        process.exit(1)
      }
      const slug = positional[1]
      if (!slug) throw new Error("usage: cairn org use <slug>")
      let auth: AuthConfig
      try {
        auth = await useOrg({
          apiUrl: cfg.auth.apiUrl,
          token: cfg.auth.token,
          slug,
          // Switching spaces needs a token scoped to the new one, and only the
          // browser flow mints tokens.
          login: (org) => signIn(cfg.auth!.apiUrl, { org }),
        })
      } catch (err) {
        console.log(ui.warn(rootMessage(err)))
        process.exit(1)
      }
      await writeConfig(ROOT, { ...cfg, auth })
      console.log(ui.ok(`this machine now uses ${ui.bold(auth.orgSlug)}`))
      break
    }
    case "telemetry": {
      // Consent must be withdrawable from the CLI. It used to be a one-shot
      // question at `init`, so changing your mind meant hand-editing
      // config.json — a bad property for a consent flow, and true even while
      // nothing was being transmitted.
      const arg = rest.find((a) => !a.startsWith("-")) ?? "status"
      if (arg !== "status" && arg !== "on" && arg !== "off") {
        console.error(ui.warn(`unknown argument: ${arg} — cairn telemetry takes status, on or off`))
        process.exit(1)
      }
      // A root with no config yet still gets an answer recorded: the
      // alternative is telling someone to re-run `init` and answer a dozen
      // other questions to change one of them.
      const cfg = (await readConfig(ROOT)) ?? newConfig(false)
      if (arg === "status") {
        const last = cfg.lastSentAt ? `last sent ${cfg.lastSentAt}` : "nothing sent yet"
        console.log(cfg.telemetry ? ui.ok(`on — ${last}`) : ui.ok("off — nothing is sent"))
        break
      }
      // Spread, so the install id survives a toggle: a user who changes their
      // mind twice is one install, not three.
      await writeConfig(ROOT, { ...cfg, telemetry: arg === "on" })
      console.log(
        arg === "on"
          ? ui.ok("telemetry on — counts only, at most once a day. `cairn telemetry off` stops it.")
          : ui.ok("telemetry off — nothing is sent."),
      )
      break
    }
    case "status": {
      // The mode is read straight from config, never computed: `cairn stats`
      // reads the same field the same way, and the approve rate below means
      // different things in the two modes — local usage is solo, which makes
      // proposer and reviewer the same person.
      const mode: Mode = (await readConfig(ROOT))?.mode ?? "team"
      const store = await openStore()
      console.log(ui.dim(`${mode === "local" ? "local" : "team"} space`))
      console.log(
        formatStatus(await store.list("pending"), await store.stats(), await store.list("approved")),
      )
      break
    }
    case "stats": {
      // From the store, not from a local file beside it: printing this
      // machine's counts for a shared space is the same silent lie this branch
      // was already written to avoid, one layer up.
      //
      // The mode is spread in here, at the CLI's own output layer, rather than
      // added to `Stats` itself: `Stats` is shared with the hosted service,
      // which has no notion of local mode at all.
      const mode: Mode = (await readConfig(ROOT))?.mode ?? "team"
      console.log(JSON.stringify({ ...(await (await openStore()).stats()), mode }, null, 2))
      break
    }
    case "rebuild": {
      // Local only: the hosted store maintains an FTS table on every write, so
      // there is nothing to rebuild there. FileStore's
      // own index can still drift from the claims on disk — one such case is a
      // write that indexed but did not persist the claim file, and the reverse
      // is possible too — so local mode keeps a real repair for it.
      const cfg = await readConfig(ROOT)
      if (cfg?.mode !== "local") {
        console.error(ui.warn("rebuild is gone — the shared space indexes claims as it stores them."))
        console.error(ui.dim("  Nothing on a hosted space holds an index this machine owns."))
        process.exit(1)
      }
      const store = (await makeStore(ROOT)) as FileStore
      // Both counts come back named, from the loop that did the work.
      // Reporting a sum as claims is how a local space holding 0 claims and 22
      // documents — the normal state after `cairn import` on this version —
      // came to print "reindexed 22 claims". That was first fixed by
      // subtracting a second `listDocuments()` from the sum, which was correct
      // and walked every document on disk twice; `rebuildIndex` now returns the
      // pair it always had.
      const { claims, documents } = await store.rebuildIndex()
      console.log(
        ui.ok(
          `reindexed ${claims} claim${claims === 1 ? "" : "s"} and ` +
            `${documents} document${documents === 1 ? "" : "s"}`,
        ),
      )
      // A real `break`, not a fall-through guarded only by `process.exit`: the
      // team-mode branch above still exits before reaching here, but the local
      // path now returns a value and must not fall into `review`.
      break
    }
    case "review": {
      const mine = rest.includes("--mine")
      // Refused before the store is opened, for the reason the TTY check below
      // gives: the complaint a run gets should be the one that is about it.
      // A local root has no members, so no tag belongs to one of them —
      // `--mine` there could only mean "everything", and a flag that quietly
      // widened to everything would be describing a space this machine is not
      // in. `FileStore.list` refuses the same call independently.
      if (mine && (await readConfig(ROOT))?.mode === "local") {
        console.error(
          ui.warn(
            "cairn review --mine needs a team space — tag ownership lives in the shared space, " +
              "and this root is local.",
          ),
        )
        process.exit(1)
      }
      if (rest.includes("--json")) {
        // The claims exactly as the store returns them. A narrower shape would
        // hide the body, abstract and overlaps this command renders — the
        // fields a script needs to decide anything — and invent a second
        // schema for a claim alongside the one the API and MCP already use.
        console.log(JSON.stringify(await (await openStore()).list("pending", { mine }), null, 2))
        break
      }
      // Refusing beats a silent no-op: an interactive command that exits 0
      // under CI having reviewed nothing is the same defect as an installer
      // that exits 0 having installed nothing.
      //
      // Checked BEFORE the store is opened, so a CI run gets the complaint
      // that is actually about it. Opening first meant a machine that was
      // both signed out and headless heard "not signed in" and, once signed
      // in, hit the real problem on the next run.
      if (!process.stdin.isTTY) {
        console.error(
          ui.warn("cairn review is interactive. Use `cairn review --json` for the pending queue."),
        )
        process.exit(1)
      }
      const store = await openStore()
      // Dynamic import only: this keeps opentui off the static graph cli.ts
      // pulls in on every command, `cairn mcp` included.
      const { runScreenReview } = await import("./review-screen")
      const summary = await runScreenReview({ store, ui, mine })
      console.log(
        `${summary.approved} approved, ${summary.edited} edited, ` +
          `${summary.rejected} rejected, ${summary.skipped} left pending`,
      )
      break
    }
    case "search": {
      const query = rest.filter((a) => !a.startsWith("-")).join(" ")
      if (query === "") {
        console.error(ui.warn("cairn search needs something to search for."))
        process.exit(1)
      }
      const store = await openStore()
      const all = rest.includes("--all")
      const hits = await runSearch(store, query, all)
      // Documents never gate on `--all` — they carry no status to widen —
      // and they are searched separately from claims (`searchDocuments`,
      // not `search`) for the same reason `team_knowledge_search` keeps the
      // two apart: mixing unreviewed material into "what has a reviewer
      // judged" would make a document indistinguishable from a claim in the
      // one place that question is asked.
      const docHits = await store.searchDocuments(query)
      if (rest.includes("--json")) {
        console.log(
          JSON.stringify(
            [
              ...hits.map((c) => ({ kind: "claim" as const, ...c })),
              ...docHits.map((d) => ({ kind: "document" as const, ...d })),
            ],
            null,
            2,
          ),
        )
      } else {
        // The terminal view is capped at the same limit `team_knowledge_search`
        // uses, and for the same reason: a query popular enough to match
        // hundreds of claims should not bury a person's terminal in them.
        // `--json` above stays complete — a script asked for everything and
        // gets everything.
        const shownHits = hits.slice(0, DEFAULT_SEARCH_LIMIT)
        const shownDocHits = docHits.slice(0, DEFAULT_SEARCH_LIMIT)
        // `formatSearch` can return "" when documents matched but no claim
        // did under `--all` — nothing left to say about the claim half, so
        // nothing is printed for it rather than a blank line.
        const claimsText = formatSearch(shownHits, all, shownDocHits.length > 0)
        if (claimsText) console.log(claimsText)
        if (shownDocHits.length > 0) console.log(formatDocumentHits(shownDocHits))
        const more = hits.length - shownHits.length + (docHits.length - shownDocHits.length)
        if (more > 0) console.log(ui.dim(`… and ${more} more — use --json for all`))
      }
      break
    }
    case "show": {
      const id = rest.find((a) => !a.startsWith("-"))
      if (id === undefined) {
        console.error(ui.warn("cairn show needs an id — `cairn search` prints them."))
        process.exit(1)
      }
      const store = await openStore()
      // The `doc-` prefix is the whole routing decision, the same way
      // `kbRead` (src/mcp.ts) routes on it — never a claim lookup that falls
      // back to a document lookup on a miss, which would make a stale claim
      // id and a real document id fail identically.
      if (id.startsWith("doc-")) {
        const doc = await store.getDocument(id)
        if (doc === null) {
          console.error(ui.warn(`no document with id ${id}`))
          process.exit(1)
        }
        // `kind` first and then the object spread, byte-for-byte the shape
        // `search --json` emits for the same document. A script that pipes a
        // search hit's id into `show` got a bare `Document` back and had to
        // special-case which command it came from.
        if (rest.includes("--json")) {
          console.log(JSON.stringify({ kind: "document" as const, ...doc }, null, 2))
        } else console.log(formatDocument(doc))
        break
      }
      const claim = await store.get(id)
      if (claim === null) {
        // Named, not a silent empty: an id that does not exist and a claim with
        // no body would otherwise print the same nothing.
        console.error(ui.warn(`no claim with id ${id}`))
        process.exit(1)
      }
      // BEFORE resolving anything, deliberately. `--json` prints the stored
      // claim verbatim and uses neither the documents nor the people below, so
      // resolving them first was one HTTP round-trip per citation plus a
      // members lookup against a hosted space, every one of them discarded.
      if (rest.includes("--json")) {
        // Tagged for the same reason the document above is, and in the same
        // order. Tagging only the document would have fixed the mismatch
        // between the two COMMANDS by opening one inside this one.
        console.log(JSON.stringify({ kind: "claim" as const, ...claim }, null, 2))
        break
      }
      // Resolved here, not inside `formatClaim`: that function holds no store
      // (see its comment), so the caller is the only place that can look a
      // cited document up by id.
      const docs = new Map<string, Document>()
      for (const cite of claim.cites) {
        const doc = await store.getDocument(cite.doc)
        if (doc) docs.set(doc.id, doc)
      }
      // Resolved here for the same reason the documents are: `formatClaim`
      // holds no store and no network. A local space has no members endpoint
      // to ask, so this is an empty map there and the reviewer renders as
      // whatever id the local store recorded — that id is
      // `unknown` in local mode.
      const people = await resolvePeople(ROOT, claim)
      // Resolved here for the third time and the same reason: `formatClaim`
      // holds no store. An overlap that no longer resolves is left out of the
      // map deliberately rather than skipped here — the renderer still prints
      // its id and says it is gone, because the id is on this claim either way
      // and a silently shorter list is the one thing this must not produce.
      const overlaps = new Map<string, Claim>()
      for (const id of claim.overlaps) {
        const other = await store.get(id)
        if (other) overlaps.set(other.id, other)
      }
      console.log(formatClaim(claim, docs, people, overlaps))
      break
    }
    case "retract": {
      // `--reason`'s value is excluded from the id search the same way `show`
      // excludes nothing extra — it has no valued flag to trip over. Here one
      // exists, so the id search must skip the token right after `--reason`
      // or a reason typed before the id would be mistaken for it.
      const reasonIndex = rest.indexOf("--reason")
      const id = rest.find((a, i) => !a.startsWith("-") && (reasonIndex === -1 || i !== reasonIndex + 1))
      if (id === undefined) {
        console.error(ui.warn("cairn retract needs an id — `cairn search` prints them."))
        process.exit(1)
      }
      const reason = flagValue(rest, "--reason")
      // A missing or blank `--reason` is refused with the exact sentence the
      // store throws for an empty one — not a CLI-specific message — so an
      // operator sees the same words whether the refusal came from the flag
      // parser or from `Store.retract` itself.
      if (reason === undefined || reason.trim() === "") {
        console.error(ui.warn(EMPTY_RETRACT_REASON))
        process.exit(1)
      }
      // `readConfig(ROOT)?.auth?.user` is the only identity a local CLI has
      // to offer — there is no config field a human-run command shares with
      // `propose` (that arrives over MCP with `author` supplied by the
      // calling agent, never read from config). Falls back to "unknown",
      // matching `parseClaim`'s (src/claims.ts) convention for an identity it
      // does not have — this value is written into the event log and into
      // `Claim.retracted.by`, read back long after this session, and "you"
      // means nothing to whoever reads it then.
      const by = (await readConfig(ROOT))?.auth?.user ?? "unknown"
      const store = await openStore()
      try {
        const claim = await runRetract(store, id, reason, by)
        if (claim === null) {
          console.error(ui.warn(`no claim with id ${id}`))
          process.exit(1)
        }
        console.log(ui.ok(`${id} retracted`))
      } catch (err) {
        // Not caught to reword: the sentence is the store's
        // (`notRetractableMessage`, packages/protocol/src/event-kinds.ts), and rewording it
        // here is exactly the drift that shared module exists to prevent.
        console.error(ui.warn(rootMessage(err)))
        process.exit(1)
      }
      break
    }
    case "cite": {
      const supportsIndex = rest.indexOf("--supports")
      const positional = rest.filter(
        (a, i) => !a.startsWith("-") && (supportsIndex === -1 || i !== supportsIndex + 1),
      )
      // Routed on the `doc-` prefix, not on order: `cairn cite <doc> <claim>`
      // is the same instruction typed the other way round, and refusing it on
      // position alone would be a rule with no reason behind it.
      const doc = positional.find((a) => a.startsWith("doc-"))
      const claimId = positional.find((a) => !a.startsWith("doc-"))
      if (claimId === undefined || doc === undefined) {
        console.error(ui.warn("cairn cite needs a claim id and a document id — `cairn search` prints both."))
        process.exit(1)
      }
      const supports = flagValue(rest, "--supports")
      // A missing or blank --supports is refused with the exact sentence the
      // store throws, not a CLI-specific message, so an operator sees the same
      // words whichever layer refused.
      if (supports === undefined || supports.trim() === "") {
        console.error(ui.warn(EMPTY_SUPPORTS))
        process.exit(1)
      }
      // The only identity a local CLI has to offer — the same route
      // `cairn retract` uses. There is no config field a human-run command
      // shares with `propose`, which arrives over MCP with `author` supplied
      // by the calling agent.
      const by = (await readConfig(ROOT))?.auth?.user ?? "unknown"
      const store = await openStore()
      try {
        const claim = await runCite(store, claimId, doc, supports, by)
        if (claim === null) {
          console.error(ui.warn(`no claim with id ${claimId}`))
          process.exit(1)
        }
        console.log(ui.ok(`${claimId} now cites ${doc}`))
      } catch (err) {
        // Not caught to reword: the sentence is the store's
        // (`notCitableMessage`, packages/protocol/src/event-kinds.ts), and rewording it here is
        // exactly the drift that shared module exists to prevent.
        console.error(ui.warn(rootMessage(err)))
        process.exit(1)
      }
      break
    }
    case "uncite": {
      // No valued flag to trip over, so the id search needs no exclusion —
      // the same shape `show`'s id search has.
      const positional = rest.filter((a) => !a.startsWith("-"))
      const doc = positional.find((a) => a.startsWith("doc-"))
      const claimId = positional.find((a) => !a.startsWith("doc-"))
      if (claimId === undefined || doc === undefined) {
        console.error(ui.warn("cairn uncite needs a claim id and a document id — `cairn show <id>` lists what it cites."))
        process.exit(1)
      }
      const store = await openStore()
      try {
        const claim = await runUncite(store, claimId, doc)
        if (claim === null) {
          console.error(ui.warn(`no claim with id ${claimId}`))
          process.exit(1)
        }
        console.log(ui.ok(`${claimId} no longer cites ${doc}`))
      } catch (err) {
        // Not caught to reword: the sentence is the store's
        // (`notUncitableMessage`, packages/protocol/src/event-kinds.ts), and rewording it here
        // is exactly the drift that shared module exists to prevent.
        console.error(ui.warn(rootMessage(err)))
        process.exit(1)
      }
      break
    }
    case "curate": {
      // The same refusal `review` makes, before the store is opened and for the
      // same reason: an interactive command that exits 0 under CI having
      // curated nothing is a silent no-op. There is no `--json` counterpart —
      // writing an abstract is the whole command, and a script that wants to
      // set one has `PATCH /claims/:id` directly.
      if (!process.stdin.isTTY) {
        console.error(ui.warn("cairn curate is interactive — it needs a terminal to write in."))
        process.exit(1)
      }
      const store = await openStore()
      // Dynamic import only: this keeps opentui off the static graph cli.ts
      // pulls in on every command, `cairn mcp` included.
      const { runScreenCurate } = await import("./review-screen")
      const summary = await runScreenCurate({ store, ui })
      console.log(`${summary.written} rewritten, ${summary.skipped} left as generated`)
      break
    }
    case "mcp": {
      const mode = (await readConfig(ROOT))?.mode
      const server = createMcpServer(await openStore(), await openSink(), {
        mode,
        onSearchResult: (hits) => recordSearchHit(ROOT, hits),
      })
      await server.connect(new StdioServerTransport())
      break
    }
    case "abstracts": {
      const all = rest.includes("--all")
      const dryRun = rest.includes("--dry-run")
      const force = rest.includes("--force")
      const cfg = await readConfig(ROOT)
      const gate = await gateGeneration(resolveGeneration(cfg?.generation ?? null, process.env), {
        isTty: Boolean(process.stdin.isTTY),
        out: (line) => console.log(ui.warn(line)),
        confirm: async () => {
          const clack = await import("@clack/prompts")
          const now = await clack.confirm({ message: "Choose one now?", initialValue: true })
          return clack.isCancel(now) ? null : now
        },
        runPicker: () => main(["model"]),
        reread: async () =>
          resolveGeneration((await readConfig(ROOT))?.generation ?? null, process.env),
      })
      // Declining is a choice, not a failure, and nothing was written.
      if (gate.kind === "declined") process.exit(0)
      if (gate.kind !== "ready") process.exit(1)
      const resolved = gate.resolved
      const onProgress = process.stdout.isTTY
        ? (done: number, total: number) => {
            process.stdout.write(`\r${progressLine(done, total, "written")}`)
          }
        : undefined
      const r = await runBackfill(await openStore(), (c) => generateAbstract(c, resolved), { all, force, dryRun, onProgress })
      if (onProgress) process.stdout.write("\r\x1b[K")
      // `r.targets`, not the two counters: a rate limit on the first claim
      // leaves both at zero and this sentence would be false about a space
      // holding fifty claims with no abstract.
      if (r.targets === 0) {
        console.log(ui.skip("Every approved claim already has an abstract."))
        break
      }
      console.log(
        ui.ok(`${dryRun ? "would write" : "wrote"} ${ui.bold(String(r.generated))} abstract(s)`),
      )
      if (r.failed > 0) {
        console.log(ui.warn(`${r.failed} failed — those claims still have none`))
        for (const line of formatFailures(r.failures)) console.log(ui.dim(`  ${line}`))
      }
      if (r.stopped) {
        const { notAttempted, reason } = r.stopped
        console.log(
          ui.warn(`rate limited — stopped, and ${notAttempted} claim(s) were not attempted`),
        )
        console.log(ui.dim(`  ${reason}`))
        console.log(ui.dim("  Wait for the limit to reset and run `cairn abstracts` again."))
      }
      for (const w of r.written) {
        console.log(`\n  ${ui.bold(w.claim)}`)
        console.log(ui.dim(`  ${w.abstract}`))
      }
      if (!dryRun && r.generated > 0) {
        // No surface lists them: they are approved, so they are not in the
        // review queue. `cairn status` is the one command that counts them,
        // and pointing at anything else here would be advice that dead-ends.
        console.log(ui.dim("  Nobody has reviewed these — run `cairn curate` to give them your own wording."))
      }
      break
    }
    case "init": {
      const dryRun = rest.includes("--dry-run")
      // Parsed before anything is asked, so a typo fails at once.
      const agentsFlag = parseAgentsFlag(rest)
      // Resolve our own path rather than asking for it — a wrong absolute path
      // is the single most common way this setup fails.
      const cliPath = fileURLToPath(import.meta.url)
      const cwd = process.cwd()
      const interactive = Boolean(process.stdin.isTTY) && !rest.includes("--yes")

      const clack = interactive ? await import("@clack/prompts") : null
      clack?.intro("cairn")
      // Only a person, or a dry run showing one what would happen, gets the
      // repository: a script keeps configuring exactly where it is run.
      const repo = interactive || dryRun ? await findRepo(cwd) : null
      // Asked for during the run, started only once init has finished
      // printing — Claude Code takes over the terminal.
      let launch: { prompt: string; cwd: string } | null = null
      const answered = <T,>(answer: T): Exclude<T, symbol> | null =>
        clack!.isCancel(answer) ? null : (answer as Exclude<T, symbol>)

      const outcome = await runInitCommand({
        root: ROOT,
        home: process.env.HOME ?? ".",
        cwd,
        cliPath,
        execPath: process.execPath,
        // Resolve bun the way the user's shell does, not the version-pinned
        // path of the running binary — that breaks on the next upgrade.
        bunPath: Bun.which("bun") ?? process.execPath,
        dryRun,
        // Only an explicit --project unlocks writing without a detected agent.
        // The scope resolver defaults to project when nobody says otherwise,
        // and defaulting into "write config for an agent I could not find"
        // is a decision the operator should make out loud.
        writeWithoutAgent: rest.includes("--project"),
        ...initPrompts(rest, cwd, interactive, repo),
        interactive,
        repo,
        modeFlag: modeFromFlags(rest),
        agentsFlag,
        chooseAgents: async (found) => {
          const answer = answered(
            await clack!.multiselect<Agent | "other">({
              message: "Which agents should cairn connect to?",
              options: [
                ...INIT_AGENTS.map((agent) => ({
                  value: agent,
                  label: AGENT_LABEL[agent],
                  hint: found.includes(agent) ? "found" : "not found",
                })),
                {
                  value: "other" as const,
                  label: OTHER_CLIENT_LABEL,
                  hint: "writes AGENTS.md and prints the config to paste",
                },
              ],
              initialValues: INIT_AGENTS.filter((a) => found.includes(a)),
              required: false,
            }),
          )
          if (answer === null) return null
          return { agents: answer.filter((a): a is Agent => a !== "other"), other: answer.includes("other") }
        },
        confirmWrite: async (message) => answered(await clack!.confirm({ message, initialValue: true })),
        selectFolders: async (folders) =>
          answered(
            await clack!.multiselect({
              message: "Import the docs in these folders?",
              options: folders.map(({ folder, count }) => ({
                value: folder,
                label: folder === "." ? "(top level)" : `${folder}/`,
                hint: `${count} doc${count === 1 ? "" : "s"}`,
              })),
              initialValues: folders.map((f) => f.folder),
              required: false,
            }),
          ),
        addFolder: async () =>
          answered(
            await clack!.text({
              message: "Add another folder of docs? (leave blank to continue)",
              placeholder: "path/to/docs",
              defaultValue: "",
            }),
          ) || null,
        confirmTeamImport: async (n, space) => {
          clack!.log.warn(teamImportMessage(n, space))
          return answered(await clack!.confirm({ message: "Import them?", initialValue: false }))
        },
        signIn: () => signIn(process.env.CAIRN_API_URL ?? DEFAULT_API_URL, {}),
        handshake: (entry) => spawnHandshake(entry),
        openStore: makeStore,
        agentOnPath: () => Bun.which("claude") !== null,
        launchAgent: async (prompt, dir) => {
          const yes = answered(await clack!.confirm({ message: "Start Claude Code now?", initialValue: true }))
          if (yes === true) launch = { prompt, cwd: dir }
        },
        resolveMigration: async (held) => askMigration(clack, held),
        resolveTelemetry: async (existing) => {
          const flagged = telemetryChoice(rest)
          if (flagged !== null) return flagged
          // Nobody to ask. Keep what the operator already answered; default to
          // off only when there is nothing to keep, which is a first run on a
          // bare machine — the case the old default was written for.
          if (!interactive) return existing ?? false
          return askTelemetry(clack!)
        },
        out: (line) => console.log(line),
        outro: (line) => clack!.outro(line),
      })

      if (outcome === "cancelled") {
        // Exit 0: cancelling is a choice, not a failure — and nothing was
        // written, so there is nothing to clean up or explain.
        if (clack) clack.cancel("Nothing was written.")
        else console.log(ui.warn("Cancelled. Nothing was written."))
        process.exit(0)
      }
      if (outcome === "no-agent") {
        // Unlike "cancelled", nothing was written and nothing was chosen —
        // the command did not do what it was asked. Exiting 0 here told every
        // caller, human or script, that the install was configured.
        process.exit(1)
      }
      if (outcome === "written") {
        // An interactive run has already closed itself through `outro`, and a
        // scripted one through runInitCommand's own closing line.
        // After the closing line rather than before it, so the clack rail
        // still ends where clack ends it — `outro` draws the `└` that closes
        // the box, and rows printed into the middle of that break it. This is
        // the one moment somebody is setting the tool up rather than using it,
        // and the frame they screenshot when showing it to someone.
        const mark = wordmark(process.stdout.columns)
        if (mark) {
          console.log("")
          for (const line of mark) console.log(ui.dim(line))
        }
        // Read through a const: TypeScript cannot see the callback above
        // assign it, and narrows the `let` to null.
        const agentLaunch = launch as { prompt: string; cwd: string } | null
        if (agentLaunch) {
          const proc = Bun.spawn(["claude", agentLaunch.prompt], {
            cwd: agentLaunch.cwd,
            stdio: ["inherit", "inherit", "inherit"],
          })
          // Awaited so cairn does not exit under it, but its exit code is
          // Claude Code's own business: init itself succeeded.
          await proc.exited
        }
      }
      break
    }
    case "model": {
      const flags = modelFlags(rest)
      const interactive = Boolean(process.stdin.isTTY) && !rest.includes("--yes")
      const existing = (await readConfig(ROOT)) ?? newConfig(false)

      if (flags.list) {
        const id = flags.provider ?? existing.generation?.provider
        const provider = id ? providerById(id) : null
        if (!provider) {
          console.log(ui.warn("no provider chosen — pass --provider, or run cairn model"))
          process.exit(1)
        }
        // Only the stored block for THIS provider counts: an OpenAI key stored
        // months ago is not a credential for the Ollama endpoint being listed.
        const stored =
          existing.generation?.provider === provider.id ? existing.generation : null
        // Flag → CAIRN_MODEL_URL → stored, so `--list` shows the endpoint the
        // configuration actually names. Listing Ollama on :11434 while a
        // custom endpoint is configured is the same "shows one, uses another"
        // defect the verification path was already fixed for once.
        const baseUrl = resolveBaseUrl(flags.baseUrl, process.env, stored?.baseUrl)
        const apiKey = resolveKey(provider, process.env, stored?.apiKey)
        try {
          for (const m of await provider.list({ model: "", apiKey, baseUrl })) {
            console.log(m.hint ? `${m.id}  ${ui.dim(m.hint)}` : m.id)
          }
        } catch (err) {
          // The SDK's own crash report names source lines, every enumerable
          // property of the error and a stack. None of that is actionable and
          // some of it is the request. One line, naming what was called.
          console.log(ui.warn(`could not read models from ${baseUrl ?? provider.label}: ${rootMessage(err)}`))
          process.exit(1)
        }
        break
      }

      // Non-interactive: set it directly, verifying only when asked.
      if (!interactive || (flags.provider && flags.model)) {
        if (!flags.provider || !flags.model) {
          console.log(ui.warn("pass both --provider and --model to set a model without prompting"))
          process.exit(1)
        }
        // Resolved once and threaded into both the verification and the saved
        // config, exactly as the picker does. Passing the raw flag verified
        // against the provider default while CAIRN_MODEL_URL named another
        // endpoint — proving out an endpoint the saved config would not use.
        const baseUrl = resolveBaseUrl(flags.baseUrl, process.env, null)
        const generation = {
          provider: flags.provider, model: flags.model,
          baseUrl: baseUrl ?? null, apiKey: null,
          maxTokens: flags.maxTokens ?? null,
        }
        if (flags.verify) {
          const provider = providerById(flags.provider)!
          const subject = await verificationSubject(await openStore(), (line) =>
            console.log(ui.warn(line)),
          )
          // No stored key: `generation` above saves apiKey null, so verifying
          // with a stored one would prove out credentials the saved config
          // will not use.
          const apiKey = resolveKey(provider, process.env, null)
          try {
            const text = await provider.generate(subject, {
              // Verified at the cap that will be saved, not the provider's
              // default — otherwise --verify proves a configuration nobody ends
              // up running.
              model: flags.model, baseUrl, apiKey, maxTokens: flags.maxTokens,
            })
            console.log(ui.dim(`  ${text}`))
          } catch (err) {
            console.log(ui.warn(
              `${flags.model} could not write an abstract via ` +
              `${baseUrl ?? provider.label}: ${rootMessage(err)}`,
            ))
            // Nothing is written: an unverified model must not be saved by the
            // command whose whole point was to verify it.
            process.exit(1)
          }
        }
        await writeConfig(ROOT, { ...existing, generation })
        console.log(ui.ok(`using ${ui.bold(flags.model)} via ${flags.provider}`))
        break
      }

      const clack = await import("@clack/prompts")
      clack.intro("cairn")
      const result = await runModelCommand({
        store: await openStore(),
        env: process.env,
        baseUrl: flags.baseUrl,
        resolveProvider: async () => {
          const answer = await clack.select({
            message: "Which provider?",
            options: allProviders().map((p) => ({ value: p.id, label: p.label })),
          })
          return clack.isCancel(answer) ? null : answer
        },
        resolveModel: async (models) => {
          const answer = await clack.select({
            message: "Which model?",
            options: models.map((m) => ({ value: m.id, label: m.label, hint: m.hint })),
          })
          return clack.isCancel(answer) ? null : answer
        },
        resolveKey: async () => {
          const answer = await clack.password({ message: "API key (leave blank to skip)" })
          if (clack.isCancel(answer)) return null
          return answer.trim() === "" ? null : answer
        },
        confirmKeep: async (abstract, ms) => {
          clack.note(`${abstract}\n\n${(ms / 1000).toFixed(1)}s`, "Generated from a real claim")
          const answer = await clack.confirm({ message: "Keep this model?", initialValue: true })
          return clack.isCancel(answer) ? null : answer
        },
        out: (line) => clack.log.error(line),
      })

      if (result.outcome === "cancelled") {
        clack.cancel("Nothing was saved.")
        process.exit(0)
      }
      if (result.outcome === "rejected") {
        clack.outro("Nothing was saved.")
        process.exit(1)
      }
      await writeConfig(ROOT, { ...existing, generation: result.generation ?? null })
      clack.outro(`Saved. Run ${"`cairn abstracts`"} to fill in the claims that have none.`)
      break
    }
    case "doctor": {
      const results = await runDoctor({
        home: process.env.HOME ?? ".",
        cwd: process.cwd(),
        root: ROOT,
        execPath: process.execPath,
        handshake: spawnHandshake,
        env: process.env,
      })
      const { exitCode, renderJson, renderPretty } = await import("./doctor-render")
      if (rest.includes("--json")) console.log(renderJson(results))
      else renderPretty(results)
      process.exit(exitCode(results))
    }
    case "--version":
    case "-v":
    case "version":
      console.log(versionLine())
      break
    default:
      // The mark goes above the command list, which is where a wordmark
      // conventionally sits — but only when there is no command, which is
      // `cairn` on its own and `--help`, since that recurses into `main([])`.
      // An unknown command lands in this same branch and must NOT get one:
      // that is the `cairn doctor` objection, which keeps the mark
      // off screens people are reading because something already went wrong.
      // A terminal too narrow for it falls back to the synopsis below, which
      // names the tool in plain text a line later — the alternative is
      // printing the word twice in two typefaces.
      if (command === undefined) {
        const mark = wordmark(process.stdout.columns)
        if (mark) {
          for (const line of mark) console.log(ui.dim(line))
          console.log("")
        }
      }
      console.log(
        `usage: ${ui.bold("cairn")} <init|model|doctor|import|adopt-imports|abstracts|status|stats|search|show|review|retract|cite|uncite|rebuild|curate|mcp|login|logout|org|telemetry>`,
      )
      console.log(
        ui.dim(
          "  init [--local|--team] [--project|--global] [--agents claude,cursor,codex,other] [--yes] [--telemetry|--no-telemetry] [--dry-run]   connect your agents",
        ),
      )
      console.log(
        ui.dim(
          "  model [--provider anthropic|openai|compatible --model Y] [--base-url URL] [--max-tokens N] [--list] [--verify] [--yes]   choose a model",
        ),
      )
      console.log(ui.dim("  doctor [--json]                         check that it actually works"))
      console.log(
        ui.dim("  import <dir>                            seed the space from a directory of .md files"),
      )
      console.log(
        ui.dim("  adopt-imports                           convert claims that cairn imported into documents"),
      )
      console.log(
        ui.dim(
          "  abstracts [--all[--force]] [--dry-run]  fill missing abstracts; --all also redoes generated ones, --force all of them",
        ),
      )
      console.log(ui.dim("  status                                  queue, reads, and missing abstracts"))
      console.log(ui.dim("  stats                                   the raw counts as JSON"))
      console.log(ui.dim("  search <text> [--all] [--json]          find what the team knows"))
      console.log(ui.dim("  show <id> [--json]                      one claim or document in full"))
      console.log(ui.dim("  review [--json] [--mine]                walk the pending queue"))
      console.log(
        ui.dim("  retract <id> --reason <text>            withdraw an approved claim"),
      )
      console.log(ui.dim("  cite <id> <doc-id> --supports <text>    attach a document as evidence"))
      console.log(ui.dim("  uncite <id> <doc-id>                    detach a citation"))
      console.log(ui.dim("  rebuild                                 reindex a local space (local only)"))
      console.log(ui.dim("  curate                                  rewrite the abstracts a model wrote"))
      console.log(ui.dim("  mcp                                     serve the MCP tools an agent calls"))
      console.log(ui.dim("  login [--no-browser]                    sign in and store a token"))
      console.log(ui.dim("  logout                                  revoke this machine's token"))
      console.log(ui.dim("  org [list|use <slug>]                   see or change which space this machine uses"))
      console.log(ui.dim("  telemetry [status|on|off]               counts only, and off by default"))
      console.log(ui.dim("  --version                               print build stamp"))
      // Asking for help succeeded; a command cairn does not have did not.
      // Exiting 0 on a typo makes `cairn revieww && deploy` run the deploy,
      // which is the same silent-success failure `init` shipped once already.
      //
      // Thrown, never `process.exit` — `main` is called directly by tests, and
      // exiting here takes the test runner down with it. Owning the exit code
      // is `runCli`'s job, which is the whole reason it exists.
      if (command !== undefined) throw new Error(`unknown command: ${command}`)
  }
}

/**
 * `main`, with the one thing every command needs and none of them had.
 *
 * Without this, any store-touching command against an unreachable service
 * exited on a raw Bun crash report: a source excerpt of the catch block that
 * raised it, the error class name, and a stack — with the actionable sentence
 * the store had carefully written buried in the middle of it. `login` and
 * `logout` each did the right thing for themselves; every other command did
 * not. One catch, the same `rootMessage`/`ui.warn` convention those two use,
 * and a non-zero exit.
 *
 * On stderr, not stdout: a command that failed must not put its diagnosis into
 * whatever a caller is piping the output into.
 */
export async function runCli(argv: string[]): Promise<void> {
  try {
    await main(argv)
    // Piggybacked here rather than inside `main`: this is the real entry
    // point, so a test that calls `main` directly makes no network call, and
    // a command that failed does not report counts as though it had run.
    //
    // Awaited, and that is deliberate. `sendTelemetry` carries its own 2s
    // abort and swallows every failure, so the worst case is one command a
    // day taking two seconds longer; firing it unawaited would instead race
    // process exit and lose the ping most of the time — a send that usually
    // does not happen is worse than a bounded wait that does.
    await sendTelemetry({
      root: ROOT,
      version: VERSION,
      platform: `${process.platform}-${process.arch}`,
      stats: async () => {
        // Guarded rather than left to `makeStore`, whose `requireAuth` prints
        // and calls `process.exit(1)`. A process exit cannot be caught, so a
        // best-effort path must never sit in front of one: without this,
        // `cairn telemetry on` on a team root with no account turned a
        // successful command into a login prompt and exit 1.
        const cfg = await readConfig(ROOT)
        if (cfg?.mode !== "local" && !cfg?.auth) throw new Error("no store to read counts from")
        return (await makeStore(ROOT)).stats()
      },
      env: process.env,
    })
  } catch (err) {
    console.error(ui.warn(rootMessage(err)))
    process.exit(1)
  }
}

if (import.meta.main) await runCli(process.argv.slice(2))
