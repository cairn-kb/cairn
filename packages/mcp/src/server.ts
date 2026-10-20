import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  ABSTRACT_GUIDANCE,
  CITE_DESCRIPTION,
  createTools,
  DEFAULT_MAP_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  GENERATED_NOTE,
  MAP_DESCRIPTION,
  PROPOSE_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  WRITE_DOCUMENT_DESCRIPTION,
  type KbTools,
  type ToolSink,
  type ToolStore,
  type Via,
} from "./tools"

/**
 * What a caller is allowed to do through the server. A tool outside the
 * granted scopes is not registered at all, so a host never lists it — the
 * same structural refusal that keeps `team_knowledge_uncite` out.
 */
export type Scope = "knowledge:read" | "knowledge:write"

export const ALL_SCOPES: ReadonlySet<Scope> = new Set<Scope>(["knowledge:read", "knowledge:write"])

export interface ServerOptions {
  /** Reported to the host in the handshake — the build's, never a literal. */
  version: string
  /** Which transport this server is served over; every event records it. */
  via: Via
  /** Defaults to `ALL_SCOPES`. */
  scopes?: ReadonlySet<Scope>
  /**
   * When set, `team_knowledge_write_document` answers with this sentence as
   * its error and never reaches the store. The CLI passes one for a space
   * that talks to the hosted service.
   */
  teamWriteRefusal?: string
  /** Called with the hit count after every `team_knowledge_search`. */
  onSearchResult?: (hits: number) => Promise<void>
}

/**
 * Why every tool carries annotations, and why `propose` is not destructive.
 *
 * Anthropic's connector review criteria make `title` plus the applicable hint
 * a pass/fail requirement, and say what the hint is FOR: "read-only tools can
 * run without per-call confirmation; destructive tools always prompt." With no
 * annotation a host must assume the worst, so `team_knowledge_map` — the call
 * an agent makes at the start of every session — and `team_knowledge_search`
 * were each costing a permission prompt they do not need. Those are the two
 * calls `cairn status` counts, which meant the product was reading friction it
 * imposed itself as agents not being interested.
 *
 * `propose` is a write and is deliberately NOT marked destructive: it appends
 * a pending claim and deletes or overwrites nothing. Marking it destructive
 * would put a confirmation dialog in front of the one action the product wants
 * more of. It is not idempotent either — proposing twice files two claims.
 *
 * `openWorldHint` is deliberately absent rather than true. It would be
 * accurate for the hosted store and false for a local one, and the same server
 * serves both; an unset hint is silence, while a true one would be a statement
 * about the world that is wrong half the time.
 */
const READ_ONLY = { readOnlyHint: true } as const

export function createMcpServer(store: ToolStore, log: ToolSink, opts: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "cairn", version: opts.version },
    { instructions: SERVER_INSTRUCTIONS },
  )
  const tools = createTools(store, log, opts.via)
  const scopes = opts.scopes ?? ALL_SCOPES
  if (scopes.has("knowledge:read")) registerReadTools(server, tools, opts)
  if (scopes.has("knowledge:write")) registerWriteTools(server, tools, opts)

  // No `team_knowledge_uncite` is registered here, deliberately — see the doc
  // comment on KbTools.kbCite and Store.uncite. Enforced structurally: a
  // capability-inventory test (test/capability-inventory.test.ts) reads this
  // file's source and asserts the exact set of registered tool names, so a
  // call added here later would need that assertion changed alongside it
  // rather than slipping in unnoticed.

  return server
}

