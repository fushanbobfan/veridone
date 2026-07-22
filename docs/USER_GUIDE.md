# User guide

## 1. Connect evidence sources

Open **Add source** and approve a directory before connecting anything inside it. An approved root grants read access for repository discovery and receipt parsing; it never grants permission to execute imported text.

Connect a repository to capture its current Git state. You can discover repositories inside an approved root instead of typing paths. Preview and then import one agent receipt—or an atomic directory batch—to create reviewable work items. VeriDone accepts the local harness format and the portable format in [DATA_FORMAT.md](DATA_FORMAT.md).

## 2. Bind a claim

A new receipt is intentionally unbound. Select it and choose **Link to repository**. The binding records the current content-sensitive repository fingerprint. If the repository changes later, the claim and earlier evidence become stale until you explicitly rebind.

## 3. Approve checks

Choose **Approve a check** and enter:

- a human label and evidence kind;
- an executable and literal JSON argument array;
- the working directory relative to the repository;
- a literal version-argument array such as `["--version"]`;
- optional repository-relative path prefixes that define allowed change scope.

The entire definition is versioned. Editing policy means approving a new definition and invalidates evidence produced for the old check set.

Checks run without a shell, receive a minimal environment, and are bounded by a two-minute default timeout and 1 MB output cap. Two checks may run concurrently per service process. A running check exposes a cancel action. Cancellation, timeout, spawn error, output cap, ordinary failure, and repository mutation remain distinct evidence states.

## 4. Read readiness

The review surface distinguishes:

- import provenance;
- claim-to-repository binding;
- each approved check and its latest evidence;
- declared-scope inspection;
- sensitive-path attention flags;
- the human verdict.

Acceptance is locked until required checks are fresh and passing and any declared scope is satisfied. **Override lock** remains available for accountable exceptions and requires both a decision note and an override reason.

## 5. Decide

**Accept**, **Request changes**, and **Reject** append a verdict bound to the current fingerprint and contract. Prior verdicts are never overwritten. A later repository change leaves history intact while making the old decision superseded for the new state.

VeriDone never records an automated verdict. Even a fully green work item waits for a person.

## 6. Export or move the workspace

Use **Export packet** for a strict-privacy standalone HTML record. The workspace explorer offers HTML, Markdown, and JSON formats for decided items. JSON packets can be verified with `pnpm verify:packet`.

The settings button opens workspace backup and restore. Backups include approved roots, local paths, checks, evidence, and verdicts. Imports validate schema and SHA-256 integrity first, then merge transactionally by stable ID without deleting existing data.

## Keyboard and mobile use

- The first focusable link skips directly to the selected review.
- Dialog focus is trapped and returns to the trigger on close.
- Escape closes dialogs.
- Every required decision remains available in the 360 px decision dock.
- Theme cycles through system, light, and dark; reduced-motion system preferences disable nonessential animation.
