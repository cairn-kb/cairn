import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventLog } from "../src/events"
import { FileStore } from "../src/store"
import { CONTRACT_CASES, DOCUMENT_CONTRACT_CASES, type ContractLog, type ExpectFn } from "./store-contract"

for (const c of [...CONTRACT_CASES, ...DOCUMENT_CONTRACT_CASES]) {
  test(`FileStore: ${c.name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cairn-contract-"))
    // Constructed exactly as cli.ts's openStore() does it: propose and review
    // write events, and a FileStore without a sink throws rather than dropping
    // one. The log writes events.jsonl inside root, so removing root below
    // removes the store and the log together.
    const log = new EventLog(root)
    const store = new FileStore(root, log)
    await store.init()
    // The same append `createTools`' read path makes (src/mcp.ts): kind
    // `read`, carrying the claim's id — which is what put a read event in
    // front of the adoption guard in the first place.
    // A fixed literal, distinct from any reviewer identity `review()` ever
    // produces: FileStore's `review()` never sets `reviewer` at all (it stays
    // whatever `propose` set it to, always null — see src/store.ts), so any
    // non-null string here is already a different actor. `retract` takes
    // `by` directly, so no second identity needs seeding the way HttpStore's
    // harness needs a second token.
    const RETRACT_ACTOR = "a-second-reviewer"
    const CITE_ACTOR = "a-grounding-agent"
    const contractLog: ContractLog = {
      read: (claimId) => log.append("read", claimId),
      retractAs: (id, reason) => store.retract(id, reason, RETRACT_ACTOR),
      retractActorId: RETRACT_ACTOR,
      // FileStore records the `by` it is handed verbatim, so the harness's
      // expected identity and the argument it passes are the same string —
      // and deliberately NOT "cursor", the agent `proposal()` proposes as: a
      // `cite` that attributed the citation to the claim's proposing agent
      // rather than to its caller would otherwise read back as correct.
      citeAs: (id, input) => store.cite(id, input, CITE_ACTOR),
      citeActorId: CITE_ACTOR,
    }
    try {
      // bun:test's expect is far wider than ExpectFn; the cast narrows it to
      // the subset other runners also provide, which is what keeps the cases
      // runner-neutral.
      await c.run(store, expect as unknown as ExpectFn, contractLog)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
