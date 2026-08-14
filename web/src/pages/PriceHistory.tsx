import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, validationDetails } from '../api';
import { ErrorBox, fmtDate, fmtNum, Modal, Pager } from '../components/common';
import { deleteRangeValid, resetPhraseOk } from '../lib/confirm';
import type { AppInfo, AssetInfo, Paged, PricePoint, PriceStats } from '../types';

const PAGE_SIZE = 25;

interface Filters {
  assetId: string;
  from: string;
  to: string;
}

export function PriceHistory({ app }: { app: AppInfo }) {
  const caps = app.capabilities.priceHistory;
  const [data, setData] = useState<Paged<PricePoint> | null>(null);
  const [stats, setStats] = useState<PriceStats[]>([]);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({ assetId: '', from: '', to: '' });
  const [error, setError] = useState<unknown>(null);
  const [deletingRange, setDeletingRange] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const query = {
        page,
        pageSize: PAGE_SIZE,
        assetId: filters.assetId || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
      };
      const res = await api<Paged<PricePoint>>(`/apps/${app.id}/price-history`, { query });
      setData(res);
    } catch (err) {
      setError(err);
    }
  }, [app.id, page, filters]);

  const loadStats = useCallback(async () => {
    if (!caps.stats) return;
    try {
      const res = await api<{ stats: PriceStats[] }>(`/apps/${app.id}/price-history/stats`);
      setStats(res.stats);
    } catch {
      setStats([]);
    }
  }, [app.id, caps.stats]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadStats();
  }, [loadStats]);
  useEffect(() => {
    api<{ assets: AssetInfo[] }>(`/apps/${app.id}/assets`)
      .then((r) => setAssets(r.assets))
      .catch(() => setAssets([]));
  }, [app.id]);

  if (!caps.list) return <div className="warn-box">Price history is not supported by the {app.label} adapter.</div>;

  const setFilter = (k: keyof Filters) => (e: { target: { value: string } }) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  return (
    <div>
      <div className="page-head">
        <h1>{app.label} — Price History</h1>
        <div className="actions">
          {caps.deleteRange && <button onClick={() => setDeletingRange(true)}>Delete range…</button>}
          {caps.reset && <button className="danger" onClick={() => setResetting(true)}>Reset all…</button>}
        </div>
      </div>

      {caps.stats && stats.length > 0 && (
        <div className="card">
          <h2>Per-asset stats</h2>
          <table>
            <thead><tr><th>Asset</th><th>Points</th><th>Min</th><th>Max</th><th>Avg</th><th>First</th><th>Last</th></tr></thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.assetId}>
                  <td>{s.assetSymbol}</td>
                  <td>{s.count}</td>
                  <td>{fmtNum(s.min)}</td>
                  <td>{fmtNum(s.max)}</td>
                  <td>{fmtNum(s.avg)}</td>
                  <td>{fmtDate(s.firstAt)}</td>
                  <td>{fmtDate(s.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="filters">
        <select value={filters.assetId} onChange={setFilter('assetId')}>
          <option value="">All assets</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol}</option>)}
        </select>
        <label className="inline">From <input type="date" value={filters.from} onChange={setFilter('from')} /></label>
        <label className="inline">To <input type="date" value={filters.to} onChange={setFilter('to')} /></label>
      </div>
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>ID</th><th>Asset</th><th>Price</th><th>Recorded</th></tr></thead>
        <tbody>
          {(data?.items ?? []).map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td>
              <td>{p.assetId}</td>
              <td>{fmtNum(p.price)}</td>
              <td>{fmtDate(p.recordedAt)}</td>
            </tr>
          ))}
          {data && data.items.length === 0 && <tr><td colSpan={4} className="muted">No price points.</td></tr>}
        </tbody>
      </table>
      <Pager page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} />

      {deletingRange && (
        <DeleteRangeModal
          app={app}
          assets={assets}
          onClose={() => setDeletingRange(false)}
          onDeleted={() => { setDeletingRange(false); load(); loadStats(); }}
        />
      )}
      {resetting && (
        <ResetModal
          app={app}
          onClose={() => setResetting(false)}
          onDone={() => { setResetting(false); load(); loadStats(); }}
        />
      )}
    </div>
  );
}

function DeleteRangeModal({
  app,
  assets,
  onClose,
  onDeleted,
}: {
  app: AppInfo;
  assets: AssetInfo[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState({ assetId: '', from: '', to: '', confirm: false });
  const [matched, setMatched] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = deleteRangeValid(form);

  const preview = async () => {
    setError(null);
    try {
      const res = await api<{ count: number }>(`/apps/${app.id}/price-history/count`, {
        query: { assetId: form.assetId || undefined, from: form.from || undefined, to: form.to || undefined },
      });
      setMatched(res.count);
    } catch (err) {
      setError(validationDetails(err) ?? (err instanceof Error ? err.message : 'Count failed'));
    }
  };

  const doDelete = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/apps/${app.id}/price-history/delete-range`, {
        method: 'POST',
        body: {
          assetId: form.assetId || undefined,
          from: form.from || undefined,
          to: form.to || undefined,
          confirm: true,
        },
      });
      onDeleted();
    } catch (err) {
      setError(validationDetails(err) ?? (err instanceof Error ? err.message : 'Delete failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Delete price history range" onClose={onClose}>
      <form onSubmit={doDelete}>
        <p>Select a filter, preview how many rows match, then confirm.</p>
        <label>Asset
          <select value={form.assetId} onChange={(e) => { setForm({ ...form, assetId: e.target.value }); setMatched(null); }}>
            <option value="">All assets</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol}</option>)}
          </select>
        </label>
        <label>From <input type="date" value={form.from} onChange={(e) => { setForm({ ...form, from: e.target.value }); setMatched(null); }} /></label>
        <label>To <input type="date" value={form.to} onChange={(e) => { setForm({ ...form, to: e.target.value }); setMatched(null); }} /></label>
        <button type="button" onClick={preview} disabled={!form.assetId && !form.from && !form.to}>
          Preview matched rows
        </button>
        {matched !== null && <p className={matched > 0 ? 'warn-text' : 'muted'}>{matched.toLocaleString()} rows match this filter.</p>}
        <label className="inline checkbox">
          <input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} />
          I understand this permanently deletes the matched rows
        </label>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>Cancel</button>
          <button type="submit" className="danger" disabled={!valid || busy || matched === null || matched === 0}>
            {busy ? 'Deleting…' : 'Delete matched rows'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetModal({ app, onClose, onDone }: { app: AppInfo; onClose: () => void; onDone: () => void }) {
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doReset = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/apps/${app.id}/price-history/reset`, { method: 'POST', body: { phrase } });
      onDone();
    } catch (err) {
      setError(validationDetails(err) ?? (err instanceof Error ? err.message : 'Reset failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Reset all price history" onClose={onClose}>
      <form onSubmit={doReset}>
        <p className="warn-text">
          This deletes every price-history row for {app.label}. Other tables are untouched.
        </p>
        <label>Type <strong>RESET</strong> to confirm
          <input value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        </label>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>Cancel</button>
          <button type="submit" className="danger" disabled={!resetPhraseOk(phrase) || busy}>
            {busy ? 'Resetting…' : 'Reset price history'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
