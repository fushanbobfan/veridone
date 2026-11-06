# v1 security best-practices audit

Date: 2026-07-21 (updated through v1.2.0 on 2026-11-05)

## Executive summary

The v1 audit found no open critical or high-severity issue after remediation. VeriDone has a deliberately narrow boundary: an unauthenticated service that refuses non-loopback binds, displays all imported data through React text rendering, and executes only operator-approved literal process definitions. The most important pre-release findings—remote bind exposure, incomplete request-body limiting, app-shell CSP coverage, and descendant process cleanup—were fixed and covered by tests.

This review followed the local JavaScript/TypeScript and React security specifications, plus the official [Hono secure-headers](https://hono.dev/docs/middleware/builtin/secure-headers) and [body-limit](https://hono.dev/docs/middleware/builtin/body-limit) guidance.

## Remediated findings

### VDS-001 — High — unauthenticated remote binding

- **Location:** `apps/server/src/config.ts:54-56`
- **Evidence:** configuration now accepts only `127.0.0.1` or `::1`; the previous opt-in remote override was removed.
- **Impact before fix:** a user enabling remote bind would have exposed the bootstrap CSRF token and mutation API to other network clients without authentication.
- **Fix:** v1 refuses every non-loopback host. A regression test includes the legacy override flag and still expects rejection.

### VDS-002 — Medium — workspace body limit trusted a request header

- **Location:** `apps/server/src/app.ts:343-373`
- **Evidence:** the import route uses Hono's streaming `bodyLimit` middleware before JSON parsing, at the 500 MB limit export also applies.
- **Impact before fix:** a chunked request without `Content-Length` could force an unexpectedly large allocation.
- **Fix:** enforce the limit for declared and streamed body sizes and return 413 before schema/import work.

### VDS-003 — Medium — app shell lacked an enforceable CSP baseline

- **Location:** `apps/web/index.html:5-8`, `apps/web/public/_headers:1-6`, `apps/server/src/app.ts:105-118`
- **Evidence:** the static shell has an early CSP meta policy, supported edge hosts receive CSP/clickjacking/nosniff/privacy headers, and the API uses Hono secure headers. Script policy is self-only with no `unsafe-inline` or `unsafe-eval`. The meta policy permits Vite's development style elements and inline Motion styles; production edge headers narrow style elements back to self-only assets.
- **Impact before fix:** an unrelated rendering mistake would have had less browser defense in depth.
- **Fix:** add static and response-header policies while explicitly disabling HSTS for loopback HTTP.

### VDS-004 — Medium — bounded checks killed only the direct process

- **Location:** `packages/adapters/src/process.ts:35-61`, `packages/adapters/src/process.ts:84-111`
- **Evidence:** non-Windows checks start in a process group; timeout, cancellation, and output-cap termination kill the group. Windows uses `taskkill /t /f` without a shell and falls back to the direct child.
- **Impact before fix:** a timed-out tool could leave descendant processes running.
- **Fix:** terminate the process tree for every bounded abnormal state.

### VDS-005 — Medium — portable evidence needed deterministic privacy verification

- **Location:** `apps/server/src/packet.ts:88-111`, `apps/server/src/packet.ts:333-436`, `apps/server/src/packet.ts:159-271`
- **Evidence:** packet text is credential/path-redacted, raw stdout/stderr are excluded, generation time derives from stable review state, and the verifier recomputes the payload hash and compares the manifest's artifact hashes with the evidence records.
- **Impact before fix:** packets could expose common local paths and repeated exports of unchanged state produced different hashes.
- **Fix:** strict privacy payloads, deterministic serialization, three-format parity tests, and a standalone verifier.

## Verified controls

- Origin allowlist and per-process anti-CSRF token: `apps/server/src/app.ts:232-259`.
- Canonical approved-root and symlink boundary: `packages/adapters/src/path-boundary.ts:22-51`.
- Direct spawn with `shell: false`: `packages/adapters/src/process.ts:35-42`.
- Minimal check environment, redaction, tool version, exit code, and before/after mutation classification: `apps/server/src/check-runner.ts:17-31`, `apps/server/src/check-runner.ts:66-270`.
- Full workspace schema/hash validation before a single import transaction: `apps/server/src/workspace.ts:353-421`.
- Frontend audit found no `dangerouslySetInnerHTML`, DOM HTML sink, string-to-code execution, dynamic script, postMessage, auth-token storage, or third-party remote script.
- `localStorage` contains only an allowlisted theme preference: `apps/web/src/App.tsx:62-66`, `apps/web/src/App.tsx:207-210`.

## Residual, documented boundaries

1. **Approved checks have the local user's OS permissions.** VeriDone prevents imported-command execution and shell interpolation; it is not a VM or malware sandbox. Use a container/VM for hostile build tools.
2. **Workspace backups are private.** They intentionally contain approved paths, redacted process output, and executable definitions. Acceptance packets—not workspace backups—are the strict-privacy sharing format.
3. **Regex redaction is one layer of defense in depth and catches only the credential and path forms it knows.** Raw output is excluded from packets, and users must still review exports before sharing.

## Automated evidence

- Unit/integration tests cover origin/CSRF, streaming size limits, traversal/symlink boundaries, hostile literal arguments, cancellation/timeout/output cap/spawn error, mutation, scope drift, workspace rollback, packet tampering, and privacy redaction.
- Playwright exercises the isolated local flow and Chromium/Firefox/WebKit synthetic demo; axe scans target WCAG 2.2 AA.
- CI runs frozen-lockfile install, format, lint, types, tests, build, a low-threshold audit of production and development dependencies, license allowlist, and secret scan. CodeQL and Dependabot are enabled.
- v1.0.1 pins patched transitive versions for `shell-quote` GHSA-395f-4hp3-45gv and `esbuild` GHSA-g7r4-m6w7-qqqr; `pnpm audit --audit-level low` reports no known vulnerability.
- v1.0.2 aligns every contributor-facing statement with the enforced loopback-only boundary; remote and multi-user deployments remain unsupported.
- v1.1.0 requires an explicit repository choice before claim binding and displays the selected commit, path, dirty state, and fingerprint, preventing an unbound claim from silently targeting the first connected repository.
- v1.2.0 runs approved checks in a clean checkout of the bound commit with a pinned top-level executable, starts Git with a fixed configuration, makes verdicts compare-and-swap and append-only, signs packets and replaces local identifiers with pseudonyms, redacts the paths the workspace knows, keeps restored roots pending until approved, and checks the API's `Host` header. An operator can replace or retire a check with a recorded reason, which packets show, and evidence counts only under the check set it ran with. A verdict records while a repository cannot be read, against the last state captured, and a plain acceptance stays refused there.
