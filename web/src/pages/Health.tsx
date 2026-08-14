import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox } from '../components/common';
import type { AppHealth } from '../types';

interface HealthDetail {
  ok: boolean;
  adminDb: { ok: boolean; error?: string };
  /** Per-app ping result keyed by app id (unavailable apps report ok:false + error). */
  apps: Record<string, AppHealth>;
}

export function Health() {
  const [data, setData] = useState<HealthDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<HealthDetail>('/health/detail').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Checking health…</p>;

  return (
    <div>
      <h1>System health</h1>
      <div className="card-grid">
        <div className="card stat">
          <span className="muted">Admin database</span>
          <strong className={data.adminDb.ok ? 'ok-text' : 'warn-text'}>
            {data.adminDb.ok ? 'OK' : 'FAIL'}
          </strong>
          {data.adminDb.error && <div className="warn-text">{data.adminDb.error}</div>}
        </div>
        {Object.entries(data.apps).map(([id, h]) => (
          <div className="card stat" key={id}>
            <span className="muted">{id}</span>
            <strong className={h.ok ? 'ok-text' : 'warn-text'}>
              {h.ok ? `OK${typeof h.latencyMs === 'number' ? ` (${h.latencyMs} ms)` : ''}` : 'FAIL'}
            </strong>
            {h.error && <div className="warn-text">{h.error}</div>}
            {h.serverVersion && <div className="muted small">{h.serverVersion.split(' ').slice(0, 2).join(' ')}</div>}
            {h.tables && (
              <div className="muted small">
                {Object.entries(h.tables).map(([t, n]) => `${t}: ${n}`).join(' · ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
