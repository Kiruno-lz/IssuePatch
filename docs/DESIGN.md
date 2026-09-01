# IssuePatch product design

## Product boundary

IssuePatch autonomously maintains GitHub Issues. It is not a replacement for
GitHub Actions: Actions runs known repository checks, while IssuePatch turns an
ambiguous Issue into a routed maintenance action and, when code changes are
needed, a verified pull request.

The final code-maintenance product is a PR containing or linking to a
reproducible Repair Proof. A non-code Issue is maintained through a comment,
label, duplicate link, status update, or human-escalation marker.

## Required Solari foundation

Every code or feature workflow uses these four capabilities:

- **Sandbox**: isolated VM filesystem, checkout, commands, build, and tests;
- **Port Preview**: exposes the application port from the VM;
- **Browser**: performs the real user interaction and reads the resulting UI;
- **Session Recording**: preserves a replayable browser session.

The Browser and VM lifecycles are owned by the host and released in cleanup
paths. A missing required capability fails the run; it is not silently replaced
by a local screenshot or an LLM assertion.

## Issue routing

The classifier produces structured output with a confidence score, evidence,
repository context, acceptance criteria, and a human-review flag.
Supported routes are:

```text
code_bug
feature_request
repo_maintenance
question
needs_information
duplicate_or_invalid
human_review
```

Security-sensitive Issues are routed through `human_review` unless the
repository policy explicitly enables an isolated security workflow.

## Code workflow

1. Fetch the Issue and select the base revision.
2. Create an isolated branch workspace in the Solari Sandbox.
3. Establish the baseline with repository checks.
4. Reproduce the Issue through the real Browser and VM/preview environment;
   for a feature request, verify that the requested behavior is still absent.
5. Add a redline test or acceptance test and prove it fails on the baseline.
6. Apply the smallest coherent code change.
7. Run the test suite and prove the redline test is green.
8. Restart the application and replay the same Browser/VM E2E scenario.
9. Run the independent host verifier.
10. Build the Repair Proof, create a commit and branch, and open a PR.
11. Comment on the Issue with the classification, result, and PR link.

The workflow cannot create a successful repair PR if reproduction, redline
failure, green tests, or post-patch E2E verification is missing.

## Non-code workflow

The agent may answer a question from repository evidence, ask for missing
logs or reproduction steps, identify and link duplicate Issues, apply labels,
or explain why an Issue is out of scope. Product/design decisions, ambiguous
ownership, and security disclosures are escalated rather than guessed.

Non-code handling is intentionally outside the Repair Proof PR MVP, but its
result must still be recorded in the Issue event log.

## Repair Proof

The proof manifest contains:

```text
issue.md
classification.json
environment.json
baseline-tests.json
redline-tests.json
before.png
action-trace.jsonl
patch.diff
after.png
e2e-verification.json
proof.json
replay-url.txt           # when Solari recording is available
pr.json
```

The manifest records the repository, base SHA, branch, commit SHA, Issue
number, run ID, tool versions, commands, and verifier decisions. Secrets,
ephemeral preview URLs, API keys, and session capability URLs are excluded
from committed evidence unless the configured evidence policy explicitly
allows a safe replay link.

## Deterministic fixture

The inventory fixture is a test harness for the execution kernel. Its Issue
requires `Next` to show `Item 6` and `Page 2 of 2`, then `Previous` to restore
`Item 1`. It proves that a host verifier can reject a stale first-page response
even when the page indicator changes.
