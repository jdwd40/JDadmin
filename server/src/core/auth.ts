import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { AdminDb } from '../db/adminDb.js';
import type { AppConfig } from '../config.js';

export interface AdminUser {
  id: string;
  username: string;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionInfo {
  sessionId: string;
  user: AdminUser;
  csrfToken: string;
  expiresAt: Date;
}

const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  disabled: boolean;
  created_at: Date;
  last_login_at: Date | null;
}

function toAdminUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    username: row.username,
    disabled: row.disabled,
    createdAt: row.created_at.toISOString(),
    lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
  };
}

export class AuthService {
  constructor(
    private readonly db: AdminDb,
    private readonly config: AppConfig,
  ) {}

  async findUserByUsername(username: string): Promise<(AdminUser & { passwordHash: string }) | null> {
    const res = await this.db.query<UserRow>(
      'SELECT * FROM admin_users WHERE lower(username) = lower($1)',
      [username],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ...toAdminUser(row), passwordHash: row.password_hash };
  }

  async createUser(username: string, password: string): Promise<AdminUser> {
    const res = await this.db.query<UserRow>(
      `INSERT INTO admin_users (username, password_hash) VALUES ($1, $2) RETURNING *`,
      [username, hashPassword(password)],
    );
    return toAdminUser(res.rows[0] as UserRow);
  }

  async verifyLogin(username: string, password: string): Promise<AdminUser | null> {
    const user = await this.findUserByUsername(username);
    if (!user || user.disabled) {
      // Constant-shape work to reduce user-enumeration timing signal.
      verifyPassword(password, '$2a$12$000000000000000000000uV5M6kH7cF3y3mF6k0b0m0m0m0m0m0m');
      return null;
    }
    const ok = verifyPassword(password, user.passwordHash);
    if (!ok) return null;
    await this.db.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id]);
    const { passwordHash: _omit, ...safe } = user;
    return safe;
  }

  async createSession(userId: string, ip?: string, userAgent?: string): Promise<SessionInfo & { token: string }> {
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + this.config.sessionTtlMs);
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO admin_sessions (token_hash, user_id, csrf_token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [sha256(token), userId, sha256(csrfToken), expiresAt, ip ?? null, userAgent ?? null],
    );
    const user = await this.getUser(userId);
    return {
      sessionId: (res.rows[0] as { id: string }).id,
      token,
      csrfToken,
      expiresAt,
      user,
    };
  }

  async getUser(userId: string): Promise<AdminUser> {
    const res = await this.db.query<UserRow>('SELECT * FROM admin_users WHERE id = $1', [userId]);
    const row = res.rows[0];
    if (!row) throw new Error('admin user missing');
    return toAdminUser(row);
  }

  /** Returns null when the token is unknown, expired, revoked, or the user is disabled. */
  async resolveSession(token: string | undefined): Promise<SessionInfo | null> {
    if (!token) return null;
    const found = await this.db.query<{
      id: string;
      user_id: string;
      expires_at: Date;
      revoked_at: Date | null;
      csrf_token_hash: string;
    }>('SELECT * FROM admin_sessions WHERE token_hash = $1', [sha256(token)]);
    const row = found.rows[0];
    if (!row || row.revoked_at || row.expires_at.getTime() < Date.now()) return null;
    let user: AdminUser;
    try {
      user = await this.getUser(row.user_id);
    } catch {
      return null;
    }
    if (user.disabled) return null;
    return {
      sessionId: row.id,
      user,
      // The raw CSRF token is only ever handed out at login; the session row
      // stores its hash. Callers needing verification use verifyCsrf below.
      csrfToken: '',
      expiresAt: row.expires_at,
    };
  }

  async verifyCsrf(sessionId: string, presentedToken: string | undefined): Promise<boolean> {
    if (!presentedToken) return false;
    const res = await this.db.query<{ csrf_token_hash: string }>(
      'SELECT csrf_token_hash FROM admin_sessions WHERE id = $1 AND revoked_at IS NULL',
      [sessionId],
    );
    const row = res.rows[0];
    if (!row) return false;
    return safeEqualHex(row.csrf_token_hash, sha256(presentedToken));
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
  }

  /** Change password; revokes all other sessions for the user. Never logs hashes. */
  async changePassword(userId: string, currentPassword: string, nextPassword: string): Promise<boolean> {
    const res = await this.db.query<UserRow>('SELECT * FROM admin_users WHERE id = $1', [userId]);
    const row = res.rows[0];
    if (!row) return false;
    if (!verifyPassword(currentPassword, row.password_hash)) return false;
    return this.db.transaction(async (client) => {
      await client.query('UPDATE admin_users SET password_hash = $1, updated_at = now() WHERE id = $2', [
        hashPassword(nextPassword),
        userId,
      ]);
      await client.query(
        'UPDATE admin_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      );
      return true;
    });
  }
}
