import { readFile, stat } from 'node:fs/promises';

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

export type HarnessReceipt = z.infer<typeof harnessReceiptSchema>;

export interface ReceiptPreview {
  runId: string;
  taskType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  stageCount: number;
  degraded: boolean;
  sourcePath: string;
}

export async function readHarnessReceipt(
  requestedPath: string,
  approvedRoots: string[],
  maxBytes = 2_000_000,
): Promise<{ receipt: HarnessReceipt; preview: ReceiptPreview }> {
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

  const receipt = harnessReceiptSchema.parse(parsed);
  const successfulStates = new Set([
    'complete',
    'completed',
    'passed',
    'success',
    'succeeded',
    'ok',
  ]);
  return {
    receipt,
    preview: {
      runId: receipt.run_id,
      taskType: receipt.task.type,
      status: receipt.status,
      startedAt: receipt.started_at,
      completedAt: receipt.completed_at ?? null,
      stageCount: receipt.stages.length,
      degraded:
        !successfulStates.has(receipt.status.toLowerCase()) ||
        receipt.stages.some(
          (stage) =>
            stage.status !== undefined && !successfulStates.has(stage.status.toLowerCase()),
        ),
      sourcePath,
    },
  };
}
