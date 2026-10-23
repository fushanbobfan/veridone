# Maintainer dogfooding evidence

On 2026-07-22, VeriDone was used against four separate public repositories in one local workspace. This was internal dogfooding run by the maintainer; no external user took part. The purpose was to test the real multi-repository workflow, publish evidence whose checksums anyone can recompute, and let the product reveal its own next improvement.

## Method

For each repository, the maintainer workflow:

1. cloned the public `main` branch into a fresh, clean worktree;
2. imported a portable Codex receipt as an untrusted claim;
3. explicitly linked the claim to the repository snapshot;
4. approved the repository's documented test command as local policy;
5. let VeriDone execute the check without a shell and capture commit, fingerprint, tool version, exit status, duration, and artifact hash;
6. exported a strict-privacy JSON review packet and verified its SHA-256 manifest; and
7. rechecked the Git worktree and commit after execution.

No human verdict was recorded. Each packet deliberately contains `humanVerdict: null` and an empty `verdicts` array: green automated evidence does not authorize a human acceptance decision.

## Results

| Repository                                                                           | Bound commit                               | Tests | Captured tool   | Result                  | Packet payload SHA-256                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------ | ----: | --------------- | ----------------------- | ----------------------------------------------------------------------------- |
| [Gravity Garden](https://github.com/fushanbobfan/gravity-garden)                     | `f56b49894191921e4ffbb17738a2e2c717bcc02b` |   128 | Node `v24.18.0` | Passed; clean after run | [`2b6c0c…fae6`](evidence/dogfood/gravity-garden-review-packet.json)           |
| [AI Eval Micro Lab](https://github.com/fushanbobfan/ai-eval-micro-lab)               | `660ceccd869a8fe862ddbff2d89f8e93c3b75845` |    73 | Python `3.14.5` | Passed; clean after run | [`9b0fd7…5e51`](evidence/dogfood/ai-eval-micro-lab-review-packet.json)        |
| [Useful Automation Lab](https://github.com/fushanbobfan/useful-automation-lab)       | `2549721dfd5fc1e4b31089fd0c2abcf4f51c2a29` |    77 | Python `3.14.5` | Passed; clean after run | [`fcbdcf…a7e3`](evidence/dogfood/useful-automation-lab-review-packet.json)    |
| [Quant Research Micro Lab](https://github.com/fushanbobfan/quant-research-micro-lab) | `c9a9fca214cf45a10de4eb98574c92dd757f901e` |    62 | Python `3.14.5` | Passed; clean after run | [`d91cbb…97d2`](evidence/dogfood/quant-research-micro-lab-review-packet.json) |

The run produced four fresh passing evidence records across 340 tests, four distinct commit-bound fingerprints, four packet checksums that pass the verifier, zero repository mutations, and zero automated human verdicts.

## Product finding

The exercise exposed a provenance hazard in the original multi-repository flow: an unbound claim's primary action targeted the first connected repository instead of requiring an explicit choice. That behavior was tolerable in the single-repository end-to-end fixture but unsafe and confusing in a real four-repository workspace.

The v1.1 change adds a repository-binding dialog that:

- starts with no selected repository;
- shows repository, branch, full commit, local path, clean/dirty state, and fingerprint before binding;
- requires an explicit operator choice; and
- keeps the claim visibly untrusted after identity is bound.

The regression suite now creates two repositories and proves that the operator can deliberately bind the intended one before checks run.

## Verify the published packets

From a VeriDone checkout:

```bash
pnpm verify:published-evidence
```

Or verify packets individually:

```powershell
Get-ChildItem docs/evidence/dogfood/*.json | ForEach-Object { pnpm verify:packet $_.FullName }
```

```bash
for packet in docs/evidence/dogfood/*.json; do pnpm verify:packet "$packet"; done
```

The committed packets use strict privacy mode: they omit raw process output and absolute local paths. They are evidence of maintained, real-project use; they must not be cited as external users, stars, forks, or ecosystem adoption.
