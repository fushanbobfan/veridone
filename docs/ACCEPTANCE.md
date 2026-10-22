# v1.1 executable acceptance criteria

These criteria are release gates. The coverage map at the end lists the automated test or manual evidence for each ID and marks the gaps.

## Onboarding and import

- **ONB-01:** A fresh install launches on loopback and opens the welcome screen without an account or cloud service.
- **ONB-02:** An operator can approve a root, discover and choose a Git repository inside it, and add that repository to the workspace.
- **ONB-03:** An agent-receipt file or directory is fully validated and previewed before complete and degraded runs import with provenance.
- **ONB-04:** Malformed, oversized, traversal, and symlink-escape inputs are rejected with actionable errors and no partial commit.
- **ONB-05:** Imported command-like text remains inert and cannot reach the process runner.
- **ONB-06:** An unbound claim in a multi-repository workspace requires an explicit repository choice and displays the selected branch, commit, path, dirty state, and fingerprint before binding.

## Triage and review

- **REV-01:** The inbox explains why a work item is blocked, stale, risky, ready, or awaiting human review.
- **REV-02:** Filters, search, sort, empty states, and deep links survive reload.
- **REV-03:** The review page distinguishes claims, evidence, unknowns, and human verdicts visually and semantically.
- **REV-04:** Changed files, branch, HEAD, dirty state, and diff statistics match Git for the fixture repository.
- **REV-05:** Security-sensitive paths and out-of-contract scope produce explainable flags without pretending to prove a vulnerability.

## Verification

- **VER-01:** A declared passing check captures command identity, tool version, timestamps, exit status, capped output, and artifact hashes.
- **VER-02:** Failing, timed-out, cancelled, spawn-error, output-capped, and mutating checks produce distinct states.
- **VER-03:** No check is spawned through a shell, and hostile arguments remain literal arguments.
- **VER-04:** A repository change makes prior bound evidence stale at the next snapshot refresh: every page load, the 15-second background refresh, and each check run.
- **VER-05:** Evidence from a different commit, repo, contract, or check definition cannot satisfy a required gate.
- **VER-06:** Parallel requests obey concurrency limits and cannot run an undeclared check ID.

## Verdict and export

- **DEC-01:** Accept, Request changes, and Reject each append a human decision with a note and snapshot binding; the verdict API never updates or deletes a verdict.
- **DEC-02:** Acceptance is blocked when required gates are missing, failing, invalid, or stale; override requires an explicit recorded reason and is visually persistent.
- **DEC-03:** Later repository state marks an old verdict superseded and reopens the work item for a new decision without altering the historical record.
- **EXP-01:** JSON, Markdown, and sanitized standalone HTML packets contain the same verdict, criteria, evidence summary, provenance, and integrity manifest.
- **EXP-02:** The verifier rejects a packet whose payload or artifact list differs from its stored SHA-256 checksum. The checksum is unsigned, so an editor who recomputes it also passes verification.
- **EXP-03:** Export excludes secrets, absolute paths under privacy mode, database internals, and unselected raw artifacts.
- **EXP-04:** Workspace export/import round-trips all supported domain data transactionally.

## Experience and quality

- **UX-01:** The primary workflow is usable at 360 px, 768 px, and desktop widths without hidden required actions.
- **UX-02:** Every action is keyboard reachable with visible focus; dialogs manage focus; status is not conveyed by color alone.
- **UX-03:** Automated axe scans find no serious or critical violations across the tested inbox, review, dialog, export, demo, and mobile states.
- **UX-04:** Reduced-motion preference disables nonessential motion, and light/dark/system themes persist.
- **UX-05:** Loading, local-service-unavailable, no-data, validation-error, and partial-source states are explicit and never masquerade as live evidence.

## Release and operations

- **REL-01:** A clean clone on documented prerequisites passes frozen install, database migration, tests, build, launch, and first-workspace smoke steps.
- **REL-02:** Linux, Windows, and macOS CI pass lint, typecheck, unit, integration, and platform path/process tests.
- **REL-03:** Playwright validates the full onboarding-to-export journey in Chromium; Firefox and WebKit cover the hosted demo journey.
- **REL-04:** Dependency audit, secret scan, license policy, and CodeQL are green or have a documented, defensible exception.
- **REL-05:** The public demo is accessible and labels every synthetic record as demo data.
- **REL-06:** Installation, user guide, architecture, security, data format, contributing, dogfooding, and release documentation are complete for v1.1.

## Coverage map

Status as of 2026-10-22. **Automated** means a test drives the product path; **Partial** names what the tests leave out; **Manual** means release-checklist evidence only.

