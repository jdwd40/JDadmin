import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, fmtDate } from '../components/common';
import { MetricCard } from '../components/MetricCard';
import type { AppHealth, AppResourceUsage, HostResourceUsage } from '../types';

interface HealthDetail {
  ok: boolean;
  adminDb: { ok: boolean; error?: string };
  /** Per-app ping result keyed by app id (unavailable apps report ok:false + error). */
  apps: Record<string, AppHealth & { resources?: AppResourceUsage }>;
  /** Admin-host resource usage (host-wide scope, not app-specific). */
  host?: HostResourceUsage;
}

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function Health() {
  const [data, setData] = useState<HealthDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<HealthDetail>('/health/detail').then(setData).catch(setError);
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Checking health…</p>;

  const appsWithResources = Object.entries(data.apps).filter(
    (entry): entry is [string, AppHealth & { resources: AppResourceUsage }] =>
      entry[1].resources !== undefined,
  );

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

      {appsWithResources.length > 0 && (
        <section aria-labelledby="app-resources-heading">
          <h2 id="app-resources-heading">Application resources</h2>
          {appsWithResources.map(([id, h]) => (
            <div className="card metric-group" key={id}>
              <div className="metric-group-head">
                <strong>{titleCase(id)}</strong>
                <span className={`status-pill ${h.ok ? 'status-normal' : 'status-unavailable'}`}>
                  {h.ok ? 'Reachable' : 'Unreachable'}
                </span>
                <span className="muted small">collected {fmtDate(h.resources.collectedAt)}</span>
              </div>
              <div className="metric-grid">
                <MetricCard label="Storage" metric={h.resources.storage} />
                <MetricCard label="Memory" metric={h.resources.memory} />
              </div>
            </div>
          ))}
        </section>
      )}

      {data.host && (
        <section aria-labelledby="host-resources-heading">
          <h2 id="host-resources-heading">Admin host resources</h2>
          <p className="muted small">
            Host-wide measurements for the machine running JDadmin — distinct from the per-app
            database metrics above.
          </p>
          <div className="card metric-group metric-group-host">
            <div className="metric-group-head">
              <strong>Admin host</strong>
              <span className="status-pill status-host">Host-wide</span>
              <span className="muted small">collected {fmtDate(data.host.collectedAt)}</span>
            </div>
            <div className="metric-grid">
              <MetricCard label="Host memory" metric={data.host.memory} />
              <MetricCard label="Host storage" metric={data.host.storage} />
              <MetricCard label="Process memory (RSS)" metric={data.host.processMemory} />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
