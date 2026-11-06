# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

### Added

- **Checks** in the navigation lists each approved check with its pinned tool, arguments, and hash, and pins a tool again after the operator reviews it.
- Packets are signed with an Ed25519 key that the workspace creates on first use and leaves out of backups. **Download the packet signing key**, under backup and restore, saves the public key, and `pnpm verify:packet <packet.json> --key <public-key.pem>` checks that this key signed a packet. Packets written by VeriDone 1.1 and earlier still verify, as unsigned, and the verifier refuses a signing key of any other type.
- A check can name setup arguments that its pinned tool runs in the checkout before the check, with a ten-minute timeout, for example a frozen `pnpm install`. A setup that fails ends the run with its own exit code and output, files it writes outside ignored paths mark the evidence mutated, and a check without setup keeps its definition hash. Stored stdout and stderr each stay within the check's output limit in UTF-8 bytes, with the setup's part cut first.
- Restoring a backup first lists the roots, repositories, checks, and work items it would add, with the evidence and verdict counts, and writes nothing until the operator confirms; `POST /api/v1/workspace/preview` returns the same list.
- **Roots** in the workspace explorer lists each root with its state and approves a root restored from a backup.
- Packets name each check's command, setup command, working directory, and tool hash, and give the test counts from the last summary that node:test, Vitest, Jest, or pytest printed. A pytest summary that reports `157 subtests passed` is read with that part left out of the counts.
- **Replace** and **Retire** under **Checks** change a repository's policy. A definition stays fixed once approved, apart from pinning its tool again, so Replace opens the approval form filled in from the old check, then approves the new one and retires the old one in one step, and Retire takes a check out of the gate with a reason. The record and its evidence stay, packets show when it retired and why, and evidence counts only under the set of checks it ran with. A check that cannot be pinned, that needs a setup step in the clean checkout, or that was approved by mistake no longer holds the gate for good.
- The review shows what a check's latest run printed: **Show output** reads the end of each stream from `GET /api/v1/evidence/:id/output`. The bootstrap leaves output out, so polling no longer carries every run's output.
- The check dialog sets the timeout and the output limit, and **Manage checks** in the review opens **Checks**.

### Changed

- The check dialog suggests `node --test`, which runs in a clean checkout without installed dependencies.
- A declared scope of `./` means the whole repository and is stored as no scope.
- A work item's verdicts are listed by their place in the chain, so a packet heads its verdict history with the latest verdict whatever the clocks recorded.
- A repository capture skips `git submodule status` when the repository has no `.gitmodules` file; on Windows that script took about 1.7 seconds of every capture.
- Updated `motion` to 12.43.0, `lucide-react` to 1.59.0, `@hono/node-server` to 2.1.5, `@playwright/test` to 1.64.1, and `jsdom` to 30.1.3. jsdom 30, which the unit tests use, supports Node.js 22.22.2 or a later 22.x, 24.15 or a later 24.x, and 26 or later.
- Acceptance packets are schema version 2: identifiers are pseudonyms, a `checks` section and per-evidence `testCounts` are added, the payload hash covers keys in UTF-16 code-unit order (the RFC 8785 order), and the manifest carries the signature. Markdown and HTML render from one view of the JSON packet, so the HTML packet now carries the source, fingerprint, contract clauses, checks, and test counts as the Markdown packet does.
- The service computes each work item's readiness and sends it with the bootstrap, and the verdict gate and the review view use that one result. In the review score, the receipt of a degraded run counts as a failed gate.
- `packages/core` keeps the domain types, fingerprints, and declared-scope checks; the criterion, freshness, and triage evaluators and six schemas that only their own tests used are removed.

### Fixed

