import { expect, test } from "bun:test"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

test("MCP SDK constructs a server under Bun", () => {
  const server = new McpServer({ name: "cairn", version: "0.1.0" })
  expect(server).toBeDefined()
})

test("bun:sqlite is available with FTS5", () => {
  const { Database } = require("bun:sqlite")
  const db = new Database(":memory:")
  db.run("CREATE VIRTUAL TABLE t USING fts5(body)")
  db.run("INSERT INTO t(body) VALUES ('hello world')")
  const rows = db.query("SELECT body FROM t WHERE t MATCH 'hello'").all()
  expect(rows.length).toBe(1)
})
