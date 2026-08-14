import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, fmtDate, fmtNum } from '../components/common';
import { Sparkline } from '../components/Sparkline';
import type { AppInfo, OverviewData } from '../types';

export function Overview({ app }: { app: AppInfo }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!app.capabilities.overview) return;
    api<OverviewData>(`/apps/${app.id}/overview`).then(setData).catch(setError);
  }, [app.id, app.capabilities.overview]);

  if (!app.capabilities.overview) {
    return <div className="warn-box">Overview is not supported by the {app.label} adapter.</div>;
  }

  return (
    <div>
      <h1>{app.label} — Overview</h1>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="card-grid">
            <div className="card stat"><span className="muted">Users</span><strong>{fmtNum(data.users)}</strong></div>
            <div className="card stat"><span className="muted">Assets</span><strong>{fmtNum(data.assets)}</strong></div>
            <div className="card stat"><span className="muted">Transactions</span><strong>{fmtNum(data.transactions)}</strong></div>
            {data.totalBalance != null && (
              <div className="card stat"><span className="muted">Total balance</span><strong>{fmtNum(data.totalBalance)}</strong></div>
            )}
          </div>

          {data.assetsSparkline.length > 0 && (
            <div className="card">
              <h2>Asset price trends</h2>
              <div className="card-grid">
                {data.assetsSparkline.map((s) => (
                  <div className="card stat" key={s.assetId}>
                    <span className="muted">{s.symbol}</span>
                    <strong>{s.latestPrice != null ? fmtNum(s.latestPrice) : '—'}</strong>
                    <Sparkline points={s.points} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.recentTransactions.length > 0 && (
            <div className="card">
              <h2>Recent transactions</h2>
              <table>
                <thead><tr><th>ID</th><th>User</th><th>Asset</th><th>Type</th><th>Quantity</th><th>Total</th><th>When</th></tr></thead>
                <tbody>
                  {data.recentTransactions.map((t) => (
                    <tr key={t.id}>
                      <td>{t.id}</td>
                      <td>{t.userId}</td>
                      <td>{t.assetSymbol ?? t.assetId}</td>
                      <td>{t.type}</td>
                      <td>{fmtNum(t.quantity)}</td>
                      <td>{fmtNum(t.totalAmount)}</td>
                      <td>{fmtDate(t.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {!data && !error && <p className="muted">Loading…</p>}
    </div>
  );
}
