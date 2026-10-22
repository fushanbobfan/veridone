import {
  Archive,
  FileCheck2,
  FolderGit2,
  Inbox,
  ListChecks,
  Moon,
  Settings2,
  Sun,
} from 'lucide-react';

export type WorkspaceSection = 'repositories' | 'checks' | 'contracts' | 'exports';

export function Navigation({
  theme,
  reviewCount,
  serviceMode,
  themePreference,
  onToggleTheme,
  onOpenWorkspace,
  onOpenSection,
}: {
  theme: 'light' | 'dark';
  reviewCount: number;
  serviceMode: 'local' | 'demo';
  themePreference: 'light' | 'dark' | 'system';
  onToggleTheme: () => void;
  onOpenWorkspace?: () => void;
  onOpenSection?: (section: WorkspaceSection) => void;
}) {
  return (
    <aside className="navigation" aria-label="Primary navigation">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">
          V
        </span>
        <span>VeriDone</span>
      </div>

      <nav>
        <a className="nav-item active" href="#inbox" aria-current="page">
          <Inbox aria-hidden="true" size={17} />
          Review inbox
          <span className="nav-count">{reviewCount}</span>
        </a>
        <button
          className="nav-item"
          type="button"
          onClick={() => onOpenSection?.('repositories')}
          disabled={!onOpenSection}
        >
          <FolderGit2 aria-hidden="true" size={17} />
          Repositories
        </button>
        <button
          className="nav-item"
          type="button"
          onClick={() => onOpenSection?.('checks')}
          disabled={!onOpenSection}
        >
          <ListChecks aria-hidden="true" size={17} />
          Checks
        </button>
        <button
          className="nav-item"
          type="button"
          onClick={() => onOpenSection?.('contracts')}
          disabled={!onOpenSection}
        >
          <FileCheck2 aria-hidden="true" size={17} />
          Contracts
        </button>
        <button
          className="nav-item"
          type="button"
          onClick={() => onOpenSection?.('exports')}
          disabled={!onOpenSection}
        >
          <Archive aria-hidden="true" size={17} />
          Exports
        </button>
      </nav>

      <div className="navigation-footer">
        <div className="local-status">
          <span className="local-dot" aria-hidden="true" />
          <span>
            {serviceMode === 'local' ? 'Local service' : 'Demo workspace'}
            <small>{serviceMode === 'local' ? 'Loopback only' : 'Synthetic data'}</small>
          </span>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onToggleTheme}
          title={`Theme preference: ${themePreference}`}
        >
          {theme === 'dark' ? (
            <Sun aria-hidden="true" size={17} />
          ) : (
            <Moon aria-hidden="true" size={17} />
          )}
          <span className="sr-only">Switch to {theme === 'dark' ? 'light' : 'dark'} theme</span>
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={onOpenWorkspace}
          disabled={!onOpenWorkspace}
        >
          <Settings2 aria-hidden="true" size={17} />
          <span className="sr-only">
            {onOpenWorkspace ? 'Open workspace backup and restore' : 'Workspace backup unavailable'}
          </span>
        </button>
      </div>
    </aside>
  );
}
