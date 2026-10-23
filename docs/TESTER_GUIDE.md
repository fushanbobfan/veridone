# External tester guide

This guide is for maintainers who use coding agents and want to evaluate VeriDone on one repository without sharing source code, command output, or a workspace backup.

## What you will test

The guided flow checks whether VeriDone can keep three things separate:

- an agent's untrusted completion claim;
- fresh evidence captured from the exact local Git snapshot; and
- a decision that only you can record.

VeriDone is loopback-only and has no telemetry. It does not upload your repository. Approved checks still run with your local OS permissions, so use a non-sensitive test repository and a command you already trust.

## Set up

Prerequisites: Git, Node.js 22+, and pnpm 11.9.0.

```bash
git clone https://github.com/fushanbobfan/veridone.git
cd veridone
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:4173`.

## Run one review

1. Choose a non-sensitive Git repository with a safe, deterministic test command.
2. In VeriDone, add the repository's parent directory as an approved root, then discover and connect the repository.
3. Save the following portable receipt inside that approved root, editing the title, claim, and timestamps to describe one real agent-assisted change:

   ```json
   {
     "schema_version": 1,
     "run_id": "manual-evaluation-001",
     "source": "generic",
     "title": "Verify one agent-assisted change",
     "claim": "The agent reports that the requested change is complete and tests pass.",
     "status": "complete",
     "started_at": "2026-07-22T19:00:00.000Z",
     "completed_at": "2026-07-22T19:05:00.000Z",
     "stages": [{ "name": "tests", "status": "passed" }]
   }
   ```

4. Import the receipt. Confirm that the claim appears as reported context, not passing evidence.
5. Select **Link to repository**. Inspect the branch, full commit, path, worktree state, and fingerprint, then choose the intended repository.
6. Select **Approve a check**. Enter only a test command you already trust. VeriDone uses an executable plus a literal JSON argument array, pins the executable file by its SHA-256, and never turns receipt text into a command.
7. Run the approved check. It runs in a fresh checkout of the bound commit, so commit the work first. Inspect the captured result, tool version, exit status, freshness, and scope signals.
8. Record a verdict only if the evidence supports your own decision. A green check must never decide for you.
9. Export a JSON packet and run `pnpm verify:packet path/to/packet.json`.

## High-value failure tests

If you are comfortable continuing, try one or more of these safe cases:

- connect two repositories and confirm VeriDone never preselects one for an unbound claim;
- change a tracked or untracked file after evidence is captured and confirm prior evidence becomes stale;
- approve a deliberately failing command and confirm acceptance remains locked;
- cancel a long-running safe check and confirm cancellation is distinct from failure;
- export the same unchanged review twice and confirm the packet payload hash is deterministic.

## Send useful feedback without sending private data

Use the [dogfood feedback form](https://github.com/fushanbobfan/veridone/issues/new?template=dogfood-feedback.yml). Helpful feedback includes:

- OS, Node version, and VeriDone version or commit;
- which step was confusing or surprisingly clear;
- whether the repository-binding information was sufficient;
- which safe check type you used and whether the state matched your expectation; and
- the packet payload hash, only if you want to share it.

Do not attach workspace backups, raw command output, repository files, credentials, private receipt text, or undisclosed vulnerability details. Report security issues privately through [SECURITY.md](../SECURITY.md).
