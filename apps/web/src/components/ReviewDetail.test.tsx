// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { demoReviews, type ReviewItem } from '../data.js';
import { ReviewDetail } from './ReviewDetail.js';

afterEach(cleanup);

const base = demoReviews[0];
if (!base) throw new Error('The demo has no review.');
const item: ReviewItem = {
  ...base,
  criteria: [
    {
      id: 'check',
      title: 'Unit tests',
      detail: 'failed · 12 ms',
      state: 'failed',
      evidenceLabel: 'test',
      evidenceId: 'evidence',
    },
  ],
};
const actions = {
  decision: null,
  onBack: () => undefined,
  onAccept: () => undefined,
  onRequestChanges: () => undefined,
  onReject: () => undefined,
};

describe('reading what a check printed', () => {
  it('reads the output on request, says when it is cut, and hides it again', async () => {
    const user = userEvent.setup();
    const onReadOutput = vi.fn(async () => ({
      stdout: 'ran 1 test',
      stderr: "Error: Cannot find module 'dep'",
      truncated: true,
    }));
    render(<ReviewDetail item={item} {...actions} onReadOutput={onReadOutput} />);

    expect(onReadOutput).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Show output of Unit tests' }));
    expect(onReadOutput).toHaveBeenCalledWith('evidence');
    expect(await screen.findByText("Error: Cannot find module 'dep'")).toBeTruthy();
    expect(screen.getByText('ran 1 test')).toBeTruthy();
    expect(screen.getByText('Only the end of the output is shown.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Hide output of Unit tests' }));
    expect(screen.queryByText('ran 1 test')).toBeNull();
  });

  it('says so when the output cannot be read', async () => {
    const user = userEvent.setup();
    render(
      <ReviewDetail
        item={item}
        {...actions}
        onReadOutput={vi.fn(async () => {
          throw new Error('The service is not answering.');
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Show output of Unit tests' }));
    expect(await screen.findByText('The service is not answering.')).toBeTruthy();
  });

  it('offers no output for a row without a run, and the way to the checks', async () => {
    const user = userEvent.setup();
    const onManageChecks = vi.fn();
    const withoutRun: ReviewItem = {
      ...item,
      criteria: item.criteria.map(({ evidenceId: _evidenceId, ...criterion }) => criterion),
    };
    render(
      <ReviewDetail
        item={withoutRun}
        {...actions}
        onReadOutput={vi.fn()}
        onManageChecks={onManageChecks}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Show output of Unit tests' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Manage checks' }));
    expect(onManageChecks).toHaveBeenCalled();
  });

  it('offers another repository when the caller can bind one', async () => {
    const user = userEvent.setup();
    const onChangeRepository = vi.fn();
    render(<ReviewDetail item={item} {...actions} onChangeRepository={onChangeRepository} />);
    await user.click(screen.getByRole('button', { name: 'Change repository' }));
    expect(onChangeRepository).toHaveBeenCalled();
  });

  it('keeps every decision but plain acceptance open when gates are open', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(
      <ReviewDetail
        item={{ ...item, gatesReady: false }}
        {...actions}
        onReject={onReject}
        onOverride={() => undefined}
      />,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Accept work' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Override lock' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalled();
  });
});

describe('removing a work item from the review', () => {
  it('offers it where the workspace can act on it', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const { rerender } = render(<ReviewDetail item={item} {...actions} onRemove={onRemove} />);
    await user.click(screen.getByRole('button', { name: 'Remove work item' }));
    expect(onRemove).toHaveBeenCalled();

    rerender(<ReviewDetail item={item} {...actions} />);
    expect(screen.queryByRole('button', { name: 'Remove work item' })).toBeNull();
  });
});

describe('while the service is not answering', () => {
  const lastData = { lastDataReceived: 'Nov 7, 10:46 AM' };
  const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
  const offers = {
    evidenceActionLabel: 'Run approved checks',
    onEvidenceAction: () => undefined,
    onOverride: () => undefined,
    onExport: () => undefined,
    onChangeRepository: () => undefined,
    onViewContract: () => undefined,
    onManageChecks: () => undefined,
    onReadOutput: vi.fn(),
    onRemove: () => undefined,
  };

  it('turns off what needs the service and keeps what reads the last data', () => {
    render(
      <ReviewDetail item={{ ...item, gatesReady: false }} {...actions} {...offers} {...lastData} />,
    );
    for (const name of [
      'Accept work',
      'Request changes',
      'Reject',
      'Override lock',
      'Run approved checks',
      'Export packet',
      'Change repository',
      'Remove work item',
    ]) {
      expect(button(name).disabled, name).toBe(true);
    }
    for (const name of ['View contract', 'Manage checks', 'Show output of Unit tests']) {
      expect(button(name).disabled, name).toBe(false);
    }
  });

  it('offers all of it again once the service answers', () => {
    render(<ReviewDetail item={{ ...item, gatesReady: false }} {...actions} {...offers} />);
    for (const name of [
      'Request changes',
      'Reject',
      'Override lock',
      'Run approved checks',
      'Export packet',
      'Change repository',
      'Remove work item',
    ]) {
      expect(button(name).disabled, name).toBe(false);
    }
  });

  it('still cancels a check that was running when the service stopped', async () => {
    const user = userEvent.setup();
    const onCancelEvidence = vi.fn();
    render(
      <ReviewDetail
        item={item}
        {...actions}
        {...offers}
        {...lastData}
        evidenceActionBusy
        onCancelEvidence={onCancelEvidence}
      />,
    );
    await user.click(button('Cancel check'));
    expect(onCancelEvidence).toHaveBeenCalled();
  });

  it('dates what the last data says and says decisions wait', () => {
    render(<ReviewDetail item={{ ...item, gatesReady: true }} {...actions} {...lastData} />);
    expect(
      screen.getByText(
        `${item.requiredSatisfied} of ${item.requiredTotal} required gates are current as of Nov 7, 10:46 AM`,
      ),
    ).toBeTruthy();
    expect(screen.getByText('All required evidence is current as of Nov 7, 10:46 AM')).toBeTruthy();
    expect(screen.getByText('Waiting for the local service')).toBeTruthy();
    expect(screen.getByText('Decisions wait for the local service')).toBeTruthy();
    expect(
      screen.getByText('The service records every verdict, and it is not answering.'),
    ).toBeTruthy();
    expect(screen.queryByText('Ready for your decision')).toBeNull();
    expect(screen.queryByText('Evidence is current')).toBeNull();
  });

  it('keeps showing a verdict already on record', () => {
    render(
      <ReviewDetail item={item} {...actions} {...lastData} decision="accepted · superseded" />,
    );
    expect(screen.getByText('accepted · superseded')).toBeTruthy();
    expect(screen.queryByText('Waiting for the local service')).toBeNull();
  });
});
