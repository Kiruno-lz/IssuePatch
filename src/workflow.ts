import { decideProof, IssueEvent, IssueRoute, ProofInput, TriageResult } from "./domain.js"
import { ChangedFile, GitHubClient, PublishedPullRequest } from "./github.js"

export interface MaintenanceResult {
  proof: ProofInput
  files: ChangedFile[]
  diff: string
  commitMessage: string
  prTitle: string
  proofSummary: string
}

export interface MaintenanceExecutor {
  execute(event: IssueEvent, triage: TriageResult): Promise<MaintenanceResult>
}

export interface TriageProvider {
  classify(issue: IssueEvent["issue"]): Promise<TriageResult>
}

export interface WorkflowResult {
  route: IssueRoute
  outcome: "commented" | "human_review" | "pr_opened" | "failed"
  pullRequest?: PublishedPullRequest
  proofPassed?: boolean
}

const codeRoutes: IssueRoute[] = ["code_bug", "feature_request", "repo_maintenance"]

export class IssueWorkflow {
  constructor(
    private readonly github: GitHubClient,
    private readonly triage: TriageProvider,
    private readonly executor: MaintenanceExecutor,
  ) {}

  async handle(event: IssueEvent): Promise<WorkflowResult> {
    const result = await this.triage.classify(event.issue)
    if (!codeRoutes.includes(result.route)) return await this.handleNonCode(event, result)

    const maintenance = await this.executor.execute(event, result)
    const proof = decideProof(maintenance.proof)
    if (!proof.passed) {
      await this.github.createIssueComment(event.issue.repository, event.issue.number, this.failureComment(result, proof.missing))
      return { route: result.route, outcome: "failed", proofPassed: false }
    }

    const repository = await this.github.getRepository(event.issue.repository)
    const branch = `issuepatch/${event.issue.number}-${event.issue.id}`
    const pullRequest = await this.github.publishRepair({
      repository: event.issue.repository,
      baseBranch: repository.defaultBranch,
      baseSha: repository.defaultSha,
      branch,
      files: maintenance.files,
      commitMessage: maintenance.commitMessage,
      prTitle: maintenance.prTitle,
      prBody: this.prBody(event, result, proof, maintenance),
    })
    await this.github.createIssueComment(event.issue.repository, event.issue.number, `IssuePatch opened PR #${pullRequest.number}: ${pullRequest.htmlUrl}`)
    return { route: result.route, outcome: "pr_opened", pullRequest, proofPassed: true }
  }

  private async handleNonCode(event: IssueEvent, triage: TriageResult): Promise<WorkflowResult> {
    if (triage.needsHumanReview || triage.route === "human_review") {
      await this.github.createIssueComment(event.issue.repository, event.issue.number, "IssuePatch classified this Issue for human review. No repository changes were made.")
      await this.github.addIssueLabels(event.issue.repository, event.issue.number, ["issuepatch:human-review"])
      return { route: triage.route, outcome: "human_review" }
    }
    const message = triage.route === "needs_information"
      ? "IssuePatch needs more information before it can proceed. Please provide reproducible steps, environment details, and relevant logs."
      : triage.route === "question"
        ? `IssuePatch classified this as a question.\n\n${triage.rationale}`
        : `IssuePatch classified this Issue as ${triage.route}.\n\n${triage.rationale}`
    await this.github.createIssueComment(event.issue.repository, event.issue.number, message)
    return { route: triage.route, outcome: "commented" }
  }

  private failureComment(triage: TriageResult, missing: string[]): string {
    return [
      `IssuePatch could not open a PR for this ${triage.route} Issue.`,
      "The host proof gate did not pass.",
      `Missing evidence: ${missing.join(", ")}.`,
      "No successful repair claim was made.",
    ].join("\n\n")
  }

  private prBody(event: IssueEvent, triage: TriageResult, proof: ReturnType<typeof decideProof>, maintenance: MaintenanceResult): string {
    return [
      `Closes #${event.issue.number}`,
      "",
      "## IssuePatch Repair Proof",
      "",
      `- Route: ${triage.route}`,
      `- Confidence: ${triage.confidence}`,
      `- Run trigger: ${event.triggerId}`,
      `- Proof: PASS (${Object.values(proof).filter((value) => value === true).length} gates)`,
      "- The host verifier, not the LLM's final text, authorized this PR.",
      "",
      "## Changed behavior",
      maintenance.proofSummary,
      "",
      "## Diff summary",
      "```diff",
      maintenance.diff.slice(0, 12000),
      "```",
    ].join("\n")
  }
}
