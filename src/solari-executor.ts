import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"
import { BrowserStep, IssueEvent, TriageResult, VerificationPlan, decideProof } from "./domain.js"
import { ChangedFile, GitHubClient } from "./github.js"
import { IssuePatchConfig } from "./config.js"
import { MaintenanceExecutor, MaintenanceResult } from "./workflow.js"

type AnyPage = any
type AnyBrowser = any
type AnySandbox = any
const REPO_ROOT = "/tmp/issuepatch-repo"
const here = dirname(fileURLToPath(import.meta.url))

class RunRecorder {
  readonly runId = new Date().toISOString().replace(/[:.]/g, "-")
  readonly dir = resolve(here, "..", "artifacts", this.runId)
  private readonly events: Record<string, unknown>[] = []

  async init(event: IssueEvent, triage: TriageResult): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await this.text("issue.md", `# ${event.issue.title}\n\n${event.issue.body}\n`)
    await this.json("classification.json", triage)
  }

  async event(kind: string, data: Record<string, unknown>): Promise<void> {
    this.events.push({ at: new Date().toISOString(), kind, ...data })
    await this.text("action-trace.jsonl", this.events.map((item) => JSON.stringify(item)).join("\n") + "\n")
  }

  async json(name: string, value: unknown): Promise<void> {
    await this.text(name, JSON.stringify(value, null, 2) + "\n")
  }

  async text(name: string, value: string): Promise<void> {
    await writeFile(join(this.dir, name), value, "utf8")
  }

  async screenshot(name: string, bytes: Uint8Array): Promise<void> {
    await writeFile(join(this.dir, name), bytes)
  }
}

class SandboxWorkspace {
  private serverHandle: any
  private phase: "redline" | "patch" = "redline"

  constructor(private readonly sandbox: AnySandbox, private readonly recorder: RunRecorder, private readonly config: IssuePatchConfig) {}

  async clone(cloneUrl: string, branch: string, token: string): Promise<void> {
    await this.sandbox.git.clone(cloneUrl, {
      path: REPO_ROOT,
      branch,
      depth: 1,
      username: "x-access-token",
      password: token,
    })
    await this.run("git", ["config", "user.email", "issuepatch@example.invalid"])
    await this.run("git", ["config", "user.name", "IssuePatch"])
    await this.recorder.event("workspace.ready", { root: REPO_ROOT, branch })
  }

  setPhase(phase: "redline" | "patch"): void {
    this.phase = phase
  }

  async listFiles(path = REPO_ROOT): Promise<unknown> {
    return await this.sandbox.files.list(this.safePath(path))
  }

  async readFile(path: string): Promise<string> {
    return await this.sandbox.files.readText(this.safePath(path))
  }

  async searchCode(pattern: string): Promise<unknown> {
    return await this.sandbox.files.search(REPO_ROOT, pattern, 100)
  }

  async writeFile(path: string, content: string): Promise<{ path: string; bytes: number }> {
    const target = this.safePath(path)
    if (this.phase === "redline" && !this.isTestPath(target)) {
      throw new Error("The redline phase may only write test files")
    }
    await this.sandbox.files.write(target, content)
    await this.recorder.event("sandbox.write", { path: target, bytes: content.length, phase: this.phase })
    return { path: target, bytes: content.length }
  }

