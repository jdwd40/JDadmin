import { ReactNode } from 'react';
import { resolveNav, selectableApps } from '../lib/capabilities';
import type { AdminUser, AppInfo } from '../types';

interface LayoutProps {
  admin: AdminUser;
  apps: AppInfo[];
  selectedAppId: string;
  onSelectApp: (id: string) => void;
  page: string;
  onNavigate: (page: string) => void;
  onLogout: () => void;
  children: ReactNode;
}

export function Layout(props: LayoutProps) {
  const { admin, apps, selectedAppId, onSelectApp, page, onNavigate, onLogout, children } = props;
  const app = apps.find((a) => a.id === selectedAppId);
  const nav = resolveNav(app);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Universal Admin</div>
        <label className="app-selector">
          <span className="muted">Application</span>
          <select value={selectedAppId} onChange={(e) => onSelectApp(e.target.value)}>
            {selectableApps(apps).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.available ? '' : ' (unavailable)'}
              </option>
            ))}
          </select>
        </label>
        {app && !app.available && (
          <div className="warn-box" title={app.availabilityError}>
            {app.label} is unavailable: {app.availabilityError}
          </div>
        )}
        <nav>
          {nav.map((item) => (
            <button
              key={item.key}
              className={`nav-item ${page === item.key ? 'active' : ''}`}
              disabled={!item.enabled}
              title={item.enabled ? undefined : 'Not supported by this app'}
              onClick={() => onNavigate(item.key)}
            >
              {item.label}
              {!item.enabled && <span className="badge">n/a</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="muted">{admin.username}</span>
          <button className="link" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
