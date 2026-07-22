import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { resolveWithinApprovedRoots } from './path-boundary.js';

const stageSchema = z
  .object({
    name: z.string().optional(),
    provider: z.string().optional(),
    status: z.string().optional(),
    duration_ms: z.number().nonnegative().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const harnessReceiptSchema = z
  .object({
    schema_version: z.union([z.string(), z.number()]),
    run_id: z.string().min(1),
    started_at: z.string(),
    completed_at: z.string().optional(),
    duration_ms: z.number().nonnegative().optional(),
    status: z.string().min(1),
    task: z
      .object({
        type: z.string().min(1),
        mode: z.string().optional(),
        project_path: z.string().nullable().optional(),
      })
      .passthrough(),
    stages: z.array(stageSchema).max(100),
    artifacts: z.unknown().optional(),
  })
  .passthrough();

const portableReceiptSchema = z
  .object({
    schema_version: z.union([z.string(), z.number()]),
    run_id: z.string().min(1),
    source: z.enum(['codex', 'claude-code', 'ci', 'generic', 'manual']).default('generic'),
    title: z.string().min(1).max(300),
    claim: z.string().min(1).max(20_000),
    status: z.string().min(1),
    started_at: z.string(),
    completed_at: z.string().optional(),
    stages: z.array(stageSchema).max(100).default([]),
  })
  .passthrough();

export type HarnessReceipt = z.infer<typeof harnessReceiptSchema>;
export type PortableReceipt = z.infer<typeof portableReceiptSchema>;

export interface ReceiptPreview {
  runId: string;
  taskType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  stageCount: number;
  degraded: boolean;
  sourcePath: string;
  sourceType: 'codex' | 'claude-code' | 'harness' | 'ci' | 'generic' | 'manual';
  sourceLabel: string;
  title: string;
  claim: string;
}

export async function readHarnessReceipt(
  requestedPath: string,
  approvedRoots: string[],
  maxBytes = 2_000_000,
): Promise<{ receipt: HarnessReceipt | PortableReceipt; preview: ReceiptPreview }> {
  const sourcePath = await resolveWithinApprovedRoots(requestedPath, approvedRoots);
  const fileStat = await stat(sourcePath);
  if (!fileStat.isFile()) throw new Error('The receipt path is not a file.');
  if (fileStat.size > maxBytes) throw new Error(`The receipt exceeds the ${maxBytes}-byte limit.`);

  const raw = await readFile(sourcePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The receipt is not valid JSON.');
  }

  const harnessResult = harnessReceiptSchema.safeParse(parsed);
  const successfulStates = new Set([
    'complete',
    'completed',
    'passed',
    'success',
    'succeeded',
    'ok',
  ]);
  const degraded = (status: string, stages: Array<{ status?: string | undefined }>) =>
    !successfulStates.has(status.toLowerCase()) ||
    stages.some(
      (stage) => stage.status !== undefined && !successfulStates.has(stage.status.toLowerCase()),
    );

  if (harnessResult.success) {
    const receipt = harnessResult.data;
    return {
      receipt,
      preview: {
        runId: receipt.run_id,
        taskType: receipt.task.type,
        status: receipt.status,
        startedAt: receipt.started_at,
        completedAt: receipt.completed_at ?? null,
        stageCount: receipt.stages.length,
        degraded: degraded(receipt.status, receipt.stages),
        sourcePath,
        sourceType: 'harness',
        sourceLabel: 'Harness receipt',
        title: `${receipt.task.type} · ${receipt.run_id.slice(0, 12)}`,
        claim: `The harness reported this ${receipt.task.type} run as ${receipt.status}.`,
      },
    };
  }

  const portableResult = portableReceiptSchema.safeParse(parsed);
  if (!portableResult.success) {
    throw new Error(
      'The receipt matches neither the harness schema nor the VeriDone portable receipt schema.',
    );
  }
  const receipt = portableResult.data;
  return {
    receipt,
    preview: {
      runId: receipt.run_id,
      taskType: receipt.source,
      status: receipt.status,
      startedAt: receipt.started_at,
      completedAt: receipt.completed_at ?? null,
      stageCount: receipt.stages.length,
      degraded: degraded(receipt.status, receipt.stages),
      sourcePath,
      sourceType: receipt.source,
      sourceLabel: `${receipt.source === 'claude-code' ? 'Claude Code' : receipt.source === 'codex' ? 'Codex' : receipt.source.toUpperCase()} receipt`,
      title: receipt.title,
      claim: receipt.claim,
    },
  };
}

export async function readReceiptCollection(
  requestedPath: string,
  approvedRoots: string[],
  options: { maxFiles?: number; maxTotalBytes?: number } = {},
): Promise<Array<{ receipt: HarnessReceipt | PortableReceipt; preview: ReceiptPreview }>> {
  const sourcePath = await resolveWithinApprovedRoots(requestedPath, approvedRoots);
  const sourceStat = await stat(sourcePath);
  if (sourceStat.isFile()) return [await readHarnessReceipt(sourcePath, approvedRoots)];
  if (!sourceStat.isDirectory()) throw new Error('The receipt source is not a file or directory.');

  const maxFiles = options.maxFiles ?? 50;
  const maxTotalBytes = options.maxTotalBytes ?? 10_000_000;
  const entries = (await readdir(sourcePath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new Error('The receipt directory contains no JSON files.');
  if (entries.length > maxFiles) {
    throw new Error(`The receipt directory exceeds the ${maxFiles}-file limit.`);
  }
  const paths = entries.map((entry) => path.join(sourcePath, entry.name));
  const sizes = await Promise.all(paths.map(async (entryPath) => (await stat(entryPath)).size));
  const totalBytes = sizes.reduce((total, size) => total + size, 0);
  if (totalBytes > maxTotalBytes) {
    throw new Error(`The receipt directory exceeds the ${maxTotalBytes}-byte total limit.`);
  }
  return Promise.all(paths.map((entryPath) => readHarnessReceipt(entryPath, approvedRoots)));
}
