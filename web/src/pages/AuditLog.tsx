import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, fmtDate, Pager } from '../components/common';
import type { AppInfo, AuditEntry } from '../types';

const PAGE_SIZE = 25;

/** Server returns items+total only (no echoed page fields). */
interface AuditList {
  items: AuditEntry[];
  total: number;
}

export function AuditLog({ apps }: { apps: AppInfo[] }) {
  const [data, setData] = useState<AuditList | null>(null);
  const [page, setPage] = useState(1);
  const [appId, setAppId] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<AuditList>('/audit', {
        query: { page, pageSize: PAGE_SIZE, appId: appId || undefined, search: search || undefined },
      });
      setData(res);
    } catch (err) {
      setError(err);
    }
  }, [page, appId, search]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <h1>Audit log</h1>
      <div className="filters">
        <select value={appId} onChange={(e) => { setAppId(e.target.value); setPage(1); }}>
          <option value="">All apps</option>
          {apps.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <input placeholder="Search actor/action/entity…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>App</th><th>Action</th><th>Entity</th><th /></tr></thead>
        <tbody>
          {(data?.items ?? []).map((e) => (
            <>
              <tr key={e.id} className="clickable" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                <td>{fmtDate(e.createdAt)}</td>
                <td>{e.actorUsername}</td>
                <td>{e.appId}</td>
                <td>{e.action}</td>
                <td>{e.entityType}{e.entityId ? ` #${e.entityId}` : ''}</td>
                <td className="muted">{expanded === e.id ? '▲' : '▼'}</td>
              </tr>
              {expanded === e.id && (
                <tr key={`${e.id}-detail`}>
                  <td colSpan={6}>
                    <div className="audit-detail">
                      <div><h3>Previous</h3><pre>{JSON.stringify(e.previous, null, 2) ?? '—'}</pre></div>
                      <div><h3>New</h3><pre>{JSON.stringify(e.next, null, 2) ?? '—'}</pre></div>
                      {e.meta && Object.keys(e.meta).length > 0 && (
                        <div><h3>Meta</h3><pre>{JSON.stringify(e.meta, null, 2)}</pre></div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
          {data && data.items.length === 0 && <tr><td colSpan={6} className="muted">No audit entries.</td></tr>}
        </tbody>
      </table>
      <Pager page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} />
    </div>
  );
}