  async run(command: string, args: string[], cwd = REPO_ROOT): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const allowed = new Set(["git", "node", "npm", "pnpm", "yarn", "python", "python3", "pytest", "cargo", "go", "make", "grep", "find", "rg", "sh"])
    if (!allowed.has(command)) throw new Error(`Command is not allow-listed: ${command}`)
    const joined = [command, ...args].join(" ").toLowerCase()
    if (/\b(rm|rmdir|shutdown|reboot|mkfs|kill|pkill|curl|wget)\b|:\s*>/.test(joined)) throw new Error("Potentially destructive or network command rejected")
    const result = await this.sandbox.commands.run(command, { args, cwd })
    await this.recorder.event("sandbox.command", { command, args, cwd, exitCode: result.exitCode })
    return result
  }

  async runConfiguredTest(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.config.projectTestCommand) throw new Error("ISSUEPATCH_TEST_COMMAND is required for code maintenance")
    return await this.run(this.config.projectTestCommand, this.config.projectTestArgs)
  }

  async startServer(port: number): Promise<string> {
    if (!this.config.projectStartCommand) throw new Error("ISSUEPATCH_START_COMMAND is required for browser maintenance")
    this.serverHandle = await this.sandbox.commands.start(this.config.projectStartCommand, { args: this.config.projectStartArgs, cwd: REPO_ROOT })
    const { url } = await this.sandbox.previewUrl(port)
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        if ((await fetch(url)).ok) {
          await this.recorder.event("preview.ready", { url, port })
          return url
        }
      } catch {
        // The application may need a moment after the process starts.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    }
    throw new Error(`Application did not become reachable at ${url}`)
  }

  async stopServer(): Promise<void> {
    if (this.serverHandle) {
      await this.serverHandle.kill().catch(() => undefined)
      this.serverHandle = undefined
    }
  }

  async diff(): Promise<string> {
    await this.sandbox.git.add(["."], REPO_ROOT)
    const result = await this.run("git", ["diff", "--cached", "--no-ext-diff"])
    return result.stdout
  }

  async changedFiles(): Promise<ChangedFile[]> {
    const status = await this.sandbox.git.status(REPO_ROOT)
    const paths = [...new Set([...status.staged, ...status.modified, ...status.untracked])]
    return await Promise.all(paths.map(async (path) => ({ path, content: await this.readFile(path) })))
  }

  private safePath(input: string): string {
    const candidate = posix.normalize(input.startsWith("/") ? input : `${REPO_ROOT}/${input}`)
    if (candidate !== REPO_ROOT && !candidate.startsWith(`${REPO_ROOT}/`)) throw new Error(`Path escapes repository: ${input}`)
    return candidate
  }

  private isTestPath(path: string): boolean {
    return /(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.[^/]+$/.test(path)
  }
}

class BrowserWorkspace {
  constructor(private readonly page: AnyPage, private readonly recorder: RunRecorder) {}

  async snapshot(): Promise<{ url: string; text: string }> {
    const text = await this.page.locator("body").innerText()
    return { url: this.page.url(), text: text.slice(0, 6000) }
  }

  async click(selector: string): Promise<unknown> {
    return await this.runPlan(this.page.url(), [{ action: "click", selector }], "agent-click")
  }

  async assertText(selector: string, expected: string): Promise<unknown> {
    return await this.runPlan(this.page.url(), [{ action: "assert_text", selector, expected }], "agent-assert")
  }

  async runPlan(baseUrl: string, steps: BrowserStep[], phase: string): Promise<{ passed: boolean; results: unknown[] }> {
    const results: unknown[] = []
    for (const step of steps) {
      if (step.action === "goto") {
        await this.page.goto(step.path ? new URL(step.path, baseUrl).toString() : baseUrl)
        results.push({ action: step.action, passed: true })
      } else if (step.action === "click") {
        await this.page.locator(step.selector).click()
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
        results.push({ action: step.action, selector: step.selector, passed: true })
      } else if (step.action === "type") {
        await this.page.locator(step.selector).fill(step.value)
        results.push({ action: step.action, selector: step.selector, passed: true })
      } else {
        const locator = this.page.locator(step.selector)
        const count = await locator.count()
        const text = count ? await locator.first().innerText() : ""
        const passed = count > 0 && text.includes(step.expected)
        results.push({ action: step.action, selector: step.selector, expected: step.expected, text, passed })
        if (!passed) break
      }
    }
    const passed = results.every((result) => (result as { passed: boolean }).passed)
    await this.recorder.event(`browser.${phase}`, { passed, results })
    return { passed, results }
  }
}

class RepairAgent {
  constructor(private readonly apiKey: string, private readonly baseUrl: string, private readonly model: string, private readonly recorder: RunRecorder) {}

