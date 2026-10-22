export interface ApprovedRootDto {
  id: string;
  path: string;
  label: string;
  createdAt: string;
}

export interface RepositoryDto {
  id: string;
  path: string;
  name: string;
  snapshot: {
    repositoryId: string;
    head: string;
    branch: string | null;
    statusEntries: string[];
    worktreeHash: string;
    diffStats: {
      changedFiles: number;
      additions: number;
      deletions: number;
      binaryFiles: number;
      untrackedFiles: number;
    };
    fingerprint: string;
    capturedAt: string;
  };
  updatedAt: string;
}

export interface ReceiptDto {
  id: string;
  runId: string;
  sourcePath: string;
  taskType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  stageCount: number;
  degraded: boolean;
  importedAt: string;
}

export interface ReceiptPreviewDto {
  runId: string;
  taskType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  stageCount: number;
  degraded: boolean;
  sourcePath: string;
  sourceType: string;
  sourceLabel: string;
  title: string;
  claim: string;
}

export interface WorkItemDto {
  id: string;
  repositoryId: string | null;
  sourceType: string;
  sourceRef: string;
  title: string;
  claim: string;
  sourceLabel: string;
  updatedAt: string;
  snapshotFingerprint: string | null;
  humanVerdict: 'accepted' | 'changes-requested' | 'rejected' | null;
}

export interface ContractDto {
  id: string;
  version: string;
  title: string;
  criteria: Array<{ id?: string; title?: string; required?: boolean }>;
  createdAt: string;
}

export interface CheckDto {
  id: string;
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
  definitionHash: string;
  approvedAt: string;
}

export interface EvidenceDto {
  id: string;
  workItemId: string;
  checkId: string;
  kind: string;
  label: string;
  result: string;
  repositoryId: string;
  snapshotFingerprint: string;
  head: string;
  completedAt: string;
  durationMs: number;
  toolVersion: string | null;
  exitCode: number | null;
  invalidReason: string | null;
  isolation: 'clean-checkout' | null;
}

export interface VerdictDto {
  id: string;
  workItemId: string;
  decision: 'accepted' | 'changes-requested' | 'rejected';
  note: string;
  decidedAt: string;
  snapshotFingerprint: string;
  overrideReason: string | null;
}

export interface BootstrapDto {
  mode: 'local' | 'demo';
  csrfToken: string;
  sourceIssues: Array<{ repositoryId: string; message: string }>;
  roots: ApprovedRootDto[];
  repositories: RepositoryDto[];
  receipts: ReceiptDto[];
  workItems: WorkItemDto[];
  contracts: ContractDto[];
  checks: CheckDto[];
  evidence: EvidenceDto[];
  verdicts: VerdictDto[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T & { error?: string; message?: string };
  if (!response.ok)
    throw new Error(body.message ?? body.error ?? `Request failed (${response.status}).`);
  return body;
}

export function fetchBootstrap(signal?: AbortSignal): Promise<BootstrapDto> {
  return request<BootstrapDto>('/api/v1/bootstrap', signal ? { signal } : undefined);
}

export type SourceKind = 'root' | 'repository' | 'receipt';

export async function addLocalSource(
  kind: SourceKind,
  path: string,
  csrfToken: string,
  label?: string,
): Promise<void> {
  const endpoint =
    kind === 'root'
      ? '/api/v1/roots'
      : kind === 'repository'
        ? '/api/v1/repositories'
        : '/api/v1/receipts/import';
  await request(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VeriDone-CSRF': csrfToken,
    },
    body: JSON.stringify(kind === 'root' ? { path, label: label || undefined } : { path }),
  });
}

export async function discoverRepositories(rootId: string, csrfToken: string): Promise<string[]> {
  const result = await mutate<{ repositories: string[] }>(
    '/api/v1/repositories/discover',
    csrfToken,
    { rootId },
  );
  return result.repositories;
}

export async function previewReceipts(
  path: string,
  csrfToken: string,
): Promise<ReceiptPreviewDto[]> {
  const result = await mutate<{ previews: ReceiptPreviewDto[] }>(
    '/api/v1/receipts/preview',
    csrfToken,
    { path },
  );
  return result.previews;
}

async function mutate<T>(url: string, csrfToken: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VeriDone-CSRF': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

export async function linkWorkItem(
  workItemId: string,
  repositoryId: string,
  csrfToken: string,
): Promise<void> {
  await mutate(`/api/v1/work-items/${workItemId}/link`, csrfToken, { repositoryId });
}

export interface NewCheckInput {
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
}

export async function createCheck(input: NewCheckInput, csrfToken: string): Promise<void> {
  await mutate('/api/v1/checks', csrfToken, input);
}

export async function runCheck(
  checkId: string,
  workItemId: string,
  csrfToken: string,
  runId: string,
): Promise<void> {
  await mutate(`/api/v1/checks/${checkId}/run`, csrfToken, { workItemId, runId });
}

export async function cancelCheck(runId: string, csrfToken: string): Promise<void> {
  await mutate(`/api/v1/check-runs/${runId}/cancel`, csrfToken, {});
}

export async function createVerdict(
  workItemId: string,
  decision: 'accepted' | 'changes-requested' | 'rejected',
  note: string,
  csrfToken: string,
  overrideReason: string | null = null,
): Promise<void> {
  await mutate(`/api/v1/work-items/${workItemId}/verdicts`, csrfToken, {
    decision,
    note,
    overrideReason,
  });
}

export async function importWorkspaceDocument(
  document: unknown,
  csrfToken: string,
): Promise<{ imported: Record<string, number> }> {
  return mutate('/api/v1/workspace/import', csrfToken, document);
}
