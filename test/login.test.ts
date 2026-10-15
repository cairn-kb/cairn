import { expect, test } from "bun:test"
import { pkcePair, runLogin, runLogout } from "../src/login"

test("the challenge is the S256 hash of the verifier, not the verifier", async () => {
  const { verifier, challenge } = await pkcePair()
  expect(challenge).not.toBe(verifier)
  expect(challenge).not.toContain("=")
  expect(challenge).not.toContain("+")
})

test("the challenge matches the base64url(SHA-256(verifier)) the server computes", async () => {
  // This is the exact derivation the hosted service uses:
  // digest the verifier's UTF-8 bytes with SHA-256, then base64url-encode
  // (unpadded, +/ swapped to -_). Reimplemented here from first principles
  // rather than compared against pkcePair's own base64url helper, so this
  // test would catch a shared bug in that helper too.
  const { verifier, challenge } = await pkcePair()
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  expect(challenge).toBe(expected)
})

test("login exchanges the code and returns the auth block", async () => {
  let opened = ""
  const auth = await runLogin({
    apiUrl: "https://api.test",
    machineName: "laptop",
    openBrowser: async (url) => {
      opened = url
      // Simulate the browser hitting the local callback.
      const u = new URL(url)
      const port = u.searchParams.get("port")!
      const state = u.searchParams.get("state")!
      await fetch(`http://127.0.0.1:${port}/callback?code=THE_CODE&state=${state}`)
    },
    fetchImpl: (async (input: string, init?: { body?: string }) => {
      const url = String(input)
      if (url.endsWith("/v1/cli/exchange")) {
        const body = JSON.parse(String(init!.body)) as { code: string; verifier: string }
        expect(body.code).toBe("THE_CODE")
        expect(body.verifier).toBeTruthy()
        return new Response(
          JSON.stringify({ token: "tok", orgId: "o1", orgSlug: "acme", user: "alice" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected fetch to ${url}`)
    }) as unknown as typeof fetch,
  })
  expect(opened).toContain("/v1/cli/authorize")
  expect(opened).toContain("code_challenge_method=S256")
  expect(auth).toMatchObject({ token: "tok", orgId: "o1", orgSlug: "acme" })
  expect(auth.apiUrl).toBe("https://api.test")
})

// --- the wait for the browser is bounded and legible -----------------------
//
// A fresh laptop whose browser has never seen cairn used to print
// "opening your browser…" and then hang for ever, silently, with the browser
// on a 404. A command that waits with no output and no end is the same defect
// class as one that exits 0 having done nothing.

test("waiting for the browser says what a sign-in prompt means before it blocks", async () => {
  const printed: string[] = []
  await runLogin({
    apiUrl: "https://api.test",
    machineName: "laptop",
    print: (line) => printed.push(line),
    openBrowser: async (url) => {
      // Nothing is printed after this point until the code arrives, so
      // everything the operator needs must already be on screen.
      const u = new URL(url)
      await fetch(
        `http://127.0.0.1:${u.searchParams.get("port")}/callback?code=C&state=${u.searchParams.get("state")}`,
      )
    },
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ token: "tok", orgId: "o1", orgSlug: "acme", user: "r" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  })
  const text = printed.join("\n")
  expect(text).toMatch(/sign in/i)
  expect(text).toMatch(/approve/i)
  // And the way out, BEFORE the wait rather than after it. The browser on
  // another machine can never reach this loopback, so the timeout is the only
  // signal it failed — an operator who can already see that must not be made
  // to sit out the whole wait to learn there was a paste prompt coming.
  expect(text).toContain("address bar")
  expect(text).toContain("code=")
  // Since the prompt is already open, the copy must say the code
  // can go in NOW. It used to say to press Ctrl-C and re-run with
  // `--no-browser`, which became false the moment the prompt went live —
  // and a command that prints a false sentence about itself is worse than
  // one that prints nothing.
  expect(text).toMatch(/paste it at the prompt/i)
  expect(text).toMatch(/do not have to wait/i)
  expect(text).not.toContain("Ctrl-C")
})

test("the wait ends rather than hanging for ever, naming what to do next", async () => {
  const err = await runLogin({
    apiUrl: "https://api.test",
    machineName: "laptop",
    timeoutMs: 30,
    // The browser never comes back: the human closed the tab, or never had
    // a session and gave up at the GitHub page.
    openBrowser: async () => {},
    fetchImpl: (async () => {
      throw new Error("the exchange must never be reached")
    }) as unknown as typeof fetch,
  }).then(
    () => new Error("the wait must not have succeeded"),
    (e: Error) => e,
  )

  // What to do next, which is the half this test is named for.
  expect(err.message).toMatch(/cairn login/)

  // And that the wait was bounded by `timeoutMs` -- asserted by WHICH error
  // arrives rather than by the clock.
  //
  // This message is reachable only from the `timeout` promise: `openBrowser`
  // never comes back so `codePromise` never settles, and `fetchImpl` throws if
  // the exchange is ever reached. Getting this string back is proof the timer
  // fired, which is what "the wait ends" means.
  //
  // It used to read `expect(Date.now() - started).toBeLessThan(5_000)`, which
  // measures wall-clock elapsed time and so fails whenever the MACHINE is
  // loaded rather than whenever the code is wrong. It did exactly that during
  // an earlier flaky round, on a run that took 271s against a normal 18.5s.
  //
  // If the wait ever stops being bounded, this test hangs and the runner fails
  // it. That backstop is why dropping the clock loses nothing: an unbounded
  // wait cannot pass either way. What is deliberately NOT asserted is how LONG
  // it waited -- 30ms versus 4 seconds is invisible from out here, and pinning
  // it needs a clock injected into `runLogin`, which is a change to src/ rather
  // than to this file.
  expect(err.message).toMatch(/gave up waiting for the browser/)
})

test("the timeout message names how long it waited, not a hardcoded five minutes", async () => {
  const err = await runLogin({
    apiUrl: "https://api.test",
    timeoutMs: 30,
    openBrowser: async () => {},
    fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
  }).then(
    () => new Error("the wait must not have succeeded"),
    (e: Error) => e,
  )
  expect(err.message).toMatch(/waiting/i)
  expect(err.message).not.toContain("5 minutes")
})

test("the default wait spans the human flow, not just the code's TTL", async () => {
  // 5 minutes was the server's code lifetime, which starts at APPROVAL. This
  // wait starts at `open` and has to cover finding the browser window, a
  // GitHub sign-in and a 2FA prompt on a phone that needs unlocking first.
  const printed: string[] = []
  await runLogin({
    apiUrl: "https://api.test",
    print: (line) => printed.push(line),
    openBrowser: async (url) => {
      const u = new URL(url)
      await fetch(
        `http://127.0.0.1:${u.searchParams.get("port")}/callback?code=C&state=${u.searchParams.get("state")}`,
      )
    },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ token: "tok", orgId: "o1", orgSlug: "acme", user: "r" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  })
  expect(printed.join("\n")).toContain("Waiting up to 15 minutes")
})

// --- a delivery that fails is recoverable, never thrown away ---------------
//
// By the time the loopback matters the server has already minted the token and
// burned nothing: the code stays valid for five minutes after approval, and
// the browser is sitting on `…/callback?code=…` whether or not anything
// answered it. Dying here threw away a login that had already happened.

test("a wait that runs out falls back to pasting the code by hand", async () => {
  let prompted = 0
  const printed: string[] = []
  const auth = await runLogin({
    apiUrl: "https://api.test",
    timeoutMs: 30,
    // The redirect never reaches the loopback — a slow human, or a browser on
    // another machine.
    openBrowser: async () => {},
    print: (line) => printed.push(line),
    promptCode: async () => {
      prompted += 1
      return "FROM_THE_ADDRESS_BAR"
    },
    fetchImpl: (async (_input: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init!.body)) as { code: string }
      expect(body.code).toBe("FROM_THE_ADDRESS_BAR")
      return new Response(
        JSON.stringify({ token: "tok", orgId: "o1", orgSlug: "acme", user: "r" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch,
  })
  expect(prompted).toBe(1)
  expect(auth.token).toBe("tok")
  // Where to find the code: the browser is showing a connection error whose
  // address bar holds it. Without that sentence the prompt is unanswerable.
  expect(printed.join("\n")).toContain("code=")
})

test("a callback that arrives for someone else's login still offers the paste", async () => {
  // A state mismatch means that response was not ours, not that ours failed —
  // and the exchange still needs the PKCE verifier only this process holds, so
  // reading a code off the screen is exactly as safe here as on --no-browser.
  const auth = await runLogin({
    apiUrl: "https://api.test",
    openBrowser: async (url) => {
      const port = new URL(url).searchParams.get("port")!
      await fetch(`http://127.0.0.1:${port}/callback?code=X&state=WRONG`)
    },
    promptCode: async () => "PASTED",
    fetchImpl: (async (_input: string, init?: { body?: string }) => {
      expect((JSON.parse(String(init!.body)) as { code: string }).code).toBe("PASTED")
      return new Response(
        JSON.stringify({ token: "tok", orgId: "o1", orgSlug: "acme", user: "r" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch,
  })
  expect(auth.token).toBe("tok")
})

test("a burned code is not retried through the paste prompt", async () => {
  // The fallback exists for an undelivered code, not a refused one: the
  // server burns a code on any attempt, so re-prompting after a failed
  // exchange would ask the operator for something that cannot work.
  //
  // Since the prompt is OPEN for the whole wait rather than offered
  // after it, so "was it prompted at all" no longer measures this: it is now
  // opened on every browser login and aborted when the callback wins. What
  // still has to hold — and what this test asserts instead — is that the
  // exchange happens exactly once, with the code the BROWSER delivered, and
  // that the prompt's answer is never reached for a second attempt.
  //
  // The prompt hangs until aborted, which is also what a real one does: a
  // human who has not typed anything yet.
  let attempts = 0
  const exchanged: string[] = []
  let aborted = false
  await expect(
    runLogin({
      apiUrl: "https://api.test",
      openBrowser: async (url) => {
        const u = new URL(url)
        await fetch(
          `http://127.0.0.1:${u.searchParams.get("port")}/callback?code=BURNED&state=${u.searchParams.get("state")}`,
        )
      },
      promptCode: (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("the paste prompt was superseded"))
          })
        }),
      fetchImpl: (async (_input: string, init?: { body?: string }) => {
        attempts += 1
        exchanged.push((JSON.parse(String(init!.body)) as { code: string }).code)
        return new Response(JSON.stringify({ code: "invalid_code" }), { status: 400 })
      }) as unknown as typeof fetch,
    }),
  ).rejects.toThrow()
  expect(attempts).toBe(1)
  // The browser's code, not a pasted one — a refused exchange is not retried.
  expect(exchanged).toEqual(["BURNED"])
  // And the prompt was closed rather than left holding the terminal.
  expect(aborted).toBe(true)
})

test("a callback with the wrong state is refused", async () => {
  await expect(
    runLogin({
      apiUrl: "https://api.test",
      machineName: "laptop",
      openBrowser: async (url) => {
        const port = new URL(url).searchParams.get("port")!
        await fetch(`http://127.0.0.1:${port}/callback?code=X&state=WRONG`)
      },
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    }),
  ).rejects.toThrow(/state/i)
})

test("a failed exchange is not retried — one attempt, then the caller starts over", async () => {
  let attempts = 0
  await expect(
    runLogin({
      apiUrl: "https://api.test",
      machineName: "laptop",
      openBrowser: async (url) => {
        const u = new URL(url)
        const port = u.searchParams.get("port")!
        const state = u.searchParams.get("state")!
        await fetch(`http://127.0.0.1:${port}/callback?code=BURNED&state=${state}`)
      },
      fetchImpl: (async () => {
        attempts += 1
        return new Response(JSON.stringify({ code: "invalid_code" }), { status: 400 })
      }) as unknown as typeof fetch,
    }),
  ).rejects.toThrow()
  expect(attempts).toBe(1)
})

test("--no-browser prints the URL and accepts a pasted code", async () => {
  let printed = ""
  const auth = await runLogin({
    apiUrl: "https://api.test",
    machineName: "server",
    noBrowser: true,
    print: (line) => {
      printed += line
    },
    promptCode: async () => "PASTED_CODE",
    fetchImpl: (async (_input: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init!.body)) as { code: string }
      expect(body.code).toBe("PASTED_CODE")
      return new Response(
        JSON.stringify({ token: "tok", orgId: "o1", orgSlug: "acme", user: "r" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch,
    openBrowser: async () => {
      throw new Error("must not open a browser when --no-browser is set")
    },
  })
  expect(printed).toContain("/v1/cli/authorize")
  // The port param is OMITTED, not sent as "0": a port that does not exist is
  // not the same thing as port zero, and the server branches on
  // exactly this — an absent port means "show the code on the page", while a
  // present-but-junk one (0 included) is still a rejected request.
  expect(printed).not.toContain("port=")
  expect(auth.token).toBe("tok")
})

test("--no-browser without a promptCode is a programming error, named plainly", async () => {
  await expect(
    runLogin({
      apiUrl: "https://api.test",
      noBrowser: true,
      openBrowser: async () => {},
    }),
  ).rejects.toThrow(/promptCode/)
})

test("logout revokes the token server-side", async () => {
  const called: { url: string; auth: string | null }[] = []
  const result = await runLogout({
    auth: { token: "tok", orgId: "o1", orgSlug: "acme", apiUrl: "https://api.test", user: null },
    fetchImpl: (async (input: string, init?: { headers?: Record<string, string> }) => {
      called.push({ url: String(input), auth: init?.headers?.authorization ?? null })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch,
  })
  expect(called).toEqual([{ url: "https://api.test/v1/cli/token", auth: "Bearer tok" }])
  expect(result.revoked).toBe(true)
})

test("logout clears locally and warns, rather than throwing, when the network is down", async () => {
  const result = await runLogout({
    auth: { token: "tok", orgId: "o1", orgSlug: "acme", apiUrl: "https://api.test", user: null },
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch,
  })
  expect(result.revoked).toBe(false)
  expect(result.warning).toMatch(/\/v1\/cli\/token/)
  expect(result.warning).toMatch(/ECONNREFUSED/)
})

test("a 500 during an outage is a warning, not a false success", async () => {
  // Reaching the server is not the same as the server actually revoking the
  // token: a 5xx means the DELETE was refused, and reporting `revoked: true`
  // here would be exactly the "lost laptop stays valid forever" bug this
  // whole function exists to avoid.
  const result = await runLogout({
    auth: { token: "tok", orgId: "o1", orgSlug: "acme", apiUrl: "https://api.test", user: null },
    fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
  })
  expect(result.revoked).toBe(false)
  expect(result.warning).toMatch(/\/v1\/cli\/token/)
  expect(result.warning).toMatch(/500/)
})

test("a 401 is treated as already revoked — the server does not know this token either way", async () => {
  const result = await runLogout({
    auth: { token: "tok", orgId: "o1", orgSlug: "acme", apiUrl: "https://api.test", user: null },
    fetchImpl: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
  })
  expect(result.revoked).toBe(true)
  expect(result.warning).toBeUndefined()
})

test("the browser gets a real page back, not a closed connection", async () => {
  // Every other test in this file fetches the callback INSIDE openBrowser, so
  // runLogin is still blocked on `await deps.openBrowser(...)` and the server
  // is trivially still up. The real `open` returns as soon as it has spawned
  // the browser, and the callback arrives later — while runLogin is already
  // waiting and about to tear the server down. That ordering is the one a
  // browser actually produces, and it is the one that shipped broken: the
  // operator's tab showed a connection error on a login that had in fact
  // succeeded.
  let delivered: Promise<{ status: number; body: string }> | null = null

  await runLogin({
    apiUrl: "https://api.test",
    machineName: "laptop",
    openBrowser: async (url) => {
      const u = new URL(url)
      const target =
        `http://127.0.0.1:${u.searchParams.get("port")}/callback` +
        `?code=THE_CODE&state=${u.searchParams.get("state")}`
      // Deliberately not awaited here: hand control back the way `open` does.
      delivered = fetch(target).then(async (r) => ({ status: r.status, body: await r.text() }))
    },
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ token: "tok", orgId: "o1", orgSlug: "acme", user: "alice" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  })

  const res = await delivered!
  expect(res.status).toBe(200)
  expect(res.body).toContain("close this tab")
})

test("an org, when asked for, travels in the authorize URL", async () => {
  let opened = ""
  await runLogin({
    apiUrl: "https://api.test",
    machineName: "laptop",
    org: "acme",
    openBrowser: async (url) => {
      opened = url
      const u = new URL(url)
      await fetch(
        `http://127.0.0.1:${u.searchParams.get("port")}/callback?code=C&state=${u.searchParams.get("state")}`,
      )
    },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ token: "t", orgId: "o2", orgSlug: "acme", user: "bob" }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  })
  expect(new URL(opened).searchParams.get("org")).toBe("acme")
})

// The paste prompt used to be reachable only AFTER the wait
// expired, so an operator whose browser is on another machine — the case the
// fallback exists for, where the loopback is unreachable in principle — had
// to sit out fifteen minutes or Ctrl-C and start again with `--no-browser`.
// These three pin the race that replaced it.

test("a pasted code is accepted during the wait, without waiting it out", async () => {
  // `timeoutMs` is ten minutes. If the paste is not raced against the
  // callback, this test does not fail — it HANGS, and the runner fails it.
  // That is the same backstop the bounded-wait test above relies on, and it
  // is deliberately not a clock assertion: wall-clock measurements fail when
  // the machine is loaded rather than when the code is wrong.
  const auth = await runLogin({
    apiUrl: "https://api.test",
    timeoutMs: 600_000,
    // The redirect never arrives — the browser is on another machine.
    openBrowser: async () => {},
    promptCode: async () => "FROM_THE_ADDRESS_BAR",
    fetchImpl: (async (_input: string, init?: { body?: string }) => {
      expect((JSON.parse(String(init!.body)) as { code: string }).code).toBe(
        "FROM_THE_ADDRESS_BAR",
      )
      return new Response(
        JSON.stringify({ token: "tok", orgId: "o1", orgSlug: "acme", user: "r" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch,
  })
  expect(auth.token).toBe("tok")
})

test("a callback that arrives first aborts the prompt and wins", async () => {
  // The other half of the race, and the half that decides whether a normal
  // login leaves a dead prompt holding the terminal. The prompt never
  // resolves on its own; only the abort ends it.
  let aborted = false
  const auth = await runLogin({
    apiUrl: "https://api.test",
    timeoutMs: 600_000,
    openBrowser: async (url) => {
      const u = new URL(url)
      await fetch(
        `http://127.0.0.1:${u.searchParams.get("port")}/callback?code=FROM_BROWSER&state=${u.searchParams.get("state")}`,
      )
    },
    promptCode: (signal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("the paste prompt was superseded"))
        })
      }),
    fetchImpl: (async (_input: string, init?: { body?: string }) => {
      expect((JSON.parse(String(init!.body)) as { code: string }).code).toBe("FROM_BROWSER")
      return new Response(
        JSON.stringify({ token: "tok", orgId: "o1", orgSlug: "acme", user: "r" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch,
  })
  expect(auth.token).toBe("tok")
  // Without this the login still succeeds and the terminal is left with a
  // prompt nothing will ever answer, drawing over whatever prints next.
  expect(aborted).toBe(true)
})

test("cancelling the prompt ends the login rather than re-asking", async () => {
  // Ctrl-C at the prompt is the operator saying stop. Before this change the
  // prompt was the last thing offered, so cancelling it could only end the
  // login; now it is open from the start, and the risk is the opposite —
  // that a cancel is treated as one failed path among several and the
  // command carries on waiting.
  let prompts = 0
  const err = await runLogin({
    apiUrl: "https://api.test",
    timeoutMs: 600_000,
    openBrowser: async () => {},
    promptCode: async () => {
      prompts += 1
      throw new Error("login cancelled")
    },
    fetchImpl: (async () => {
      throw new Error("the exchange must never be reached")
    }) as unknown as typeof fetch,
  }).then(
    () => new Error("cancelling must not have succeeded"),
    (e: Error) => e,
  )
  expect(err.message).toMatch(/login cancelled/)
  expect(err.message).toMatch(/cairn login/)
  expect(prompts).toBe(1)
})
