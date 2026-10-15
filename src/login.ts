import { hostname } from "node:os"
import type { AuthConfig } from "./config"

/**
 * `src/cli.ts` reaches this module unconditionally (the `login`/`logout`
 * cases live in its switch), and `cairn mcp` shares stdout with the MCP
 * protocol — so this file must never import `@clack/prompts` itself. The
 * caller in `cli.ts` supplies clack's text prompt through `promptCode`.
 */

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/**
 * PKCE S256. The CLI is a public client, where RFC 9700 requires it.
 *
 * Must match the hosted service's challenge exactly: SHA-256 of the
 * verifier's UTF-8 bytes, base64url-encoded with no padding. Any divergence —
 * even just keeping the `=` padding — makes every exchange fail, since the
 * server recomputes the same digest from the verifier and compares strings.
 */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(digest) }
}

export interface LoginDeps {
  apiUrl: string
  machineName?: string
  openBrowser: (url: string) => Promise<void>
  fetchImpl?: typeof fetch
  /** No browser on this machine (e.g. over SSH) — print the URL and take the code by hand. */
  noBrowser?: boolean
  /**
   * Which space this machine's token is for. Omitted, the server picks the
   * earliest membership — which is right for a first login and wrong for
   * anyone who joined a team after signing up.
   */
  org?: string
  print?: (line: string) => void
  /**
   * Read a code the operator copied off the screen. Used by `--no-browser`,
   * and as the fallback whenever a redirect does not reach the loopback.
   * Without it those paths have nothing to fall back to and throw instead.
   */
  /**
   * The signal is aborted as soon as some other path delivers the code — the
   * browser callback arriving first, or the login ending. An implementation
   * that renders a prompt must stop rendering and release stdin when it
   * fires, or a login the browser completed leaves a dead prompt on screen
   * holding the terminal. `@clack/prompts` takes an `AbortSignal`
   * on its text options and cancels promptly; `cli.ts` passes this straight
   * through.
   */
  promptCode?: (signal?: AbortSignal) => Promise<string>
  /**
   * How long to wait for the browser before falling back to the paste prompt.
   * An option so a test can reach that branch without waiting minutes.
   */
  timeoutMs?: number
}

/**
 * How long to wait for the browser.
 *
 * NOT the server's code lifetime, which this used to copy. The two measure
 * different spans: the code's TTL starts at approval, while this starts at
 * `open` and has to cover finding the window the browser opened behind
 * something, a GitHub sign-in, and a 2FA prompt on a phone that has to be
 * unlocked first. Five minutes is short for exactly the first-run case, and
 * running out is no longer fatal anyway — see the fallback in `runLogin`.
 */
const WAIT_MS = 15 * 60 * 1000

/** "5 minutes", "30 seconds" — the number in the message has to be the number
 *  actually waited, or the sentence is a lie in every test that shortens it. */
function humanDuration(ms: number): string {
  if (ms >= 60_000) {
    const mins = Math.round(ms / 60_000)
    return `${mins} minute${mins === 1 ? "" : "s"}`
  }
  const secs = Math.round(ms / 1000)
  return `${secs} second${secs === 1 ? "" : "s"}`
}

/**
 * `port: null` means the `--no-browser` path: there is no loopback to
 * redirect to, so the param is OMITTED entirely rather than sent as `0` —
 * absent is honest about there being no port; `0` is a port that does not
 * exist. The hosted service branches on exactly this: an absent port renders the code on a page instead of
 * redirecting; a present-but-junk one is still a rejected request.
 */
function authorizeUrl(
  apiUrl: string,
  challenge: string,
  state: string,
  port: number | null,
  name: string,
  org?: string,
): URL {
  const url = new URL(`${apiUrl}/v1/cli/authorize`)
  url.searchParams.set("challenge", challenge)
  // The server ignores this; it is here because a public client declaring its
  // PKCE method is what RFC 9700 expects of it.
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  if (port !== null) url.searchParams.set("port", String(port))
  url.searchParams.set("name", name)
  if (org) url.searchParams.set("org", org)
  return url
}

/**
 * A failed exchange burns the one-time code server-side, deliberately, so
 * this makes exactly one attempt. On
 * failure the caller's only recourse is `cairn login` again, and the message
 * says so.
 */
async function exchange(
  apiUrl: string,
  doFetch: typeof fetch,
  code: string,
  verifier: string,
): Promise<AuthConfig> {
  const endpoint = `${apiUrl}/v1/cli/exchange`
  const res = await doFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  })
  if (!res.ok) {
    throw new Error(`cairn refused the code at ${endpoint} (${res.status}) — run cairn login again`)
  }
  const body = (await res.json()) as {
    token: string
    orgId: string
    orgSlug: string
    user: string | null
  }
  return { ...body, apiUrl }
}

