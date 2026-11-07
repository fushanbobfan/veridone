import type { Page, Route } from '@playwright/test';

/**
 * A bootstrap the page reads as given: one work item ready for a verdict and one root waiting for approval, so that a
 * decision and a workspace change are both on offer. A real service derives readiness from passing checks, and would
 * also list the pending root's repository under source issues.
 */
export const workspace = {
  mode: 'local',
  csrfToken: 'stand-in',
  sourceIssues: [],
  roots: [
    {
      id: 'root',
      path: '/stand-in',
      label: 'Stand-in root',
      createdAt: '2026-11-01T00:00:00.000Z',
      status: 'pending',
      missing: false,
      onlyCovers: ['repository'],
      removedAt: null,
      removedReason: null,
    },
  ],
  repositories: [
    {
      id: 'repository',
      path: '/stand-in/repository',
      name: 'stand-in-repository',
      snapshot: {
        repositoryId: 'repository',
        head: 'a'.repeat(40),
        branch: 'main',
        statusEntries: [],
        worktreeHash: 'b'.repeat(64),
        diffStats: {
          changedFiles: 0,
          additions: 0,
          deletions: 0,
          binaryFiles: 0,
          untrackedFiles: 0,
        },
        fingerprint: 'current-state',
        contractVersion: 'stand-in',
        checkDefinitionVersion: 'stand-in',
        capturedAt: '2026-11-01T00:00:00.000Z',
      },
      updatedAt: '2026-11-01T00:00:00.000Z',
      removedAt: null,
      removedReason: null,
    },
  ],
  receipts: [],
  workItems: [
    {
      id: 'work-item',
      repositoryId: 'repository',
      sourceType: 'manual',
      sourceRef: 'manual:stand-in',
      title: 'Stand-in work item',
      claim: 'Stand-in claim',
      sourceLabel: 'Stand-in source',
      updatedAt: '2026-11-01T00:00:00.000Z',
      snapshotFingerprint: 'current-state',
      humanVerdict: null,
      claimHash: 'stand-in',
      removedAt: null,
      removedReason: null,
    },
  ],
  removed: { roots: [], repositories: [], workItems: [] },
  contracts: [],
  checks: [],
  evidence: [],
  verdicts: [],
  signingKey: { keyId: 'stand-in' },
  readiness: {
    'work-item': {
      ready: true,
      repositoryIssue: null,
      bound: true,
      bindingFresh: true,
      degraded: false,
      checkCount: 0,
      passingCount: 0,
      evidenceIds: [],
      scopeDeclared: false,
      scopeDriftPaths: [],
      checks: [],
    },
  },
};

export type Answer = (route: Route) => Promise<void>;

export const answers =
  (body: unknown): Answer =>
  (route) =>
    route.fulfill({ json: body });
/** What the browser sees when nothing listens on the page's port. */
export const refused: Answer = (route) => route.abort('connectionrefused');
/** What Vite's proxy answers once the service behind it has stopped. */
export const proxyError: Answer = (route) =>
  route.fulfill({ status: 502, contentType: 'text/plain', body: '' });

/** The same work item bound to an earlier state of its repository, so the page offers to bind it again. */
export const movedOn = {
  ...workspace,
  workItems: workspace.workItems.map((item) => ({
    ...item,
    snapshotFingerprint: 'earlier-state',
  })),
};

/** Answers the page's bootstrap requests; a test sets `answer` to stop the service and to start it again. */
export async function standInService(page: Page, body: unknown = workspace) {
  const service = { requests: 0, answer: answers(body) };
  await page.route('**/api/v1/bootstrap', (route) => {
    service.requests += 1;
    return service.answer(route);
  });
  return service;
}
