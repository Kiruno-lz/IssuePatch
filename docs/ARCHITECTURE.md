# IssuePatch architecture

## 1. System context

```text
GitHub Issues / comments
          |
          v
  GitHub Monitor + Event Store
          |
          v
      Issue Triage (LLM)
          |
   +------+------+----------------+
   |             |                |
 code_bug   feature_request   non-code routes
   |             |
   +-------> Maintenance Planner
                     |
                     v
           Solari Execution Runtime
       +---------+---------+----------+
       | Sandbox | Preview | Browser  |
       +---------+---------+----------+
                     |
             Session Recording
                     |
                     v
          Independent Proof Verifier
                     |
                     v
          Commit -> PR -> Issue update
```

IssuePatch owns orchestration and evidence. Solari owns the isolated execution
surfaces. GitHub owns the source, Issue, branch, commit, PR, and review state.
The LLM proposes semantic decisions and code edits; host-side gates decide
whether a state transition and a successful PR are allowed.

## 2. Monitor and trigger model

The monitor has two configurable trigger modes which can be enabled together:

- `poll`: periodically lists new open Issues and processes each unseen Issue;
- `mention`: scans Issue bodies and comments for `@IssuePatch`, then enqueues
  the referenced Issue even when it is not new.

The durable event key is `(repository, issue_number, trigger_id)`. The state
store records observed events, active runs, terminal results, and the last
poll cursor. Processing is idempotent: a repeated poll or comment cannot start
two runs for the same trigger.

The first implementation uses polling so it works as a standalone process.
A webhook adapter may feed the same event interface later without changing the
workflow or proof layers.

## 3. State machine

```text
observed
  -> classified
  -> queued
  -> workspace_ready
  -> baseline_checked
  -> reproduced
  -> redline_failed
  -> patched
  -> tests_green
  -> e2e_verified
  -> proof_built
  -> committed
  -> pr_opened
  -> issue_updated
```

Non-code routes stop at `issue_updated`. Any failure records a terminal
failure state and evidence; it must not be reported as a successful repair.
Human review is an explicit terminal route, not an implicit model fallback.

## 4. Solari execution contract

The runtime exposes a narrow host interface:

- Sandbox: checkout, list/read/write files, run allow-listed commands, start
  and stop the application;
- Port Preview: resolve the running application to a browser URL;
- Browser: navigate, snapshot, click/type, assert, and capture screenshots;
- Session Recording: close/release the session and retrieve its replay URL.

All four are required for UI-facing code work. A desktop-only application may
use a Solari VM/Desktop surface for visual control, but it must still produce
the same host-verifiable proof shape.

The command runner passes argv separately from the executable, enforces a
repository-root path guard, rejects destructive commands, and records exit
codes. The browser is never allowed to mutate source files; edits go through
the bounded Sandbox file interface.

## 5. GitHub integration

The GitHub adapter performs only scoped operations for the selected repository:

1. read Issue, comments, repository metadata, and base ref;
2. create a non-base branch after verification is complete;
3. publish changed files as a commit;
4. open a PR with structured proof metadata;
5. comment on and label the source Issue.

The base branch is never directly updated. PR creation is blocked unless the
proof manifest points to the exact base SHA and commit payload being published.

## 6. Proof model

Every artifact is associated with a `runId`. The proof verifier accepts only
when all required predicates are true:

```text
baseline_reproduced
AND redline_failed_on_baseline
AND tests_green_after_patch
AND e2e_passed_after_restart
AND changed_files_present
AND evidence_same_run
```

The PR body contains a compact summary and links to the committed proof
manifest. Large screenshots and replay links use the configured artifact
transport. Credentials and VM/session capability URLs are never committed.

## 7. LLM boundary

The LLM receives the Issue, bounded observations, and bounded tools. It may
propose a classification, acceptance criteria, test, patch, or non-code reply.
It cannot mark a run successful, bypass the host verifier, write outside the
isolated repository, or publish directly to the base branch.

The classifier and repair agent are separate prompts and separate recorded
events. This prevents a repair agent from silently changing an Issue's route
after execution has begun.