- A verdict is recorded on the work item the reviewer opened. The background refresh used to reset the selection to the first work item every 15 seconds, so a verdict written for one item could be recorded on another, and a local `?review=` deep link was lost on load.
- The verdict dialog names the work item, repository, commit, and fingerprint it records against.
- After the repository changes, an earlier verdict is marked superseded and the work item opens for a new decision. Accepting with every gate passing records a plain acceptance; the server stores an override reason only while required gates are open.
- Light-theme status, kicker, and diff text use a darker accent that meets WCAG AA contrast.
- A receipt whose time has no UTC offset, such as `2026-07-21 13:00:00`, imports as the machine's local time with an offset, and workspace export accepts receipts an earlier version stored that way. Receipt import and the workspace backup share one set of field rules, so a receipt that imports also exports; a time that is not a timestamp is refused at import.
- A receipt time with a UTC offset that stops at the minute, such as `2026-07-21T13:00Z`, still imports, exports, and restores: zod 4.5 and later require seconds, so VeriDone adds `:00`.
- The source dialog kept the previous discovery list while a new discovery ran, so a repository chosen from it could be replaced by the first repository of the new answer, and the dialog connected a repository other than the one chosen. Discovery now hides the previous list until it answers, drops an answer that a newer discovery replaced, and keeps a chosen repository that the new list still contains.
- The source dialog opens idle after an add closed it during a discovery; the button used to read "Discovering…" until it was pressed again.
- One approved root whose folder is gone stops nothing under the other roots. **Roots** marks it, and repositories under it report the reason in plain words.
- A verdict records while the repository cannot be read: a rejection, a change request, and an override bind to the last state captured, and a plain acceptance is refused with the reason.
- A backup restores up to 500 MB, up from 25 MB, and export refuses to write a larger one and names the data directory to copy. Evidence is never deleted, so a backup used to outgrow what restore read.
- An agent that writes each run's receipt to one file can import every run. The second used to fail with a database error, since a receipt's file path had to be unique.
- A backup carries what earlier versions stored and today's import refuses: a long run id, status, or task type, or a time that is no timestamp. One such record used to stop export altogether.
- Refusals say what to do next: a missing path, `VERIDONE_GIT` naming nothing, no approved root, more than 10,000 changed files, and a tool that cannot be pinned, which used to send the operator back to pin it.
- One check that refuses to start no longer keeps the review's other checks from running, and an empty workspace offers **Restore a backup** on its first screen.

### Security

