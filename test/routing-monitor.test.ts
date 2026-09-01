import assert from "node:assert/strict"
import test from "node:test"
import { loadConfig } from "../src/config.js"
import { containsMention, decideProof, Issue, IssueComment, MonitorState } from "../src/domain.js"
import { EventSink, IssueMonitor, IssueSource, StateStore } from "../src/monitor.js"
import { LlmTriageClassifier, parseTriageResult, TriageModel, triagePrompt } from "../src/triage.js"

const issue: Issue = {
  id: 10,
  number: 7,
  repository: "owner/repo",
  title: "Pagination is stuck",
  body: "Click Next and the rows do not change.",
  state: "open",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
}

test("mention detection respects word boundaries", () => {
  assert.equal(containsMention("Please try @IssuePatch", "IssuePatch"), true)
  assert.equal(containsMention("@issuepatch investigate", "@IssuePatch"), true)
  assert.equal(containsMention("@IssuePatcher investigate", "IssuePatch"), false)
})

test("configuration requires repository credentials for monitor modes", () => {
  assert.throws(() => loadConfig({ ISSUEPATCH_MODE: "poll" }), /GITHUB_REPOSITORY/)
  const config = loadConfig({ ISSUEPATCH_MODE: "once", GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "token" })
  assert.equal(config.githubRepository, "owner/repo")
  assert.equal(config.mentionHandle, "issuepatch")
})

test("monitor emits new issues and mentioned comments once", async () => {
  const comment: IssueComment = {
    id: 22,
    issueNumber: 7,
    body: "@IssuePatch please investigate",
    createdAt: "2026-09-01T00:01:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
  }
  const source: IssueSource = {
    async listOpenIssues() { return [issue] },
    async listIssueComments() { return [comment] },
  }
  let state: MonitorState = { initializedAt: "2026-09-01T00:00:00.000Z", processedTriggers: {} }
  const store: StateStore = {
    async load() { return structuredClone(state) },
    async save(next) { state = next },
  }
  const accepted: string[] = []
  const sink: EventSink = { async accept(event) { accepted.push(`${event.source}:${event.issue.number}`) } }
  const monitor = new IssueMonitor(source, store, sink, {
    repository: "owner/repo",
    mentionHandle: "IssuePatch",
    includeExisting: true,
    now: () => "2026-09-01T00:02:00.000Z",
  })
  const first = await monitor.pollOnce()
  const second = await monitor.pollOnce()
  assert.deepEqual(first.map((event) => event.source), ["poll", "mention"])
  assert.equal(second.length, 0)
  assert.deepEqual(accepted, ["poll:7", "mention:7"])
})

test("monitor accepts a fresh mention in the Issue body", async () => {
  const mentionedIssue = { ...issue, body: "@IssuePatch please investigate", createdAt: "2026-09-01T00:01:00.000Z" }
  const source: IssueSource = {
    async listOpenIssues() { return [mentionedIssue] },
    async listIssueComments() { return [] },
  }
  let state: MonitorState = { initializedAt: "2026-09-01T00:00:00.000Z", processedTriggers: {} }
  const store: StateStore = { async load() { return structuredClone(state) }, async save(next) { state = next } }
  const accepted: IssueEvent[] = []
  const monitor = new IssueMonitor(source, store, { async accept(event) { accepted.push(event) } }, {
    repository: "owner/repo", mentionHandle: "IssuePatch", includeExisting: false, now: () => "2026-09-01T00:02:00.000Z",
  })
  const events = await monitor.pollOnce()
  assert.equal(events.length, 1)
  assert.equal(events[0].source, "mention")
  assert.match(events[0].triggerId, /mention:body$/)
  assert.equal(accepted.length, 1)
})

test("triage parser accepts structured model output and classifier falls back to human review", async () => {
  const json = JSON.stringify({
    route: "code_bug",
    confidence: 0.94,
    rationale: "The report describes incorrect visible behavior.",
    evidence: ["mentions clicking Next", "describes stale rows"],
    acceptanceCriteria: ["page 2 shows the next rows"],
    needsHumanReview: false,
  })
  const parsed = parseTriageResult(json)
  assert.equal(parsed.route, "code_bug")
  assert.match(triagePrompt(issue), /Allowed route values/)
  const model: TriageModel = { async complete() { return "not json" } }
  const fallback = await new LlmTriageClassifier(model).classify(issue)
  assert.equal(fallback.route, "human_review")
  assert.equal(fallback.needsHumanReview, true)
})

test("proof decision requires every independent gate", () => {
  const failed = decideProof({
    baselineTestsGreen: true,
    baselineReproduced: true,
    redlineFailedOnBaseline: false,
    testsGreenAfterPatch: true,
    e2ePassedAfterRestart: true,
    changedFilesPresent: true,
    evidenceSameRun: true,
  })
  assert.equal(failed.passed, false)
  assert.deepEqual(failed.missing, ["redline test failure on baseline"])
  assert.equal(decideProof({
    baselineTestsGreen: true,
    baselineReproduced: true,
    redlineFailedOnBaseline: true,
    testsGreenAfterPatch: true,
    e2ePassedAfterRestart: true,
    changedFilesPresent: true,
    evidenceSameRun: true,
  }).passed, true)
})
