import { Archive, FileCheck2, FolderGit2, Inbox, Moon, Settings2, Sun } from 'lucide-react';

export function Navigation({
  theme,
  reviewCount,
  serviceMode,
  onToggleTheme,
}: {
  theme: 'light' | 'dark';
  reviewCount: number;
  serviceMode: 'local' | 'demo';
  onToggleTheme: () => void;
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
        <a className="nav-item" href="#repositories">
          <FolderGit2 aria-hidden="true" size={17} />
          Repositories
        </a>
        <a className="nav-item" href="#contracts">
          <FileCheck2 aria-hidden="true" size={17} />
          Contracts
        </a>
        <a className="nav-item" href="#exports">
          <Archive aria-hidden="true" size={17} />
          Exports
        </a>
      </nav>

      <div className="navigation-footer">
        <div className="local-status">
          <span className="local-dot" aria-hidden="true" />
          <span>
            {serviceMode === 'local' ? 'Local service' : 'Demo workspace'}
            <small>{serviceMode === 'local' ? 'Loopback only' : 'Synthetic data'}</small>
          </span>
        </div>
        <button className="icon-button" type="button" onClick={onToggleTheme}>
          {theme === 'dark' ? (
            <Sun aria-hidden="true" size={17} />
          ) : (
            <Moon aria-hidden="true" size={17} />
          )}
          <span className="sr-only">Switch to {theme === 'dark' ? 'light' : 'dark'} theme</span>
        </button>
        <button className="icon-button" type="button">
          <Settings2 aria-hidden="true" size={17} />
          <span className="sr-only">Open settings</span>
        </button>
      </div>
    </aside>
  );
}