- A verdict is a compare-and-swap write. The verdict dialog keeps the repository fingerprint, claim hash, and latest verdict it showed when it opened; the server captures the repository again at decision time and records the verdict in one transaction only if all three still match, otherwise it answers 409 and says what changed. The dialog also refuses to submit once the workspace it shows has moved on. Each verdict records the claim hash it judged, and re-importing a receipt can no longer rewrite the claim of a work item that already has a verdict.
- Verdicts and evidence are append-only in the database itself: each work item's verdicts form a chain in which every verdict names the one it supersedes, SQLite accepts a new verdict only at the head of that chain, and it refuses any update or deletion of a verdict or evidence record. Workspace restore now adds what the workspace lacks: existing records stay as they are, evidence and verdicts with a known ID must match exactly, and each work item's verdicts replay in chain order through the same append path, so a backup can extend a history while recorded verdicts keep their content, and a verdict must judge the claim the local work item shows. A conflicting backup is refused as a whole. Restored evidence is marked imported and stays history without satisfying a gate, restored checks must have their tools pinned before they run, and their definition hashes are recomputed from the restored fields. Backups are written as schema version 2; version 1 backups still restore.
- Approving a check pins its tool. The executable resolves once to a canonical file outside the repository (a command name is searched on the absolute `PATH` entries; any other name must be an absolute path), and the file's SHA-256 becomes part of the check definition. Every run hashes the file again just before starting it and refuses to start if it changed, and hashes it once more after the run. **Pin tool again** under **Checks** shows the file and SHA-256 that would be pinned and pins only that file. A different file is a new definition, so evidence from the old tool stops satisfying the gate. Evidence records the tool path and SHA-256, and packets carry the hash. Checks approved before this change must be pinned before they run. A check's `PATH` keeps only absolute entries, and on Windows the programs it starts by name are not looked up in its working directory.
- Approved checks run in a checkout that VeriDone creates from the bound commit in its own temporary directory, so uncommitted changes, ignored files, build output, and Git configuration in the operator's repository cannot reach a check. Files are checked out as committed, without submodules or the operator's line-ending conversion, and a check that needs dependencies installs them itself. Checks refuse to start while the repository has uncommitted changes. After the run, VeriDone requires the checkout's HEAD to still be the bound commit and compares its work tree with a fresh index read from that commit, so a check that edits, commits, or hides a change in its checkout is recorded as mutated. Evidence recorded before this change no longer satisfies a gate. A SHA-256 repository gets a SHA-256 checkout.
- VeriDone starts Git by an absolute path found on the absolute `PATH` entries (or set with `VERIDONE_GIT`), from a directory outside every repository, and gives it a fixed configuration. System and global Git configuration are ignored except for settings that decide how files compare, such as line endings; a repository's fsmonitor hook, filter commands, hooks, and external diff or textconv programs never run, and safe directories come only from the operator's own configuration. Git 2.32 or later is required.
- Updated `hono` to 4.13.13, `vite` to 8.1.6, `vitest` to 4.1.12, and `concurrently` to 10.0.6, and pinned patched transitive `undici`, `postcss`, `nanoid`, and `source-map-js`; `pnpm audit --audit-level low` reports no known vulnerabilities.
- Updated `zod` to 4.6.7 for GHSA-mrhx-c7xc-m3w5, in which validating an oversized constrained collection could exhaust memory.
- The API answers 403 to a request whose `Host` header, or the host of an absolute request URL, names anything other than its loopback names on its port or the host of an allowed origin. A web page that points its own domain name at 127.0.0.1 reads nothing from the API, the anti-CSRF token included.
- Redaction covers secret names that end an identifier, such as `NPM_TOKEN` and `AWS_SECRET_ACCESS_KEY`, quoted values that hold spaces, escaped quotes or escaped line breaks or lack their closing quote, values joined from adjacent quoted or escaped parts, as in `'alpha'"beta"`, the value after an option named for a secret, fine-grained GitHub, GitLab, Slack, and npm tokens, AWS key ids, JWTs, bearer values, and private key blocks, including one that the output cap cut off. Every text in a packet passes through these rules, a restored contract's included, and also loses quoted paths up to their closing quote, Windows paths written with forward slashes or escaped as in JSON, paths whose folders hold spaces, UNC paths, home-relative paths, and paths under `/mnt`, `/srv`, `/root`, `/Volumes`, `/private`, and `/media`. Each pattern takes linear time on hostile check output.
- Packets redact the local paths the workspace knows: its home and temporary directories, approved roots, pinned tools, repositories, and pending roots. A known path matches wherever a text names it, right after a command-line flag or a local URL's host included, and in each form text writes it: either separator, JSON escapes, quotes, file URLs with percent-encoding in either case, a shell's backslash escapes, a POSIX shell's name for a Windows drive, `~` or `$HOME` for a path under home, and the other name the system gives the home or temporary directory, such as a Windows short name or macOS's `/var`. Known paths go before credentials, so an assignment that holds one keeps none of it, and what follows a known path inside it goes with it, read as Windows or a POSIX shell reads a path, by how the path's root is written, the rest of a last segment the text goes on in, as in `project copy/x`, included. A known path is redacted whole when a folder name in it holds a space, and a POSIX path outside the listed prefixes, such as `/work/clients/acme`, is redacted when an approved root holds it. Every string in a packet's payload passes through the sanitizer, the evidence fields that a restored backup can set included, and a Windows path ends at `;`, so each entry of a PATH list is redacted. A packet text longer than a million characters appears as `[REDACTED: text too long to sanitize]`.
- Redacting check output finishes on any text up to the largest output limit, ten million bytes. One long credential value, token, or bearer value used to throw, from about 5.6 million characters, so the run's evidence was never recorded, and the JWT pattern took quadratic time on `eyJ-eyJ-…`, 14 minutes at the default limit of one million bytes on the thread that serves requests. Every text the old patterns could read gets the same output.
- Exporting a packet finishes on any check output up to the largest output limit, on both streams. One long line in a text that holds a character past Latin-1 used to throw in the test summary, from about 8.4 million characters, so the export answered 400. The summary's patterns now read no line past 65,536 characters, color codes aside, so they skip pytest's summary line when a `COLUMNS` setting pads it past that length.
- Packets carry the repository id, fingerprint, worktree hash, claim hash, check-definition hashes, and artifact hashes as HMAC-SHA256 pseudonyms under a workspace key that backups leave out. The repository id hashes the local path and the others take local data as inputs, so each raw value would let a reader confirm a guessed path or file.
- A root restored from a backup stays pending until the operator approves it: discovery refuses it, and nothing under it counts as approved. Approval resolves the path again and refuses one that is missing or now resolves somewhere else.
- Accepting a work item whose receipt reports a failed or incomplete stage requires an override reason; the server used to record such an acceptance as a plain one. The receipt is found by its exact run id.

