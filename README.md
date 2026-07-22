# VeriDone

> Don't trust “done.” Verify it.

VeriDone is a local-first acceptance desk for AI-assisted software work. It turns scattered agent receipts, Git state, test output, CI results, screenshots, and human review into one reproducible acceptance packet.

Most agent dashboards help start or watch agents. VeriDone begins where they stop: deciding whether the work deserves to be accepted.

## The core workflow

1. Add an approved repository and optional receipt folders.
2. Import claims from Codex, Claude Code, generic JSON, or existing automation receipts.
3. Compare each claim with the current commit, worktree, configured acceptance criteria, and independent checks.
4. Re-run allowlisted checks with bounded execution and captured evidence.
5. Accept, reject, or request changes as a human decision.
6. Export a portable JSON, Markdown, or HTML acceptance packet with integrity hashes.

## Trust model

VeriDone deliberately separates three things:

- **Claim** — what an agent or automation says happened.
- **Evidence** — independently inspectable data tied to a specific repository state.
- **Verdict** — an explicit human decision based on the evidence.

An agent saying “all tests pass” is context. A fresh, bounded test run against the same commit and worktree is evidence. Only the maintainer can sign off.

## Status

VeriDone is under active construction toward v1.0. The product specification, threat model, architecture, and executable release criteria are already tracked in [`docs/`](docs/).

## License

MIT. See [LICENSE](LICENSE).
