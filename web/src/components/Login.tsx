import { FormEvent, useState } from 'react';
import { api, setCsrfToken, validationDetails } from '../api';
import type { AdminUser } from '../types';

interface LoginResponse {
  admin: AdminUser;
  csrfToken: string;
  expiresAt: string;
}

export function Login({ onLoggedIn }: { onLoggedIn: (user: AdminUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      setCsrfToken(res.csrfToken);
      onLoggedIn(res.admin);
    } catch (err) {
      setError(validationDetails(err) ?? (err instanceof Error ? err.message : 'Login failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-card">
      <form className="card login-card" onSubmit={submit}>
        <h1>Universal Admin</h1>
        <p className="muted">Sign in with an admin account. There is no public registration.</p>
        <label>
          Username
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="error-box">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
