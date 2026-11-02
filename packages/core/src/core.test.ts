import { describe, expect, it } from 'vitest';

import { assessDeclaredScope, createRepositorySnapshot } from './index.js';

const capturedAt = '2026-07-21T20:00:00.000Z';

function snapshot(overrides: { statusEntries?: string[]; checkDefinitionVersion?: string } = {}) {
  return createRepositorySnapshot(
    {
      repositoryId: 'repo-1',
      head: '1234567890abcdef',
      branch: 'main',
      statusEntries: overrides.statusEntries ?? [],
      submoduleEntries: [],
      contractVersion: '1',
      checkDefinitionVersion: overrides.checkDefinitionVersion ?? '1',
    },
    capturedAt,
  );
}

describe('repository fingerprint', () => {
  it('changes with the work tree', async () => {
    const clean = await snapshot();
    const changed = await snapshot({ statusEntries: [' M src/index.ts'] });
    expect(changed.fingerprint).not.toBe(clean.fingerprint);
  });

  it('leaves acceptance-policy versions to their own comparison', async () => {
    const original = await snapshot();
    const policyChanged = await snapshot({ checkDefinitionVersion: '2' });
    expect(policyChanged.fingerprint).toBe(original.fingerprint);
    expect(policyChanged.checkDefinitionVersion).toBe('2');
  });
});

describe('declared scope', () => {
  it('matches a scope prefix only at a path boundary', () => {
    expect(
      assessDeclaredScope([' M apps/web/src/App.tsx', '?? apps/webhook/escape.ts'], ['apps/web']),
    ).toMatchObject({
      declared: true,
      satisfied: false,
      outsidePaths: ['apps/webhook/escape.ts'],
    });
  });

  it('reports no drift when no scope is declared', () => {
    expect(assessDeclaredScope([' M SECURITY.md'], [])).toMatchObject({
      declared: false,
      satisfied: true,
      outsidePaths: [],
    });
  });
});
