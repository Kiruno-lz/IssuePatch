import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"
import { loadConfig } from "./config.js"
import { GitHubClient } from "./github.js"
import { IssueMonitor, JsonStateStore } from "./monitor.js"
import { AnthropicTriageModel, LlmTriageClassifier } from "./triage.js"
import { IssueWorkflow } from "./workflow.js"
import { SolariRepairExecutor } from "./solari-executor.js"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Message = Record<string, unknown>
type ToolCall = { id: string; name: string; input: Record<string, unknown> }
type Page = any
type Browser = any
type Sandbox = any

const PORT = 3000
const REPO_ROOT = "/tmp/issuepatch-repo"
const here = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(here, "../fixtures/inventory-app")
const issuePath = resolve(here, "../fixtures/inventory-pagination-issue.md")

const requiredEnv = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}. Copy .env.example and set it before running.`)
  return value
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

class Recorder {
  readonly runId = new Date().toISOString().replace(/[:.]/g, "-")
  readonly dir = resolve(here, "..", "artifacts", this.runId)
  readonly trace: Record<string, Json>[] = []

  async init(issue: string) {
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, "issue.md"), issue)
  }

  async event(kind: string, data: Record<string, Json>) {
    this.trace.push({ at: new Date().toISOString(), kind, ...data })
    await writeFile(join(this.dir, "action-trace.jsonl"), this.trace.map((e) => JSON.stringify(e)).join("\n") + "\n")
  }

  async screenshot(name: string, bytes: Uint8Array) {
    await writeFile(join(this.dir, name), bytes)
  }

  async text(name: string, value: string) {
    await writeFile(join(this.dir, name), value)
  }
}

function safeRepoPath(input: string): string {
  const candidate = posix.normalize(input.startsWith("/") ? input : `${REPO_ROOT}/${input}`)
  if (candidate !== REPO_ROOT && !candidate.startsWith(`${REPO_ROOT}/`)) {
    throw new Error(`Path escapes the fixture repository: ${input}`)
  }
  return candidate
}

class SandboxHost {
  private serverHandle: any

  constructor(readonly sandbox: Sandbox, readonly recorder: Recorder) {}

  async writeFixture() {
    const files = ["server.py", "index.html"]
    for (const file of files) {
      const content = await readFile(join(fixtureRoot, file), "utf8")
      await this.sandbox.files.write(`${REPO_ROOT}/${file}`, content)
    }
    await this.sandbox.files.write(`${REPO_ROOT}/ISSUE.md`, await readFile(issuePath, "utf8"))
    await this.run("git", ["init", "-q", REPO_ROOT])
    await this.run("git", ["-C", REPO_ROOT, "config", "user.email", "issuepatch@example.invalid"])
    await this.run("git", ["-C", REPO_ROOT, "config", "user.name", "IssuePatch"])
    await this.run("git", ["-C", REPO_ROOT, "add", "."])
    await this.run("git", ["-C", REPO_ROOT, "commit", "-qm", "baseline fixture"])
  }

  async run(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const allowed = new Set(["git", "python3", "grep", "find", "sh"])
    if (!allowed.has(command)) throw new Error(`Command is not allow-listed: ${command}`)
    const joined = [command, ...args].join(" ").toLowerCase()
    if (/\b(rm|rmdir|shutdown|reboot|mkfs|kill|pkill)\b|:\s*>/.test(joined)) {
      throw new Error("Potentially destructive command rejected")
    }
    const result = await this.sandbox.commands.run(command, { args, ...(cwd ? { cwd } : {}) })
    await this.recorder.event("sandbox.command", {
      command,
      args: JSON.stringify(args),
      exitCode: result.exitCode,
    })
    return result
  }

  async startServer() {
    this.serverHandle = await this.sandbox.commands.start("python3", { args: ["server.py"], cwd: REPO_ROOT })
    await this.recorder.event("sandbox.server.started", { cwd: REPO_ROOT, port: PORT })
    const { url } = await this.sandbox.previewUrl(PORT)
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        const response = await fetch(url)
        if (response.ok) return url
      } catch {
        // The preview URL can be ready before the process has bound the port.
      }
      await sleep(500)
    }
    throw new Error(`Fixture did not become reachable at ${url}`)
  }

  async restartServer() {
    if (this.serverHandle) await this.serverHandle.kill()
    await sleep(250)
    return await this.startServer()
  }

  async stopServer() {
    if (this.serverHandle) {
      await this.serverHandle.kill().catch(() => undefined)
      this.serverHandle = undefined
    }
  }

  async listFiles(path = REPO_ROOT) {
    return await this.sandbox.files.list(safeRepoPath(path))
  }

  async readFile(path: string) {
    return await this.sandbox.files.readText(safeRepoPath(path))
  }

  async writeFile(path: string, content: string) {
    const target = safeRepoPath(path)
    await this.sandbox.files.write(target, content)
    await this.recorder.event("sandbox.write", { path: target, bytes: content.length })
    return { path: target, bytes: content.length }
  }

  async diff() {
    const result = await this.run("git", ["-C", REPO_ROOT, "diff", "--no-ext-diff"])
    return result.stdout
  }
}

class BrowserHost {
  constructor(readonly browser: Browser, readonly page: Page, readonly recorder: Recorder) {}

  async snapshot() {
    const text = await this.page.locator("body").innerText()
    const result = { url: this.page.url(), text: text.slice(0, 6000) }
    await this.recorder.event("browser.snapshot", result)
    return result
  }

  async click(selector: string) {
    await this.page.locator(selector).click()
    await sleep(150)
    await this.recorder.event("browser.click", { selector })
    return await this.snapshot()
  }

  async assert(selector: string, expected?: string) {
    const locator = this.page.locator(selector)
    const count = await locator.count()
    const text = count ? await locator.first().innerText() : ""
    const passed = count > 0 && (expected === undefined || text.includes(expected))
    const result = { selector, expected: expected ?? null, count, text, passed }
    await this.recorder.event("browser.assert", result)
    return result
  }
}

const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the isolated fixture repository.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file in the isolated fixture repository.",
      parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search the fixture source for a literal or regular expression.",
      parameters: { type: "object", required: ["pattern"], properties: { pattern: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run an allow-listed diagnostic command in the isolated sandbox.",
      parameters: {
        type: "object",
        required: ["command", "args"],
        properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description: "Read the current visible text from the real browser preview.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click a CSS selector in the real browser preview.",
      parameters: { type: "object", required: ["selector"], properties: { selector: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_assert",
      description: "Assert that a selector exists and optionally contains text.",
      parameters: {
        type: "object",
        required: ["selector"],
        properties: { selector: { type: "string" }, expected: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Replace a text file below the isolated fixture repository root.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Stop after the issue has been reproduced and repaired.",
      parameters: { type: "object", required: ["summary"], properties: { summary: { type: "string" } } },
    },
  },
]

const systemPrompt = [
  "You are IssuePatch, a careful software repair agent.",
  `The isolated repository is ${REPO_ROOT}. A real browser is already open on the running app.`,
  "First inspect the files and reproduce the issue through the browser. Then make the smallest correct code change.",
  "Run a syntax/test check and use the browser again after your edit. Do not claim success from your own prose: the host runs an independent verifier.",
  "Never write outside the repository root. Do not use destructive commands. Finish only after the browser shows the expected state.",
].join("\n")

const anthropicTools = toolDefinitions.map((tool) => ({
  name: tool.function.name,
  description: tool.function.description,
  input_schema: tool.function.parameters,
}))

async function callModel(messages: Message[]): Promise<{ message: Message; toolCalls: ToolCall[] }> {
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.deepseek.com/anthropic").replace(/\/$/, "")
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": requiredEnv("LLM_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL ?? "deepseek-v4-flash",
      system: systemPrompt,
      messages,
      max_tokens: 4000,
      tools: anthropicTools,
      tool_choice: "auto",
      temperature: 0.1,
      thinking: { type: "disabled" },
    }),
  })
  if (!response.ok) throw new Error(`LLM request failed (${response.status}): ${(await response.text()).slice(0, 500)}`)
  const payload = (await response.json()) as {
    content?: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string }>
  }
  if (!payload.content) throw new Error("LLM response did not contain content")
  const message: Message = { role: "assistant", content: payload.content }
  const toolCalls = payload.content
    .filter((block) => block.type === "tool_use" && block.id && block.name)
    .map((block) => ({ id: block.id!, name: block.name!, input: block.input ?? {} }))
  return { message, toolCalls }
}

async function executeTool(name: string, rawArgs: string, host: SandboxHost, browser: BrowserHost) {
  const args = JSON.parse(rawArgs || "{}") as Record<string, any>
  switch (name) {
    case "list_files":
      return await host.listFiles(args.path)
    case "read_file":
      return await host.readFile(args.path)
    case "search_code": {
      const result = await host.run("grep", ["-RIn", "--exclude-dir=.git", args.pattern, REPO_ROOT])
      return { ...result, stdout: result.stdout.slice(0, 6000), stderr: result.stderr.slice(0, 2000) }
    }
    case "run_command": {
      const result = await host.run(args.command, args.args ?? [], REPO_ROOT)
      return { ...result, stdout: result.stdout.slice(0, 6000), stderr: result.stderr.slice(0, 2000) }
    }
    case "browser_snapshot":
      return await browser.snapshot()
    case "browser_click":
      return await browser.click(args.selector)
    case "browser_assert":
      return await browser.assert(args.selector, args.expected)
    case "write_file":
      return await host.writeFile(args.path, args.content)
    case "finish":
      return { accepted: true, summary: args.summary }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

async function runAgent(issue: string, host: SandboxHost, browser: BrowserHost) {
  const messages: Message[] = [{ role: "user", content: `Issue report:\n\n${issue}` }]

  for (let step = 1; step <= 16; step += 1) {
    const response = await callModel(messages)
    messages.push(response.message)
    await host.recorder.event("agent.response", { step, toolCalls: response.toolCalls.length })
    if (!response.toolCalls.length) break
    let finished = false
    for (const toolCall of response.toolCalls) {
      let result: unknown
      try {
        result = await executeTool(toolCall.name, JSON.stringify(toolCall.input), host, browser)
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) }
      }
      await host.recorder.event("agent.tool", { step, name: toolCall.name, result: JSON.stringify(result).slice(0, 2000) })
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolCall.id, content: JSON.stringify(result) }],
      })
      if (toolCall.name === "finish") finished = true
    }
    if (finished) break
  }
}

async function verify(page: Page, baseUrl: string, recorder: Recorder) {
  const readFirstItem = async (expected?: string) => {
    let firstItem = ""
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await page.locator('[data-testid="item"]').count()) {
        firstItem = await page.locator('[data-testid="item"]').first().innerText()
        if (!expected || firstItem === expected) break
      }
      await sleep(200)
    }
    return firstItem
  }

  await page.goto(baseUrl)
  await page.locator('[data-testid="page-status"]').innerText()
  const before = {
    status: await page.locator('[data-testid="page-status"]').innerText(),
    firstItem: await readFirstItem("Item 1"),
  }
  await page.locator("#next").click()
  const nextFirstItem = await readFirstItem("Item 6")
  const afterNext = {
    status: await page.locator('[data-testid="page-status"]').innerText(),
    firstItem: nextFirstItem,
    itemCount: await page.locator('[data-testid="item"]').count(),
  }
  await page.locator("#previous").click()
  const previousFirstItem = await readFirstItem("Item 1")
  const afterPrevious = {
    status: await page.locator('[data-testid="page-status"]').innerText(),
    firstItem: previousFirstItem,
  }
  const passed = before.firstItem === "Item 1" && afterNext.firstItem === "Item 6" && afterNext.status === "Page 2 of 2" && afterNext.itemCount === 5 && afterPrevious.firstItem === "Item 1"
  const proof = { passed, baseUrl, before, afterNext, afterPrevious, checkedAt: new Date().toISOString() }
  await recorder.event("independent.verifier", proof)
  return proof
}

async function runFixture() {
  requiredEnv("SOLARI_API_KEY")
  const issue = await readFile(issuePath, "utf8")
  const recorder = new Recorder()
  await recorder.init(issue)
  const client = new SolariClient({ apiKey: process.env.SOLARI_API_KEY! })
  const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY! })
  const sandbox = await client.sandboxes.create({ template: "base", timeoutMs: 5 * 60_000 })
  let browser: Browser | undefined
  try {
    await sandbox.connect()
    const host = new SandboxHost(sandbox, recorder)
    await host.writeFixture()
    const previewUrl = await host.startServer()
    await recorder.text("preview-url.txt", `${previewUrl}\n`)

    browser = await solari.launch({ recording: true })
    const sessionId = browser.id
    const page = await browser.newPage()
    const browserHost = new BrowserHost(browser, page, recorder)
    await page.goto(previewUrl)
    await page.locator("body").innerText()
    await recorder.screenshot("before.png", await page.screenshot({ fullPage: true }))
    await recorder.event("run.started", { previewUrl, sessionId })
    const baseline = await verify(page, previewUrl, recorder)
    await recorder.text("baseline.json", JSON.stringify(baseline, null, 2) + "\n")

    await runAgent(issue, host, browserHost)
    // The first browser session intentionally observed the pre-patch process.
    // Restarting the isolated app makes the verifier exercise the edited source.
    const verifiedPreviewUrl = await host.restartServer()
    const proof = await verify(page, verifiedPreviewUrl, recorder)
    await recorder.screenshot("after.png", await page.screenshot({ fullPage: true }))
    const diff = await host.diff()
    await recorder.text("patch.diff", diff)

    let replayUrl = ""
    if (sessionId) {
      await browser.close()
      browser = undefined
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          replayUrl = (await solari.sessions.getReplayUrl(sessionId)).url
          break
        } catch {
          await sleep(1000)
        }
      }
    }
    if (replayUrl) await recorder.text("replay-url.txt", `${replayUrl}\n`)
    const report = [
      `# IssuePatch run ${recorder.runId}`,
      "",
      proof.passed ? "**PASS** — the independent verifier observed the repaired behavior." : "**FAIL** — the independent verifier did not observe the expected behavior.",
      "",
      `- Preview: ${previewUrl}`,
      `- Changed lines: ${diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++" )).length}`,
      replayUrl ? `- Replay: ${replayUrl}` : "- Replay: unavailable (recording may still be uploading)",
      "",
      "The model's final response is not used as proof; proof.json is produced from a fresh browser run by the host verifier.",
    ].join("\n")
    await recorder.text("proof.json", JSON.stringify({ baseline, ...proof, replayUrl, diff }, null, 2) + "\n")
    await recorder.text("report.md", report + "\n")
    console.log(JSON.stringify({ status: proof.passed ? "passed" : "failed", artifacts: recorder.dir, previewUrl, replayUrl }, null, 2))
    if (!proof.passed) process.exitCode = 1
  } finally {
    if (browser) await browser.close().catch(() => undefined)
    await solari.close().catch(() => undefined)
    // The process handle is best-effort; killing the sandbox below is the final guard.
    await sandbox.kill().catch(() => undefined)
  }
}

