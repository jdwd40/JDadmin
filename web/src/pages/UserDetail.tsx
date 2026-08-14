import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, validationDetails } from '../api';
import { CapabilityNote, ErrorBox, fmtDate, fmtNum, Modal, Pager } from '../components/common';
import type { AppInfo, InventoryItem, Paged, TransactionItem, UserDetail as UserDetailT } from '../types';
import { DeleteUserModal } from './Users';

const PAGE_SIZE = 25;
type Tab = 'details' | 'inventory' | 'transactions';

export function UserDetail({ app, userId, onBack }: { app: AppInfo; userId: string; onBack: () => void }) {
  const caps = app.capabilities.users;
  const [user, setUser] = useState<UserDetailT | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const user = await api<UserDetailT>(`/apps/${app.id}/users/${userId}`);
      setUser(user);
    } catch (err) {
      setError(err);
    }
  }, [app.id, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleDisabled = async () => {
    if (!user) return;
    try {
      await api(`/apps/${app.id}/users/${user.id}/disable`, {
        method: 'POST',
        body: { disabled: !user.disabled },
      });
      await load();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <button className="link" onClick={onBack}>← All users</button>
          <h1>{user ? user.username : 'User'} <span className="muted">#{userId}</span></h1>
        </div>
        {user && (
          <div className="actions">
            {caps.update && <button onClick={() => setEditing(true)}>Edit</button>}
            {caps.resetPassword && <button onClick={() => setResetting(true)}>Reset password</button>}
            {caps.disable && (
              <button onClick={toggleDisabled}>{user.disabled ? 'Enable' : 'Disable'}</button>
            )}
            {caps.delete && <button className="danger" onClick={() => setDeleting(true)}>Delete</button>}
          </div>
        )}
      </div>
      <ErrorBox error={error} />
      {!caps.disable && app.available && <CapabilityNote supported={false} label="Disable/enable" />}
      {!caps.delete && app.available && <CapabilityNote supported={false} label="User deletion" />}
      {user && (
        <>
          <div className="tabs">
            {(['details', 'inventory', 'transactions'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          {tab === 'details' && (
            <div className="card">
              <dl className="detail-list">
                <dt>Username</dt><dd>{user.username}</dd>
                <dt>Email</dt><dd>{user.email ?? '—'}</dd>
                <dt>Display name</dt><dd>{user.displayName ?? '—'}</dd>
                <dt>Balance</dt><dd>{fmtNum(user.balance)}</dd>
                <dt>Status</dt><dd>{user.disabled === null ? '—' : user.disabled ? 'disabled' : 'active'}</dd>
                <dt>Created</dt><dd>{fmtDate(user.createdAt)}</dd>
                {Object.entries(user.extra ?? {}).filter(([k]) => k !== 'relatedCounts').map(([k, v]) => (
                  <span key={k} className="detail-pair"><dt>{k}</dt><dd>{String(v)}</dd></span>
                ))}
              </dl>
            </div>
          )}
          {tab === 'inventory' && <UserInventory app={app} userId={userId} />}
          {tab === 'transactions' && <UserTransactions app={app} userId={userId} />}
        </>
      )}
      {editing && user && (
        <EditUserModal app={app} user={user} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />
      )}
      {resetting && user && (
        <ResetPasswordModal app={app} user={user} onClose={() => setResetting(false)} />
      )}
      {deleting && user && (
        <DeleteUserModal app={app} user={user} onClose={() => setDeleting(false)} onDeleted={onBack} />
      )}
    </div>
  );
}

function UserInventory({ app, userId }: { app: AppInfo; userId: string }) {
  const [data, setData] = useState<Paged<InventoryItem> | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setError(null);
    api<Paged<InventoryItem>>(`/apps/${app.id}/inventory`, { query: { userId, page, pageSize: PAGE_SIZE } })
      .then(setData)
      .catch(setError);
  }, [app.id, userId, page]);

  if (!app.capabilities.inventory.list) return <CapabilityNote supported={false} label="Inventory listing" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="card">
      <table>
        <thead><tr><th>Asset</th><th>Quantity</th><th>Avg price</th></tr></thead>
        <tbody>
          {data.items.map((i) => (
            <tr key={i.id}>
              <td>{i.assetSymbol} — {i.assetName}</td>
              <td>{fmtNum(i.quantity)}</td>
              <td>{fmtNum(i.averagePrice)}</td>
            </tr>
          ))}
          {data.items.length === 0 && <tr><td colSpan={3} className="muted">No holdings.</td></tr>}
        </tbody>
      </table>
      <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
    </div>
  );
}

function UserTransactions({ app, userId }: { app: AppInfo; userId: string }) {
  const [data, setData] = useState<Paged<TransactionItem> | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setError(null);
    api<Paged<TransactionItem>>(`/apps/${app.id}/transactions`, { query: { userId, page, pageSize: PAGE_SIZE } })
      .then(setData)
      .catch(setError);
  }, [app.id, userId, page]);

  if (!app.capabilities.transactions.list) return <CapabilityNote supported={false} label="Transaction listing" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="card">
      <table>
        <thead><tr><th>When</th><th>Type</th><th>Asset</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
        <tbody>
          {data.items.map((t) => (
            <tr key={t.id}>
              <td>{fmtDate(t.createdAt)}</td>
              <td>{t.type}</td>
              <td>{t.assetSymbol ?? t.assetId ?? '—'}</td>
              <td>{fmtNum(t.quantity)}</td>
              <td>{fmtNum(t.price)}</td>
              <td>{fmtNum(t.totalAmount)}</td>
            </tr>
          ))}
          {data.items.length === 0 && <tr><td colSpan={6} className="muted">No transactions.</td></tr>}
        </tbody>
      </table>
      <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
    </div>
  );
}

function EditUserModal({ app, user, onClose, onSaved }: { app: AppInfo; user: UserDetailT; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    username: user.username,
    email: user.email ?? '',
    displayName: user.displayName ?? '',
    balance: user.balance !== null && user.balance !== undefined ? String(user.balance) : '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/apps/${app.id}/users/${user.id}`, {
        method: 'PATCH',
        body: {
          username: form.username !== user.username ? form.username : undefined,
          email: form.email !== (user.email ?? '') ? form.email : undefined,
          displayName: form.displayName !== (user.displayName ?? '') ? form.displayName : undefined,
          balance: form.balance !== '' && Number(form.balance) !== user.balance ? Number(form.balance) : undefined,
        },
      });
      onSaved();
    } catch (err) {
      setError(validationDetails(err) ?? (err instanceof Error ? err.message : 'Update failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit ${user.username}`} onClose={onClose}>
      <form onSubmit={submit}>
        <label>Username<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label>Email<input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Display name<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
        <label>Balance<input value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} inputMode="decimal" /></label>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ app, user, onClose }: { app: AppInfo; user: UserDetailT; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = password.length >= 10;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/apps/${app.id}/users/${user.id}/reset-password`, { method: 'POST', body: { newPassword: password } });
      setDone(true);
    } catch (err) {
      setError(validationDetails(err) ?? (err instanceof Error ? err.message : 'Reset failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Reset password for ${user.username}`} onClose={onClose}>
      {done ? (
        <>
          <p className="ok-text">Password updated. The new password is never stored or shown again.</p>
          <div className="modal-actions"><button onClick={onClose}>Close</button></div>
        </>
      ) : (
        <form onSubmit={submit}>
          <label>New password (min 10 chars)
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <ErrorBox error={error} />
          <div className="modal-actions">
            <button type="button" className="link" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={!valid || busy}>{busy ? 'Resetting…' : 'Reset password'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
