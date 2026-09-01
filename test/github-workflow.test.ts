import assert from "node:assert/strict"
import test from "node:test"
import { IssueEvent, ProofInput, TriageResult } from "../src/domain.js"
import { ChangedFile, GitHubClient } from "../src/github.js"
import { IssueWorkflow, MaintenanceExecutor } from "../src/workflow.js"

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

const event: IssueEvent = {
  triggerId: "owner/repo#7:poll",
  source: "poll",
  issue: {
    id: 70,
    number: 7,
    repository: "owner/repo",
    title: "Fix pagination",
    body: "Next shows stale rows.",
    state: "open",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  observedAt: "2026-09-01T00:01:00.000Z",
}

const bugTriage: TriageResult = {
  route: "code_bug",
  confidence: 0.95,
  rationale: "A visible behavior is incorrect.",
  evidence: ["stale rows"],
  acceptanceCriteria: ["Next shows the next rows"],
  needsHumanReview: false,
}

const passingProof: ProofInput = {
  baselineTestsGreen: true,
  baselineReproduced: true,
  redlineFailedOnBaseline: true,
  testsGreenAfterPatch: true,
  e2ePassedAfterRestart: true,
  changedFilesPresent: true,
  evidenceSameRun: true,
}

test("GitHub client maps issue and filters pull requests", async () => {
  const calls: string[] = []
  const client = new GitHubClient("secret", "https://github.test", async (input) => {
    const url = String(input)
    calls.push(url)
    return response([
      { id: 1, number: 2, title: "Issue", body: "body", state: "open", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
      { id: 2, number: 3, title: "PR", body: "body", state: "open", pull_request: {}, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
    ])
  })
  const issues = await client.listOpenIssues("owner/repo")
  assert.equal(issues.length, 2)
  assert.equal(issues[1].isPullRequest, true)
  assert.match(calls[0], /state=open/)
})

test("workflow does not publish a PR when a proof gate is missing", async () => {
  const calls: string[] = []
  const github = new GitHubClient("secret", "https://github.test", async (input) => {
    calls.push(String(input))
    return response(undefined, 201)
  })
  const executor: MaintenanceExecutor = {
    async execute() {
      return {
        proof: { ...passingProof, e2ePassedAfterRestart: false },
        files: [{ path: "src/app.ts", content: "patched" }],
        diff: "+patched",
        commitMessage: "fix: issue",
        prTitle: "fix: issue",
        proofSummary: "not verified",
      }
    },
  }
  const result = await new IssueWorkflow(github, { async classify() { return bugTriage } }, executor).handle(event)
  assert.equal(result.outcome, "failed")
  assert.equal(calls.length, 1)
  assert.match(calls[0], /comments/)
})

test("workflow publishes a commit and PR only after all proof gates pass", async () => {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const queue: unknown[] = [
    { full_name: "owner/repo", default_branch: "main", clone_url: "https://github.test/owner/repo.git", html_url: "https://github.test/owner/repo" },
    { object: { sha: "base-sha" } },
    { sha: "blob-sha" },
    { sha: "tree-sha" },
    { sha: "commit-sha" },
    undefined,
    { number: 8, html_url: "https://github.test/owner/repo/pull/8" },
    undefined,
  ]
  const github = new GitHubClient("secret", "https://github.test", async (input, init) => {
    requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return response(queue.shift())
  })
  const files: ChangedFile[] = [{ path: "src/app.ts", content: "patched" }]
  const executor: MaintenanceExecutor = {
    async execute() {
      return { proof: passingProof, files, diff: "+patched", commitMessage: "fix: issue", prTitle: "fix: issue", proofSummary: "verified" }
    },
  }
  const result = await new IssueWorkflow(github, { async classify() { return bugTriage } }, executor).handle(event)
  assert.equal(result.outcome, "pr_opened")
  assert.equal(result.pullRequest?.number, 8)
  assert.equal(requests.some((request) => request.url.endsWith("/pulls")), true)
  assert.equal(requests.some((request) => request.url.endsWith("/git/refs")), true)
})

test("workflow handles a question without invoking the maintenance executor", async () => {
  let executed = false
  const calls: string[] = []
  const github = new GitHubClient("secret", "https://github.test", async (input) => {
    calls.push(String(input))
    return response(undefined, 201)
  })
  const executor: MaintenanceExecutor = { async execute() { executed = true; throw new Error("must not run") } }
  const question: TriageResult = { ...bugTriage, route: "question", rationale: "Here is the answer." }
  const result = await new IssueWorkflow(github, { async classify() { return question } }, executor).handle(event)
  assert.equal(result.outcome, "commented")
  assert.equal(executed, false)
  assert.match(calls[0], /comments/)
})