async function runService() {
  const config = loadConfig()
  if (!config.githubRepository || !config.githubToken || !config.llmApiKey) {
    throw new Error("GITHUB_REPOSITORY, GITHUB_TOKEN, and LLM_API_KEY are required in poll or once mode")
  }
  const github = new GitHubClient(config.githubToken)
  const classifier = new LlmTriageClassifier(new AnthropicTriageModel(config.llmApiKey, config.llmBaseUrl, config.llmModel))
  const executor = new SolariRepairExecutor(github, config)
  const workflow = new IssueWorkflow(github, classifier, executor)
  const monitor = new IssueMonitor(github, new JsonStateStore(config.statePath), {
    accept: async (event) => {
      const result = await workflow.handle(event)
      console.log(JSON.stringify({ issue: event.issue.number, route: result.route, outcome: result.outcome, pullRequest: result.pullRequest?.htmlUrl ?? null }))
    },
  }, {
    repository: config.githubRepository,
    mentionHandle: config.mentionHandle,
    includeExisting: config.includeExisting,
  })
  const poll = async () => {
    const events = await monitor.pollOnce()
    console.log(JSON.stringify({ monitored: events.length }))
  }
  await poll()
  if (config.mode === "poll") {
    setInterval(() => { void poll().catch((error) => console.error(error instanceof Error ? error.stack : error)) }, config.pollIntervalMs)
    await new Promise(() => undefined)
  }
}

const config = loadConfig()
;(config.mode === "fixture" ? runFixture() : runService()).catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