export async function runLogin(deps: LoginDeps): Promise<AuthConfig> {
  const doFetch = deps.fetchImpl ?? fetch
  const { verifier, challenge } = await pkcePair()
  const state = crypto.randomUUID()
  const name = deps.machineName ?? hostname()

  if (deps.noBrowser) {
    if (!deps.promptCode) {
      throw new Error("--no-browser needs promptCode to read the pasted code")
    }
    // Nothing to redirect to, so there is no loopback server and no state
    // check on this path — the PKCE verifier and the exchange are otherwise
    // identical to the browser path.
    const url = authorizeUrl(deps.apiUrl, challenge, state, null, name, deps.org)
    const print = deps.print ?? (() => {})
    print("open this URL to authorize this machine, then paste the code it gives you:")
    print(`  ${url.toString()}`)
    const code = await deps.promptCode()
    return exchange(deps.apiUrl, doFetch, code, verifier)
  }

  let resolveCode: (code: string) => void
  let rejectCode: (err: Error) => void
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  // The rejection (state mismatch, missing code) is delivered inside
  // Bun.serve's own request-handling task, which finishes — and so is
  // checked for an unhandled rejection — before `await codePromise` below is
  // even reached. Attaching a no-op handler now marks it handled without
  // consuming it; the real `await codePromise` below still sees the value.
  codePromise.catch(() => {})

  // Bind to loopback only, on a port the OS picks. Binding 0.0.0.0 would
  // expose the callback — and the one-time code it carries — to the network.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 })
      if (url.searchParams.get("state") !== state) {
        rejectCode(new Error("state mismatch — the login response did not come from your request"))
        return new Response("state mismatch", { status: 400 })
      }
      const code = url.searchParams.get("code")
      if (!code) {
        rejectCode(new Error("no code in the login response"))
        return new Response("missing code", { status: 400 })
      }
      resolveCode(code)
      return new Response("cairn: you can close this tab and return to your terminal.", {
        // `connection: close` matters for the shutdown below: it tells the
        // browser not to hold the socket open for reuse, so a graceful stop
        // has nothing left to wait on and the process exits promptly.
        headers: { "content-type": "text/plain", connection: "close" },
      })
    },
  })

  const print = deps.print ?? (() => {})
  const waitMs = deps.timeoutMs ?? WAIT_MS
  // Definite assignment: the executor below runs synchronously, so this is set
  // before the `finally` can read it.
  let timer!: ReturnType<typeof setTimeout>

  // Every racer below RESOLVES to one of these rather than rejecting, and
  // that is load-bearing rather than a style choice. `Promise.race` settles
  // on the first outcome of either kind, so a rejecting loser ends the whole
  // race — and two of the three losers here are paths the login is expected
  // to survive. A callback that fails its state check must still leave the
  // paste prompt standing — that case has a test — and the wait
  // running out must not close a prompt the operator is walking towards.
  type Delivery =
    | { kind: "code"; code: string }
    | { kind: "callback-failed"; err: Error }
    | { kind: "paste-failed"; err: Error }
    | { kind: "timeout" }

  const timeout = new Promise<Delivery>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), waitMs)
  })

  // Only the DELIVERY of the code is guarded here. The exchange happens after
  // the server is down, and deliberately outside this try: a refused exchange
  // has already burned the code server-side, so falling back to a paste prompt
  // there would ask the operator for something that cannot work.
  let delivered: string | null = null
  let undelivered: Error | null = null
  // Aborted on every exit path, so the prompt cannot outlive the login that
  // opened it.
  const promptAbort = new AbortController()
  try {
    const port = server.port
    if (port === undefined) throw new Error("the local login server did not bind a port")
    const url = authorizeUrl(deps.apiUrl, challenge, state, port, name, deps.org)
    await deps.openBrowser(url.toString())

    // Said BEFORE the wait, because nothing is printed during it. A browser
    // with no cairn session shows a sign-in page first; finishing that comes
    // back to the approval page and this same terminal carries on, so the one
    // thing an operator must not do is assume it is stuck.
    print("  If the browser asks you to sign in first, finish that — it will bring")
    print("  you back to the page that asks you to approve this machine.")
    print(`  Waiting up to ${humanDuration(waitMs)} for you to approve…`)
    // The paste prompt is OPEN from here, not offered after the wait fails.
    // The case this fallback most exists for is a browser on another machine,
    // where the loopback is unreachable in principle — so the operator can
    // already see it will never arrive, and used to have to sit out the whole
    // wait or Ctrl-C and start over with `--no-browser`.
    print("")
    print("  If the browser cannot reach this terminal — it is on another machine, or")
    print("  it lands on a page that will not load — the code is in its address bar")
    print("  after `code=`. Paste it at the prompt below; you do not have to wait,")
    print("  and the prompt closes by itself if the browser gets through first.")

    // Opened BEFORE the race so it is on screen for the whole wait. Its
    // rejection is mapped rather than thrown: an operator pressing Ctrl-C at
    // the prompt ends the login, but a prompt aborted because the callback
    // won is not a failure and must not read as one.
    const paste = deps.promptCode
      ? deps.promptCode(promptAbort.signal).then<Delivery, Delivery>(
          (code) => ({ kind: "code", code }),
          (err: Error) => ({ kind: "paste-failed", err }),
        )
      : null

    const callback = codePromise.then<Delivery, Delivery>(
      (code) => ({ kind: "code", code }),
      (err: Error) => ({ kind: "callback-failed", err }),
    )

    let outcome = await Promise.race(paste ? [callback, paste, timeout] : [callback, timeout])

    // Losing the race is not the same as being out of the running. The
    // callback can fail its state check, or the wait can run out, while the
    // prompt is still open and still the path most likely to deliver — so
    // neither of those ends the login on its own. Only the prompt's own
    // failure, or its absence, does.
    if (outcome.kind !== "code" && outcome.kind !== "paste-failed" && paste) {
      outcome = await paste
    }

    switch (outcome.kind) {
      case "code":
        delivered = outcome.code
        break
      case "callback-failed":
      case "paste-failed":
        undelivered = outcome.err
        break
      case "timeout":
        undelivered = new Error(
          `gave up waiting for the browser after ${humanDuration(waitMs)}`,
        )
        break
    }
  } catch (err) {
    undelivered = err as Error
  } finally {
    // All three, on every path: an uncleared timer holds the event loop open
    // for the rest of the wait after a login that already succeeded, and an
    // un-aborted prompt holds stdin and keeps drawing over whatever the
    // command prints next.
    clearTimeout(timer)
    promptAbort.abort()
    // Graceful, NOT stop(true). The code is delivered from inside the request
    // handler, so by the time this runs the handler's response is still being
    // written — and `stop(true)` closes active connections immediately, which
    // tore that response down mid-flight. The login itself succeeded, but the
    // operator's browser showed a connection error, which reads as a failure.
    // The paired `connection: close` header means there is no idle keep-alive
    // socket for a graceful stop to wait on.
    server.stop()
  }

  if (delivered === null) {
    const why = undelivered ?? new Error("the browser never came back")
    // There is no second prompt to offer here any more. The paste prompt was
    // open for the whole wait, so reaching this point means it was declined,
    // cancelled, or never supplied — and re-asking somebody who just pressed
    // Ctrl-C is worse than saying plainly that the login did not happen.
    //
    // The approval itself is not lost by this: the server minted the token
    // before redirecting and burned nothing, so the code in the browser's
    // address bar stays redeemable for five minutes. `cairn login
    // --no-browser` takes it.
    throw new Error(`${why.message} — run \`cairn login\` again`)
  }

  return exchange(deps.apiUrl, doFetch, delivered, verifier)
}