  async run(issue: IssueEvent, triage: TriageResult, workspace: SandboxWorkspace, browser: BrowserWorkspace, phase: "redline" | "patch"): Promise<void> {
    const root = REPO_ROOT
    const tools = [
      { name: "list_files", description: "List repository files.", properties: { path: { type: "string" } } },
      { name: "read_file", description: "Read a repository text file.", required: ["path"], properties: { path: { type: "string" } } },
      { name: "search_code", description: "Search repository code.", required: ["pattern"], properties: { pattern: { type: "string" } } },
      { name: "run_command", description: "Run an allow-listed repository command.", required: ["command", "args"], properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } } },
      { name: "browser_snapshot", description: "Read visible browser text.", properties: {} },
      { name: "browser_click", description: "Click a CSS selector.", required: ["selector"], properties: { selector: { type: "string" } } },
      { name: "browser_assert", description: "Assert visible selector text.", required: ["selector", "expected"], properties: { selector: { type: "string" }, expected: { type: "string" } } },
      { name: "write_file", description: phase === "redline" ? "Write a test file only." : "Write a repository file.", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
      { name: "finish", description: "Finish this phase.", required: ["summary"], properties: { summary: { type: "string" } } },
    ]
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: `Issue #${issue.issue.number}: ${issue.issue.title}\n\n${issue.issue.body}` }]
    const system = [
      "You are a careful IssuePatch maintenance agent.",
      `The isolated repository is ${root}.`,
      `This is the ${phase} phase.`,
      phase === "redline"
        ? "Only add a test that expresses the Issue acceptance criteria. Do not modify application code. Finish after the test is written."
        : "Apply the smallest correct implementation change. Use the existing redline test and finish after the code is repaired.",
      `Acceptance criteria: ${triage.acceptanceCriteria.join("; ") || "derive them from the Issue"}`,
      "Do not claim a phase succeeded from prose; the host records command and browser results.",
    ].join("\n")

    for (let step = 1; step <= 16; step += 1) {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, system, messages, max_tokens: 4000, temperature: 0, tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: { type: "object", required: tool.required ?? [], properties: tool.properties } })) }),
      })
      if (!response.ok) throw new Error(`Repair agent request failed (${response.status})`)
      const payload = await response.json() as { content?: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string }> }
      if (!payload.content) throw new Error("Repair agent response did not contain content")
      messages.push({ role: "assistant", content: payload.content })
      const calls = payload.content.filter((item) => item.type === "tool_use" && item.id && item.name)
      await this.recorder.event("agent.response", { phase, step, toolCalls: calls.length })
      if (!calls.length) break
      let finished = false
      for (const call of calls) {
        let result: unknown
        try {
          const input = call.input ?? {}
          switch (call.name) {
            case "list_files": result = await workspace.listFiles(String(input.path ?? root)); break
            case "read_file": result = await workspace.readFile(String(input.path)); break
            case "search_code": result = await workspace.searchCode(String(input.pattern)); break
            case "run_command": result = await workspace.run(String(input.command), Array.isArray(input.args) ? input.args.map(String) : []); break
            case "browser_snapshot": result = await this.snapshot(browser); break
            case "browser_click": result = await this.click(browser, String(input.selector)); break
            case "browser_assert": result = await this.assert(browser, String(input.selector), String(input.expected)); break
            case "write_file": result = await workspace.writeFile(String(input.path), String(input.content)); break
            case "finish": result = { accepted: true, summary: String(input.summary ?? "") }; finished = true; break
            default: throw new Error(`Unknown agent tool: ${call.name}`)
          }
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) }
        }
        await this.recorder.event("agent.tool", { phase, step, name: call.name, result: JSON.stringify(result).slice(0, 2000) })
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result) }] })
      }
      if (finished) break
    }
  }

  private async snapshot(browser: BrowserWorkspace): Promise<unknown> { return await browser.snapshot() }

  private async click(browser: BrowserWorkspace, selector: string): Promise<unknown> { return await browser.click(selector) }

  private async assert(browser: BrowserWorkspace, selector: string, expected: string): Promise<unknown> { return await browser.assertText(selector, expected) }
}

export class SolariRepairExecutor implements MaintenanceExecutor {
  constructor(private readonly github: GitHubClient, private readonly config: IssuePatchConfig) {}

