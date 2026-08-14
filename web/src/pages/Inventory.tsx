import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, validationDetails } from '../api';
import { CapabilityNote, ErrorBox, fmtNum, Modal, Pager } from '../components/common';
import type { AppInfo, AssetInfo, InventoryItem, Paged } from '../types';

const PAGE_SIZE = 25;

export function Inventory({ app }: { app: AppInfo }) {
  const caps = app.capabilities.inventory;
  const [data, setData] = useState<Paged<InventoryItem> | null>(null);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [page, setPage] = useState(1);
  const [assetId, setAssetId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<InventoryItem | 'new' | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<Paged<InventoryItem>>(`/apps/${app.id}/inventory`, {
        query: { page, pageSize: PAGE_SIZE, assetId: assetId || undefined },
      });
      setData(res);
    } catch (err) {
      setError(err);
    }
  }, [app.id, page, assetId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<{ assets: AssetInfo[] }>(`/apps/${app.id}/assets`)
      .then((r) => setAssets(r.assets))
      .catch(() => setAssets([]));
  }, [app.id]);

  if (!caps.list) return <div className="warn-box">Inventory is not supported by the {app.label} adapter.</div>;

  const remove = async (item: InventoryItem) => {
    if (!window.confirm(`Delete holding of ${item.quantity} ${item.assetSymbol} for user ${item.userId}?`)) return;
    try {
      await api(`/apps/${app.id}/inventory/${item.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>{app.label} — Inventory</h1>
        {caps.create && <button onClick={() => setEditing('new')}>Add holding</button>}
      </div>
      <div className="filters">
        <select value={assetId} onChange={(e) => { setAssetId(e.target.value); setPage(1); }}>
          <option value="">All assets</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol} — {a.name}</option>)}
        </select>
      </div>
      <ErrorBox error={error} />
      <table>
        <thead><tr><th>ID</th><th>User</th><th>Asset</th><th>Quantity</th><th>Avg price</th><th /></tr></thead>
        <tbody>
          {(data?.items ?? []).map((i) => (
            <tr key={i.id}>
              <td>{i.id}</td>
              <td>{i.userId}</td>
              <td>{i.assetSymbol} — {i.assetName}</td>
              <td>{fmtNum(i.quantity)}</td>
              <td>{fmtNum(i.averagePrice)}</td>
              <td className="row-actions">
                {caps.update && <button className="link" onClick={() => setEditing(i)}>Edit</button>}
                {caps.delete && <button className="link danger-text" onClick={() => remove(i)}>Delete</button>}
              </td>
            </tr>
          ))}
          {data && data.items.length === 0 && <tr><td colSpan={6} className="muted">No holdings.</td></tr>}
        </tbody>
      </table>
      <Pager page={page} pageSize={PAGE_SIZE} total={data?.total ?? 0} onPage={setPage} />
      {editing && (
        <InventoryModal
          app={app}
          assets={assets}
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function InventoryModal({
  app,
  assets,
  item,
  onClose,
  onSaved,
}: {
  app: AppInfo;
  assets: AssetInfo[];
  item: InventoryItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    userId: item?.userId ?? '',
    assetId: item?.assetId ?? '',
    quantity: item ? String(item.quantity) : '',
    averagePrice: item?.averagePrice !== null && item?.averagePrice !== undefined ? String(item.averagePrice) : '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = item === null;
  const valid = isNew
    ? Boolean(form.userId && form.assetId && Number(form.quantity) > 0)
    : form.quantity === '' || Number(form.quantity) > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        await api(`/apps/${app.id}/inventory`, {
          method: 'POST',
          body: {
            userId: form.userId,
            assetId: form.assetId,
            quantity: Number(form.quantity),
            averagePrice: form.averagePrice ? Number(form.averagePrice) : undefined,
          },
        });
      } else {
        await api(`/apps/${app.id}/inventory/${item.id}`, {
          method: 'PATCH',
          body: {
            quantity: form.quantity ? Number(form.quantity) : undefined,
            averagePrice: form.averagePrice ? Number(form.averagePrice) : undefined,
          },
        });
      }
      onSaved();
    } catch (err) {
      setError(validationDetails(err) ?? (err instanceof Error ? err.message : 'Save failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={isNew ? 'Add holding' : `Edit holding #${item.id}`} onClose={onClose}>
      <form onSubmit={submit}>
        {isNew && (
          <>
            <label>User ID<input value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} /></label>
            <label>Asset
              <select value={form.assetId} onChange={(e) => setForm({ ...form, assetId: e.target.value })}>
                <option value="">Select…</option>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol} — {a.name}</option>)}
              </select>
            </label>
          </>
        )}
        <label>Quantity<input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} inputMode="decimal" /></label>
        <label>Average price<input value={form.averagePrice} onChange={(e) => setForm({ ...form, averagePrice: e.target.value })} inputMode="decimal" /></label>
        <CapabilityNote supported={isNew ? app.capabilities.inventory.create : app.capabilities.inventory.update} label={isNew ? 'Holding creation' : 'Holding update'} />
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!valid || busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
