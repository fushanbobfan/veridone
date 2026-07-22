# Contributing to VeriDone

VeriDone welcomes focused issues and pull requests that strengthen evidence quality, portability, accessibility, or safe local operation.

## Development

1. Fork and clone the repository.
2. Use Node.js 22 and pnpm 11.9.0.
3. Run `pnpm install --frozen-lockfile`.
4. Create a branch and keep changes scoped.
5. Run `pnpm quality` and, for user-flow changes, `pnpm test:e2e`.

Tests belong beside the affected package. Security boundary changes should include a hostile or failure-path regression test. UI changes should preserve keyboard use, 360 px layout, visible focus, non-color status cues, and the axe suite.

To evaluate an unchanged release on a real local repository, follow the privacy-preserving [external tester guide](docs/TESTER_GUIDE.md) and use the dedicated dogfood feedback issue form.

## Pull requests

Describe the user problem, trust-boundary impact, verification performed, and any deliberate limitation. Do not claim adoption, security guarantees, or test coverage that the repository cannot demonstrate.

Never include real credentials, private receipt contents, local workspace backups, or acceptance packets containing sensitive project information.

## Design constraints

- Claims never satisfy evidence gates.
- Imported command text remains inert.
- Executable checks require explicit local approval and literal arguments.
- Verdicts are human and append-only.
- The v1 service binds only to loopback and rejects every non-loopback host; remote and multi-user deployments are out of scope.
- Public demos contain visibly synthetic data and no filesystem/process capability.

## Reporting security issues

Do not open a public issue for an undisclosed vulnerability. Follow [SECURITY.md](SECURITY.md).
