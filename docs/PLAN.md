# IssuePatch implementation plan

This plan is the execution contract for the build. Each stage has a semantic
commit and a verification gate. A later stage must not hide a failed earlier
gate.

## Stage 1 — Product and architecture baseline

Deliverables:

- corrected README and product design;
- architecture document;
- this staged plan;
- repository hygiene for secrets, artifacts, and local state.

Gate:

```bash
git diff --check
rg -n "four|required|poll|mention|redline|Repair Proof|PR" README.md docs
```

Commit: `docs: define issue maintenance architecture`

## Stage 2 — Domain, configuration, and trigger monitoring

Deliverables:

- typed Issue/triage/run/proof models;
- environment configuration;
- polling for unseen Issues;
- `@IssuePatch` mention detection in Issue bodies/comments;
- idempotent local event state;
- unit tests for routing and triggers.

Gate:

```bash
npm run typecheck
npm test -- --test-name-pattern='monitor|triage|config'
```

Commit: `feat: add issue monitoring and semantic routing`

## Stage 3 — GitHub adapter and maintenance workflow

Deliverables:

- authenticated GitHub REST client;
- Issue comments/labels and repository metadata;
- branch, commit, and PR publishing boundary;
- non-code Issue maintenance actions;
- proof-gated PR creation.

Gate:

```bash
npm run typecheck
npm test -- --test-name-pattern='github|workflow|proof'
```

Tests use a local fake GitHub server; no external write is required.

Commit: `feat: add github maintenance workflow`

## Stage 4 — Solari code and feature execution

Deliverables:

- repository checkout in Sandbox;
- baseline and redline test phases;
- Browser/Port Preview replay before and after edits;
- Session Recording retrieval;
- deterministic fixture adapter;
- artifact manifest linked to the exact run.

Gate:

```bash
npm run typecheck
npm test
npm run fixture:check
```

The fixture gate must prove baseline failure, redline failure, post-patch
green, and independent E2E success. If Solari credentials are unavailable,
the contract tests still run but the live gate remains explicitly unverified.

Commit: `feat: run verified repairs in solari`

## Stage 5 — Operational packaging and final audit

Deliverables:

- documented poll/mention startup modes;
- failure and human-review handling;
- clean secret/artifact boundaries;
- final acceptance report;
- staged commit audit.

Gate:

```bash
npm run typecheck
npm test
git diff --check
git status --short
```

Commit: `chore: verify issuepatch release workflow`

## Explicit non-goals for this build

- direct writes to a repository base branch;
- treating screenshots or model prose as verification;
- automatic handling of security disclosures without policy approval;
- claiming live Solari success without a real Solari run;
- committing API keys, preview capability URLs, or local state.
