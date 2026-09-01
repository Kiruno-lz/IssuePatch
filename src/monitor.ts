import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { containsMention, Issue, IssueComment, IssueEvent, MonitorState, triggerKey } from "./domain.js"

export interface IssueSource {
  listOpenIssues(repository: string): Promise<Issue[]>
  listIssueComments(repository: string, issueNumber: number, since?: string): Promise<IssueComment[]>
}

export interface EventSink {
  accept(event: IssueEvent): Promise<void>
}

export interface StateStore {
  load(): Promise<MonitorState>
  save(state: MonitorState): Promise<void>
}

export class JsonStateStore implements StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<MonitorState> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as MonitorState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return { initializedAt: new Date().toISOString(), processedTriggers: {} }
    }
  }

  async save(state: MonitorState): Promise<void> {
    const target = resolve(this.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(state, null, 2) + "\n", "utf8")
  }
}

export interface MonitorOptions {
  repository: string
  mentionHandle: string
  includeExisting: boolean
  now?: () => string
}

export class IssueMonitor {
  constructor(
    private readonly source: IssueSource,
    private readonly store: StateStore,
    private readonly sink: EventSink,
    private readonly options: MonitorOptions,
  ) {}

  async pollOnce(): Promise<IssueEvent[]> {
    const state = await this.store.load()
    const observedAt = this.options.now?.() ?? new Date().toISOString()
    const cursor = state.lastPollAt
    const issues = await this.source.listOpenIssues(this.options.repository)
    const events: IssueEvent[] = []

    for (const issue of issues) {
      if (issue.isPullRequest) continue
      const isNew = cursor ? issue.createdAt > cursor : this.options.includeExisting
      const bodyIsNew = cursor ? issue.updatedAt > cursor : this.options.includeExisting || issue.createdAt > state.initializedAt
      const bodyMentioned = bodyIsNew && containsMention(issue.body, this.options.mentionHandle)
      if (isNew && !bodyMentioned) {
        await this.emit({ source: "poll", issue, observedAt }, state, events)
      }
      if (bodyMentioned) {
        await this.emit({ source: "mention", issue, observedAt }, state, events)
      }

      const comments = await this.source.listIssueComments(this.options.repository, issue.number, cursor)
      for (const comment of comments) {
        if (!cursor && !this.options.includeExisting && comment.createdAt <= state.initializedAt) continue
        if (!containsMention(comment.body, this.options.mentionHandle)) continue
        await this.emit({ source: "mention", issue, comment, observedAt }, state, events)
      }
    }

    state.lastPollAt = observedAt
    await this.store.save(state)
    return events
  }

  private async emit(event: Omit<IssueEvent, "triggerId">, state: MonitorState, events: IssueEvent[]): Promise<void> {
    const key = triggerKey(event)
    if (state.processedTriggers[key]) return
    state.processedTriggers[key] = { status: "queued", observedAt: event.observedAt }
    const queuedEvent: IssueEvent = { ...event, triggerId: key }
    try {
      await this.sink.accept(queuedEvent)
    } catch (error) {
      state.processedTriggers[key].status = "failed"
      throw error
    }
    state.processedTriggers[key].status = "processed"
    events.push(queuedEvent)
  }
}
