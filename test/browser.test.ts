import { expect, test } from "bun:test"
import { openInBrowser } from "../src/browser"

test("darwin opens with `open`", async () => {
  let spawned: string[] | null = null
  await openInBrowser("https://example.test", {
    platform: "darwin",
    spawn: (cmd) => {
      spawned = cmd
      return { exited: Promise.resolve(0) }
    },
  })
  // Cast needed: TS's control-flow narrowing does not see the assignment
  // inside the `spawn` closure and keeps `spawned` typed as its initializer
  // (`null`) at this point, even though it has genuinely been reassigned.
  expect(spawned as string[] | null).toEqual(["open", "https://example.test"])
})

test("linux opens with `xdg-open`", async () => {
  let spawned: string[] | null = null
  await openInBrowser("https://example.test", {
    platform: "linux",
    spawn: (cmd) => {
      spawned = cmd
      return { exited: Promise.resolve(0) }
    },
  })
  expect(spawned as string[] | null).toEqual(["xdg-open", "https://example.test"])
})

test("win32 opens through the shell's `start`", async () => {
  let spawned: string[] | null = null
  await openInBrowser("https://example.test", {
    platform: "win32",
    spawn: (cmd) => {
      spawned = cmd
      return { exited: Promise.resolve(0) }
    },
  })
  expect(spawned as string[] | null).toEqual(["cmd", "/c", "start", "", "https://example.test"])
})

test("a spawn that throws falls back to printing the URL rather than rejecting", async () => {
  let printed = ""
  await expect(
    openInBrowser("https://example.test", {
      platform: "darwin",
      spawn: () => {
        throw new Error("ENOENT")
      },
      print: (line) => {
        printed += line + "\n"
      },
    }),
  ).resolves.toBeUndefined()
  expect(printed).toContain("https://example.test")
  expect(printed).toContain("ENOENT")
})

test("a process that exits non-zero also falls back to printing the URL", async () => {
  let printed = ""
  await openInBrowser("https://example.test", {
    platform: "linux",
    spawn: () => ({ exited: Promise.resolve(1) }),
    print: (line) => {
      printed += line + "\n"
    },
  })
  expect(printed).toContain("https://example.test")
})

test("with no print dep, a failure still resolves rather than rejecting — never fatal", async () => {
  // The default print falls back to console.error rather than a no-op: a
  // browser that would not open is diagnostic information the operator still
  // needs, just not on stdout (which `cairn mcp` shares with the protocol).
  // Stubbed so the test suite's own output stays clean.
  const original = console.error
  const logged: string[] = []
  console.error = (m: string) => logged.push(String(m))
  try {
    await expect(
      openInBrowser("https://example.test", {
        platform: "darwin",
        spawn: () => {
          throw new Error("nope")
        },
      }),
    ).resolves.toBeUndefined()
  } finally {
    console.error = original
  }
  expect(logged.join(" ")).toContain("https://example.test")
})