export interface LogoutDeps {
  auth: AuthConfig
  fetchImpl?: typeof fetch
}

export interface LogoutResult {
  /** False when the server could not be reached at all — network down, DNS, etc. */
  revoked: boolean
  /**
   * Set only when `revoked` is false. Names the endpoint that could not be
   * reached, since the local sign-out proceeds either way and the operator
   * needs to know the token is still live server-side.
   */
  warning?: string
}

/**
 * Revokes the token server-side, but never leaves an operator stuck signed in
 * locally because the network was down: a laptop with no connectivity must
 * still be able to `cairn logout` and have the local block cleared. A network
 * failure here is reported back rather than thrown, so the caller can clear
 * the local config regardless and tell the operator what did not happen.
 */
export async function runLogout(deps: LogoutDeps): Promise<LogoutResult> {
  const doFetch = deps.fetchImpl ?? fetch
  const endpoint = `${deps.auth.apiUrl}/v1/cli/token`
  try {
    const res = await doFetch(endpoint, {
      method: "DELETE",
      headers: { authorization: `Bearer ${deps.auth.token}` },
    })
    // 401 is not a failure to revoke: it means the server already does not
    // recognize this token — unknown or already revoked — so it is unusable
    // either way. Anything else non-2xx (a 5xx during the outage this whole
    // function is guarding against, most likely) means the DELETE was
    // refused, and reporting that as revoked would be exactly the "stays
    // valid forever" bug this function exists to avoid.
    if (res.ok || res.status === 401) return { revoked: true }
    return {
      revoked: false,
      warning:
        `${endpoint} refused to revoke this machine's token (status ${res.status}) — ` +
        `signed out locally, but the token may still be valid server-side until revoked another way`,
    }
  } catch (err) {
    return {
      revoked: false,
      warning:
        `could not reach ${endpoint} to revoke this machine's token (${(err as Error).message}) — ` +
        `signed out locally, but the token stays valid server-side until it is revoked another way`,
    }
  }
}
