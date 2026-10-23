# User guide

## 1. Connect evidence sources

Open **Add source** and approve a directory before connecting anything inside it. An approved root grants read access for repository discovery and receipt parsing; it never grants permission to execute imported text.

Connect a repository to capture its current Git state. You can discover repositories inside an approved root instead of typing paths. Preview and then import one agent receipt—or an atomic directory batch—to create reviewable work items. VeriDone accepts the local harness format and the portable format in [DATA_FORMAT.md](DATA_FORMAT.md).

## 2. Bind a claim

A new receipt is intentionally unbound. Select it and choose **Link to repository**. VeriDone never guesses from receipt text or silently chooses the first connected repository: the binding dialog starts empty and requires you to inspect and select the intended repository. It shows the repository path, branch, full commit, clean or dirty state, and fingerprint before you confirm.

The binding records the current content-sensitive repository fingerprint. It establishes which worktree the claim concerns; it does not turn the imported claim into proof. If the repository changes later, the claim and earlier evidence become stale until you explicitly rebind.

Checks run on the bound commit, so commit the work before you bind it for checking. While the work tree has uncommitted changes, the review says so and checks refuse to start.

## 3. Approve checks

Choose **Approve a check** and enter:

- a human label and evidence kind;
- an executable and literal JSON argument array;
- the working directory relative to the repository;
- a literal version-argument array such as `["--version"]`;
- optional repository-relative path prefixes that define allowed change scope.

The entire definition is versioned. Editing policy means approving a new definition and invalidates evidence produced for the old check set.

Name the executable by an absolute path or by a command name on `PATH`. Approval pins it: VeriDone resolves it once to a file outside the repository and records that file's SHA-256 in the definition. On Windows the file must be an `.exe` or `.com`; run scripts through an interpreter, such as `node scripts/test.mjs`. **Checks** in the navigation lists every check with its pinned tool, arguments, and hash. When a tool is updated, the next run refuses to start. Choose **Pin tool again** to see the file and SHA-256 that would be pinned, check them, and choose **Pin this file**; if a different file resolves by then, VeriDone refuses and you review again. Pinning a different file is a new definition, so evidence from the old tool stops counting.

Each run happens in a fresh checkout of the bound commit that VeriDone creates in a temporary directory and removes afterwards. The checkout holds the committed files only: no uncommitted changes, ignored files, build output, installed dependencies, or submodules. A check that needs dependencies installs them itself, for example with a package manager command that installs from the lockfile and then runs the tests.

Checks run without a shell, receive a minimal environment, and are bounded by a two-minute default timeout and 1 MB output cap. Two checks may run concurrently per service process. A running check exposes a cancel action. Cancellation, timeout, spawn error, output cap, ordinary failure, and a check that changes files in its checkout remain distinct evidence states.

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

**Accept**, **Request changes**, and **Reject** append a verdict bound to the current fingerprint and contract. The verdict dialog names the work item, commit, and fingerprint it records against. Recording a decision never edits an earlier verdict. After the repository changes, the review view marks the earlier verdict superseded and the item can be decided again; the history keeps both.

The dialog holds on to the state it showed when it opened: the repository fingerprint, the claim, and the latest verdict. If any of them changes before you record your decision, the dialog says so and the service refuses the verdict; close the dialog, review the current state, and decide again.

VeriDone never records an automated verdict. Even a fully green work item waits for a person.

## 6. Export or move the workspace

Use **Export packet** for a strict-privacy standalone HTML record. The workspace explorer offers HTML, Markdown, and JSON formats for decided items. JSON packets can be verified with `pnpm verify:packet`.

The settings button opens workspace backup and restore. Backups include approved roots, local paths, checks, evidence, and verdicts. Restore validates the schema and SHA-256 integrity first, then adds the records the workspace lacks in one transaction. Records that already exist stay as they are, recorded verdicts and evidence keep their content, and a backup that conflicts with them is refused as a whole. Restored evidence stays visible as history but passes no gate, so run the checks again, and pin the tools of restored checks before they run. The checksum detects accidental damage and carries no signature, so restore only backups you made or received through a channel you trust.

## Keyboard and mobile use

- The first focusable link skips directly to the selected review.
- Dialog focus is trapped and returns to the trigger on close.
- Escape closes dialogs.
- Every required decision remains available in the 360 px decision dock.
- Theme cycles through system, light, and dark; reduced-motion system preferences disable nonessential animation.
