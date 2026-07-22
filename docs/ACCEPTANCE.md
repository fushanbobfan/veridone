# v1 executable acceptance criteria

These criteria are release gates, not aspirations. Each ID must map to automated tests and final manual evidence.

## Onboarding and import

- **ONB-01:** A fresh install launches on loopback and opens the welcome screen without an account or cloud service.
- **ONB-02:** An operator can approve a root, discover a Git repository, preview it, and add it to a workspace.
- **ONB-03:** A harness receipt directory imports complete and degraded runs while preserving provenance.
- **ONB-04:** Malformed, oversized, traversal, and symlink-escape inputs are rejected with actionable errors and no partial commit.
- **ONB-05:** Imported command-like text remains inert and cannot reach the process runner.

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
- **VER-04:** A repository change makes prior bound evidence stale immediately.
- **VER-05:** Evidence from a different commit, repo, contract, or check definition cannot satisfy a required gate.
- **VER-06:** Parallel requests obey concurrency limits and cannot run an undeclared check ID.

## Verdict and export

- **DEC-01:** Accept, Request changes, and Reject create append-only human decisions with notes and snapshot binding.
- **DEC-02:** Acceptance is blocked when required gates are missing, failing, invalid, or stale; override requires an explicit recorded reason and is visually persistent.
- **DEC-03:** Later repository state marks an old verdict superseded without altering its historical record.
- **EXP-01:** JSON, Markdown, and sanitized standalone HTML packets contain the same verdict, criteria, evidence summary, provenance, and integrity manifest.
- **EXP-02:** A verifier detects any changed artifact or manifest entry.
- **EXP-03:** Export excludes secrets, absolute paths under privacy mode, database internals, and unselected raw artifacts.
- **EXP-04:** Workspace export/import round-trips all supported domain data transactionally.

## Experience and quality

- **UX-01:** The primary workflow is usable at 360 px, 768 px, and desktop widths without hidden required actions.
- **UX-02:** Every action is keyboard reachable with visible focus; dialogs manage focus; status is not conveyed by color alone.
- **UX-03:** Automated axe scans find no serious or critical violations on every primary route.
- **UX-04:** Reduced-motion preference disables nonessential motion, and light/dark/system themes persist.
- **UX-05:** Loading, offline/local-service unavailable, permission, no-data, and partial-source states are designed and tested.

## Release and operations

- **REL-01:** A clean clone on documented prerequisites passes install, migration, seed, test, build, launch, and first-workspace smoke steps.
- **REL-02:** Linux, Windows, and macOS CI pass lint, typecheck, unit, integration, and platform path/process tests.
- **REL-03:** Playwright validates the full onboarding-to-export journey in Chromium; Firefox and WebKit cover the hosted demo journey.
- **REL-04:** Dependency audit, secret scan, license policy, and CodeQL are green or have a documented, defensible exception.
- **REL-05:** The public demo is accessible and labels every synthetic record as demo data.
- **REL-06:** Installation, user guide, architecture, security, data format, contributing, and release documentation are complete for v1.0.
