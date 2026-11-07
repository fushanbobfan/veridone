import { useEffect, useRef, type RefObject } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Moves focus to what the page shows now, when the element that held it has left with its record: the selected review,
 * the inbox where a phone shows it instead, or the empty page.
 */
export function focusCurrentView(): void {
  ['#review-detail', '#inbox-title', '.empty-workspace h1']
    .map((selector) => document.querySelector<HTMLElement>(selector))
    .find((element) => element && element.offsetParent !== null)
    ?.focus();
}

export function useDialogFocus(
  open: boolean,
  onClose: () => void,
  dialog: RefObject<HTMLElement | null>,
  initialFocus: RefObject<HTMLElement | null>,
): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const returnTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Someone already in a field keeps it: their next keys would land on the first target.
    const focusFrame = window.requestAnimationFrame(() => {
      if (!dialog.current?.contains(document.activeElement)) initialFocus.current?.focus();
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', keydown);
      window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus();
        else focusCurrentView();
      });
    };
  }, [dialog, initialFocus, open]);
}
