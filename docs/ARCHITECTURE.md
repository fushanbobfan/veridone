# Architecture

## Shape

VeriDone is a TypeScript monorepo with a local Node service and a React web client.

```text
Browser
  -> typed local API
      -> domain engine
          -> SQLite repository
          -> Git adapter
          -> receipt adapters
          -> bounded check runner
          -> export renderer
```

The public deployment runs the same client and domain behavior against a clearly labeled synthetic workspace. Filesystem access and command execution are absent in hosted demo mode.

## Packages

- `apps/web` — responsive React UI, routes, accessibility, and browser tests.
- `apps/server` — loopback HTTP API, filesystem boundary, check process lifecycle, and persistence composition root.
- `packages/core` — framework-independent domain types, fingerprints, freshness, priority, gates, verdicts, and export manifests.
- `packages/adapters` — Git, generic receipt, harness receipt, CI, and filesystem implementations.
- `packages/ui` — shared accessible components and design tokens.
- `fixtures` — synthetic demo and test workspaces, never presented as real user data.

## Core domain

### Workspace

An operator-owned collection of approved roots, repositories, receipt sources, preferences, and export policy.

### Work item

A unit of work to review. It may originate from a receipt, commit range, branch, pull request, or manual title. Multiple source records can be linked without being trusted as evidence.

### Claim

An untrusted statement attributed to a source: tests passed, files changed, deployment succeeded, or a criterion is complete.

### Repository snapshot

A normalized, hashed record of repository identity, HEAD, branch, index/worktree status, relevant diff metadata, and configuration. It is the binding key for executable evidence.

### Acceptance contract

Versioned criteria plus declared checks. Criteria can require one or more evidence kinds and can never be satisfied by claim text alone.

### Evidence

An immutable record with source, timestamps, snapshot binding, procedure, result, artifact references, integrity hashes, and freshness state.

### Verdict

An append-only human decision bound to a work item, contract version, snapshot, and selected evidence. Later state does not rewrite history.

## Persistence

SQLite is the local source of truth. Migrations are versioned and tested. Large artifacts are stored in an application data directory by content hash; the database stores metadata and references. Atomic writes and foreign keys are required.

Workspace export is a versioned ZIP containing validated JSON, rendered summaries, selected artifacts, and a SHA-256 manifest. Import occurs into a staging namespace, validates every path and hash, and commits only after the full bundle passes.

## Fingerprints and freshness

A repository fingerprint includes:

- repository identity and canonical path hash;
- HEAD commit;
- index and worktree status entries;
- submodule state when present;
- acceptance contract version;
- check definition version.

Evidence is `fresh` only when its binding matches the current fingerprint and the check observed no mutation. It becomes `stale`, `mismatched`, `invalid`, or `unbound` for explainable reasons.

## Check execution

Checks are declared locally with an executable and argument array. The runner:

1. validates the declaration against policy;
2. resolves the working directory inside an approved repository;
3. captures the initial fingerprint and tool version;
4. spawns without a shell and with a minimal environment;
5. streams capped stdout/stderr with redaction;
6. enforces timeout and cancellation;
7. captures the final fingerprint;
8. stores evidence only after classifying mutation and exit state.

## API

The local API uses versioned routes and shared runtime schemas. Mutating requests require an origin check and per-process anti-CSRF token. Hosted demo mode exposes only synthetic read APIs and in-browser ephemeral interactions.

## Portability

The server supports Windows, macOS, and Linux. Path handling uses canonical platform-aware comparisons. CI covers all three operating systems for core and adapter behavior; browser E2E runs on Linux and a Windows smoke test validates process and path boundaries.
