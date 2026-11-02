# Security model

## Trust boundaries

VeriDone reads repositories, agent receipts, CI metadata, logs, and exported bundles. Every one of these is untrusted input. The application must display them safely and must never follow instructions embedded in them.

The repository under review is writable by the agent whose work it holds: its work tree, ignored files, index, and Git configuration can all change between the agent's claim and the human's decision. VeriDone reads that state to bind a claim, but it produces evidence from its own checkout of the bound commit.

The local operator is trusted to approve roots, define checks, pin their tools, and issue verdicts. A passing process is not trusted to prove more than the declared check measured.

## Primary threats and controls

### Imported command execution

**Threat:** a receipt contains a command or prompt that attempts to trigger execution.

**Control:** imported commands are inert strings. Only operator-authored check declarations are executable. The process API accepts only stored check IDs.

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

**Threat:** a hostile website calls the loopback API, points its own domain name at the loopback address to read the API as a same-origin page, or the UI renders injected content.

**Control:** loopback binding, a Host allowlist, strict Origin allowlist, per-process anti-CSRF token, restrictive CORS/CSP, secure response headers, JSON content types, React escaping, and sanitized standalone HTML exports. The Host allowlist holds the loopback names on the service's port and the hosts of the allowed origins; the service answers 403 when the `Host` header or the host of an absolute request URL is anything else, so a page served under another name reads nothing, the anti-CSRF token included.

### Shell injection

**Threat:** configuration values are interpolated into a shell command.

**Control:** spawn executables directly with argument arrays and `shell: false`; validate working directories and environment keys; never concatenate command strings.

### Secret leakage

**Threat:** logs or bundles expose tokens, environment secrets, home paths, or repository credentials.

**Control:** minimal environment, redaction of credential assignments (a quoted value up to its closing quote, past escaped quotes, or to the end of the line, and a value joined from adjacent quoted or escaped parts, as shell quoting writes it), the value after an option named for a secret, common token formats, bearer values, and private key blocks (a key cut off by the output limit is redacted to the end of the text), output limits, export allowlists, path privacy modes, no `.git` object export, and a pre-export secret scan. Packets carry each tool's hash and leave its local path out. Every text in a packet, object keys included, first loses the paths the workspace knows (its home and temporary directories, approved roots, pinned tools, repositories, and pending roots), so a credential assignment that holds one keeps none of it. They match in each form text writes them: either separator, JSON escapes (`\\`, `\/`, `\u5ba2`), quotes, file URLs with percent-encoding in either case (`c%3A` for a drive included), a shell's backslash escapes, a POSIX shell's name for a Windows drive (`/d/x`, `/mnt/d/x`, `/cygdrive/d/x`), `~`, `$HOME` or `%USERPROFILE%` for a path under the home directory, letter case on Windows and macOS, and the other name the system gives the home or temporary directory, such as a Windows short name or macOS's `/var` for `/private/var`. A known path also matches right after a command-line flag (`-I/x`), a local URL's host (`file://localhost/x`, `vscode://file/x`) or Vite's `/@fs`, and stays as written inside a longer relative path or a remote URL. What follows it inside that path goes with it, read at least as far as the general patterns read, and in a credential value the value's own rules read the quotes after it.

A hash of local data in a packet would let a reader confirm a guess: the repository id hashes the local path, and the fingerprint, worktree, claim, check-definition, and artifact hashes take local paths, text before sanitizing, or uncommitted file content as inputs. Packets carry each of these as an HMAC-SHA256 pseudonym under a random key that the workspace keeps in its database and leaves out of backups. Equal values get equal pseudonyms within one workspace, so a reader can still see that a verdict, its evidence, and the work item name the same state.

### Stale or forged evidence

**Threat:** old results or edited artifacts are presented as current.

**Control:** bind evidence to repository and check-definition fingerprints, hash each check result, recompute packet and workspace checksums when they are verified or imported, classify source provenance, and never upgrade unbound imported claims into executable evidence. Evidence restored from a backup is marked imported and never satisfies a gate.

Packets are signed with an Ed25519 key that the workspace creates on first use and leaves out of backups. The verifier checks the signature against the public key the packet carries, which must be an Ed25519 key, and with `--key` it also requires that key to be one the reader trusts. The operator publishes the public key; a reader who checks against it can tell a changed packet from the one the workspace signed, even when the changer recomputed every hash and signed again with a key of their own. A packet rewritten as schema 1 without its signature verifies only as unsigned, and fails once the reader gives a key. Workspace backup checksums stay unsigned and detect accidental changes only.

### Acceptance on incomplete evidence

**Threat:** a work item is accepted while a check lacks fresh passing evidence, its binding is out of date, the agent's own receipt reports a failed or incomplete stage, or changed paths leave the declared scope.

**Control:** the service computes each work item's readiness in one place. The verdict gate refuses an acceptance without an override reason unless every condition holds, and the review view shows the readiness the service computed.

### Restored access

**Threat:** a backup made on another machine, or by someone else, grants read access to directories on this one.

**Control:** restore adds roots as pending. A pending root grants nothing: discovery refuses it, and repository capture, receipt import, and checks count approved roots only. Approving a restored root resolves its stored path again and refuses a path that is missing, is no directory, or now resolves somewhere else. Before anything is written, a restore preview lists the roots, repositories, checks, and work items the backup would add.

### A decision on a state the reviewer did not see

**Threat:** the repository, the claim, or the verdict history changes between the moment a reviewer opens a verdict and the moment it is recorded.

**Control:** the verdict request carries the fingerprint, claim hash, and latest verdict the reviewer saw. The server captures the repository again and records the verdict in one immediate transaction only if all three still match; otherwise it answers 409. A receipt cannot change the claim of a work item that already has a verdict.

