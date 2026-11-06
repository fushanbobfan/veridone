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

Required fields are `schema_version`, `run_id`, `title`, `claim`, `status`, and `started_at`. `source` is one of `codex`, `claude-code`, `ci`, `generic`, or `manual` and defaults to `generic`. `completed_at` and up to 100 stage summaries are optional. Unknown fields are preserved by parsing but are not upgraded into evidence. The run id identifies a receipt, so one file can hold a new run each time an agent writes it.

`started_at` and `completed_at` are ISO 8601 timestamps. A time with a UTC offset is kept as written, with `:00` seconds added when it stops at the minute, such as `2026-07-21T13:00Z`; a date and time without one, such as `2026-07-21 13:00:00`, is read as the importing machine's local time and stored with an offset. `run_id` holds at most 512 characters, `status` and `task.type` at most 200, `title` at most 300, and `claim` at most 20,000. The workspace backup checks the same rules, so a receipt that imports also exports.

A top-level status or stage status outside `complete`, `completed`, `passed`, `success`, `succeeded`, and `ok` marks the import degraded. It does not execute or trust output fields.

You may also select a directory. VeriDone parses every direct `.json` child before writing anything, with limits of 50 files and 10 MB total. One invalid file rejects the complete batch; a successful batch commits atomically.

## Harness receipt

VeriDone also accepts the local harness structure: `schema_version`, `run_id`, timestamps, `status`, `task.type`, and `stages`. It derives a neutral claim such as “The harness reported this review run as complete.”

## Workspace backup v2

Workspace backup is a JSON document with:

- `schemaVersion: 2` and `application: "veridone"`;
- an export timestamp;
- approved roots, repositories, receipts, work items, contracts, checks, evidence, and verdicts;
- an `integrity` object containing the SHA-256 hash of canonical payload JSON.

Version 2 adds, for each check, the pinned tool (`resolvedExecutable`, `executableSha256`) its setup step (`setupArgs`, `setupTimeoutMs`), and its retirement (`retiredAt`, `retiredReason`, null while it counts); for each approved root, repository, and work item, its removal (`removedAt`, `removedReason`, null while it is in the workspace, and read as null when a backup leaves them out); for each evidence record, its `isolation`, `toolPath`, `toolSha256`, and `origin` (`local` or `imported`); and for each verdict, its position in the work item's chain (`sequence`, `previousVerdictId`) and the `claimHash` it judged. A check without `setupArgs` restores with no setup step and a `setupTimeoutMs` of 600000.

Backups include absolute local paths and approved executable definitions. Treat them as private operational records. They leave out the workspace's packet keys. Export and restore share a limit of 500 MB, so export refuses to write a backup that restore would refuse. Receipt import limits new data, and a backup carries what earlier versions accepted, such as a long run id or a time that is no timestamp. Restore checks the hash over the payload as written, validates the schema, and commits in one SQLite transaction. It adds what the workspace lacks:

- records that already exist stay as they are, so a backup never retires a check the workspace holds, and a retired check it adds stays retired; likewise a backup neither removes a root, repository, or work item the workspace holds nor brings back one the workspace removed, and a removed record it adds stays removed;
- evidence and verdicts that share an ID with a local record must match it exactly;
- each work item's verdicts replay in chain order and must extend the local history;
- restored evidence is marked `imported` and satisfies no gate;
- restored checks are validated like new ones, lose their tool pins, and get their definition hash recomputed, so they run only after the operator pins their tools;
- restored roots are `pending` and grant no access until the operator approves each one on this machine.

A backup that conflicts with recorded history is refused as a whole. Version 1 backups still restore; their verdicts are chained in the order they were decided.

`POST /api/v1/workspace/preview` takes the same document, runs the restore, and rolls it back. It answers with the counts of records the restore would add and find unchanged, with the roots, repositories, checks, and work items it would add, and apart from those with the records it would add as removed, or with the error that would refuse the restore.

## Acceptance packet v2

