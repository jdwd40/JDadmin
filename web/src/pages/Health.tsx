import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, fmtDate } from '../components/common';
import { describeMetric } from '../lib/format';
import type { AppHealth, AppResourceUsage, HostResourceUsage, MetricSample } from '../types';

interface HealthDetail {
  ok: boolean;
  adminDb: { ok: boolean; error?: string };
  /** Per-app ping result keyed by app id (unavailable apps report ok:false + error). */
  apps: Record<string, AppHealth & { resources?: AppResourceUsage }>;
  /** Admin-host resource usage (host-wide scope, not app-specific). */
  host?: HostResourceUsage;
}

function MetricRow({ label, metric }: { label: string; metric: MetricSample }) {
  const d = describeMetric(metric);
  return (
    <div className="small">
      <span className="muted">{label}: </span>
      <span className={d.tone}>{d.text}</span>
      <div className="muted">{d.detail}</div>
    </div>
  );
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
            {h.resources && (
              <div>
                <MetricRow label="Storage" metric={h.resources.storage} />
                <MetricRow label="Memory" metric={h.resources.memory} />
                <div className="muted small">collected {fmtDate(h.resources.collectedAt)}</div>
              </div>
            )}
          </div>
        ))}
        {data.host && (
          <div className="card stat">
            <span className="muted">Admin host</span>
            <MetricRow label="Memory" metric={data.host.memory} />
            <MetricRow label="Storage" metric={data.host.storage} />
            <MetricRow label="Process" metric={data.host.processMemory} />
            <div className="muted small">collected {fmtDate(data.host.collectedAt)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
