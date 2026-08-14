import { useCallback, useEffect, useState } from 'react';
import { api, setCsrfToken } from './api';
import { Layout } from './components/Layout';
import { Login } from './components/Login';
import { AuditLog } from './pages/AuditLog';
import { Health } from './pages/Health';
import { Inventory } from './pages/Inventory';
import { Overview } from './pages/Overview';
import { PriceHistory } from './pages/PriceHistory';
import { Transactions } from './pages/Transactions';
import { UserDetail } from './pages/UserDetail';
import { Users } from './pages/Users';
import type { AdminUser, AppInfo } from './types';

export function App() {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [page, setPage] = useState('overview');
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const loadApps = useCallback(async () => {
    const res = await api<{ apps: AppInfo[] }>('/apps');
    setApps(res.apps);
    setSelectedAppId((cur) => cur || res.apps.find((a) => a.available)?.id || res.apps[0]?.id || '');
  }, []);

  // A fresh page load has no in-memory CSRF token; /me alone is not enough to
  // resume, so we start logged out unless a session was created this load.
  useEffect(() => {
    setBootError(null);
  }, []);

  const onLoggedIn = useCallback(
    async (user: AdminUser) => {
      setAdmin(user);
      await loadApps();
    },
    [loadApps],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setCsrfToken(null);
      setAdmin(null);
      setApps([]);
      setPage('overview');
      setDetailUserId(null);
    }
  }, []);

  const openUser = useCallback((userId: string) => {
    setDetailUserId(userId);
    setPage('user-detail');
  }, []);

  if (bootError) return <div className="center-card error-box">{bootError}</div>;
  if (!admin) return <Login onLoggedIn={onLoggedIn} />;

  const app = apps.find((a) => a.id === selectedAppId);

  const navigate = (next: string) => {
    setPage(next);
    if (next !== 'user-detail') setDetailUserId(null);
  };

  return (
    <Layout
      admin={admin}
      apps={apps}
      selectedAppId={selectedAppId}
      onSelectApp={(id) => {
        setSelectedAppId(id);
        setDetailUserId(null);
        setPage('overview');
      }}
      page={page}
      onNavigate={navigate}
      onLogout={logout}
    >
      {page === 'overview' && app && <Overview app={app} />}
      {page === 'users' && app && <Users app={app} onOpenUser={openUser} />}
      {page === 'user-detail' && app && detailUserId && (
        <UserDetail app={app} userId={detailUserId} onBack={() => navigate('users')} />
      )}
      {page === 'inventory' && app && <Inventory app={app} />}
      {page === 'transactions' && app && <Transactions app={app} />}
      {page === 'price-history' && app && <PriceHistory app={app} />}
      {page === 'audit' && <AuditLog apps={apps} />}
      {page === 'health' && <Health />}
    </Layout>
  );
}
