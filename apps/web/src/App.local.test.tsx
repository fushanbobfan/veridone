// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapDto, ReadinessDto, VerdictDto } from './api.js';

// App.tsx decides when it loads whether the page has a service, and under test it has none. This file loads it in
// development mode, where the page asks its service for the workspace and refreshes it every 15 seconds, and answers
// those requests itself.
let App: typeof import('./App.js').App;

beforeAll(async () => {
  vi.stubEnv('MODE', 'development');
  ({ App } = await import('./App.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  // The 15-second refresh waits for the test. Timeouts stay real, so user-event and the time limit of Testing
  // Library's waits work, but those waits poll on an interval too: here they check again only when the page changes.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const fingerprint = 'f'.repeat(64);
const claimHash = '3'.repeat(64);
const recordedAt = '2026-11-08T08:00:00.000Z';

const readiness: ReadinessDto = {
  ready: true,
  repositoryIssue: null,
  bound: true,
  bindingFresh: true,
  degraded: false,
  checkCount: 1,
  passingCount: 1,
  evidenceIds: [],
  scopeDeclared: false,
  scopeDriftPaths: [],
  checks: [],
};

/** One work item, ready for a decision, on a repository that does not change. */
function workspace(verdicts: VerdictDto[]): BootstrapDto {
  return {
    mode: 'local',
    csrfToken: 'token',
    sourceIssues: [],
    roots: [],
    repositories: [
      {
        id: 'repository-c',
        path: '/work/revision-c',
        name: 'revision-c',
        removedAt: null,
        removedReason: null,
        snapshot: {
          repositoryId: 'repository-c',
          head: 'c'.repeat(40),
          branch: 'main',
          statusEntries: [],
          worktreeHash: 'd'.repeat(64),
          diffStats: {
            changedFiles: 0,
            additions: 0,
            deletions: 0,
            binaryFiles: 0,
            untrackedFiles: 0,
          },
          fingerprint,
          contractVersion: 'default-v1',
          checkDefinitionVersion: 'e'.repeat(64),
          capturedAt: recordedAt,
        },
        updatedAt: recordedAt,
      },
    ],
    receipts: [],
    workItems: [
      {
        id: 'work-c',
        repositoryId: 'repository-c',
        sourceType: 'receipt',
        sourceRef: 'receipt:revision-c',
        title: 'Revision item C',
        claim: 'Revision item C is complete.',
        sourceLabel: 'Codex run',
        updatedAt: recordedAt,
        snapshotFingerprint: fingerprint,
        humanVerdict: verdicts.at(-1)?.decision ?? null,
        claimHash,
        removedAt: null,
        removedReason: null,
      },
    ],
    removed: { roots: [], repositories: [], workItems: [] },
    contracts: [],
    checks: [],
    evidence: [],
    verdicts,
    signingKey: { keyId: 'e'.repeat(64) },
    readiness: { 'work-c': readiness },
  };
}

/** Answers the page's requests as its service would, and holds an answer back when a test asks. */
function fakeService() {
  let verdicts: VerdictDto[] = [];
  const held = new Map<'bootstrap' | 'verdict', { arrived: () => void; answer: Promise<void> }>();

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  const hold = (kind: 'bootstrap' | 'verdict') => {
    let arrived = () => {};
    let answer = () => {};
    const request = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    held.set(kind, {
      arrived,
      answer: new Promise<void>((resolve) => {
        answer = resolve;
      }),
    });
    return { request, answer };
  };

  const waitIfHeld = async (kind: 'bootstrap' | 'verdict') => {
    const wait = held.get(kind);
    held.delete(kind);
    if (wait) {
      wait.arrived();
      await wait.answer;
    }
  };

  const record = (decision: VerdictDto['decision'], note: string): VerdictDto => {
    const verdict: VerdictDto = {
      id: `verdict-${verdicts.length + 1}`,
      workItemId: 'work-c',
      decision,
      note,
      decidedAt: recordedAt,
      snapshotFingerprint: fingerprint,
      overrideReason: null,
      sequence: verdicts.length + 1,
      previousVerdictId: verdicts.at(-1)?.id ?? null,
      claimHash,
    };
    verdicts = [...verdicts, verdict];
    return verdict;
  };

  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/bootstrap') {
      await waitIfHeld('bootstrap');
      return json(workspace(verdicts));
    }
    if (url === '/api/v1/work-items/work-c/verdicts' && init?.method === 'POST') {
      const { decision, note } = JSON.parse(String(init.body)) as Pick<
        VerdictDto,
        'decision' | 'note'
      >;
      const verdict = record(decision, note);
      await waitIfHeld('verdict');
      return json({ verdict, readiness }, 201);
    }
    return json({ error: 'not_found' }, 404);
  });

  return {
    fetch,
    /** A verdict recorded from another tab or window. */
    recordElsewhere: (decision: VerdictDto['decision']) =>
      record(decision, 'Recorded from another window.'),
    /** Holds the next bootstrap request: `request` settles when it arrives, and `answer` lets it return. */
    holdNextBootstrap: () => hold('bootstrap'),
    /** Records the next verdict, then holds the answer to it in the same way. */
    holdNextVerdictAnswer: () => hold('verdict'),
  };
}

describe('a verdict dialog on a page with its service', () => {
  it('does not take the verdict it recorded for another one while its own refresh is slow', async () => {
    const service = fakeService();
    vi.stubGlobal('fetch', service.fetch);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Accept work' }));
    const dialog = screen.getByRole('dialog', { name: 'Accept this work' });
    await user.type(
      within(dialog).getByLabelText('Decision note'),
      'Regression test added and the check passes.',
    );
    // Once the verdict is recorded, the dialog asks for the workspace again, and that answer is slow.
    const reload = service.holdNextBootstrap();
    await user.click(within(dialog).getByRole('button', { name: 'Record acceptance' }));
    await act(() => reload.request);

    // The page's 15-second refresh answers first, with the verdict this dialog recorded.
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(await screen.findByText('accepted')).toBeTruthy();
    expect(within(dialog).queryByText(/Another verdict/u)).toBeNull();

    await act(async () => reload.answer());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not take the verdict it recorded for another one while the answer is on its way', async () => {
    const service = fakeService();
    vi.stubGlobal('fetch', service.fetch);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Accept work' }));
    const dialog = screen.getByRole('dialog', { name: 'Accept this work' });
    await user.type(within(dialog).getByLabelText('Decision note'), 'Reviewed the change.');
    // The service records the verdict, and its answer is slow to reach the page.
    const answer = service.holdNextVerdictAnswer();
    await user.click(within(dialog).getByRole('button', { name: 'Record acceptance' }));
    await act(() => answer.request);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(await screen.findByText('accepted')).toBeTruthy();
    expect(within(dialog).queryByText(/Another verdict/u)).toBeNull();

    await act(async () => answer.answer());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('still stops the decision when another verdict is recorded while it is open', async () => {
    const service = fakeService();
    vi.stubGlobal('fetch', service.fetch);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Accept work' }));
    const dialog = screen.getByRole('dialog', { name: 'Accept this work' });
    service.recordElsewhere('rejected');
    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(
      await within(dialog).findByText(/Another verdict was recorded after this dialog opened/u),
    ).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Record acceptance' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
