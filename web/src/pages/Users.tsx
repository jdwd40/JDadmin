import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, validationDetails } from '../api';
import { CapabilityNote, ErrorBox, fmtDate, fmtNum, Modal, Pager } from '../components/common';
import { usernameConfirmOk } from '../lib/confirm';
import { clampPage, nextSort } from '../lib/pagination';
import type { AppInfo, Paged, UserSummary } from '../types';

const PAGE_SIZE = 25;
type Sort = { sort?: string; order: 'asc' | 'desc' };

export function Users({ app, onOpenUser }: { app: AppInfo; onOpenUser: (userId: string) => void }) {
  const caps = app.capabilities.users;
  const [items, setItems] = useState<UserSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>({ sort: undefined, order: 'asc' });
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<Paged<UserSummary>>(`/apps/${app.id}/users`, {
        query: { page, pageSize: PAGE_SIZE, search: search || undefined, sort: sort.sort, order: sort.sort ? sort.order : undefined },
      });
      setItems(res.items);
      setTotal(res.total);
      setPage((p) => clampPage(p, res.total, PAGE_SIZE));
    } catch (err) {
      setError(err);
    }
  }, [app.id, page, search, sort]);

  useEffect(() => {
    load();
  }, [load]);

  if (!caps.list) return <div className="warn-box">User listing is not supported by the {app.label} adapter.</div>;

  const sortHeader = (label: string, col: string) => (
    <th>
      <button className="link" onClick={() => setSort((s) => nextSort(s, col))}>
        {label} {sort.sort === col ? (sort.order === 'asc' ? '▲' : '▼') : ''}
      </button>
    </th>
  );

  return (
    <div>
      <div className="page-head">
        <h1>{app.label} — Users</h1>
        {caps.create && <button onClick={() => setCreating(true)}>Create user</button>}
      </div>
      {!caps.create && <CapabilityNote supported={false} label="User creation" />}
      <input
        className="search"
        placeholder="Search username or email…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
      />
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            {sortHeader('Username', 'username')}
            {sortHeader('Email', 'email')}
            <th>Display name</th>
            {sortHeader('Balance', 'balance')}
            <th>Status</th>
            {sortHeader('Created', 'createdAt')}
          </tr>
        </thead>
        <tbody>
          {items.map((u) => (
            <tr key={u.id} className="clickable" onClick={() => onOpenUser(u.id)}>
              <td>{u.username}</td>
              <td>{u.email ?? '—'}</td>
              <td>{u.displayName ?? '—'}</td>
              <td>{fmtNum(u.balance)}</td>
              <td>{u.disabled === null ? '—' : u.disabled ? <span className="badge bad">disabled</span> : <span className="badge ok">active</span>}</td>
              <td>{fmtDate(u.createdAt)}</td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={6} className="muted">No users found.</td></tr>}
        </tbody>
      </table>
      <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />

      {creating && (
        <CreateUserModal
          app={app}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}

export function DeleteUserModal({
  app,
  user,
  onClose,
  onDeleted,
}: {
  app: AppInfo;
  user: UserSummary;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [related, setRelated] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ counts: Record<string, number> }>(`/apps/${app.id}/users/${user.id}/related-counts`)
      .then((r) => setRelated(r.counts))
      .catch(() => setRelated(null));
  }, [app.id, user.id]);

  const ok = usernameConfirmOk(typed, user.username);

  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/apps/${app.id}/users/${user.id}`, { method: 'DELETE', body: { confirmUsername: typed } });
      onDeleted();
    } catch (err) {
      setError(validationDetails(err) ?? (err instanceof Error ? err.message : 'Delete failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete user ${user.username}`} onClose={onClose}>
      <p>
        This permanently deletes the user and (for adapters with cascading support) their related
        data. This cannot be undone.
      </p>
      {related && (
        <p className="muted">
          Related rows: {Object.entries(related).map(([k, v]) => `${k}: ${v}`).join(', ')}
        </p>
      )}
      <label>
        Type the username <strong>{user.username}</strong> to confirm
        <input value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <div className="modal-actions">
        <button className="link" onClick={onClose}>Cancel</button>
        <button className="danger" disabled={!ok || busy} onClick={doDelete}>
          {busy ? 'Deleting…' : 'Delete user'}
        </button>
      </div>
    </Modal>
  );
}

export function CreateUserModal({
  app,
  onClose,
  onCreated,
}: {
  app: AppInfo;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({ username: '', email: '', password: '', balance: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = form.username.length >= 2 && form.password.length >= 10;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/apps/${app.id}/users`, {
        method: 'POST',
        body: {
          username: form.username,
          email: form.email || undefined,
          password: form.password,
          balance: form.balance ? Number(form.balance) : undefined,
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
    <Modal title="Create user" onClose={onClose}>
      <form onSubmit={submit}>
        <label>Username (min 2 chars)
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </label>
        <label>Email (optional)
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label>Password (min 10 chars)
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <label>Initial balance (optional)
          <input value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} inputMode="decimal" />
        </label>
        <CapabilityNote supported={app.capabilities.users.create} label="User creation" />
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!valid || busy}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}
