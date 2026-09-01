import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"

const fixture = resolve("fixtures/inventory-app")

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // The process may need a moment to bind its port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(`fixture did not start at ${url}`)
}

async function runServer(root: string, port: number): Promise<{ stop: () => void }> {
  const child = spawn("python3", ["server.py"], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: "ignore" })
  await waitForServer(`http://127.0.0.1:${port}/api/items?page=1`)
  return { stop: () => child.kill() }
}

test("fixture serves the repaired pagination behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "issuepatch-fixture-"))
  await writeFile(join(root, "server.py"), await readFile(join(fixture, "server.py")))
  const server = await runServer(root, 31991)
  try {
    const baseline = await fetch("http://127.0.0.1:31991/api/items?page=2").then((response) => response.json()) as { items: string[] }
    assert.equal(baseline.items[0], "Item 6")
  } finally {
    server.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("fixture passes the same acceptance condition after the minimal patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "issuepatch-fixture-"))
  const source = await readFile(join(fixture, "server.py"), "utf8")
  await writeFile(join(root, "server.py"), source.replace("start = 0", "start = (page - 1) * PAGE_SIZE"))
  const server = await runServer(root, 31992)
  try {
    const fixed = await fetch("http://127.0.0.1:31992/api/items?page=2").then((response) => response.json()) as { items: string[] }
    assert.equal(fixed.items[0], "Item 6")
  } finally {
    server.stop()
    await rm(root, { recursive: true, force: true })
  }
})
