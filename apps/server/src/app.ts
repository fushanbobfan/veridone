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
  pinExecutable,
  readReceiptCollection,
} from '@veridone/adapters';

import { CheckCapacityError, CheckExecutionManager } from './check-execution.js';
import { checkDefinitionHash, checkRequestSchema } from './check-policy.js';
import { acceptanceReadiness, aggregateCheckVersion } from './check-runner.js';
import type { ServerConfig } from './config.js';
import type { RepositoryRecord, VeriDoneDatabase } from './database.js';
import { buildAcceptancePacket } from './packet.js';
import { exportWorkspace, importWorkspace, WorkspaceConflictError } from './workspace.js';

const rootRequestSchema = z.object({
  path: z.string().min(1).max(4_096),
  label: z.string().min(1).max(120).optional(),
});
const rootIdSchema = z.object({ rootId: z.string().uuid() });
const repositoryRequestSchema = z.object({ path: z.string().min(1).max(4_096) });
const receiptRequestSchema = z.object({ path: z.string().min(1).max(4_096) });
const linkRequestSchema = z.object({ repositoryId: z.string().min(1).max(128) });
const runCheckRequestSchema = z.object({
  workItemId: z.string().uuid(),
  runId: z.string().uuid().optional(),
});
const verdictRequestSchema = z.object({
  decision: z.enum(['accepted', 'changes-requested', 'rejected']),
  note: z.string().max(10_000).default(''),
  overrideReason: z.string().min(1).max(2_000).nullable().default(null),
});

export interface AppOptions {
  database: VeriDoneDatabase;
  config: ServerConfig;
  csrfToken?: string;
  checkExecutionManager?: CheckExecutionManager;
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

  const refreshKnownRepositories = async () => {
    const approvedRoots = options.database.listApprovedRoots().map((root) => root.path);
    const results = await Promise.all(
      options.database.listRepositories().map(async (repository) => {
        try {
          const checks = options.database
            .listChecks()
            .filter((check) => check.repositoryId === repository.id);
          const captured = await captureGitSnapshot(repository.path, {
            approvedRoots,
            contractVersion: repository.snapshot.contractVersion,
            checkDefinitionVersion:
              checks.length > 0
                ? await aggregateCheckVersion(checks)
                : repository.snapshot.checkDefinitionVersion,
          });
          options.database.upsertRepository(captured.repositoryPath, captured.snapshot);
          return null;
        } catch (error) {
          return {
            repositoryId: repository.id,
            message: error instanceof Error ? error.message : 'Repository refresh failed.',
          };
        }
      }),
    );
    return results.filter((result) => result !== null);
  };

  /** Records the repository's new aggregate check version after its check set changed. */
  const refreshCheckDefinitionVersion = async (repository: RepositoryRecord) => {
    const approvedRoots = options.database.listApprovedRoots().map((root) => root.path);
    const checks = options.database
      .listChecks()
      .filter((candidate) => candidate.repositoryId === repository.id);
    const captured = await captureGitSnapshot(repository.path, {
      approvedRoots,
      contractVersion: repository.snapshot.contractVersion,
      checkDefinitionVersion: await aggregateCheckVersion(checks),
    });
    options.database.upsertRepository(captured.repositoryPath, captured.snapshot);
  };

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
    return context.json({
      mode: options.config.demoMode ? 'demo' : 'local',
      csrfToken,
      sourceIssues,
      roots: options.database.listApprovedRoots(),
      repositories: options.database.listRepositories(),
      receipts: options.database.listReceipts(),
      workItems: options.database.listWorkItems(),
      contracts: options.database.listContracts(),
      checks: options.database.listChecks(),
      evidence: options.database.listEvidence(),
      verdicts: options.database.listVerdicts(),
    });
  });

  app.get('/api/v1/workspace/export', async (context) => {
    const document = await exportWorkspace(options.database);
    context.header('Content-Type', 'application/json; charset=utf-8');
    context.header(
      'Content-Disposition',
      `attachment; filename="veridone-workspace-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return context.body(`${JSON.stringify(document, null, 2)}\n`);
  });

  app.post(
    '/api/v1/workspace/import',
    bodyLimit({
      maxSize: 25_000_000,
      onError: (context) => context.json({ error: 'workspace_too_large' }, 413),
    }),
    async (context) => {
      const result = await importWorkspace(options.database, await context.req.json());
      return context.json(result, 201);
    },
  );

  app.post('/api/v1/roots', async (context) => {
    const request = rootRequestSchema.parse(await context.req.json());
    const canonicalPath = await realpath(path.resolve(request.path));
    const rootStat = await stat(canonicalPath);
    if (!rootStat.isDirectory()) return context.json({ error: 'root_is_not_directory' }, 400);
    const root = options.database.addApprovedRoot(canonicalPath, request.label);
    return context.json({ root }, 201);
  });

  app.post('/api/v1/repositories/discover', async (context) => {
    const request = rootIdSchema.parse(await context.req.json());
    const root = options.database.getApprovedRoot(request.rootId);
    if (!root) return context.json({ error: 'approved_root_not_found' }, 404);
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
    // Approval pins the tool file it resolves to; each run verifies that file before starting it.
    const tool = await pinExecutable(request.executable, { repositoryPath: repository.path });
    const definition = { ...request, resolvedExecutable: tool.path, executableSha256: tool.sha256 };
    const check = options.database.addCheck({
      ...definition,
      definitionHash: await checkDefinitionHash(definition),
    });
    await refreshCheckDefinitionVersion(repository);
    return context.json({ check }, 201);
  });

  app.post('/api/v1/checks/:id/pin', async (context) => {
    const existing = options.database.getCheck(context.req.param('id'));
    if (!existing) return context.json({ error: 'check_not_found' }, 404);
    const repository = options.database.getRepository(existing.repositoryId);
    if (!repository) return context.json({ error: 'repository_not_found' }, 404);
    const tool = await pinExecutable(existing.executable, { repositoryPath: repository.path });
    const check = options.database.updateCheckPin(
      existing.id,
      tool,
      await checkDefinitionHash({
        ...existing,
        resolvedExecutable: tool.path,
        executableSha256: tool.sha256,
      }),
    );
    await refreshCheckDefinitionVersion(repository);
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
    if (!workItem?.repositoryId) return context.json({ error: 'work_item_not_bound' }, 409);
    const repository = options.database.getRepository(workItem.repositoryId);
    if (!repository) return context.json({ error: 'repository_not_found' }, 404);
    const readiness = acceptanceReadiness(options.database, workItemId);
    if (request.decision === 'accepted' && !readiness.ready && !request.overrideReason) {
      return context.json({ error: 'required_gates_open', readiness }, 409);
    }
    const verdict = options.database.recordVerdict({
      workItemId,
      decision: request.decision,
      note: request.note,
      snapshotFingerprint: repository.snapshot.fingerprint,
      contractVersion: repository.snapshot.contractVersion,
      evidenceIds: readiness.evidenceIds,
      // An override explains an acceptance with open gates; with every gate passing it is a plain acceptance.
      overrideReason:
        request.decision === 'accepted' && !readiness.ready ? request.overrideReason : null,
    });
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
      return context.json({ error: 'invalid_request', issues: error.issues }, 400);
    }
    if (error instanceof CheckCapacityError) {
      return context.json({ error: 'check_capacity_reached', limit: error.limit }, 429);
    }
    if (error instanceof WorkspaceConflictError) {
      return context.json({ error: 'workspace_conflict', message: error.message }, 409);
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return context.json({ error: 'request_failed', message }, 400);
  });

  return app;
}
