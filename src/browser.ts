/**
 * Opens a URL in the operator's default browser, per platform.
 *
 * Deliberately not on the MCP path — this is only ever called from
 * `cairn login`, an interactive command — so it is free to use console.error
 * as its default diagnostic sink.
 */

export interface OpenBrowserDeps {
  /** Defaults to the real OS platform. Injected so tests do not depend on where they run. */
  platform?: NodeJS.Platform
  /** Defaults to Bun.spawn. Injected so tests never launch a real process. */
  spawn?: (cmd: string[]) => { exited: Promise<number> }
  /** Where the fallback instructions go when the browser can't be opened. */
  print?: (line: string) => void
}

function commandFor(url: string, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") return ["open", url]
  if (platform === "win32") return ["cmd", "/c", "start", "", url]
  return ["xdg-open", url]
}

/**
 * Best-effort only. A browser that will not open is not fatal — the caller
 * (runLogin) already has a loopback server listening, or has printed the same
 * URL for a manual paste, so any failure here falls back to printing the URL
 * rather than rejecting.
 */
export async function openInBrowser(url: string, deps: OpenBrowserDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  const spawn =
    deps.spawn ?? ((cmd: string[]) => Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }))
  const print = deps.print ?? ((line: string) => console.error(line))

  try {
    const proc = spawn(commandFor(url, platform))
    const code = await proc.exited
    if (code !== 0) throw new Error(`command exited with code ${code}`)
  } catch (err) {
    print(`could not open a browser automatically (${(err as Error).message}).`)
    print(`open this URL yourself: ${url}`)
  }
}
