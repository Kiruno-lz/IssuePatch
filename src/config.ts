import { normalizeMentionHandle } from "./domain.js"

export type IssuePatchMode = "poll" | "once" | "fixture"

export interface IssuePatchConfig {
  mode: IssuePatchMode
  githubToken?: string
  githubRepository?: string
  pollIntervalMs: number
  mentionHandle: string
  statePath: string
  includeExisting: boolean
  solariApiKey?: string
  llmApiKey?: string
  llmBaseUrl: string
  llmModel: string
  projectStartCommand?: string
  projectStartArgs: string[]
  projectTestCommand?: string
  projectTestArgs: string[]
  projectPort: number
  projectTargetPath: string
}

function optionalBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === "1" || value.toLowerCase() === "true") return true
  if (value === "0" || value.toLowerCase() === "false") return false
  throw new Error(`Expected a boolean value, received: ${value}`)
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received: ${value}`)
  return parsed
}

function jsonArgs(value: string | undefined): string[] {
  if (!value) return []
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("Expected a JSON string array")
  return parsed
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IssuePatchConfig {
  const mode = (env.ISSUEPATCH_MODE ?? "fixture") as IssuePatchMode
  if (!(["poll", "once", "fixture"] as IssuePatchMode[]).includes(mode)) {
    throw new Error(`Unsupported ISSUEPATCH_MODE: ${mode}`)
  }
  const githubRepository = env.GITHUB_REPOSITORY?.trim() || undefined
  if ((mode === "poll" || mode === "once") && !githubRepository) {
    throw new Error("GITHUB_REPOSITORY is required in poll or once mode")
  }
  if ((mode === "poll" || mode === "once") && !env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is required in poll or once mode")
  }
  return {
    mode,
    githubToken: env.GITHUB_TOKEN,
    githubRepository,
    pollIntervalMs: positiveInteger(env.ISSUEPATCH_POLL_INTERVAL_MS, 60_000),
    mentionHandle: normalizeMentionHandle(env.ISSUEPATCH_MENTION ?? "IssuePatch"),
    statePath: env.ISSUEPATCH_STATE_PATH ?? ".issuepatch/state.json",
    includeExisting: optionalBoolean(env.ISSUEPATCH_INCLUDE_EXISTING, false),
    solariApiKey: env.SOLARI_API_KEY,
    llmApiKey: env.LLM_API_KEY,
    llmBaseUrl: (env.LLM_BASE_URL ?? "https://api.deepseek.com/anthropic").replace(/\/$/, ""),
    llmModel: env.LLM_MODEL ?? "deepseek-v4-flash",
    projectStartCommand: env.ISSUEPATCH_START_COMMAND?.trim() || undefined,
    projectStartArgs: jsonArgs(env.ISSUEPATCH_START_ARGS),
    projectTestCommand: env.ISSUEPATCH_TEST_COMMAND?.trim() || undefined,
    projectTestArgs: jsonArgs(env.ISSUEPATCH_TEST_ARGS),
    projectPort: positiveInteger(env.ISSUEPATCH_PORT, 3000),
    projectTargetPath: env.ISSUEPATCH_TARGET_PATH?.trim() || ".",
  }
}
