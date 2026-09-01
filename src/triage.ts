import { BrowserStep, Issue, IssueRoute, TriageResult, VerificationPlan } from "./domain.js"

const routes: IssueRoute[] = [
  "code_bug",
  "feature_request",
  "repo_maintenance",
  "question",
  "needs_information",
  "duplicate_or_invalid",
  "human_review",
]

export interface TriageModel {
  complete(prompt: string): Promise<string>
}

export function triagePrompt(issue: Issue): string {
  return [
    "Classify this GitHub Issue for an autonomous repository maintenance service.",
    "Return JSON only with route, confidence, rationale, evidence, acceptanceCriteria, and needsHumanReview.",
    "For code_bug or feature_request, also return verificationPlan with port, baseline, and after browser steps.",
    `Allowed route values: ${routes.join(", ")}.`,
    "Use human_review for security-sensitive, ambiguous, or high-impact decisions.",
    `Repository: ${issue.repository}`,
    `Issue #${issue.number}: ${issue.title}`,
    issue.body || "(no body)",
  ].join("\n\n")
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]
  const candidate = (fenced ?? text).trim()
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("Triage response did not contain a JSON object")
  return JSON.parse(candidate.slice(start, end + 1))
}

function parseVerificationPlan(value: unknown): VerificationPlan | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") throw new Error("verificationPlan must be an object")
  const plan = value as Record<string, unknown>
  if (!Number.isInteger(plan.port) || Number(plan.port) <= 0) throw new Error("verificationPlan.port must be positive")
  const parseSteps = (key: string): BrowserStep[] => {
    if (!Array.isArray(plan[key])) throw new Error(`verificationPlan.${key} must be an array`)
    return plan[key].map((step) => {
      if (!step || typeof step !== "object" || typeof (step as Record<string, unknown>).action !== "string") throw new Error("verificationPlan contains an invalid step")
      const item = step as Record<string, unknown>
      if (item.action === "goto") return { action: "goto", ...(typeof item.path === "string" ? { path: item.path } : {}) }
      if (item.action === "click" && typeof item.selector === "string") return { action: "click", selector: item.selector }
      if (item.action === "type" && typeof item.selector === "string" && typeof item.value === "string") return { action: "type", selector: item.selector, value: item.value }
      if (item.action === "assert_text" && typeof item.selector === "string" && typeof item.expected === "string") return { action: "assert_text", selector: item.selector, expected: item.expected }
      throw new Error("verificationPlan contains an invalid browser step")
    })
  }
  return { port: Number(plan.port), baseline: parseSteps("baseline"), after: parseSteps("after") }
}

export function parseTriageResult(text: string): TriageResult {
  const value = parseJson(text) as Record<string, unknown>
  const route = value.route
  if (typeof route !== "string" || !routes.includes(route as IssueRoute)) throw new Error("Triage returned an unsupported route")
  const confidence = Number(value.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Triage confidence must be between 0 and 1")
  const list = (key: string): string[] => {
    const item = value[key]
    if (typeof item === "string") return item.trim() ? [item] : []
    if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) throw new Error(`Triage field ${key} must be a string array`)
    return item
  }
  if (typeof value.rationale !== "string") throw new Error("Triage rationale is required")
  if (typeof value.needsHumanReview !== "boolean") throw new Error("Triage needsHumanReview is required")
  return {
    route: route as IssueRoute,
    confidence,
    rationale: value.rationale,
    evidence: list("evidence"),
    acceptanceCriteria: list("acceptanceCriteria"),
    needsHumanReview: value.needsHumanReview,
    verificationPlan: parseVerificationPlan(value.verificationPlan),
  }
}

export class LlmTriageClassifier {
  constructor(private readonly model: TriageModel) {}

  async classify(issue: Issue): Promise<TriageResult> {
    try {
      return parseTriageResult(await this.model.complete(triagePrompt(issue)))
    } catch (error) {
      return {
        route: "human_review",
        confidence: 0,
        rationale: `Structured triage failed: ${error instanceof Error ? error.message : String(error)}`,
        evidence: [],
        acceptanceCriteria: [],
        needsHumanReview: true,
      }
    }
  }
}

export class AnthropicTriageModel implements TriageModel {
  constructor(private readonly apiKey: string, private readonly baseUrl: string, private readonly model: string) {}

  async complete(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1200,
        temperature: 0,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: prompt }],
      }),
    })
    if (!response.ok) throw new Error(`LLM request failed (${response.status})`)
    const payload = (await response.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = payload.content?.find((block) => block.type === "text")?.text
    if (!text) throw new Error("LLM response did not contain text")
    return text
  }
}
