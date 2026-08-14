import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, validationDetails } from '../api';
import { CapabilityNote, ErrorBox, fmtDate, fmtNum, Modal, Pager } from '../components/common';
import type { AppInfo, AssetInfo, Paged, TransactionItem } from '../types';

const PAGE_SIZE = 25;

export function Transactions({ app }: { app: AppInfo }) {
  const caps = app.capabilities.transactions;
  const [data, setData] = useState<Paged<TransactionItem> | null>(null);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ userId: '', assetId: '', type: '' });
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<Paged<TransactionItem>>(`/apps/${app.id}/transactions`, {
        query: {
          page,
          pageSize: PAGE_SIZE,
          userId: filters.userId || undefined,
          assetId: filters.assetId || undefined,
          type: filters.type || undefined,
        },
      });
      setData(res);
    } catch (err) {
      setError(err);
    }
  }, [app.id, page, filters]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ assets: AssetInfo[] }>(`/apps/${app.id}/assets`)
      .then((r) => setAssets(r.assets))
      .catch(() => setAssets([]));
  }, [app.id]);

  if (!caps.list) return <div className="warn-box">Transactions are not supported by the {app.label} adapter.</div>;

  const setFilter = (k: keyof typeof filters) => (e: { target: { value: string } }) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  return (
    <div>
      <div className="page-head">
        <h1>{app.label} — Transactions</h1>
        {caps.create && <button onClick={() => setCreating(true)}>New transaction</button>}
      </div>
      {!caps.create && <CapabilityNote supported={false} label="Transaction creation" />}
      <div className="filters">
        <input placeholder="User ID" value={filters.userId} onChange={setFilter('userId')} />
        <select value={filters.assetId} onChange={setFilter('assetId')}>
          <option value="">All assets</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol}</option>)}
        </select>
        <select value={filters.type} onChange={setFilter('type')}>
          <option value="">All types</option>
          <option value="buy">buy</option>
          <option value="sell">sell</option>
        </select>
      </div>
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>ID</th><th>When</th><th>User</th><th>Type</th><th>Asset</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
        <tbody>
          {(data?.items ?? []).map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td>
              <td>{fmtDate(t.createdAt)}</td>
              <td>{t.userId}</td>
              <td>{t.type}</td>
              <td>{t.assetSymbol ?? t.assetId ?? '—'}</td>
              <td>{fmtNum(t.quantity)}</td>
              <td>{fmtNum(t.price)}</td>
              <td>{fmtNum(t.totalAmount)}</td>
            </tr>
          ))}
          {data && data.items.length === 0 && <tr><td colSpan={8} className="muted">No transactions.</td></tr>}
        </tbody>
      </table>
      <Pager page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} />
      {creating && (
        <CreateTransactionModal
          app={app}
          assets={assets}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
        />
      )}
    </div>
  );
}

function CreateTransactionModal({
  app,
  assets,
  onClose,
  onCreated,
}: {
  app: AppInfo;
  assets: AssetInfo[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({ userId: '', assetId: '', type: 'buy', quantity: '', price: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = Boolean(form.userId && form.assetId && Number(form.quantity) > 0 && Number(form.price) > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/apps/${app.id}/transactions`, {
        method: 'POST',
        body: {
          userId: form.userId,
          assetId: form.assetId,
          type: form.type,
          quantity: Number(form.quantity),
          price: Number(form.price),
        },
      });
      onCreated();
    } catch (err) {
      setError(validationDetails(err) ?? (err instanceof Error ? err.message : 'Create failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New transaction" onClose={onClose}>
      <form onSubmit={submit}>
        <label>User ID<input value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} /></label>
        <label>Asset
          <select value={form.assetId} onChange={(e) => setForm({ ...form, assetId: e.target.value })}>
            <option value="">Select…</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol} — {a.name}</option>)}
          </select>
        </label>
        <label>Type
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="buy">buy</option>
            <option value="sell">sell</option>
          </select>
        </label>
        <label>Quantity<input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} inputMode="decimal" /></label>
        <label>Price<input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} inputMode="decimal" /></label>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!valid || busy}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}
