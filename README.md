# IssuePatch

IssuePatch is an autonomous GitHub Issue maintenance service built on four
required Solari capabilities:

1. **Sandbox** — an isolated VM for checkout, files, commands, builds, and tests;
2. **Port Preview** — a public preview address for an application running in the VM;
3. **Browser** — a real browser for reproducing and verifying user-visible behavior;
4. **Session Recording** — replayable browser evidence for the maintenance run.

Its product contract is:

```text
GitHub Issue -> monitor/mention trigger -> semantic triage -> maintenance
-> independent verification -> Repair Proof -> commit -> pull request
```

IssuePatch can be configured to poll for new Issues automatically or to react
when a user mentions `@IssuePatch` in an Issue or its comments. The LLM first
classifies the Issue; it does not assume every Issue is a code bug.

## Maintenance routes

- **Bug or regression**: reproduce the report in the Solari VM and Browser,
  add a redline regression test that fails on the baseline, patch the code,
  make the test pass, and replay the same E2E scenario.
- **Feature request**: derive explicit acceptance criteria, add a redline
  acceptance test, implement the feature, run the test green, and verify the
  user-facing behavior in the real environment.
- **Repository maintenance**: handle documentation, build, dependency, test,
  and configuration changes with the appropriate repository checks. UI-facing
  changes still require Browser/VM verification.
- **Non-code Issue**: answer questions, request missing reproduction data,
  identify duplicates, label or route invalid Issues, and escalate decisions
  that require a human. These actions do not produce a Repair Proof PR.

The service never treats the LLM's final prose as proof. A PR is created only
after the host verifier confirms the required tests and E2E checks.

## Configuration

Copy `.env.example` to `.env` and set the credentials and repository settings.
The monitor uses these variables:

```text
GITHUB_TOKEN=ghp_...
GITHUB_REPOSITORY=owner/name
ISSUEPATCH_MODE=poll             # poll, once, or fixture
ISSUEPATCH_POLL_INTERVAL_MS=60000
ISSUEPATCH_MENTION=@IssuePatch
ISSUEPATCH_STATE_PATH=.issuepatch/state.json
ISSUEPATCH_START_COMMAND=npm
ISSUEPATCH_START_ARGS=["start"]
ISSUEPATCH_TEST_COMMAND=npm
ISSUEPATCH_TEST_ARGS=["test"]
ISSUEPATCH_PORT=3000
ISSUEPATCH_TARGET_PATH=.
```

The Solari and LLM variables are required for code and feature maintenance:

```text
SOLARI_API_KEY=slr_live_...
LLM_API_KEY=...
LLM_BASE_URL=https://api.deepseek.com/anthropic
LLM_MODEL=deepseek-v4-flash
```

Run the deterministic fixture with:

```bash
npm install
npm run typecheck
npm test
npm start
```

The fixture remains a deterministic acceptance path for the workflow. It is
not the product boundary. A run writes `artifacts/<run-id>/` with the Issue,
classification, baseline/redline/final test results, screenshots, action
trace, diff, verifier proof, and PR payload or URL.

## Design and implementation plan

- [Architecture](docs/ARCHITECTURE.md) defines the system boundary, state
  machine, Solari contract, routing, proof schema, and GitHub lifecycle.
- [Plan](docs/PLAN.md) defines the implementation stages and their verification
  gates.
- [Design](docs/DESIGN.md) records the product-level acceptance contract.

The default GitHub behavior is to create a branch and PR. It never writes
directly to the repository's base branch.
