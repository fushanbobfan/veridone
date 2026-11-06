// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CheckDto } from '../api.js';
import { CheckDialog } from './CheckDialog.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const old: CheckDto = {
  id: 'old-check',
  repositoryId: 'repo',
  label: 'Unit tests',
  kind: 'lint',
  executable: 'python',
  args: ['-m', 'pytest'],
  versionArgs: ['--version'],
  scopePaths: ['src'],
  cwdRelative: 'app',
  timeoutMs: 300_000,
  maxOutputBytes: 2_500_000,
  resolvedExecutable: null,
  executableSha256: null,
  definitionHash: 'b'.repeat(64),
  approvedAt: '2026-10-22T10:00:00.000Z',
  setupArgs: ['-m', 'pip', 'install', '.'],
  setupTimeoutMs: 900_000,
  retiredAt: null,
  retiredReason: null,
};

function stubFetch(answers: Array<{ status: number; body: unknown }>) {
  const fetchMock = vi.fn(async () => {
    const answer = answers.shift();
    if (!answer) throw new Error('An unexpected request was made.');
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sent = (fetchMock: ReturnType<typeof stubFetch>, index: number) => {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};

describe('replacing a check', () => {
  it('starts from the old definition and replaces it in one request', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch([
      { status: 201, body: { check: { id: 'new-check' }, retired: { id: 'old-check' } } },
    ]);
    const onAdded = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(
      <CheckDialog
        open
        repositoryId="repo"
        csrfToken="token"
        replacing={old}
        onClose={onClose}
        onAdded={onAdded}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Replace Unit tests' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Executable').value).toBe('python');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Literal argument array').value).toBe(
      '["-m","pytest"]',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Timeout in seconds').value).toBe('300');
    expect(screen.getByLabelText<HTMLInputElement>('Output limit in MB').value).toBe('2.5');
    expect(screen.getByLabelText<HTMLInputElement>('Setup timeout in seconds').value).toBe('900');

    const reason = screen.getByLabelText('Why it changes');
    await user.type(reason, 'It needs a setup step.');
    await user.click(screen.getByRole('button', { name: 'Approve and retire the old' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const replaced = sent(fetchMock, 0);
    expect(replaced.url).toBe('/api/v1/checks/old-check/replace');
    expect(replaced.body).toMatchObject({
      reason: 'It needs a setup step.',
      expected: { definitionHash: old.definitionHash },
    });
    expect(replaced.body.check).toMatchObject({
      repositoryId: 'repo',
      kind: 'lint',
      executable: 'python',
      args: ['-m', 'pytest'],
      setupArgs: ['-m', 'pip', 'install', '.'],
      setupTimeoutMs: 900_000,
      scopePaths: ['src'],
      cwdRelative: 'app',
      timeoutMs: 300_000,
      maxOutputBytes: 2_500_000,
    });
    expect(onAdded).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('takes any definition the service accepts, however small its limits', () => {
    stubFetch([]);
    render(
      <CheckDialog
        open
        repositoryId="repo"
        csrfToken="token"
        replacing={{ ...old, timeoutMs: 1_500, maxOutputBytes: 1_024, setupTimeoutMs: 1_500 }}
        onClose={() => undefined}
        onAdded={vi.fn(async () => undefined)}
      />,
    );
    for (const label of ['Timeout in seconds', 'Output limit in MB', 'Setup timeout in seconds']) {
      expect(screen.getByLabelText<HTMLInputElement>(label).validity.valid, label).toBe(true);
    }
  });

  it('keeps the old check when the new tool is refused', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch([
      { status: 400, body: { error: 'request_failed', message: 'No executable file was found.' } },
    ]);
    const onClose = vi.fn();
    render(
      <CheckDialog
        open
        repositoryId="repo"
        csrfToken="token"
        replacing={old}
        onClose={onClose}
        onAdded={vi.fn(async () => undefined)}
      />,
    );
    await user.type(screen.getByLabelText('Why it changes'), 'A reason.');
    await user.click(screen.getByRole('button', { name: 'Approve and retire the old' }));

    expect(await screen.findByText('No executable file was found.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('approving a check', () => {
  it('asks for no reason and sends the timeout and output limit given', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch([{ status: 201, body: { check: { id: 'new-check' } } }]);
    render(
      <CheckDialog
        open
        repositoryId="repo"
        csrfToken="token"
        onClose={() => undefined}
        onAdded={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.queryByLabelText('Why it changes')).toBeNull();
    const timeout = screen.getByLabelText<HTMLInputElement>('Timeout in seconds');
    expect(timeout.value).toBe('120');
    await user.clear(timeout);
    await user.type(timeout, '900');
    await user.click(screen.getByRole('button', { name: 'Approve definition' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(fetchMock, 0).body).toMatchObject({
      timeoutMs: 900_000,
      maxOutputBytes: 1_000_000,
      setupTimeoutMs: 600_000,
    });
  });
});
