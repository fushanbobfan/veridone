# Product specification

## Problem

Maintainers using multiple coding agents spend increasing time supervising work after generation: locating the relevant session, establishing what changed, checking whether tests were truly run, detecting stale or misleading evidence, reproducing failures, reviewing risk, and recording a final decision. Existing tools primarily orchestrate agents or display traces. They do not provide a neutral, post-hoc acceptance layer that works across agents and existing workflows.

VeriDone reduces that recurring burden without becoming another agent runtime.

## Primary user

An individual maintainer or small team that uses Codex, Claude Code, CI, local automation, or several of these at once across multiple repositories. The primary user remains accountable for monitoring, testing, and accepting or rejecting the work.

## Jobs to be done

- Tell me which completed-looking work needs my attention first.
- Show exactly what the agent claimed and which parts have current evidence.
- Let me reproduce important checks safely without reconstructing commands from chat.
- Warn me when evidence belongs to an older commit or different worktree state.
- Give me one review surface for diff scope, checks, risks, artifacts, and CI.
- Record my acceptance or rejection without conflating it with an automated pass.
- Produce a portable packet another person can inspect without VeriDone.

## Product principles

1. **Evidence over confidence.** Model confidence never upgrades a gate.
2. **State-bound truth.** Evidence is meaningful only for the repository state it measured.
3. **Zero-intrusion first.** Existing receipts and repositories work without modifying an agent.
4. **Safe by construction.** Imported content is untrusted; executable checks are local policy.
5. **Human accountability.** Automation informs the verdict but never impersonates it.
6. **Progressive disclosure.** The inbox answers “what needs me?”; details expose provenance and raw artifacts.
7. **Portable outcomes.** A review should survive outside this application.

## End-to-end workflow

### 1. Onboard

The maintainer creates a workspace, selects one or more approved roots, adds repositories, and optionally adds receipt directories. VeriDone discovers compatible sources read-only and previews what will be imported.

### 2. Triage

The review inbox ranks work items by blocking failures, stale evidence, unreviewed changes, security-sensitive paths, and recency. Every priority signal is explainable.

### 3. Inspect

The review page shows:

- agent claims and source provenance;
- commit, branch, dirty state, and changed-file summary;
- acceptance criteria and coverage by evidence;
- check results, freshness, duration, bounded output, and artifact hashes;
- risk flags and explicit unknowns;
- CI and pull-request state when configured.

### 4. Verify

The maintainer selects declared checks and runs them. VeriDone uses argument arrays rather than shell strings, enforces time and output limits, captures tool versions and exit status, and binds results to a before/after repository fingerprint. A worktree mutation during a check invalidates the result.

### 5. Decide

The maintainer chooses Accept, Request changes, or Reject. VeriDone records the decision, note, timestamp, current repository fingerprint, and evidence set. If state changes later, the historical verdict remains visible but is marked superseded for the new state.

### 6. Export

VeriDone exports a self-contained packet in JSON, Markdown, and sanitized HTML. The manifest includes SHA-256 hashes for included artifacts, but does not include credentials, full environment dumps, or files outside the approved export set.

## v1 scope

### Required

- Local-first web application with a one-command launcher.
- Read-only repository discovery within approved roots.
- Git snapshot, diff metadata, branch, commit, and worktree fingerprinting.
- Generic receipt adapter plus native adapter for the local harness receipt schema.
- Review inbox with explainable priority and filters.
- Acceptance contracts with criteria and required/optional checks.
- Safe check runner with cancellation, timeout, output cap, and mutation detection.
- Evidence freshness engine and claim-to-evidence mapping.
- Human verdict history.
- JSON, Markdown, and HTML exports with integrity manifest.
- Import/export of application workspaces.
- Demo workspace for the public deployment, visibly labeled synthetic.
- Keyboard-complete UI, responsive layouts, dark/light themes, reduced motion.

### Explicit non-goals

- Launching or chatting with coding agents.
- Automatically merging, pushing, deploying, or editing repositories.
- Claiming that a passing check proves semantic correctness.
- Executing arbitrary commands supplied by receipts or remote sources.
- Enterprise identity, billing, or organization administration in v1.

## Success criteria

- A new user can import a real repository and understand its readiness within five minutes.
- A stale test claim is detected after a repository change without manual refresh logic.
- No execution can originate from imported receipt text.
- A full acceptance packet can be opened and audited without VeriDone.
- The complete critical path is validated in a real Chromium browser and automated in Playwright.
