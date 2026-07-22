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

- `apps/web` — responsive React UI, URL-backed review state, accessibility, and browser tests.
- `apps/server` — loopback HTTP API, filesystem boundary, check process lifecycle, and persistence composition root.
- `packages/core` — framework-independent domain types, fingerprints, freshness, priority, gates, verdicts, and export manifests.
- `packages/adapters` — Git, portable/harness receipt, path-boundary, and bounded-process implementations.
- `e2e` — isolated repository/receipt fixtures created at runtime plus browser acceptance tests.

## Core domain

### Workspace

An operator-owned collection of approved roots, repositories, receipt sources, preferences, and export policy.

### Work item

A unit of work to review. In v1 it originates from a portable or harness receipt and can be linked to a current repository snapshot without treating the receipt as evidence.

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

SQLite is the local source of truth. Migrations are versioned and tested. Evidence output is capped before persistence; the database stores redacted output plus content hashes. Foreign keys, WAL journaling, and transactional verdict/import writes are enabled.

Workspace export is versioned JSON containing supported domain records and a SHA-256 payload hash. Import validates the complete schema and integrity hash before a single SQLite transaction merges stable IDs. It does not delete existing records.

## Fingerprints and freshness

A repository content fingerprint includes:

- repository identity and canonical path hash;
- HEAD commit;
- index and worktree status entries;
- submodule state when present;
- raw staged diff and byte hashes for modified/untracked working files.

Acceptance-policy versions are checked separately from repository content. Evidence is `fresh` only when repository identity, HEAD, content fingerprint, contract version, and aggregate check-definition version match and the check observed no mutation. It becomes `stale`, `mismatched`, `invalid`, or `unbound` for explainable reasons.

## Check execution

Checks are declared locally with an executable and argument array. The runner:

1. validates the declaration, working directory, version arguments, and scope prefixes against policy;
2. resolves the working directory inside an approved repository;
3. captures the initial fingerprint and tool version;
4. spawns without a shell and with a minimal environment;
5. streams capped stdout/stderr with redaction;
6. enforces timeout, cancellation, output cap, and service-wide concurrency;
7. captures the final fingerprint;
8. stores evidence only after classifying mutation and exit state.

## API

The local API uses versioned routes and runtime schemas. Mutating requests require an origin check and per-process anti-CSRF token. A static deployment falls back to labeled synthetic records and keeps demo verdict interactions ephemeral in the browser.

## Portability

The server supports Windows, macOS, and Linux. Path handling uses canonical platform-aware comparisons. The CI matrix exercises core, API, path, and process behavior on all three operating systems; browser E2E runs separately on Linux.
