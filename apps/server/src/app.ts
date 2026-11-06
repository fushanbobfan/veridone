import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';

import {
  captureGitSnapshot,
  discoverGitRepositories,
  ExecutableResolutionError,
  pinExecutable,
  readReceiptCollection,
} from '@veridone/adapters';

import { CheckCapacityError, CheckExecutionManager } from './check-execution.js';
import { checkDefinitionHash, checkRequestSchema } from './check-policy.js';
import { acceptanceReadiness } from './check-runner.js';
import { allowedHosts, type ServerConfig } from './config.js';
import {
  VerdictConflictError,
  type CheckRecord,
  type RepositoryRecord,
  type VeriDoneDatabase,
} from './database.js';
import { buildAcceptancePacket, workspaceSigningKey } from './packet.js';
import {
  exportWorkspace,
  importWorkspace,
  maxWorkspaceBackupBytes,
  WorkspaceConflictError,
} from './workspace.js';

const rootRequestSchema = z.object({
  path: z.string().min(1).max(4_096),
  label: z.string().min(1).max(120).optional(),
});
const rootIdSchema = z.object({ rootId: z.string().uuid() });
const repositoryRequestSchema = z.object({ path: z.string().min(1).max(4_096) });
const receiptRequestSchema = z.object({ path: z.string().min(1).max(4_096) });
const linkRequestSchema = z.object({ repositoryId: z.string().min(1).max(128) });
// The tool file the operator reviewed; pinning records it only if it is still what resolves.
const pinRequestSchema = z.object({
  expected: z
    .object({
      path: z.string().min(1).max(4_096),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
});
// The definition the operator saw; a check retires only while it is still the one on record.
const retireRequestSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
  expected: z.object({ definitionHash: z.string().regex(/^[0-9a-f]{64}$/iu) }).strict(),
});
const replaceRequestSchema = retireRequestSchema.extend({ check: checkRequestSchema });
const runCheckRequestSchema = z.object({
  workItemId: z.string().uuid(),
  runId: z.string().uuid().optional(),
});
const verdictRequestSchema = z.object({
  decision: z.enum(['accepted', 'changes-requested', 'rejected']),
  note: z.string().max(10_000).default(''),
  overrideReason: z.string().min(1).max(2_000).nullable().default(null),
  // What the reviewer saw when the verdict opened; the verdict is recorded only while it holds.
  expected: z
    .object({
      fingerprint: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .nullable(),
      verdictId: z.string().uuid().nullable(),
      claimHash: z.string().regex(/^[0-9a-f]{64}$/u),
    })
    .strict(),
});

export interface AppOptions {
  database: VeriDoneDatabase;
  config: ServerConfig;
  csrfToken?: string;
  checkExecutionManager?: CheckExecutionManager;
  /** The largest backup export writes and restore reads; tests lower it. */
  maxBackupBytes?: number;
}

/** How much of a check's output a reader gets at once: the end of it, where a failure usually shows. */
const outputTailCharacters = 65_536;

