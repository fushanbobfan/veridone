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
- `packages/core` — framework-independent domain types, repository fingerprints, and declared-scope checks. It also exports criterion, freshness, and triage evaluators that only its unit tests call so far.
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

A normalized, hashed record of repository identity, HEAD, branch, index and worktree status, submodule status lines, and the content of changed and untracked files. Diff statistics are recorded beside it. It is the binding key for executable evidence.

### Acceptance contract

v1 ships one default contract: every approved check for the repository needs fresh passing evidence, and claim text never satisfies it. Versioned criteria that accept specific evidence kinds exist in `packages/core` and are not wired into the product yet.

### Evidence

An immutable record with source, timestamps, snapshot binding, procedure, result, artifact references, integrity hashes, and freshness state.

### Verdict

A human decision bound to a work item, contract version, repository fingerprint, claim hash, and selected evidence. Each work item's verdicts form a chain: every verdict names the one it supersedes and carries the next sequence number. SQLite accepts a verdict only at the head of its chain and refuses to change or delete one.

A verdict request carries the fingerprint, claim hash, and latest verdict the reviewer saw when the dialog opened. The server captures the repository again, then records the verdict in one immediate transaction only if all three still match; otherwise it answers 409 and names what changed. When the repository state changes later, the review view marks the earlier verdict superseded and opens the item for a new decision.

## Persistence

SQLite is the local source of truth. Migrations are versioned and tested. Evidence output is capped before persistence; the database stores redacted output plus content hashes. Foreign keys, WAL journaling, and transactional verdict/import writes are enabled, and triggers keep verdicts and evidence append-only.

Workspace export is versioned JSON containing supported domain records and a SHA-256 payload hash. Restore checks the hash over the payload as written and validates the schema, then adds what the workspace lacks in one transaction. Existing records stay as they are; evidence and verdicts that share an ID with a local record must match it exactly; verdicts replay in chain order through the same append path as new verdicts. A conflicting backup is refused as a whole. Restored evidence is marked imported and satisfies no gate, and restored checks need their tools pinned before they run.

## Fingerprints and freshness

A repository content fingerprint includes:

- repository identity and canonical path hash;
- HEAD commit;
- index and worktree status entries;
- submodule commits when present; uncommitted changes inside a submodule's work tree are outside the fingerprint;
- raw staged diff and byte hashes for modified and untracked working files; files matched by `.gitignore` are outside the fingerprint.

Acceptance-policy versions are checked separately from repository content. Evidence is `fresh` only when this workspace produced it in a clean checkout, repository identity, HEAD, content fingerprint, contract version, and aggregate check-definition version match, and the check changed nothing in its checkout. It becomes `stale`, `mismatched`, `invalid`, or `unbound` for explainable reasons.

## Git invocation

VeriDone resolves Git once per process, from `VERIDONE_GIT` or the absolute `PATH` entries, and starts it by that absolute path from a directory outside every repository. Each process gets a fixed configuration through command-scope settings, which outrank every configuration file: no system or global configuration files, no optional index writes, replace objects ignored, file transport only, fsmonitor off, an empty hooks directory, and every filter driver the repository's configuration defines blanked. For the operator's repositories, VeriDone carries over the operator's settings that decide how working files compare with the index (line endings, file mode, case and Unicode normalization, symlinks, long paths, stat comparison, excludes and attributes files) so status matches the operator's own Git; safe directories carry over only from the operator's own system and global configuration. Status and diffs compare submodules by commit; `git submodule status`, which runs only when the repository has a `.gitmodules` file, reads each populated submodule's commit under the same settings. Diffs run without external diff or textconv programs.

## Check execution

Checks are declared locally with an executable and argument array. Approval resolves the executable once to a canonical file outside the repository (a command name is searched on the absolute `PATH` entries; any other name must be an absolute path) and records its SHA-256 as part of the check definition. Pinning a tool again reports the file and hash it would record, and records them only if the operator's request names that same file and hash. The runner:

1. captures the repository and refuses to run unless the claim's binding is current and the work tree has no uncommitted changes;
2. hashes the pinned tool and refuses to run if the file changed since approval, and hashes it again just before starting it;
3. fetches the bound commit into a new repository in a temporary directory, verifies that it received exactly that commit, and checks it out; the transfer recomputes every object hash, and nothing from the operator's work tree, index, ignored files, or configuration reaches the checkout;
4. resolves the working directory inside the checkout and captures the tool version;
5. spawns the pinned file without a shell, with a minimal environment whose `PATH` keeps only absolute entries;
6. streams capped stdout/stderr with redaction and enforces timeout, cancellation, output cap, and service-wide concurrency;
7. requires the checkout's HEAD to still be the bound commit, compares its work tree with a fresh index read from that commit, lists new files its own `.gitignore` files do not cover, and hashes the tool once more; a moved HEAD, a changed or new file, a changed tool, or a comparison that cannot run marks the evidence mutated; then removes the checkout;
8. stores evidence with its isolation, tool path, and tool hash.

## API

The local API uses versioned routes and runtime schemas. Mutating requests require an origin check and per-process anti-CSRF token. A static deployment falls back to labeled synthetic records and keeps demo verdict interactions ephemeral in the browser.

## Portability

The server supports Windows, macOS, and Linux. Path handling uses canonical platform-aware comparisons. The CI matrix exercises core, API, path, and process behavior on all three operating systems; browser E2E runs separately on Linux.