  async execute(event: IssueEvent, triage: TriageResult): Promise<MaintenanceResult> {
    if (!this.config.solariApiKey || !this.config.githubToken || !this.config.llmApiKey) throw new Error("Solari, GitHub, and LLM credentials are required for code maintenance")
    const plan = triage.verificationPlan
    if (!plan) throw new Error("Code maintenance requires an LLM verificationPlan")
    const repository = await this.github.getRepository(event.issue.repository)
    const recorder = new RunRecorder()
    await recorder.init(event, triage)
    const client = new SolariClient({ apiKey: this.config.solariApiKey })
    const solari = new Solari({ apiKey: this.config.solariApiKey })
    const sandbox = await client.sandboxes.create({ template: "base", timeoutMs: 10 * 60_000 })
    let browser: AnyBrowser | undefined
    let server: SandboxWorkspace | undefined
    try {
      await sandbox.connect()
      server = new SandboxWorkspace(sandbox, recorder, this.config)
      await server.clone(repository.cloneUrl, repository.defaultBranch, this.config.githubToken)
      const baselineTests = await server.runConfiguredTest()
      await recorder.json("baseline-tests.json", baselineTests)
      const session = await solari.launch({ recording: true })
      browser = session
      const page = await session.newPage()
      const browserWorkspace = new BrowserWorkspace(page, recorder)
      const baseUrl = await server.startServer(plan.port)
      await page.goto(baseUrl)
      await recorder.screenshot("before.png", await page.screenshot({ fullPage: true }))
      const baseline = await browserWorkspace.runPlan(baseUrl, plan.baseline, "baseline")
      await server.stopServer()

      server.setPhase("redline")
      await new RepairAgent(this.config.llmApiKey, this.config.llmBaseUrl, this.config.llmModel, recorder).run(event, triage, server, browserWorkspace, "redline")
      const redline = await server.runConfiguredTest()
      await recorder.json("redline-tests.json", redline)
      server.setPhase("patch")
      await new RepairAgent(this.config.llmApiKey, this.config.llmBaseUrl, this.config.llmModel, recorder).run(event, triage, server, browserWorkspace, "patch")
      const tests = await server.runConfiguredTest()
      await recorder.json("tests-after-patch.json", tests)
      const verifiedUrl = await server.startServer(plan.port)
      const after = await browserWorkspace.runPlan(verifiedUrl, plan.after, "after")
      await recorder.screenshot("after.png", await page.screenshot({ fullPage: true }))
      const diff = await server.diff()
      const files = await server.changedFiles()
      const replaySessionId = browser.id
      await browser.close()
      browser = undefined
      let replayUrl = ""
      if (replaySessionId) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try { replayUrl = (await solari.sessions.getReplayUrl(replaySessionId)).url; break } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000)) }
        }
      }
      if (replayUrl) await recorder.text("replay-url.txt", `${replayUrl}\n`)
      const proof = decideProof({
        baselineTestsGreen: baselineTests.exitCode === 0,
        baselineReproduced: baseline.passed,
        redlineFailedOnBaseline: redline.exitCode !== 0,
        testsGreenAfterPatch: tests.exitCode === 0,
        e2ePassedAfterRestart: after.passed,
        changedFilesPresent: files.length > 0,
        evidenceSameRun: true,
      })
      await recorder.json("e2e-verification.json", { baseline, after })
      await recorder.json("proof.json", { ...proof, runId: recorder.runId, repository: event.issue.repository, issueNumber: event.issue.number, baseSha: repository.defaultSha })
      await recorder.text("patch.diff", diff)
      return {
        proof,
        files,
        diff,
        commitMessage: `${triage.route === "feature_request" ? "feat" : "fix"}: resolve #${event.issue.number}`,
        prTitle: `${triage.route === "feature_request" ? "feat" : "fix"}: ${event.issue.title}`,
        proofSummary: `Repair Proof ${proof.passed ? "passed" : "failed"}; artifacts: ${recorder.dir}`,
      }
    } finally {
      await server?.stopServer().catch(() => undefined)
      if (browser) await browser.close().catch(() => undefined)
      await solari.close().catch(() => undefined)
      await sandbox.kill().catch(() => undefined)
    }
  }
}
