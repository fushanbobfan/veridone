// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDialogFocus } from './useDialogFocus.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Dialog() {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useDialogFocus(true, () => undefined, dialog, closeButton);
  return (
    <div ref={dialog}>
      <button ref={closeButton}>Close</button>
      <input aria-label="Reason" />
    </div>
  );
}

/** Holds the frames a dialog asks for, and returns what lands them. */
function holdFrames(): () => void {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((frame) => {
    frames.push(frame);
    return frames.length;
  });
  return () => frames.splice(0).forEach((frame) => frame(0));
}

describe('the first focus of a dialog', () => {
  it('reaches its first target when focus is still outside the dialog', () => {
    const landFrames = holdFrames();
    render(<Dialog />);
    expect(document.activeElement).toBe(document.body);

    landFrames();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('leaves a field someone reached before its frame landed', () => {
    const landFrames = holdFrames();
    render(<Dialog />);
    const reason = screen.getByLabelText('Reason');
    reason.focus();

    landFrames();

    expect(document.activeElement).toBe(reason);
  });
});