### Documentation

- Workspace checksums are described as unsigned integrity checks; verdict history, fingerprint coverage, and the default contract are described as implemented; `docs/ACCEPTANCE.md` maps each criterion to its test or manual evidence.
- The architecture, security model, data formats, installation notes, and user guide describe the clean checkout, tool pinning, Git invocation, compare-and-swap verdicts, and append-only restore, with the limits of each; `docs/ACCEPTANCE.md` adds VER-07 to VER-09, DEC-04, and EXP-05 with their tests.
- The README, security model, architecture, data formats, and user guide describe the Host allowlist, redaction, pseudonyms, packet signatures and what they prove, the restore preview, pending roots, setup steps, and server-computed readiness; `docs/ACCEPTANCE.md` adds ONB-07 and VER-10 with their tests.

## [1.1.0] - 2026-07-22

### Added

- Added an explicit repository-binding dialog that requires an operator choice and shows branch, full commit, path, worktree state, and fingerprint before a claim is bound.
- Published strict-privacy review packets and a reproducible report from maintainer dogfooding across Gravity Garden and three public micro-labs.
- Added a privacy-preserving external tester guide and structured dogfood feedback form.

### Changed

- Expanded the real-browser onboarding fixture to prove correct claim binding when multiple repositories are connected.

## [1.0.2] - 2026-07-21

### Fixed

- Aligned the contribution guide with the enforced v1 security boundary: the service rejects all non-loopback bind addresses and does not support remote or multi-user deployment.

## [1.0.1] - 2026-07-21

### Security

- Pinned patched transitive versions for the `shell-quote` denial-of-service advisory and the Windows `esbuild` development-server file-read advisory.
- Expanded the local and three-platform CI dependency gate from high-severity production findings to every published advisory across production and development dependencies.

## [1.0.0] - 2026-07-21

### Added

- Local-first acceptance desk with SQLite persistence and approved-root onboarding.
- Content-sensitive Git fingerprints, freshness classification, risk paths, and declared-scope gates.
- Previewed single-file and atomic-directory import for harness and portable Codex/Claude Code/CI receipts.
- Safe approved-check runner with cancellation, concurrency, mutation detection, output bounds, redaction, tool version, and exit status.
- Append-only human verdicts with explicit override reasons.
- Deterministic verified JSON, Markdown, and standalone HTML acceptance packets.
- Transactional integrity-checked workspace backup and restore.
- Responsive keyboard-complete UI, persistent themes, reduced motion, synthetic public demo, and workspace explorer.
- Windows/macOS/Linux CI, Chromium/Firefox/WebKit acceptance tests, axe WCAG scans, CodeQL, dependency audit, license policy, and secret scan.

[1.1.0]: https://github.com/fushanbobfan/veridone/releases/tag/v1.1.0
[1.0.2]: https://github.com/fushanbobfan/veridone/releases/tag/v1.0.2
[1.0.1]: https://github.com/fushanbobfan/veridone/releases/tag/v1.0.1
[1.0.0]: https://github.com/fushanbobfan/veridone/releases/tag/v1.0.0
