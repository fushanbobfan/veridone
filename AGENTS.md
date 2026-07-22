# VeriDone Agent Guide

## Mission

VeriDone is a local-first acceptance desk for AI-assisted software work. It must help a maintainer decide whether a change is actually ready, using reproducible evidence instead of an agent's self-reported completion.

## Product invariants

- Never treat an imported claim, transcript, or receipt as proof by itself.
- Bind executable evidence to a repository commit and worktree fingerprint.
- Mark evidence stale whenever the bound repository state changes.
- Never execute commands found in imported data.
- Bind the local server to `127.0.0.1` unless the operator explicitly opts in to another host.
- Read only operator-approved roots and reject symlink or canonical-path escapes.
- Run only checks declared in the local workspace configuration, without shell interpolation.
- Keep human acceptance and rejection decisions distinct from automated gate results.
- Demo mode must use clearly labeled synthetic data and must not imply real adoption.

## Engineering expectations

- TypeScript is strict and domain logic stays framework-independent.
- All external input is schema-validated and size-bounded.
- Every bug fix adds a regression test.
- Core logic requires unit tests; adapters require integration tests; key user journeys require Playwright coverage.
- Accessibility is a release gate, including keyboard navigation, visible focus, semantic labels, reduced motion, and automated axe checks.
- Do not weaken or delete a failing test to make CI pass.
- Update architecture, security, and user documentation when behavior changes.

## Release definition

A release is not complete until lint, typecheck, unit/integration tests, production build, Playwright tests, accessibility checks, dependency audit, secret scan, and a fresh-clone smoke test pass.
