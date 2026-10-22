# Data formats

All imported data is untrusted text. No field in a receipt can become an executable check.

## Portable agent receipt v1

Save a UTF-8 JSON file smaller than 2 MB inside an approved root:

```json
{
  "schema_version": 1,
  "run_id": "codex-2026-07-21-export-hardening",
  "source": "codex",
  "title": "Harden workspace export",
  "claim": "Implemented transactional restore and packet verification.",
  "status": "complete",
  "started_at": "2026-07-21T20:00:00.000Z",
  "completed_at": "2026-07-21T20:04:12.000Z",
  "stages": [
    { "name": "implementation", "status": "completed" },
    { "name": "tests", "status": "passed" }
  ]
}
```

Required fields are `schema_version`, `run_id`, `title`, `claim`, `status`, and `started_at`. `source` is one of `codex`, `claude-code`, `ci`, `generic`, or `manual` and defaults to `generic`. `completed_at` and up to 100 stage summaries are optional. Unknown fields are preserved by parsing but are not upgraded into evidence.

A top-level status or stage status outside `complete`, `completed`, `passed`, `success`, `succeeded`, and `ok` marks the import degraded. It does not execute or trust output fields.

You may select a directory instead of one file. VeriDone parses every direct `.json` child before writing anything, with limits of 50 files and 10 MB total. One invalid file rejects the complete batch; a successful batch commits atomically.

## Harness receipt

VeriDone also accepts the local harness structure: `schema_version`, `run_id`, timestamps, `status`, `task.type`, and `stages`. It derives a neutral claim such as “The harness reported this review run as complete.”

## Workspace backup v1

Workspace backup is a JSON document with:

- `schemaVersion: 1` and `application: "veridone"`;
- an export timestamp;
- approved roots, repositories, receipts, work items, contracts, checks, evidence, and verdicts;
- an `integrity` object containing the SHA-256 hash of canonical payload JSON.

Backups include absolute local paths and approved executable definitions. Treat them as private operational records. Imports are bounded at 25 MB, schema-validated, hash-verified, and committed in one SQLite transaction.

## Acceptance packet v1

JSON packet payloads include application/schema identity, strict privacy mode, deterministic generation time, work item, path-free repository summary, contract, evidence summaries, and verdict history. The manifest contains:

```json
{
  "algorithm": "sha256",
  "payloadHash": "…",
  "evidenceArtifacts": ["…"]
}
```

The verifier recomputes canonical payload SHA-256 and checks that artifact hashes in evidence match the manifest. The checksum detects accidental changes; it is unsigned, so an edited packet with a recomputed checksum also verifies. Raw stdout/stderr are excluded. Credential-shaped values and common absolute local paths are redacted from human text.

Markdown and standalone HTML carry the same claim, repository binding, contract, evidence results, tool versions, exit codes, verdict history, privacy declaration, and payload hash. Standalone HTML escapes all imported text and uses a default-deny CSP.