async function isFolder(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const csrfToken = options.csrfToken ?? randomBytes(32).toString('base64url');
  const checkExecutionManager = options.checkExecutionManager ?? new CheckExecutionManager();

  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: false,
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  // A page that rebinds its own domain to 127.0.0.1 reaches this server under that domain's name, so the server
  // answers only to its loopback names. The request line can carry an absolute URL, so both places are checked.
  const hosts = new Set(allowedHosts(options.config));
  app.use('*', async (context, next) => {
    const header = context.req.header('Host')?.toLowerCase();
    const addressed = new URL(context.req.url).host.toLowerCase();
    if ((header !== undefined && !hosts.has(header)) || !hosts.has(addressed)) {
      return context.json({ error: 'host_not_allowed' }, 403);
    }
    return next();
  });

  /** Captures a known repository again with its current check set and stores the snapshot. */
  const recaptureRepository = async (repository: RepositoryRecord) => {
    const approvedRoots = options.database.listApprovedRoots().map((root) => root.path);
    const captured = await captureGitSnapshot(repository.path, {
      approvedRoots,
      contractVersion: repository.snapshot.contractVersion,
      checkDefinitionVersion: repository.snapshot.checkDefinitionVersion,
    });
    return options.database.upsertRepository(captured.repositoryPath, captured.snapshot);
  };

  /**
   * Captures a repository again, or says why it cannot be read: a folder that went away, a root waiting for
   * approval, or Git that will not start. The last known state stays on record, so decisions can still be made.
   */
  const captureOrExplain = async (
    repository: RepositoryRecord,
  ): Promise<{ repository: RepositoryRecord; issue: string | null }> => {
    try {
      return { repository: await recaptureRepository(repository), issue: null };
    } catch (error) {
      const reason =
        error instanceof z.ZodError
          ? 'Its state does not fit a repository snapshot.'
          : error instanceof Error
            ? error.message
            : 'It could not be read.';
      return {
        repository,
        issue: `VeriDone cannot read the repository ${repository.name}. ${reason} Until it can, you can still reject its work items, request changes, or accept with an override reason.`,
      };
    }
  };

  const refreshKnownRepositories = async () => {
    const results = await Promise.all(
      options.database.listRepositories().map(async (repository) => {
        const { issue } = await captureOrExplain(repository);
        return issue === null ? null : { repositoryId: repository.id, message: issue };
      }),
    );
    return results.filter((result) => result !== null);
  };

  /** The tool file a check's executable resolves to now, for a check already on record. */
  const resolveCheckTool = async (check: CheckRecord, repository: RepositoryRecord) => {
    try {
      return await pinExecutable(check.executable, { repositoryPath: repository.path });
    } catch (error) {
      if (!(error instanceof ExecutableResolutionError)) throw error;
      throw new ExecutableResolutionError(
        `${error.message} Replace it under Checks with a check whose tool can be pinned, or retire it.`,
      );
    }
  };

  const retiredCheck = (check: CheckRecord) => ({
    error: 'check_retired',
    message: `The check "${check.label}" is retired. To run it again, approve a new check under Checks.`,
  });

  /** Why a check cannot retire now: it is unknown, already retired, or no longer what the operator saw. */
  const retireRefusal = (check: CheckRecord | null, definitionHash: string) => {
    if (!check) {
      return {
        status: 404 as const,
        body: { error: 'check_not_found', message: 'The check does not exist.' },
      };
    }
    if (check.retiredAt) return { status: 409 as const, body: retiredCheck(check) };
    if (check.definitionHash !== definitionHash) {
      return {
        status: 409 as const,
        body: {
          error: 'check_changed',
          message: `The check "${check.label}" changed after you opened it. Review it and try again.`,
        },
      };
    }
    return null;
  };

  /** Pins the tool a new definition names and completes the definition. */
  const pinnedDefinition = async (
    request: z.infer<typeof checkRequestSchema>,
    repository: RepositoryRecord,
  ) => {
    // Approval pins the tool file it resolves to; each run verifies that file before starting it.
    const tool = await pinExecutable(request.executable, { repositoryPath: repository.path });
    const definition = { ...request, resolvedExecutable: tool.path, executableSha256: tool.sha256 };
    return { ...definition, definitionHash: await checkDefinitionHash(definition) };
  };

  const maxBackupBytes = options.maxBackupBytes ?? maxWorkspaceBackupBytes;
  const backupLimitLabel = `${Math.round(maxBackupBytes / 1_000_000)} MB`;
  const backupTooLarge = () => ({
    error: 'workspace_too_large',
    message: `This workspace's backup would be larger than ${backupLimitLabel}, the most a restore reads, so VeriDone did not write it. To keep a copy of everything, stop VeriDone and copy its data directory, ${options.config.dataDirectory}.`,
  });

  app.use('*', async (context, next) => {
    const origin = context.req.header('Origin');
    if (origin && !options.config.allowedOrigins.includes(origin)) {
      return context.json({ error: 'origin_not_allowed' }, 403);
    }

    await next();
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    context.header('Cache-Control', 'no-store');
    if (origin) {
      context.header('Access-Control-Allow-Origin', origin);
      context.header('Vary', 'Origin');
    }
  });

  app.options('*', (context) => {
    context.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    context.header('Access-Control-Allow-Headers', 'Content-Type, X-VeriDone-CSRF');
    return context.body(null, 204);
  });

  app.use('/api/v1/*', async (context, next) => {
    if (context.req.method === 'GET' || context.req.method === 'HEAD') return next();
    if (context.req.header('X-VeriDone-CSRF') !== csrfToken) {
      return context.json({ error: 'csrf_token_invalid' }, 403);
    }
    return next();
  });

  app.get('/api/v1/health', (context) =>
    context.json({ status: 'ok', mode: options.config.demoMode ? 'demo' : 'local' }),
  );

  app.get('/api/v1/bootstrap', async (context) => {
    const sourceIssues = await refreshKnownRepositories();
    const issueOf = new Map(sourceIssues.map((issue) => [issue.repositoryId, issue.message]));
    return context.json({
      mode: options.config.demoMode ? 'demo' : 'local',
      csrfToken,
      sourceIssues,
      roots: await Promise.all(
        options.database
          .listRoots()
          .map(async (root) => ({ ...root, missing: !(await isFolder(root.path)) })),
      ),
      repositories: options.database.listRepositories(),
      receipts: options.database.listReceipts(),
      workItems: options.database.listWorkItems(),
      contracts: options.database.listContracts(),
      checks: options.database.listChecks(),
      // This answers every few seconds, so a run's output stays out of it and reads on demand.
      evidence: options.database.listEvidenceSummaries(),
      verdicts: options.database.listVerdicts(),
      signingKey: { keyId: workspaceSigningKey(options.database).keyId },
      // The same readiness the verdict gate applies, so the review view and the service agree.
      readiness: Object.fromEntries(
        options.database.listWorkItems().map((item) => [
          item.id,
          acceptanceReadiness(options.database, item.id, {
            repositoryIssue: issueOf.get(item.repositoryId ?? '') ?? null,
          }),
        ]),
      ),
    });
  });

  // What a run printed, after redaction: the end of each stream, where a failure usually shows.
  app.get('/api/v1/evidence/:id/output', (context) => {
    const evidence = options.database.getEvidence(context.req.param('id'));
    if (!evidence) return context.json({ error: 'evidence_not_found' }, 404);
    return context.json({
      stdout: evidence.stdout.slice(-outputTailCharacters),
      stderr: evidence.stderr.slice(-outputTailCharacters),
      truncated:
        evidence.stdout.length > outputTailCharacters ||
        evidence.stderr.length > outputTailCharacters,
    });
  });

  // The public half of the key packets are signed with, for the operator to publish where readers can find it.
  app.get('/api/v1/workspace/signing-key', (context) => {
    const key = workspaceSigningKey(options.database);
    context.header('Content-Type', 'application/x-pem-file; charset=utf-8');
    context.header('Content-Disposition', 'attachment; filename="veridone-signing-key.pem"');
    context.header('X-VeriDone-Key-Id', key.keyId);
    return context.body(key.publicKey);
  });

  app.get('/api/v1/workspace/export', async (context) => {
    // Refused before any of it is read, since a workspace far past the limit would not fit in memory.
    if (options.database.evidenceOutputBytes() > maxBackupBytes) {
      return context.json(backupTooLarge(), 413);
    }
    let text: string;
    try {
      text = `${JSON.stringify(await exportWorkspace(options.database), null, 2)}\n`;
    } catch (error) {
      // A workspace past what one JavaScript string holds fails while it is serialized.
      if (!(error instanceof RangeError)) throw error;
      return context.json(backupTooLarge(), 413);
    }
    // Nothing goes out that restore would refuse.
    if (Buffer.byteLength(text) > maxBackupBytes) return context.json(backupTooLarge(), 413);
    context.header('Content-Type', 'application/json; charset=utf-8');
    context.header(
      'Content-Disposition',
      `attachment; filename="veridone-workspace-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return context.body(text);
  });

  const workspaceBodyLimit = bodyLimit({
    maxSize: maxBackupBytes,
    onError: (context) =>
      context.json(
        {
          error: 'workspace_too_large',
          message: `This backup is larger than ${backupLimitLabel}, the most a restore reads.`,
        },
        413,
      ),
  });

  const readBackup = async (request: { json: () => Promise<unknown> }): Promise<unknown> => {
    try {
      return await request.json();
    } catch {
      throw new Error('This file is not a VeriDone workspace backup: it does not hold valid JSON.');
    }
  };

  // What a restore of this backup would add, found by running the restore and rolling it back.
  app.post('/api/v1/workspace/preview', workspaceBodyLimit, async (context) =>
    context.json(
      await importWorkspace(options.database, await readBackup(context.req), { dryRun: true }),
    ),
  );

  app.post('/api/v1/workspace/import', workspaceBodyLimit, async (context) => {
    const result = await importWorkspace(options.database, await readBackup(context.req));
    return context.json(result, 201);
  });

  app.post('/api/v1/roots', async (context) => {
    const request = rootRequestSchema.parse(await context.req.json());
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(path.resolve(request.path));
    } catch {
      return context.json(
        { error: 'root_missing', message: `${request.path} does not exist on this machine.` },
        400,
      );
    }
    const rootStat = await stat(canonicalPath);
    if (!rootStat.isDirectory()) return context.json({ error: 'root_is_not_directory' }, 400);
    const root = options.database.addApprovedRoot(canonicalPath, request.label);
    return context.json({ root }, 201);
  });

  // A restored root takes effect once the operator approves it, after the checks adding a root runs, and only
  // while its stored path still resolves to itself.
  app.post('/api/v1/roots/:id/approve', async (context) => {
    const root = options.database.getRoot(context.req.param('id'));
    if (!root) return context.json({ error: 'approved_root_not_found' }, 404);
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(root.path);
    } catch {
      return context.json(
        {
          error: 'root_missing',
          message: `${root.path} does not exist on this machine. Put the folder back, or add its new location as a new root.`,
        },
        400,
      );
    }
    if (!(await stat(canonicalPath)).isDirectory()) {
      return context.json({ error: 'root_is_not_directory' }, 400);
    }
    if (canonicalPath !== root.path) {
      return context.json(
        {
          error: 'root_moved',
          message: `${root.path} now resolves to ${canonicalPath}. To use that directory, add it as a new root.`,
        },
        409,
      );
    }
    return context.json({ root: options.database.approveRoot(root.id) });
  });

  app.post('/api/v1/repositories/discover', async (context) => {
    const request = rootIdSchema.parse(await context.req.json());
    const root = options.database.getRoot(request.rootId);
    if (!root) return context.json({ error: 'approved_root_not_found' }, 404);
    if (root.status !== 'approved') return context.json({ error: 'root_pending_approval' }, 409);
    const repositories = await discoverGitRepositories(root.path);
    return context.json({ repositories });
  });

  app.post('/api/v1/repositories', async (context) => {
    const request = repositoryRequestSchema.parse(await context.req.json());
    const approvedRoots = options.database.listApprovedRoots().map((root) => root.path);
    const captured = await captureGitSnapshot(request.path, {
      approvedRoots,
      contractVersion: 'default-v1',
      checkDefinitionVersion: 'default-v1',
    });
    const repository = options.database.upsertRepository(
      captured.repositoryPath,
      captured.snapshot,
    );
    return context.json({ repository }, 201);
  });

  app.post('/api/v1/repositories/:id/refresh', async (context) => {
    const existing = options.database.getRepository(context.req.param('id'));
    if (!existing) return context.json({ error: 'repository_not_found' }, 404);
    const approvedRoots = options.database.listApprovedRoots().map((root) => root.path);
    const captured = await captureGitSnapshot(existing.path, {
      approvedRoots,
      contractVersion: existing.snapshot.contractVersion,
      checkDefinitionVersion: existing.snapshot.checkDefinitionVersion,
    });
    return context.json({
      repository: options.database.upsertRepository(captured.repositoryPath, captured.snapshot),
    });
  });

  app.post('/api/v1/receipts/preview', async (context) => {
    const request = receiptRequestSchema.parse(await context.req.json());
    const approvedRoots = options.database.listApprovedRoots().map((root) => root.path);
    const previews = (await readReceiptCollection(request.path, approvedRoots)).map(
      (result) => result.preview,
    );
    return context.json({ preview: previews[0], previews });
  });

  app.post('/api/v1/receipts/import', async (context) => {
    const request = receiptRequestSchema.parse(await context.req.json());
    const approvedRoots = options.database.listApprovedRoots().map((root) => root.path);
    const previews = (await readReceiptCollection(request.path, approvedRoots)).map(
      (result) => result.preview,
    );
    return context.json({ imported: options.database.importReceipts(previews) }, 201);
  });

  app.post('/api/v1/work-items/:id/link', async (context) => {
    const request = linkRequestSchema.parse(await context.req.json());
    return context.json({
      workItem: options.database.linkWorkItem(context.req.param('id'), request.repositoryId),
    });
  });

  app.post('/api/v1/checks', async (context) => {
    const request = checkRequestSchema.parse(await context.req.json());
    const repository = options.database.getRepository(request.repositoryId);
    if (!repository) return context.json({ error: 'repository_not_found' }, 404);
    const check = options.database.addCheck(await pinnedDefinition(request, repository));
    await recaptureRepository(repository);
    return context.json({ check }, 201);
  });

  // The file that pinning would record now, so the operator can review it first.
  app.get('/api/v1/checks/:id/tool', async (context) => {
    const existing = options.database.getCheck(context.req.param('id'));
    if (!existing) return context.json({ error: 'check_not_found' }, 404);
    if (existing.retiredAt) return context.json(retiredCheck(existing), 409);
    const repository = options.database.getRepository(existing.repositoryId);
    if (!repository) return context.json({ error: 'repository_not_found' }, 404);
    return context.json({ tool: await resolveCheckTool(existing, repository) });
  });

  // Takes a check out of the gate. The check set changes, and evidence counts only under the set it ran with,
  // so the remaining checks need a run under the new set unless they already have one on this commit.
  app.post('/api/v1/checks/:id/retire', async (context) => {
    const request = retireRequestSchema.parse(await context.req.json());
    const existing = options.database.getCheck(context.req.param('id'));
    const refusal = retireRefusal(existing, request.expected.definitionHash);
    if (refusal || !existing) return context.json(refusal?.body, refusal?.status);
    const check = options.database.retireCheck(existing.id, request.reason);
    // A check can retire while its repository cannot be read.
    const repository = options.database.getRepository(existing.repositoryId);
    if (repository) await captureOrExplain(repository);
    return context.json({ check });
  });

  // Approves a new definition in place of a check, in one step: a refusal leaves the old check counting.
  app.post('/api/v1/checks/:id/replace', async (context) => {
    const request = replaceRequestSchema.parse(await context.req.json());
    const checkId = context.req.param('id');
    const existing = options.database.getCheck(checkId);
    const refusal = retireRefusal(existing, request.expected.definitionHash);
    if (refusal || !existing) return context.json(refusal?.body, refusal?.status);
    if (request.check.repositoryId !== existing.repositoryId) {
      return context.json(
        {
          error: 'check_repository_mismatch',
          message: 'A replacement belongs to the repository of the check it replaces.',
        },
        400,
      );
    }
    const repository = options.database.getRepository(existing.repositoryId);
    if (!repository) return context.json({ error: 'repository_not_found' }, 404);
    const definition = await pinnedDefinition(request.check, repository);
    // Pinning awaited, so look at the old check again; nothing awaits from here to the write.
    const late = retireRefusal(options.database.getCheck(checkId), request.expected.definitionHash);
    if (late) return context.json(late.body, late.status);
    const replaced = options.database.replaceCheck(checkId, definition, request.reason);
    await captureOrExplain(repository);
    return context.json(replaced, 201);
  });

  app.post('/api/v1/checks/:id/pin', async (context) => {
    const request = pinRequestSchema.parse(await context.req.json());
    const existing = options.database.getCheck(context.req.param('id'));
    if (!existing) return context.json({ error: 'check_not_found' }, 404);
    if (existing.retiredAt) return context.json(retiredCheck(existing), 409);
    const repository = options.database.getRepository(existing.repositoryId);
    if (!repository) return context.json({ error: 'repository_not_found' }, 404);
    const tool = await resolveCheckTool(existing, repository);
    if (tool.path !== request.expected.path || tool.sha256 !== request.expected.sha256) {
      return context.json(
        {
          error: 'tool_changed',
          message:
            'The tool file changed after it was reviewed. Review it again before pinning it.',
          tool,
        },
        409,
      );
    }
    const check = options.database.updateCheckPin(
      existing.id,
      tool,
      await checkDefinitionHash({
        ...existing,
        resolvedExecutable: tool.path,
        executableSha256: tool.sha256,
      }),
    );
    await recaptureRepository(repository);
    return context.json({ check });
  });

  app.post('/api/v1/checks/:id/run', async (context) => {
    const request = runCheckRequestSchema.parse(await context.req.json());
    const { runId, evidence } = await checkExecutionManager.run(
      options.database,
      context.req.param('id'),
      request.workItemId,
      request.runId,
    );
    return context.json({
      runId,
      evidence,
      readiness: acceptanceReadiness(options.database, request.workItemId),
    });
  });

  app.post('/api/v1/check-runs/:id/cancel', (context) => {
    if (!checkExecutionManager.cancel(context.req.param('id'))) {
      return context.json({ error: 'check_run_not_active' }, 404);
    }
    return context.json({ cancelled: true }, 202);
  });

  app.post('/api/v1/work-items/:id/verdicts', async (context) => {
    const workItemId = context.req.param('id');
    const request = verdictRequestSchema.parse(await context.req.json());
    const workItem = options.database.getWorkItem(workItemId);
    if (!workItem?.repositoryId) {
      return context.json(
        {
          error: 'work_item_not_bound',
          message: 'Bind the work item to a repository before recording a verdict.',
        },
        409,
      );
    }
    const known = options.database.getRepository(workItem.repositoryId);
    if (!known) return context.json({ error: 'repository_not_found' }, 404);
    // The decision binds to the repository state captured at decision time. A repository that cannot be read
    // stops no decision: the verdict binds to the last state known, and a plain acceptance stays refused.
    const { repository, issue } = await captureOrExplain(known);
    // A changed state is the reason to report, ahead of any gate it may have reopened.
    options.database.assertVerdictExpectation(workItemId, request.expected);
    const readiness = acceptanceReadiness(options.database, workItemId, { repositoryIssue: issue });
    if (request.decision === 'accepted' && !readiness.ready && !request.overrideReason) {
      return context.json(
        {
          error: 'required_gates_open',
          message:
            issue ??
            'A plain acceptance needs every required gate to pass. Resolve the open gates, or give an override reason.',
          readiness,
        },
        409,
      );
    }
    const verdict = options.database.recordVerdict(
      {
        workItemId,
        decision: request.decision,
        note: request.note,
        snapshotFingerprint: repository.snapshot.fingerprint,
        contractVersion: repository.snapshot.contractVersion,
        evidenceIds: readiness.evidenceIds,
        // An override explains an acceptance with open gates; with every gate passing it is a plain acceptance.
        overrideReason:
          request.decision === 'accepted' && !readiness.ready ? request.overrideReason : null,
      },
      request.expected,
    );
    return context.json({ verdict, readiness }, 201);
  });

  app.get('/api/v1/work-items/:id/packet/:format', async (context) => {
    const format = z.enum(['json', 'md', 'html']).parse(context.req.param('format'));
    const built = await buildAcceptancePacket(options.database, context.req.param('id'));
    const content = format === 'json' ? built.json : format === 'md' ? built.markdown : built.html;
    const contentType =
      format === 'json'
        ? 'application/json; charset=utf-8'
        : format === 'md'
          ? 'text/markdown; charset=utf-8'
          : 'text/html; charset=utf-8';
    context.header('Content-Type', contentType);
    context.header(
      'Content-Disposition',
      `attachment; filename="veridone-${context.req.param('id')}.${format}"`,
    );
    return context.body(content);
  });

  app.onError((error, context) => {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      return context.json(
        {
          error: 'invalid_request',
          message: `The request is not valid: ${issue?.path.join('.') || 'its body'}: ${issue?.message ?? 'unreadable'}.`,
          issues: error.issues,
        },
        400,
      );
    }
    if (error instanceof CheckCapacityError) {
      return context.json({ error: 'check_capacity_reached', limit: error.limit }, 429);
    }
    if (error instanceof WorkspaceConflictError) {
      return context.json({ error: 'workspace_conflict', message: error.message }, 409);
    }
    if (error instanceof VerdictConflictError) {
      return context.json(
        {
          error: 'verdict_conflict',
          reason: error.reason,
          message: error.message,
          current: error.current,
        },
        409,
      );
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return context.json({ error: 'request_failed', message }, 400);
  });

  return app;
}
