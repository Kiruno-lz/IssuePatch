export type IssueRoute =
  | "code_bug"
  | "feature_request"
  | "repo_maintenance"
  | "question"
  | "needs_information"
  | "duplicate_or_invalid"
  | "human_review"

export type TriggerSource = "poll" | "mention"

export type RunState =
  | "observed"
  | "classified"
  | "queued"
  | "workspace_ready"
  | "baseline_checked"
  | "reproduced"
  | "redline_failed"
  | "patched"
  | "tests_green"
  | "e2e_verified"
  | "proof_built"
  | "committed"
  | "pr_opened"
  | "issue_updated"
  | "human_review"
  | "failed"

export interface Issue {
  id: number
  number: number
  repository: string
  title: string
  body: string
  state: "open" | "closed"
  htmlUrl?: string
  author?: string
  createdAt: string
  updatedAt: string
  isPullRequest?: boolean
}

export interface IssueComment {
  id: number
  issueNumber: number
  body: string
  author?: string
  createdAt: string
  updatedAt: string
  htmlUrl?: string
}

export interface IssueEvent {
  triggerId: string
  source: TriggerSource
  issue: Issue
  comment?: IssueComment
  observedAt: string
}

export interface TriageResult {
  route: IssueRoute
  confidence: number
  rationale: string
  evidence: string[]
  acceptanceCriteria: string[]
  needsHumanReview: boolean
  verificationPlan?: VerificationPlan
}

export type BrowserStep =
  | { action: "goto"; path?: string }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; value: string }
  | { action: "assert_text"; selector: string; expected: string }

export interface VerificationPlan {
  port: number
  baseline: BrowserStep[]
  after: BrowserStep[]
}

export interface MonitorState {
  initializedAt: string
  lastPollAt?: string
  processedTriggers: Record<string, { status: "queued" | "processed" | "failed"; observedAt: string }>
}

export interface ProofInput {
  baselineTestsGreen: boolean
  baselineReproduced: boolean
  redlineFailedOnBaseline: boolean
  testsGreenAfterPatch: boolean
  e2ePassedAfterRestart: boolean
  changedFilesPresent: boolean
  evidenceSameRun: boolean
}

export interface ProofDecision extends ProofInput {
  passed: boolean
  missing: string[]
}

export function normalizeMentionHandle(value: string): string {
  const normalized = value.trim().replace(/^@+/, "")
  if (!normalized || !/^[a-z0-9][a-z0-9_-]*$/i.test(normalized)) {
    throw new Error(`Invalid IssuePatch mention handle: ${value}`)
  }
  return normalized.toLowerCase()
}

export function containsMention(text: string, handle: string): boolean {
  const normalized = normalizeMentionHandle(handle)
  return new RegExp(`(^|[^a-z0-9_-])@${normalized}(?=$|[^a-z0-9_-])`, "i").test(text)
}

export function triggerKey(event: Pick<IssueEvent, "source" | "issue" | "comment">): string {
  if (event.source === "mention") {
    return `${event.issue.repository}#${event.issue.number}:mention:${event.comment?.id ?? "body"}`
  }
  return `${event.issue.repository}#${event.issue.number}:poll`
}

export function decideProof(input: ProofInput): ProofDecision {
  const checks: Array<[keyof ProofInput, string]> = [
    ["baselineTestsGreen", "baseline tests"],
    ["baselineReproduced", "baseline reproduction"],
    ["redlineFailedOnBaseline", "redline test failure on baseline"],
    ["testsGreenAfterPatch", "green tests after patch"],
    ["e2ePassedAfterRestart", "E2E pass after restart"],
    ["changedFilesPresent", "changed files"],
    ["evidenceSameRun", "same-run evidence"],
  ]
  const missing = checks.filter(([key]) => !input[key]).map(([, label]) => label)
  return { ...input, passed: missing.length === 0, missing }
}

export function baselineGateForRoute(route: IssueRoute, browserPlanPassed: boolean): boolean {
  // A bug must reproduce its broken behavior; a feature must still be absent
  // before implementation. A browser operation that throws aborts before
  // reaching this gate, so a false plan result is an expected feature absence.
  return route === "feature_request" ? !browserPlanPassed : browserPlanPassed
}
