/**
 * Terminal presentation. Deliberately dependency-free and deliberately quiet
 * when nobody is watching: `cairn stats` emits JSON people pipe, and
 * `cairn mcp` shares stdout with the MCP protocol, where a stray escape
 * sequence would corrupt the stream.
 */

export interface Ui {
  bold(s: string): string
  dim(s: string): string
  green(s: string): string
  yellow(s: string): string
  red(s: string): string
  cyan(s: string): string
  /** Something was written. */
  ok(s: string): string
  /** Something was already correct and left alone. */
  skip(s: string): string
  /** Something still needs the human. */
  warn(s: string): string
}

/** NO_COLOR is presence-based by convention — an empty value still disables. */
export function colorsEnabled(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if ("NO_COLOR" in env) return false
  return isTty
}

export function createUi(enabled: boolean): Ui {
  const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s)
  const green = wrap("32")
  const yellow = wrap("33")
  const dim = wrap("2")
  return {
    bold: wrap("1"),
    dim,
    green,
    yellow,
    red: wrap("31"),
    cyan: wrap("36"),
    ok: (s) => `${green("✓")} ${s}`,
    skip: (s) => `${dim("·")} ${s}`,
    warn: (s) => `${yellow("!")} ${s}`,
  }
}

/** One line of in-place progress, for work that actually takes time. */
export function progressLine(done: number, total: number, verb: string): string {
  return `  ${done}/${total} ${verb}…`
}
