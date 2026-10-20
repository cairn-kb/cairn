import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { darwinSqlite, vec0, type NativeTarget } from "./assets"

export type VecStatus = { ok: true; version: string } | { ok: false; reason: string }

/** `reason` says why a compiled darwin binary is running without its own SQLite. */
export type SqliteRuntime = { sqliteVersion: () => string; custom: boolean; reason?: string }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)) || "unknown error"

/**
 * Copy an embedded file out to `<root>/lib/<sha256>/<name>`, where SQLite can
 * open it: neither dlopen nor loadExtension can read `/$bunfs/`. Named by its
 * content, so a new release lands beside the old one instead of over a library
 * another running cairn has mapped, and an existing copy is reused once its
 * size and hash match; anything else there (a crash's empty file, a changed
 * one) is written again. Written to a temp name and renamed, so a reader never
 * sees half a library.
 */
function extract(embedded: string, root: string, name: string): string {
  const bytes = readFileSync(embedded)
  const sha256 = (b: Uint8Array): string => new Bun.CryptoHasher("sha256").update(b).digest("hex")
  const hash = sha256(bytes)
  const dir = join(root, "lib", hash)
  const dest = join(dir, name)
  if (existsSync(dest) && statSync(dest).size === bytes.length && sha256(readFileSync(dest)) === hash) return dest
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.${process.pid}-${crypto.randomUUID()}`)
  try {
    writeFileSync(temp, bytes, { mode: 0o755 })
    renameSync(temp, dest)
  } catch (e) {
    try {
      unlinkSync(temp)
    } catch {
      // Never written, or already gone.
    }
    throw e
  }
  return dest
}

function target(): NativeTarget | null {
  const t = `${process.platform}-${process.arch}`
  return t in vec0 ? (t as NativeTarget) : null
}

const sqliteVersion = (): string => {
  const db = new Database(":memory:")
  try {
    return (db.query("SELECT sqlite_version() AS v").get() as { v: string }).v
  } finally {
    db.close()
  }
}

let prepared: SqliteRuntime | undefined

// Where bun:sqlite looks on darwin when nothing else is chosen.
const SYSTEM_SQLITE = "/usr/lib/libsqlite3.dylib"

/**
 * Point bun:sqlite at the SQLite this binary carries. Call it before the first
 * `new Database`: the library is chosen once per process, and choosing it
 * after one has opened throws.
 *
 * Only darwin needs it. There bun:sqlite gets Apple's SQLite, which refuses
 * loadExtension, so the binary carries its own. A source checkout uses the
 * same library once scripts/build-sqlite.sh has built it, so `bun run` and the
 * binary agree. Linux has Bun's own SQLite, which loads extensions. It never
 * throws: without its own library cairn still searches, it just cannot load
 * vec0.
 *
 * `embedded` is the library to use; tests pass one that will not load.
 */
export function prepareSqlite(root: string, embedded: string | null = darwinSqlite): SqliteRuntime {
  if (prepared) return prepared
  let custom = false
  let reason: string | undefined
  if (process.platform === "darwin" && embedded) {
    let path: string | undefined
    try {
      path = extract(embedded, root, "libsqlite3.dylib")
      Database.setCustomSQLite(path)
      custom = true
    } catch (e) {
      reason = message(e)
      // A library that fails to load stays chosen, and every later
      // `new Database` throws the same error. Choosing the system one again
      // undoes that, so cairn runs on Apple's SQLite instead of not at all.
      if (path !== undefined) {
        try {
          Database.setCustomSQLite(SYSTEM_SQLITE)
        } catch {
          // Keep the first reason; the next `new Database` reports its own.
        }
      }
    }
  }
  prepared = { sqliteVersion, custom, ...(reason ? { reason } : {}) }
  return prepared
}

/** Load sqlite-vec into `db`. Never throws: a target without it uses the scan. */
export function loadVec(db: Database, root: string): VecStatus {
  const t = target()
  const embedded = t ? vec0[t] : null
  if (!embedded) return { ok: false, reason: `no sqlite-vec build for ${process.platform}-${process.arch}` }
  try {
    // The name matters: SQLite derives the entry point from it, and vec0 gives
    // sqlite3_vec_init. The embedded copy's name carries a hash suffix.
    db.loadExtension(extract(embedded, root, process.platform === "darwin" ? "vec0.dylib" : "vec0.so"))
    const { v } = db.query("SELECT vec_version() AS v").get() as { v: string }
    return { ok: true, version: v }
  } catch (e) {
    return { ok: false, reason: message(e) }
  }
}

const SELFTEST_DIMS = 1024

function vector(...entries: [number, number][]): Uint8Array {
  const v = new Float32Array(SELFTEST_DIMS)
  for (const [i, x] of entries) v[i] = x
  return new Uint8Array(v.buffer)
}

function nearestTwo(db: Database): void {
  db.run(`CREATE VIRTUAL TABLE selftest_vec USING vec0(e float[${SELFTEST_DIMS}])`)
  const insert = db.prepare("INSERT INTO selftest_vec(rowid, e) VALUES (?, ?)")
  insert.run(1, vector([0, 1]))
  insert.run(2, vector([1, 1]))
  insert.run(3, vector([0, 0.9], [1, 0.1]))
  const got = (
    db.query("SELECT rowid FROM selftest_vec WHERE e MATCH ? AND k = 2 ORDER BY distance").all(vector([0, 1])) as {
      rowid: number
    }[]
  ).map((r) => r.rowid)
  if (got.join() !== "1,3") throw new Error(`nearest two were [${got.join(", ")}], expected [1, 3]`)
}

// A custom SQLite built without FTS5 would pass the vec0 check and break every
// search, so the self-test runs a ranked FTS5 query on the same connection.
function ftsBm25(db: Database): void {
  db.run("CREATE VIRTUAL TABLE selftest_fts USING fts5(x)")
  db.run("INSERT INTO selftest_fts(rowid, x) VALUES (1, 'a c'), (2, 'b c')")
  const got = (db.query(`SELECT rowid FROM selftest_fts WHERE selftest_fts MATCH '"b"' ORDER BY bm25(selftest_fts)`).all() as {
    rowid: number
  }[]).map((r) => r.rowid)
  if (got.join() !== "2") throw new Error(`MATCH "b" returned [${got.join(", ")}], expected [2]`)
}

/**
 * `cairn __selftest vec`, run by CI against each compiled release target. It
 * fails only when SQLite will not open or FTS5 is broken, since either breaks
 * search; a target where vec0 will not load still passes, and uses the scan.
 */
export async function runSelftestVec(
  root: string,
  steps: { fts?: (db: Database) => void } = {},
): Promise<{ lines: string[]; exitCode: 0 | 1 }> {
  const lines: string[] = []
  let db: Database
  try {
    const runtime = prepareSqlite(root)
    db = new Database(":memory:")
    const { v } = db.query("SELECT sqlite_version() AS v").get() as { v: string }
    const kind = runtime.custom ? "custom" : runtime.reason ? `bundled; custom unavailable: ${runtime.reason}` : "bundled"
    lines.push(`sqlite ${v} (${kind})`)
  } catch (e) {
    lines.push(`FAIL sqlite: ${message(e)}`)
    return { lines, exitCode: 1 }
  }
  try {
    const vec = loadVec(db, root)
    if (!vec.ok) {
      lines.push(`vec unavailable: ${vec.reason}`)
    } else {
      lines.push(`vec ${vec.version}`)
      try {
        nearestTwo(db)
        lines.push("vec0 nearest-two ok")
      } catch (e) {
        lines.push(`vec unavailable: ${message(e)}`)
      }
    }
    try {
      ;(steps.fts ?? ftsBm25)(db)
      lines.push("fts5 bm25 ok")
    } catch (e) {
      lines.push(`FAIL fts5: ${message(e)}`)
      return { lines, exitCode: 1 }
    }
    return { lines, exitCode: 0 }
  } finally {
    db.close()
  }
}