function registerReadTools(server: McpServer, tools: KbTools, opts: ServerOptions): void {
  server.registerTool(
    "team_knowledge_map",
    {
      title: "Team knowledge map",
      description: MAP_DESCRIPTION,
      inputSchema: {
        agent: z.string().optional().describe("Which agent is calling, e.g. cursor"),
        session: z
          .string()
          .optional()
          .describe("Stable id for this session, so reads can be counted per session"),
        limit: z
          .number()
          .optional()
          .describe(
            `How many claims to return. Defaults to ${DEFAULT_MAP_LIMIT}; the response says how ` +
              "many were left out.",
          ),
      },
      annotations: READ_ONLY,
    },
    async (ctx) => ({
      content: [{ type: "text", text: JSON.stringify(await tools.kbMap(ctx)) }],
    }),
  )

  server.registerTool(
    "team_knowledge_read",
    {
      title: "Read team knowledge",
      description:
        "Read full claims or documents by id, once an abstract from map or a hit from search looks " +
        "relevant. A single call accepts claim ids and document ids together. A document longer " +
        "than one window comes back with nextOffset — pass that back as offset on your next call " +
        "to keep reading. offset only works when ids has exactly one id in it; to keep reading " +
        "several documents, call once per document instead. A document comes back with its hash " +
        "as it is now; a claim's citation records the hash of the document it was read from, so " +
        "the two differing means the document has changed since it was cited and the citation may " +
        "no longer describe what is in it. A claim that comes back as " +
        '{"kind":"retracted"} was approved and has since been withdrawn by a human — discard any ' +
        "copy you are holding. " +
        GENERATED_NOTE,
      inputSchema: {
        ids: z.array(z.string()),
        offset: z
          .number()
          .optional()
          .describe(
            "Where to resume a long document, taken from a previous read's nextOffset. Valid " +
              "only when ids has exactly one element — passed alongside several ids it would " +
              "reuse the same window for all of them, so that combination is refused.",
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ ids, offset }) => ({
      content: [{ type: "text", text: JSON.stringify(await tools.kbRead(ids, offset)) }],
    }),
  )

  server.registerTool(
    "team_knowledge_search",
    {
      title: "Search team knowledge",
      description:
        "Search claims and documents by text when you have a specific question map's abstracts " +
        "didn't already answer. It covers the team's recorded decisions, conventions, " +
        "architecture and history, so it is the source for questions about this project that " +
        "memory alone can't settle, and it shows whether a claim you are about to propose " +
        "already exists. Results come back as two blocks in a fixed order — every matching " +
        "claim, then every matching document — never interleaved by relevance score, so you can " +
        "always predict where one block ends and the next begins. A claim is durable knowledge a " +
        "human has reviewed and approved. A document is raw imported source material nobody has " +
        "judged — read it the way you would read any file in the repo. " +
        GENERATED_NOTE +
        " A claim's cites each name a " +
        "document together with what it supports. Neither kind of hit carries " +
        "full text: a claim hit is its sentence and abstract, a document hit a short preview. " +
        "Call team_knowledge_read on the ids that look relevant. Results are bounded — the " +
        "response says how many matches it left out.",
      inputSchema: {
        query: z.string().describe("Words to match against claims and documents"),
        limit: z
          .number()
          .optional()
          .describe(
            `How many hits of EACH kind to return — claims and documents are bounded ` +
              `separately, so a query matching many claims still returns documents. Defaults ` +
              `to ${DEFAULT_SEARCH_LIMIT}.`,
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const result = await tools.kbSearch(query, limit)
      // Only here, never inside `createTools(...).kbSearch` itself — that
      // function is also called directly by tests and by any future
      // in-process caller that should not have to carry this along.
      //
      // Guarded against both a synchronous throw and a rejection: this hook
      // is instrumentation (the first-answer metric uses it), not part of the
      // search contract, so a hook that misbehaves must never turn an
      // agent's search into an error.
      try {
        await opts.onSearchResult?.(result.hits.length)
      } catch {
        // Swallowed deliberately — see above.
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] }
    },
  )
}

function registerWriteTools(server: McpServer, tools: KbTools, opts: ServerOptions): void {
  server.registerTool(
    "team_knowledge_propose",
    {
      title: "Propose team knowledge",
      description: PROPOSE_DESCRIPTION,
      inputSchema: {
        claim: z.string().describe("One assertive sentence — the thing a reviewer judges"),
        body: z.string().describe("Detail and rationale"),
        abstract: z.string().describe(ABSTRACT_GUIDANCE),
        author: z.string(),
        agent: z.string(),
        repo: z.string().optional(),
        session: z.string().optional(),
        tags: z.array(z.string()).optional(),
        cites: z
          .array(z.object({ doc: z.string(), supports: z.string().min(1) }))
          .optional()
          .describe(
            "Documents this claim was written from, each with what it supports. `doc` is a " +
              "document id from team_knowledge_search or team_knowledge_read; `supports` names " +
              "which part of the claim that document grounds. An unknown id is refused, naming " +
              "which one — check it is a document id, not a claim id, before retrying.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(await tools.kbPropose(input)) }],
    }),
  )

  server.registerTool(
    "team_knowledge_cite",
    {
      title: "Cite a document on a claim",
      description: CITE_DESCRIPTION,
      inputSchema: {
        claim: z.string().describe("The claim id, from team_knowledge_map or team_knowledge_search"),
        doc: z.string().describe("The document id, from team_knowledge_search or team_knowledge_read"),
        supports: z
          .string()
          .min(1)
          .describe(
            "What this document grounds — which part of the claim it backs up, in your own words. " +
              "Name the specific assertion, not the topic. If the document grounds one clause and " +
              "not the rest, say which one; a citation that covers part of a claim is worth more " +
              "than one that implies it covers all of it.",
          ),
        agent: z.string().describe("Which agent is attaching this, e.g. cursor"),
      },
      // Not idempotent (a second call on an already-cited document is
      // refused, not a no-op) and not destructive (it appends evidence and
      // removes nothing) — the same reasoning `team_knowledge_propose`'s
      // annotations already state for a write that is neither.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => ({ content: [{ type: "text", text: JSON.stringify(await tools.kbCite(input)) }] }),
  )

  server.registerTool(
    "team_knowledge_write_document",
    {
      title: "Write a generated document",
      description: WRITE_DOCUMENT_DESCRIPTION,
      inputSchema: {
        repo: z.string().describe("The repository label you were given for this work, not one you invent"),
        slug: z
          .string()
          .describe(
            "Names this document within the repo, lowercase letters, digits and hyphens only " +
              '(e.g. "architecture") — it becomes part of the document\'s identity, so it cannot ' +
              'contain "/" or "..".',
          ),
        title: z.string().min(1).describe("The document's title, shown to people exactly as given"),
        text: z.string().min(1).describe("The document's full text, shown to people exactly as given"),
        agent: z.string().describe("Which agent is calling, e.g. cursor"),
      },
      // Writing again with the same repo and slug replaces the document's
      // text rather than creating a second one — idempotent in effect, but
      // not marked so: the response differs ("created" vs. "updated") in a
      // way a host should not assume away. Not destructive: it replaces this
      // one generated document's own text and removes nothing else.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      // Decided before the input is even looked at: a caller that knows its
      // space cannot take this write (the CLI, for a space that talks to the
      // hosted service) says so once, and nothing here gets far enough to try.
      if (opts.teamWriteRefusal !== undefined) throw new Error(opts.teamWriteRefusal)
      return { content: [{ type: "text", text: JSON.stringify(await tools.kbWriteDocument(input)) }] }
    },
  )
}
