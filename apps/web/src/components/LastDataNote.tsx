/** Says inside a dialog what the banner says behind it. In the dialog from the start, so a screen reader announces it. */
export function LastDataNote({
  received,
  waiting,
}: {
  /** When the data arrived; undefined while the service is answering. */
  received: string | undefined;
  /** What the dialog holds back until the service answers. */
  waiting: string;
}) {
  return (
    <div role="status">
      {received && (
        <div className="source-issue last-data-note">
          <strong>Local service unavailable</strong>
          <span>
            This is the last data received, {received}. {waiting}
          </span>
        </div>
      )}
    </div>
  );
}
