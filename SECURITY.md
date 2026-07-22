# Security policy

## Supported versions

| Version           | Supported |
| ----------------- | --------- |
| 1.x               | Yes       |
| Pre-1.0 snapshots | No        |

## Private reporting

Use GitHub's private vulnerability reporting for `fushanbobfan/veridone`: open the repository **Security** tab, choose **Advisories**, then **Report a vulnerability**. Include the affected version, operating system, reproduction, impact, and any suggested mitigation.

Please do not attach real repositories, credentials, workspace backups, or raw private receipts. A minimal synthetic fixture is preferred.

You should receive an acknowledgement within seven days. Disclosure timing will be coordinated after a fix or defensible mitigation is available.

## Product boundary

VeriDone reduces unsafe trust in agent completion claims; it is not an OS sandbox, malware scanner, or proof of semantic correctness. Operator-approved checks execute with the local user's permissions. Keep hostile repositories and build tools inside an appropriate VM/container sandbox.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md) for the v1 review.
