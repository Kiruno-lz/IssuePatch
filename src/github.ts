import { Issue, IssueComment } from "./domain.js"
import { IssueSource } from "./monitor.js"

type Fetcher = typeof fetch

interface GitHubIssuePayload {
  id: number
  number: number
  title: string
  body?: string | null
  state: "open" | "closed"
  html_url?: string
  user?: { login?: string }
  created_at: string
  updated_at: string
  pull_request?: unknown
}

interface GitHubCommentPayload {
  id: number
  body?: string | null
  html_url?: string
  user?: { login?: string }
  created_at: string
  updated_at: string
}

export interface RepositoryInfo {
  fullName: string
  defaultBranch: string
  defaultSha: string
  cloneUrl: string
  htmlUrl: string
}

export interface ChangedFile {
  path: string
  content: string
}

export interface PublishedPullRequest {
  branch: string
  commitSha: string
  number: number
  htmlUrl: string
}

function issueFromPayload(repository: string, payload: GitHubIssuePayload): Issue {
  return {
    id: payload.id,
    number: payload.number,
    repository,
    title: payload.title,
    body: payload.body ?? "",
    state: payload.state,
    htmlUrl: payload.html_url,
    author: payload.user?.login,
    createdAt: payload.created_at,
    updatedAt: payload.updated_at,
    isPullRequest: Boolean(payload.pull_request),
  }
}

export class GitHubClient implements IssueSource {
  constructor(private readonly token: string, private readonly baseUrl = "https://api.github.com", private readonly fetcher: Fetcher = fetch) {}

  async listOpenIssues(repository: string): Promise<Issue[]> {
    const payload = await this.request<GitHubIssuePayload[]>(`/repos/${repository}/issues?state=open&per_page=100&sort=created&direction=asc`)
    return payload.map((item) => issueFromPayload(repository, item))
  }

  async listIssueComments(repository: string, issueNumber: number, since?: string): Promise<IssueComment[]> {
    const payload = await this.request<GitHubCommentPayload[]>(`/repos/${repository}/issues/${issueNumber}/comments?per_page=100`)
    return payload
      .filter((item) => !since || item.created_at > since)
      .map((item) => ({
        id: item.id,
        issueNumber,
        body: item.body ?? "",
        author: item.user?.login,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        htmlUrl: item.html_url,
      }))
  }

  async getRepository(repository: string): Promise<RepositoryInfo> {
    const payload = await this.request<{ full_name: string; default_branch: string; clone_url: string; html_url: string }>(`/repos/${repository}`)
    const ref = await this.request<{ object: { sha: string } }>(`/repos/${repository}/git/ref/heads/${payload.default_branch}`)
    return {
      fullName: payload.full_name,
      defaultBranch: payload.default_branch,
      defaultSha: ref.object.sha,
      cloneUrl: payload.clone_url,
      htmlUrl: payload.html_url,
    }
  }

  async createIssueComment(repository: string, issueNumber: number, body: string): Promise<void> {
    await this.request(`/repos/${repository}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    })
  }

  async addIssueLabels(repository: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.request(`/repos/${repository}/issues/${issueNumber}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels }),
    })
  }

  async publishRepair(input: {
    repository: string
    baseBranch: string
    baseSha: string
    branch: string
    files: ChangedFile[]
    commitMessage: string
    prTitle: string
    prBody: string
  }): Promise<PublishedPullRequest> {
    const files = input.files.filter((file) => !/(^|\/)(node_modules|__pycache__)(\/|$)|\.(pyc|pyo|log)$/.test(file.path))
    if (!files.length) throw new Error("Cannot publish a repair without publishable changed files")
    const blobs = []
    for (const file of files) {
      const blob = await this.request<{ sha: string }>(`/repos/${input.repository}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
      })
      blobs.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha })
    }
    const tree = await this.request<{ sha: string }>(`/repos/${input.repository}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: input.baseSha, tree: blobs }),
    })
    const commit = await this.request<{ sha: string }>(`/repos/${input.repository}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: input.commitMessage, tree: tree.sha, parents: [input.baseSha] }),
    })
    await this.request(`/repos/${input.repository}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: commit.sha }),
    })
    const pr = await this.request<{ number: number; html_url: string }>(`/repos/${input.repository}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: input.prTitle, head: input.branch, base: input.baseBranch, body: input.prBody }),
    })
    return { branch: input.branch, commitSha: commit.sha, number: pr.number, htmlUrl: pr.html_url }
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}) at ${path}`)
    if (response.status === 204) return undefined as T
    const body = await response.text()
    return (body ? JSON.parse(body) : undefined) as T
  }
}
