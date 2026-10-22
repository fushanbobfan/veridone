# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [Unreleased]

### Fixed

- A verdict is recorded on the work item the reviewer opened. The background refresh used to reset the selection to the first work item every 15 seconds, so a verdict written for one item could be recorded on another, and a local `?review=` deep link was lost on load.
- The verdict dialog names the work item, repository, commit, and fingerprint it records against.
- After the repository changes, an earlier verdict is marked superseded and the work item opens for a new decision. Accepting with every gate passing records a plain acceptance; the server stores an override reason only while required gates are open.
- Light-theme status, kicker, and diff text use a darker accent that meets WCAG AA contrast.

### Security

- A verdict is a compare-and-swap write. The verdict dialog keeps the repository fingerprint, claim hash, and latest verdict it showed when it opened; the server captures the repository again at decision time and records the verdict in one transaction only if all three still match, otherwise it answers 409 and says what changed. The dialog also refuses to submit once the workspace it shows has moved on. Each verdict records the claim hash it judged, and re-importing a receipt can no longer rewrite the claim of a work item that already has a verdict.
- Verdicts and evidence are append-only in the database itself: each work item's verdicts form a chain in which every verdict names the one it supersedes, SQLite accepts a new verdict only at the head of that chain, and it refuses any update or deletion of a verdict or evidence record. Workspace restore now only adds what the workspace lacks: existing records stay as they are, evidence and verdicts with a known ID must match exactly, and each work item's verdicts replay in chain order through the same append path, so a backup can extend a history but not rewrite it. A conflicting backup is refused as a whole. Restored evidence is marked imported and stays history without satisfying a gate, restored checks must have their tools pinned before they run, and their definition hashes are recomputed from the restored fields. Backups are written as schema version 2; version 1 backups still restore.
- Approving a check pins its tool. The executable resolves once to a canonical file outside the repository (a command name is searched on the absolute `PATH` entries; any other name must be an absolute path), and the file's SHA-256 becomes part of the check definition. Every run hashes the file again and refuses to start if it changed; the operator reviews the new version and pins it again under **Checks**. A different file is a new definition, so evidence from the old tool stops satisfying the gate. Evidence records the tool path and SHA-256, and packets carry the hash. Checks approved before this change must be pinned before they run. A check's `PATH` keeps only absolute entries, and on Windows the programs it starts by name are not looked up in its working directory.
- Approved checks run in a checkout that VeriDone creates from the bound commit in its own temporary directory, so uncommitted changes, ignored files, build output, and Git configuration in the operator's repository cannot reach a check. Files are checked out as committed, without submodules or the operator's line-ending conversion, and a check that needs dependencies installs them itself. Checks refuse to start while the repository has uncommitted changes. A check that changes files in its checkout is recorded as mutated, and evidence recorded before this change no longer satisfies a gate.
- VeriDone starts Git by an absolute path found on the absolute `PATH` entries (or set with `VERIDONE_GIT`), never from the repository directory, and gives it a fixed configuration. System and global Git configuration are ignored except for settings that decide how files compare, such as line endings; a repository's fsmonitor hook, filter commands, hooks, and external diff or textconv programs never run. Git 2.32 or later is required.
- Updated `hono` to 4.13.13, `vite` to 8.1.6, `vitest` to 4.1.12, and `concurrently` to 10.0.6, and pinned patched transitive `undici`, `postcss`, `nanoid`, and `source-map-js`; `pnpm audit --audit-level low` reports no known vulnerabilities.

### Documentation

- Packet and workspace checksums are described as unsigned integrity checks; verdict history, fingerprint coverage, and the default contract are described as implemented; `docs/ACCEPTANCE.md` maps each criterion to its test or manual evidence.

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
