# Security model

## Trust boundaries

VeriDone reads repositories, agent receipts, CI metadata, logs, and exported bundles. Every one of these is untrusted input. The application must display them safely and must never follow instructions embedded in them.

The repository under review is writable by the agent whose work it holds: its work tree, ignored files, index, and Git configuration can all change between the agent's claim and the human's decision. VeriDone reads that state to bind a claim, but it produces evidence from its own checkout of the bound commit.

The local operator is trusted to approve roots, define checks, pin their tools, and issue verdicts. A passing process is not trusted to prove more than the declared check measured.

## Primary threats and controls

### Imported command execution

**Threat:** a receipt contains a command or prompt that attempts to trigger execution.

**Control:** imported commands are inert strings. Only operator-authored check declarations are executable. The process API accepts stored check IDs, not arbitrary command text.

### Agent-writable repository state

**Threat:** the repository's Git configuration names programs that Git runs (an fsmonitor hook, filter commands), a file in the repository shadows a program started by name, or uncommitted and ignored files change what a check observes.

**Control:** VeriDone starts Git by an absolute path, resolved once from `VERIDONE_GIT` or the absolute `PATH` entries, from a directory outside every repository. Git runs with a fixed command-scope configuration that outranks every configuration file: no system or global configuration files, fsmonitor off, an empty hooks directory, every filter driver the repository defines blanked, file transport only, replace objects ignored, and no optional index writes. Only settings that decide how files compare (line endings, file mode, case and Unicode normalization, symlinks, long paths, stat comparison, excludes and attributes files) carry over with their effective values, and safe directories carry over only from the operator's own system and global configuration. Diffs run without external diff or textconv programs. Status and diffs compare submodules by commit; `git submodule status`, which runs only when the repository has a `.gitmodules` file, reads each populated submodule's commit and description under the same fixed settings.

Checks run in VeriDone's own checkout: each run fetches the bound commit into a new repository in a temporary directory, verifies that it received exactly that commit, and checks it out with the fixed configuration and no hooks. Git recomputes every object hash during the fetch. Checks refuse to start while the operator's work tree has uncommitted changes.

### Tool substitution

**Threat:** the program behind an approved check changes after approval, or a bare command name resolves to a different file at run time.

**Control:** approval resolves the executable once to a canonical file outside the repository and records its SHA-256 in the check definition. Each run hashes that file again immediately before starting it, refuses to start on a mismatch, starts the pinned path, and hashes the file once more after the run; a tool that changed in between makes the evidence mutated. Evidence records the tool path and hash. Pinning a tool again shows the operator the file and hash that would be recorded and pins only that file. The check's `PATH` keeps only absolute entries, and on Windows its child programs are not looked up in the working directory.

### Path traversal and symlink escape

**Threat:** crafted paths access files outside approved roots or escape during export/import.

**Control:** canonicalize existing paths, compare with platform-aware root boundaries, reject symlink escapes and traversal, and re-check boundaries immediately before access.

### Local web attacks

**Threat:** a hostile website calls the loopback API, or the UI renders injected content.

**Control:** loopback binding, strict Origin allowlist, per-process anti-CSRF token, restrictive CORS/CSP, secure response headers, JSON content types, React escaping, and sanitized standalone HTML exports.

### Shell injection

**Threat:** configuration values are interpolated into a shell command.

**Control:** spawn executables directly with argument arrays and `shell: false`; validate working directories and environment keys; never concatenate command strings.

### Secret leakage

**Threat:** logs or bundles expose tokens, environment secrets, home paths, or repository credentials.

**Control:** minimal environment, key-pattern and value redaction, output limits, export allowlists, path privacy modes, no `.git` object export, and a pre-export secret scan. Packets carry each tool's hash and leave its local path out.

### Stale or forged evidence

**Threat:** old results or edited artifacts are presented as current.

**Control:** bind evidence to repository and check-definition fingerprints, hash each check result, recompute packet and workspace checksums when they are verified or imported, classify source provenance, and never upgrade unbound imported claims into executable evidence. Evidence restored from a backup is marked imported and never satisfies a gate. The checksums detect accidental changes. They are unsigned, so a party who can edit a packet or backup can also recompute its checksum; trust exported files only through a channel you control.

### A decision on a state the reviewer did not see

**Threat:** the repository, the claim, or the verdict history changes between the moment a reviewer opens a verdict and the moment it is recorded.

**Control:** the verdict request carries the fingerprint, claim hash, and latest verdict the reviewer saw. The server captures the repository again and records the verdict in one immediate transaction only if all three still match; otherwise it answers 409. A receipt cannot change the claim of a work item that already has a verdict.

### Rewritten history

**Threat:** a restored backup or a direct write replaces a recorded verdict or evidence record.

**Control:** SQLite triggers accept a verdict only as the successor of the latest verdict on its work item and refuse any update or deletion of verdicts and evidence. Restore adds the records the workspace lacks, requires evidence and verdicts with a known ID to match exactly, and replays verdicts through the same append path; a conflicting backup is refused as a whole.

### Check changes its own inputs

**Threat:** a test or build modifies tracked or untracked files, making its own result ambiguous.

**Control:** after the run, VeriDone names the checkout's repository and work tree explicitly, requires its HEAD to still be the bound commit, compares the work tree with a fresh index read from that commit, and lists new files that the work tree's own `.gitignore` files do not cover. A moved HEAD, any changed or new file, or a comparison that cannot run marks the evidence mutated and keeps it from satisfying a gate. The operator's repository is only read.

### Denial of service

**Threat:** large receipts/workspace JSON, output floods, hanging processes, or huge repository scans exhaust resources.

**Control:** receipt and streaming request-body limits, bounded concurrency, timeouts, output caps, cancellation, bounded discovery depth/count, and explicit errors instead of partial silent imports.

## Limits of these controls

- A check runs code from the commit under review with the operator's user permissions. The clean checkout removes the result's dependence on uncommitted and ignored files and on repository configuration. Code in the commit can still reach anything the operator's account can; containing hostile code needs an operating-system sandbox. Such code can also write ignore rules into its own checkout to keep a new file out of the post-run comparison.
- Only the check's top-level executable is pinned. A script passed to an interpreter as an argument, the libraries a tool loads, and the programs it starts resolve normally.
- The tool file is hashed immediately before it starts and again after the run; a file replaced and restored within the run goes unnoticed.
- The checkout holds committed files only: submodules are not checked out, Git LFS content stays as pointer files, and a check installs any dependencies it needs.
- The repository fingerprint reports uncommitted state as Git sees it. The repository's own comparison settings, such as an excludes file, and index flags such as assume-unchanged and skip-worktree can keep uncommitted changes out of it. Checks and verdicts bind to the commit, which these settings do not change.
- Workspace backups and packets are unsigned.

## Security defaults

- Refuse non-loopback bind addresses.
- No telemetry.
- No automatic command execution.
- No repository writes, Git pushes, merges, or deployments.
- No hosted upload of local data.
- Synthetic, visibly labeled public demo data only.

## Vulnerability reporting

The root [security policy](../SECURITY.md) documents supported versions and GitHub private vulnerability reporting. Public issues should not contain exploit details for unresolved vulnerabilities.
