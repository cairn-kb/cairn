import { expect, test } from "bun:test"
import { exitCode, renderJson, summaryLine } from "../src/doctor-render"
import type { CheckResult } from "../src/doctor"

const ok: CheckResult = { name: "a", group: "G", status: "ok", detail: "fine" }
const warn: CheckResult = { name: "b", group: "G", status: "warn", detail: "meh" }
const fail: CheckResult = { name: "c", group: "G", status: "fail", detail: "broken" }

test("a clean run exits zero", () => {
  expect(exitCode([ok, ok])).toBe(0)
})

test("warnings do not fail the run", () => {
  // Missing abstracts are worth saying and not worth failing CI over.
  expect(exitCode([ok, warn])).toBe(0)
})

test("any failure exits one", () => {
  expect(exitCode([ok, warn, fail])).toBe(1)
})

test("the summary counts problems, not checks", () => {
  expect(summaryLine([ok, warn, fail])).toBe("1 problem")
  expect(summaryLine([ok, fail, fail])).toBe("2 problems")
  expect(summaryLine([ok, warn])).toBe("no problems")
})

test("json output is the raw results, for pasting", () => {
  expect(JSON.parse(renderJson([ok, fail]))).toEqual([ok, fail])
})
