# Security model

## Trust boundaries

VeriDone reads repositories, agent receipts, CI metadata, logs, and exported bundles. Every one of these is untrusted input. The application must display them safely and must never follow instructions embedded in them.

The local operator is trusted to approve roots, define checks, and issue verdicts. A passing process is not trusted to prove more than the declared check measured.

## Primary threats and controls

### Imported command execution

**Threat:** a receipt contains a command or prompt that attempts to trigger execution.

**Control:** imported commands are inert strings. Only operator-authored check declarations are executable. The process API accepts stored check IDs, not arbitrary command text.

### Path traversal and symlink escape

**Threat:** crafted paths access files outside approved roots or escape during export/import.

**Control:** canonicalize existing paths, compare with platform-aware root boundaries, reject symlink escapes, reject absolute/archive traversal paths, and re-check boundaries immediately before access.

### Local web attacks

**Threat:** a hostile website calls the loopback API, or the UI renders injected content.

**Control:** loopback binding, strict Origin allowlist, per-process anti-CSRF token, restrictive CORS/CSP, secure response headers, JSON content types, React escaping, and sanitized standalone HTML exports.

### Shell injection

**Threat:** configuration values are interpolated into a shell command.

**Control:** spawn executables directly with argument arrays and `shell: false`; validate working directories and environment keys; never concatenate command strings.

### Secret leakage

**Threat:** logs or bundles expose tokens, environment secrets, home paths, or repository credentials.

**Control:** minimal environment, key-pattern and value redaction, output limits, export allowlists, path privacy modes, no `.git` object export, and a pre-export secret scan.

### Stale or forged evidence

**Threat:** old results or edited artifacts are presented as current.

**Control:** bind evidence to repository and check fingerprints, hash every artifact, verify on read/export/import, classify source provenance, and never upgrade unbound imported claims into executable evidence.

### Check mutates the repository

**Threat:** a test or build modifies tracked or untracked state, making its own result ambiguous.

**Control:** compare before/after fingerprints. Preserve the captured output but mark the evidence invalid for acceptance until the resulting state is deliberately re-verified.

### Denial of service

**Threat:** large receipts, output floods, archive bombs, hanging processes, or huge repository scans exhaust resources.

**Control:** file and archive limits, bounded concurrency, timeouts, output caps, cancellation, pagination, incremental scanning, and explicit errors instead of partial silent imports.

## Security defaults

- Bind to `127.0.0.1`.
- No telemetry.
- No automatic command execution.
- No repository writes, Git pushes, merges, or deployments.
- No hosted upload of local data.
- Synthetic, visibly labeled public demo data only.

## Vulnerability reporting

Before public v1.0, `SECURITY.md` at the repository root will document supported versions and a private reporting route. Public issues should not contain exploit details for unresolved vulnerabilities.