A JSON packet holds a payload and a `manifest`. The payload carries `schemaVersion: 2`, `application: "veridone"`, `privacyMode: "strict"`, `identifiers: "hmac-sha256-workspace-pseudonyms"`, a deterministic `generatedAt` taken from the latest verdict, evidence, or work item, the work item, a path-free repository summary, the contract the latest verdict, evidence, or snapshot was recorded under, `checks`, evidence summaries, and the verdict history. The work item and the repository summary carry `removedAt` and `removedReason`, null unless the operator removed them. A removed repository's summary is the last state captured.

Each entry in `checks` gives a check approved for the repository, or one behind the packet's evidence: its label and kind, its executable's file name without the directory, the pinned tool's SHA-256, its arguments, version arguments, setup arguments, working directory, scope prefixes, timeouts, output cap, approval time, and retirement time and reason, null while it counts. Each evidence summary carries its result, exit code, tool version, the tool's SHA-256, its isolation (`clean-checkout` for checks run in VeriDone's checkout of the bound commit), its origin, and `testCounts`: the passed, failed, skipped, and total counts and the runner, read from the last summary that node:test, Vitest, Jest, or pytest printed, or `null` when the output holds none. pytest's `subtests passed` part stays out of the counts, since pytest leaves it out at its default verbosity. A line longer than 65,536 characters, color codes aside, is skipped, pytest's summary line included when a `COLUMNS` setting pads it past that length, so the last summary before it stands. Raw stdout and stderr stay out of the packet.

Identifiers computed from local data appear as HMAC-SHA256 pseudonyms under a random key that the workspace keeps and leaves out of backups: the repository id, the fingerprint and worktree hash, the claim hash, check-definition hashes and versions, and artifact hashes. Equal values get equal pseudonyms within one workspace, so the packet's bindings can still be compared. The commit (`head`) and the pinned tool's SHA-256 appear as they are. Every text in the packet passes through the sanitizer, object keys and the contract, check arguments, and evidence fields that a restored backup can set included. The local paths the workspace knows (its home and temporary directories, roots, pinned tools, and repositories, removed ones included, in the forms `docs/SECURITY.md` lists) go first, then credential-shaped values, the value after an option named for a secret, and other common absolute local paths. A text longer than a million characters appears as `[REDACTED: text too long to sanitize]`, and the Unicode noncharacters U+FDD0 and U+FDD1, which the sanitizer uses to mark known paths, appear as U+FFFD.

The manifest contains:

```json
{
  "algorithm": "sha256",
  "payloadHash": "…",
  "evidenceArtifacts": ["…"],
  "signature": {
    "algorithm": "ed25519",
    "keyId": "…",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n",
    "value": "…"
  }
}
```

`payloadHash` is the SHA-256 of the payload serialized as JSON without whitespace, with object keys in UTF-16 code-unit order (the order RFC 8785 uses). `signature.value` is the base64 Ed25519 signature over the same bytes, and `keyId` is the SHA-256 of the public key's SPKI DER encoding.

The verifier recomputes the payload hash, checks that the artifact hashes in evidence match the manifest, checks that the embedded public key is an Ed25519 key with the named `keyId`, and verifies the signature. The public key travels inside the packet, so a sound signature shows only that the holder of that key signed. `pnpm verify:packet <packet.json> --key <public-key.pem>` also requires the signing key to be one of the keys given; `--key` may repeat. The workspace's public key downloads from Backup & restore, or from `GET /api/v1/workspace/signing-key`, which names the key in its `X-VeriDone-Key-Id` header.

Markdown and standalone HTML render from one view of the packet and carry the same claim, source, repository binding and fingerprint, removal time and reason of the work item and the repository, contract clauses, check commands, evidence results with test counts, tool versions, exit codes, verdict history, privacy declaration, payload hash, and signing key id. In that view each fact except the claim sits on one line, with a line break in its text shown as a space; the JSON packet keeps the text as written. Standalone HTML escapes all imported text and uses a default-deny CSP.

### Packet schema 1

Packets from VeriDone 1.1 and earlier have `schemaVersion: 1`, no signature, identifiers as recorded, and a payload hash over keys in locale-aware order. The verifier still accepts them and reports them unsigned; their checksum detects accidental changes only.
