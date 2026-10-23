import path from 'node:path';

import { canonicalJson, evidenceKindSchema, sha256Hex } from '@veridone/core';
import { z } from 'zod';

const relativeScopePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .transform((value) => value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, ''))
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      value !== '..' &&
      !value.startsWith('../') &&
      !value.includes('/../'),
    'Declared scope paths must remain inside the repository.',
  );

export const checkRequestSchema = z.object({
  repositoryId: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  kind: evidenceKindSchema,
  executable: z.string().min(1).max(4_096),
  args: z.array(z.string().max(4_096)).max(100),
  versionArgs: z.array(z.string().max(4_096)).max(10).default(['--version']),
  // "./" names the whole repository, which is the same as declaring no scope.
  scopePaths: z
    .array(relativeScopePathSchema)
    .max(100)
    .default([])
    .transform((paths) => paths.filter((value) => value !== '')),
  cwdRelative: z
    .string()
    .min(1)
    .max(1_024)
    .refine((value) => !path.isAbsolute(value), 'The check working directory must be relative.'),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(30 * 60_000)
    .default(120_000),
  maxOutputBytes: z.number().int().min(1_024).max(10_000_000).default(1_000_000),
});

export interface CheckDefinition {
  repositoryId: string;
  label: string;
  kind: string;
  executable: string;
  args: string[];
  versionArgs: string[];
  scopePaths: string[];
  cwdRelative: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Canonical path of the tool file the operator approved; null until the tool is pinned. */
  resolvedExecutable: string | null;
  executableSha256: string | null;
}

/** Hashes exactly the fields that define a check, including the pinned tool. */
export async function checkDefinitionHash(definition: CheckDefinition): Promise<string> {
  return sha256Hex(
    canonicalJson({
      repositoryId: definition.repositoryId,
      label: definition.label,
      kind: definition.kind,
      executable: definition.executable,
      args: definition.args,
      versionArgs: definition.versionArgs,
      scopePaths: definition.scopePaths,
      cwdRelative: definition.cwdRelative,
      timeoutMs: definition.timeoutMs,
      maxOutputBytes: definition.maxOutputBytes,
      resolvedExecutable: definition.resolvedExecutable,
      executableSha256: definition.executableSha256,
    }),
  );
}
