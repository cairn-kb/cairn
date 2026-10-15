import { intro, log, outro } from "@clack/prompts"
import type { CheckResult } from "./doctor"

/**
 * Warnings deliberately do not affect the exit code. `doctor` should be usable
 * in a script as "is this install broken", and a store with an unwritten
 * abstract is not broken.
 */
export function exitCode(results: CheckResult[]): 0 | 1 {
  return results.some((r) => r.status === "fail") ? 1 : 0
}

export function summaryLine(results: CheckResult[]): string {
  const n = results.filter((r) => r.status === "fail").length
  if (n === 0) return "no problems"
  return `${n} problem${n === 1 ? "" : "s"}`
}

export function renderJson(results: CheckResult[]): string {
  return JSON.stringify(results, null, 2)
}

const GLYPH = { ok: "✔", warn: "!", fail: "✘" } as const

export function renderPretty(results: CheckResult[]): void {
  intro("cairn doctor")
  let group = ""
  for (const r of results) {
    if (r.group !== group) {
      group = r.group
      log.step(group)
    }
    const line = `${GLYPH[r.status]} ${r.detail}`
    if (r.status === "fail") log.error(r.fix ? `${line}\n  → ${r.fix}` : line)
    else if (r.status === "warn") log.warn(r.fix ? `${line} → ${r.fix}` : line)
    else log.success(line)
  }
  outro(summaryLine(results))
}