| ID     | Status    | Evidence                                                                                                                                                                  |
| ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ONB-01 | Automated | `e2e/local-flow.spec.ts` opens an empty workspace on loopback.                                                                                                            |
| ONB-02 | Automated | `e2e/local-flow.spec.ts` approves a root, discovers and adds repositories.                                                                                                |
| ONB-03 | Automated | `apps/server/src/server.test.ts` (atomic directory import), `packages/adapters/src/adapters.test.ts` (harness and portable receipts), `e2e/local-flow.spec.ts` (preview). |
| ONB-04 | Partial   | Path, size, malformed-batch and body-limit tests run everywhere; the symlink-escape test runs on Linux and macOS only.                                                    |
| ONB-05 | Partial   | `adapters.test.ts` imports a receipt carrying a command string; no test asserts that the process runner cannot receive it.                                                |
| ONB-06 | Automated | `apps/web/src/components/RepositoryLinkDialog.test.tsx`, `e2e/local-flow.spec.ts` (decoy repository).                                                                     |
| REV-01 | Partial   | `apps/web/src/local-data.test.ts` and `App.test.tsx` cover blocked, stale, ready, decided and superseded reasons; risk flags are untested.                                |
| REV-02 | Automated | `App.test.tsx` (URL state), `e2e/verdict-binding.spec.ts` (a local deep link survives the background refresh).                                                            |
| REV-03 | Manual    | Visual review.                                                                                                                                                            |
| REV-04 | Automated | `adapters.test.ts` compares status entries and diff statistics with Git.                                                                                                  |
| REV-05 | Partial   | `packages/core/src/core.test.ts` covers declared scope; the sensitive-path patterns are untested.                                                                         |
| VER-01 | Automated | `server.test.ts` checks tool version, exit code and captured output.                                                                                                      |
| VER-02 | Partial   | `adapters.test.ts` covers timeout, cancellation, spawn error and output cap; failing and mutating checks have no test.                                                    |
| VER-03 | Automated | `adapters.test.ts` passes shell syntax as a literal argument.                                                                                                             |
| VER-04 | Partial   | `e2e/verdict-binding.spec.ts` shows a binding going stale after a repository change; `core.test.ts` covers the core freshness evaluator, which the server does not call.  |
| VER-05 | Partial   | Only the core evaluator in `core.test.ts`.                                                                                                                                |
| VER-06 | Automated | `apps/server/src/check-execution.test.ts`.                                                                                                                                |
| DEC-01 | Automated | `server.test.ts`, `apps/server/src/verdict.test.ts`.                                                                                                                      |
| DEC-02 | Partial   | `server.test.ts` and `verdict.test.ts` cover the locked and override paths in the API; the persistent override display is untested.                                       |
| DEC-03 | Automated | `local-data.test.ts`, `e2e/verdict-binding.spec.ts`.                                                                                                                      |
| EXP-01 | Partial   | `server.test.ts` checks shared fields; the HTML packet omits the source and fingerprint lines that the Markdown packet carries.                                           |
| EXP-02 | Partial   | `server.test.ts` rejects an edit made without recomputing the checksum; checksums are unsigned.                                                                           |
| EXP-03 | Partial   | `server.test.ts` checks that an absolute path and a `password=` value are excluded; see [data formats](DATA_FORMAT.md) for the redaction rules.                           |
| EXP-04 | Partial   | `server.test.ts` round-trips a workspace. Open: a receipt whose timestamp is not ISO 8601 imports and then makes workspace export fail.                                   |
| UX-01  | Partial   | Desktop and Pixel 7 projects; 768 px is untested.                                                                                                                         |
| UX-02  | Partial   | `App.test.tsx` covers dialog focus; full keyboard reachability is untested.                                                                                               |
| UX-03  | Automated | axe scans in `local-flow`, `verdict-binding`, `demo` and `mobile` specs.                                                                                                  |
| UX-04  | Partial   | `App.test.tsx` covers theme persistence; reduced motion is untested.                                                                                                      |
| UX-05  | Partial   | `demo.spec.ts` and `mobile.spec.ts` cover the service-unavailable fallback.                                                                                               |
| REL-01 | Partial   | CI frozen install and `scripts/smoke-built.mjs`; the first-workspace smoke is manual.                                                                                     |
| REL-02 | Automated | `.github/workflows/ci.yml` on Ubuntu, Windows and macOS.                                                                                                                  |
| REL-03 | Automated | Playwright projects in `playwright.config.ts`.                                                                                                                            |
| REL-04 | Automated | `pnpm audit --audit-level low`, license and secret scripts, `.github/workflows/codeql.yml`.                                                                               |
| REL-05 | Automated | `e2e/demo.spec.ts`.                                                                                                                                                       |
| REL-06 | Manual    | Documentation review.                                                                                                                                                     |