### Rewritten history

**Threat:** a restored backup or a direct write replaces a recorded verdict or evidence record.

**Control:** SQLite triggers accept a verdict only as the successor of the latest verdict on its work item and refuse any update or deletion of verdicts and evidence. Restore adds the records the workspace lacks, requires evidence and verdicts with a known ID to match exactly, and replays verdicts through the same append path; a conflicting backup is refused as a whole.

### Check changes its own inputs

**Threat:** a test or build modifies tracked or untracked files, making its own result ambiguous.

**Control:** after the run, VeriDone names the checkout's repository and work tree explicitly, requires its HEAD to still be the bound commit, compares the work tree with a fresh index read from that commit, and lists new files that the work tree's own `.gitignore` files do not cover. A moved HEAD, any changed or new file, or a comparison that cannot run marks the evidence mutated and keeps it from satisfying a gate. A setup step runs in the same checkout before the check, so its writes count too; a dependency install that writes to ignored paths such as `node_modules` leaves the comparison clean. The operator's repository is only read.

### Denial of service

**Threat:** large receipts/workspace JSON, output floods, hanging processes, or huge repository scans exhaust resources.

**Control:** receipt and streaming request-body limits, bounded concurrency, timeouts, output caps, cancellation, and bounded discovery depth/count; an import that reaches a limit fails with an explicit error and commits nothing. Check output comes from the commit under review, so the redaction and test-summary patterns that read it take linear time on any input, and tests time them on hostile output.

## Limits of these controls

- A check runs code from the commit under review with the operator's user permissions. The clean checkout removes the result's dependence on uncommitted and ignored files and on repository configuration. Code in the commit can still reach anything the operator's account can; containing hostile code needs an operating-system sandbox. Such code can also write ignore rules into its own checkout to keep a new file out of the post-run comparison.
- Only the check's top-level executable is pinned. A script passed to an interpreter as an argument, the libraries a tool loads, and the programs it starts resolve normally.
- The tool file is hashed immediately before it starts and again after the run; a file replaced and restored within the run goes unnoticed.
- The checkout holds committed files only: submodules are not checked out, Git LFS content stays as pointer files, and a check installs any dependencies it needs.
- The repository fingerprint reports uncommitted state as Git sees it. The repository's own comparison settings, such as an excludes file, and index flags such as assume-unchanged and skip-worktree can keep uncommitted changes out of it. Checks and verdicts bind to the commit, which these settings do not change.
- A setup step that installs dependencies fetches packages from the network and, depending on the package manager, may run their install scripts, with the operator's permissions.
- A packet's signature shows which key signed it. Tying that key to a person or an organization is up to the operator, through the channel that publishes the public key. Anyone who can read the workspace database can sign with its key and recompute its pseudonyms.
- Packets from one workspace share pseudonyms, so a reader can tell that two packets concern the same repository or state.
- Beyond the paths the workspace knows, path redaction recognizes drive and UNC paths, home-relative paths, and POSIX paths under `/Users`, `/home`, `/var`, `/tmp`, `/opt`, `/etc`, `/mnt`, `/srv`, `/root`, `/Volumes`, `/private`, and `/media`. Any other POSIX path stays in the text, quoted or not, such as `/work/clients/acme` when no approved root holds it. The workspace knows each root and repository by its canonical path, so a path written through a symbolic link, other than the system's own links to the home and temporary directories, is one it does not know. A known path longer than 512 characters is left to the general patterns, and so are the known paths past the first 100,000 characters in all, which the pending roots of a restored backup reach last.
- Text that encodes characters a URL or JSON leaves as they are, such as a letter written `%61` or `\u0061`, does not match a known path, and a known path whose name holds `%25` matches only as written there.
- A known path matches whole segments: a Latin letter, digit, `_` or `-` right after it, or a period or `%` before a letter or digit, continues a longer name, so `repo.Next` with no space after the period keeps the path. A Chinese character right after a known path reads as prose, as Chinese is written without spaces, so a known path that ends in a Chinese character also replaces the start of a longer name, as `/work/客户` does in `/work/客户端`.
- Redaction reads one level of quoting. Deeper nesting, such as JSON that holds a shell command whose file names carry escaped quotes, or a backslash inside shell single quotes followed by more quoted parts, can leave part of a secret or a path in the text.
- Outside quotes, a path the workspace does not know ends at its first space unless another separator follows, so the words after the first space of a last part that holds one, as in `D:\Shared\Bob Smith`, stay in the text. A known path is redacted whole, spaces included, and the parts written after it follow the same rule: in `C:\Users\Bob Smith\My Notes.txt`, with that home directory, ` Notes.txt` stays. A line and column at the end of such a path, as in `x.ts:12:5`, stay readable. A quoted path is redacted up to its closing quote, reading backslash escapes inside double quotes and none inside single quotes, as the shell does, so a quoted string that starts with a private path is redacted whole, its message included. Privacy comes before the prose around a path: words between a path and a later slash on the same line, as in `/home/page and verify pass/fail`, are redacted with it.
- A packet's test counts come from the summary line in the check's own output, which code in the commit under review can print as it likes. The exit code and the post-run comparison decide the result; the counts describe it.
- Workspace backups are unsigned.
- Every process on this machine can reach the loopback API. The Host, Origin, and anti-CSRF controls defend against web pages.

## Security defaults

- Refuse non-loopback bind addresses.
- No telemetry.
- No automatic command execution.
- No repository writes, Git pushes, merges, or deployments.
- No hosted upload of local data.
- Synthetic, visibly labeled public demo data only.

## Vulnerability reporting

The root [security policy](../SECURITY.md) documents supported versions and GitHub private vulnerability reporting. Public issues should not contain exploit details for unresolved vulnerabilities.
