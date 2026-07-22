# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

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

[1.0.2]: https://github.com/fushanbobfan/veridone/releases/tag/v1.0.2
[1.0.1]: https://github.com/fushanbobfan/veridone/releases/tag/v1.0.1
[1.0.0]: https://github.com/fushanbobfan/veridone/releases/tag/v1.0.0
