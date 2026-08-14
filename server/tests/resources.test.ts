import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MetricSample } from '../src/adapters/types.js';
import {
  APP_PROCESS_IDENTITIES,
  measureAppProcessMemory,
  measureDatabaseStorage,
  measureProcessMemory,
  MetricsCache,
  okSample,
  parseMeminfoBytes,
  sanitizeBytes,
  sanitizeMetricError,
  unavailableSample,
} from '../src/core/resources.js';
import { createHarness, TestHarness } from './helpers.js';

describe('resource measurement helpers', () => {
  describe('sanitizeBytes', () => {
    it('accepts finite non-negative numbers and numeric strings', () => {
      expect(sanitizeBytes(0)).toBe(0);
      expect(sanitizeBytes(1234.6)).toBe(1235);
      expect(sanitizeBytes('8192')).toBe(8192);
    });

    it('rejects malformed values instead of coercing to zero', () => {
      expect(sanitizeBytes('not-a-number')).toBeNull();
      expect(sanitizeBytes(NaN)).toBeNull();
      expect(sanitizeBytes(Infinity)).toBeNull();
      expect(sanitizeBytes(-1)).toBeNull();
      expect(sanitizeBytes(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
      expect(sanitizeBytes(null)).toBeNull();
      expect(sanitizeBytes(undefined)).toBeNull();
      expect(sanitizeBytes({})).toBeNull();
    });
  });

  describe('sanitizeMetricError', () => {
    it('maps permission failures to a fixed reason', () => {
      expect(sanitizeMetricError(Object.assign(new Error('pg detail'), { code: '42501' }))).toBe('permission denied');
      expect(sanitizeMetricError(Object.assign(new Error('fs detail'), { code: 'EACCES' }))).toBe('permission denied');
      expect(sanitizeMetricError(Object.assign(new Error('fs detail'), { code: 'EPERM' }))).toBe('permission denied');
    });

    it('never propagates raw error text (possible host/user leak)', () => {
      const err = new Error('password authentication failed for user "coins" at db.internal:5432');
      expect(sanitizeMetricError(err)).toBe('measurement failed');
    });
  });

  describe('okSample', () => {
    it('computes percent only when a meaningful total exists', () => {
      const s = okSample('test', 25, 75, 100);
      expect(s).toMatchObject({ status: 'ok', usedBytes: 25, availableBytes: 75, totalBytes: 100, percentUsed: 25, reason: null });
      expect(okSample('test', 25, null, null).percentUsed).toBeNull();
    });

    it('degrades malformed parts to unavailable, never zero', () => {
      const s = okSample('test', 'garbage', null, null);
      expect(s.status).toBe('unavailable');
      expect(s.usedBytes).toBeNull();
      expect(s.reason).toBe('malformed measurement');
    });
  });

  describe('parseMeminfoBytes', () => {
    const sample = 'MemTotal:       16384000 kB\nMemFree:         1024000 kB\nMemAvailable:    8192000 kB\n';
    it('parses kB values into bytes', () => {
      expect(parseMeminfoBytes(sample, 'MemTotal')).toBe(16384000 * 1024);
      expect(parseMeminfoBytes(sample, 'MemAvailable')).toBe(8192000 * 1024);
    });
    it('returns null for missing or malformed keys', () => {
      expect(parseMeminfoBytes(sample, 'MemBogus')).toBeNull();
      expect(parseMeminfoBytes('MemTotal: huge\n', 'MemTotal')).toBeNull();
    });
  });

  describe('measureDatabaseStorage', () => {
    const scope = 'app database (PostgreSQL, whole database)';

    it('returns an ok sample for a normal measurement', async () => {
      const s = await measureDatabaseStorage(async (text) => {
        expect(text).toContain('pg_database_size');
        return { rows: [{ bytes: '10485760' }] };
      });
      expect(s).toMatchObject({ status: 'ok', scope, usedBytes: 10485760, availableBytes: null, totalBytes: null, percentUsed: null });
    });

    it('reports malformed driver output as unavailable', async () => {
      const s = await measureDatabaseStorage(async () => ({ rows: [{ bytes: 'not-a-number' }] }));
      expect(s.status).toBe('unavailable');
      expect(s.usedBytes).toBeNull();
      expect(s.reason).toBe('malformed measurement');
    });

    it('classifies permission-denied without leaking driver detail', async () => {
      const err = Object.assign(new Error('permission denied for function pg_database_size'), { code: '42501' });
      const s = await measureDatabaseStorage(async () => { throw err; });
      expect(s.status).toBe('unavailable');
      expect(s.usedBytes).toBeNull();
      expect(s.reason).toBe('permission denied');
    });

    it('sanitizes generic failures', async () => {
      const s = await measureDatabaseStorage(async () => {
        throw new Error('connect timeout user=coins host=db.internal');
      });
      expect(s.status).toBe('unavailable');
      expect(s.reason).toBe('measurement failed');
      expect(JSON.stringify(s)).not.toContain('db.internal');
    });
  });

  describe('measureProcessMemory', () => {
    it('reports the jdadmin process RSS with explicit scope', () => {
      const s = measureProcessMemory();
      expect(s.status).toBe('ok');
      expect(s.scope).toContain('jdadmin process');
      expect(s.usedBytes).toBeGreaterThan(0);
      expect(s.percentUsed).toBeNull();
    });
  });

  describe('measureAppProcessMemory (issue #18)', () => {
    const coins = APP_PROCESS_IDENTITIES.coins;

    it('pins the confirmed fixed deployment identities', () => {
      expect(APP_PROCESS_IDENTITIES.coins.commandPath).toBe('/home/jd/back_coins_x/server.js');
      expect(APP_PROCESS_IDENTITIES.dwarf.commandPath).toBe(
        '/srv/dwarf-gem-exchange/production/current/backend/dist/server.js',
      );
    });

    interface FakeProcEntry {
      cmdline?: string;
      status?: string;
      /** chmod applied to the status file (e.g. to simulate EACCES). */
      statusMode?: number;
    }

    async function makeProcRoot(entries: Record<string, FakeProcEntry>): Promise<string> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jdadmin-proc-'));
      for (const [name, entry] of Object.entries(entries)) {
        const dir = path.join(root, name);
        await fs.mkdir(dir);
        if (entry.cmdline !== undefined) await fs.writeFile(path.join(dir, 'cmdline'), entry.cmdline);
        if (entry.status !== undefined) {
          const p = path.join(dir, 'status');
          await fs.writeFile(p, entry.status);
          if (entry.statusMode !== undefined) await fs.chmod(p, entry.statusMode);
        }
      }
      return root;
    }

    const statusWithRss = (kb: number) => `Name:\tnode\nVmRSS:\t   ${kb} kB\nVmSize:\t  999999 kB\n`;

    it('reports RSS for an exact argv-token match, with null total/percent', async () => {
      const root = await makeProcRoot({
        '4321': {
          cmdline: `node\0${coins.commandPath}\0`,
          status: statusWithRss(51200),
        },
        '999': { cmdline: 'postgres\0-D\0/var/lib/pg\0', status: statusWithRss(1) },
        cpuinfo: {},
      });
      try {
        const s = await measureAppProcessMemory(coins, root);
        expect(s).toMatchObject({
          status: 'ok',
          usedBytes: 51200 * 1024,
          availableBytes: null,
          totalBytes: null,
          percentUsed: null,
          reason: null,
        });
        expect(s.scope).toContain('app process');
        expect(s.scope).toContain('coins backend');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('requires an exact token: substring/lookalike/embedded paths do not match', async () => {
      const root = await makeProcRoot({
        '100': { cmdline: `node\0${coins.commandPath}.bak\0`, status: statusWithRss(100) },
        '101': { cmdline: `node\0/home/jd/back_coins_x\0`, status: statusWithRss(100) },
        // bash -c keeps the whole script as one token: the path is embedded, not exact.
        '102': { cmdline: `/usr/bin/bash\0-c\0node ${coins.commandPath}\0`, status: statusWithRss(100) },
      });
      try {
        const s = await measureAppProcessMemory(coins, root);
        expect(s.status).toBe('unavailable');
        expect(s.reason).toBe('process not found');
        expect(s.usedBytes).toBeNull();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('recognizes the space-joined Node process-title cmdline form (issue #23)', async () => {
      const root = await makeProcRoot({
        // Live Coins cmdline: one NUL token holding the space-joined title.
        '600': { cmdline: `node ${coins.commandPath}\0`, status: statusWithRss(4096) },
        '999': { cmdline: 'postgres\0-D\0/var/lib/pg\0', status: statusWithRss(1) },
      });
      try {
        const s = await measureAppProcessMemory(coins, root);
        expect(s).toMatchObject({
          status: 'ok',
          usedBytes: 4096 * 1024,
          availableBytes: null,
          totalBytes: null,
          percentUsed: null,
          reason: null,
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('process-title matching stays exact: title substrings/lookalikes do not match (issue #23)', async () => {
      const root = await makeProcRoot({
        '700': { cmdline: `node ${coins.commandPath}.bak\0`, status: statusWithRss(100) },
        '701': { cmdline: `node /home/jd/back_coins_x\0`, status: statusWithRss(100) },
        '702': { cmdline: `xx${coins.commandPath} node\0`, status: statusWithRss(100) },
      });
      try {
        const s = await measureAppProcessMemory(coins, root);
        expect(s.status).toBe('unavailable');
        expect(s.reason).toBe('process not found');
        expect(s.usedBytes).toBeNull();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('reports process not found when no process matches', async () => {
      const root = await makeProcRoot({ '1': { cmdline: 'sbin/init\0', status: statusWithRss(10) } });
      try {
        const s = await measureAppProcessMemory(coins, root);
        expect(s).toMatchObject({ status: 'unavailable', usedBytes: null, percentUsed: null });
        expect(s.reason).toBe('process not found');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('reports ambiguous rather than picking one of several matches', async () => {
      const root = await makeProcRoot({
        '200': { cmdline: `node\0${coins.commandPath}\0`, status: statusWithRss(1000) },
        '201': { cmdline: `node\0${coins.commandPath}\0`, status: statusWithRss(2000) },
      });
      try {
        const s = await measureAppProcessMemory(coins, root);
        expect(s.status).toBe('unavailable');
        expect(s.reason).toBe('ambiguous process match');
        expect(s.usedBytes).toBeNull(); // never one of the candidates' RSS
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('reports malformed measurement when VmRSS is missing or unparsable', async () => {
      const root = await makeProcRoot({
        '300': { cmdline: `node\0${coins.commandPath}\0`, status: 'Name:\tnode\nVmRSS:\thuge\n' },
      });
      try {
        const s = await measureAppProcessMemory(coins, root);
        expect(s.status).toBe('unavailable');
        expect(s.reason).toBe('malformed measurement');
        expect(s.usedBytes).toBeNull();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('reports permission denied when the status file is unreadable', async () => {
      const root = await makeProcRoot({
        '400': {
          cmdline: `node\0${coins.commandPath}\0`,
          status: statusWithRss(1234),
          statusMode: 0o000,
        },
      });
      try {
        const s = await measureAppProcessMemory(coins, root);
        expect(s.status).toBe('unavailable');
        expect(s.reason).toBe('permission denied');
        expect(s.usedBytes).toBeNull();
      } finally {
        await fs.chmod(path.join(root, '400', 'status'), 0o644).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('sanitizes proc enumeration failures without leaking OS error text', async () => {
      const s = await measureAppProcessMemory(coins, path.join(os.tmpdir(), 'jdadmin-no-such-dir'));
      expect(s.status).toBe('unavailable');
      expect(s.reason).toBe('measurement failed');
      expect(JSON.stringify(s)).not.toContain('jdadmin-no-such-dir');
    });

    it('degrades to stale (values preserved) when a refresh stops finding the process', async () => {
      const root = await makeProcRoot({
        '500': { cmdline: `node\0${coins.commandPath}\0`, status: statusWithRss(2048) },
      });
      let now = 1_000;
      const cache = new MetricsCache(30_000, () => now);
      try {
        const first = await cache.sample('k', () => measureAppProcessMemory(coins, root));
        expect(first.sample.status).toBe('ok');
        now += 31_000;
        await fs.rm(path.join(root, '500'), { recursive: true, force: true });
        const second = await cache.sample('k', () => measureAppProcessMemory(coins, root));
        expect(second.sample.status).toBe('stale');
        expect(second.sample.usedBytes).toBe(2048 * 1024); // last good value, not zero
        expect(second.sample.reason).toBe('process not found');
        expect(second.at).toBe(1_000);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('MetricsCache', () => {
    const good = (): MetricSample => okSample('test', 10, 90, 100);

    it('serves fresh values without re-measuring', async () => {
      let now = 1_000;
      let calls = 0;
      const cache = new MetricsCache(30_000, () => now);
      await cache.sample('k', async () => { calls++; return good(); });
      now += 10_000;
      const again = await cache.sample('k', async () => { calls++; return good(); });
      expect(calls).toBe(1);
      expect(again.sample.status).toBe('ok');
      expect(again.at).toBe(1_000);
    });

    it('re-measures once the fresh window expires', async () => {
      let now = 1_000;
      let calls = 0;
      const cache = new MetricsCache(30_000, () => now);
      await cache.sample('k', async () => { calls++; return good(); });
      now += 31_000;
      const res = await cache.sample('k', async () => { calls++; return { ...good(), usedBytes: 20 }; });
      expect(calls).toBe(2);
      expect(res.sample.usedBytes).toBe(20);
      expect(res.at).toBe(now);
    });

    it('degrades to stale (not zero) when a refresh fails after a good value', async () => {
      let now = 1_000;
      const cache = new MetricsCache(30_000, () => now);
      await cache.sample('k', async () => good());
      now += 31_000;
      const res = await cache.sample('k', async () => unavailableSample('test', 'permission denied'));
      expect(res.sample.status).toBe('stale');
      expect(res.sample.usedBytes).toBe(10); // last good values preserved
      expect(res.sample.reason).toBe('permission denied');
      expect(res.at).toBe(1_000); // original collection time kept
    });

    it('reports unavailable when there is no good history', async () => {
      const cache = new MetricsCache(30_000, () => 1_000);
      const res = await cache.sample('k', async () => unavailableSample('test', 'measurement failed'));
      expect(res.sample.status).toBe('unavailable');
      expect(res.sample.usedBytes).toBeNull();
    });
  });
});

describe('GET /api/health/detail resource usage (issue #4)', () => {
  let h: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    h = await createHarness({ withCoins: true, withDwarf: true });
    ({ cookie } = await h.login());
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('requires authentication', async () => {
    const res = await request(h.app).get('/api/health/detail');
    expect(res.status).toBe(401);
  });

  it('exposes app-database storage and explicit unavailable memory for Coins and Dwarf', async () => {
    const res = await request(h.app).get('/api/health/detail').set('Cookie', cookie);
    expect(res.status).toBe(200);

    for (const id of ['coins', 'dwarf'] as const) {
      const app = res.body.apps[id];
      expect(app.ok).toBe(true);
      const { storage, memory, collectedAt } = app.resources;
      expect(Number.isNaN(new Date(collectedAt).getTime())).toBe(false);

      expect(storage.status).toBe('ok');
      expect(storage.scope).toContain('database');
      expect(storage.usedBytes).toBeGreaterThan(0);

      // App process RSS is probed via fixed-identity /proc matching (issue
      // #18); the Coins/Dwarf server processes do not run on the test host, so
      // the sample is unavailable — never zero.
      expect(memory.status).toBe('unavailable');
      expect(memory.scope).toContain('app process');
      expect(memory.usedBytes).toBeNull();
      expect(memory.percentUsed).toBeNull();
      expect(memory.reason).toBe('process not found');
    }
  });

  it('exposes deterministic simulated resources for the mock app', async () => {
    const res = await request(h.app).get('/api/health/detail').set('Cookie', cookie);
    const mock = res.body.apps.mock.resources;
    expect(mock.storage.status).toBe('ok');
    expect(mock.memory).toMatchObject({ status: 'ok', usedBytes: 64 * 1024 * 1024, percentUsed: 12.5 });
  });

  it('exposes host-wide memory/storage and jdadmin process memory with explicit scopes', async () => {
    const res = await request(h.app).get('/api/health/detail').set('Cookie', cookie);
    const host = res.body.host;
    expect(Number.isNaN(new Date(host.collectedAt).getTime())).toBe(false);

    expect(host.memory.status).toBe('ok');
    expect(host.memory.scope).toContain('host-wide');
    expect(host.memory.usedBytes).toBeGreaterThan(0);
    expect(host.memory.percentUsed).toBeGreaterThanOrEqual(0);
    expect(host.memory.percentUsed).toBeLessThanOrEqual(100);

    expect(host.storage.status).toBe('ok');
    expect(host.storage.scope).toContain('filesystem');

    expect(host.processMemory.status).toBe('ok');
    expect(host.processMemory.scope).toContain('jdadmin process');
    expect(host.processMemory.usedBytes).toBeGreaterThan(0);
  });

  it('does not leak connection strings, credentials, or raw driver errors', async () => {
    const res = await request(h.app).get('/api/health/detail').set('Cookie', cookie);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/postgres(ql)?:\/\//i);
    expect(body).not.toContain('jdadmin_test');
    expect(body.toLowerCase()).not.toContain('password');
  });

  it('keeps the unauthenticated liveness probe intact', async () => {
    const res = await request(h.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /api/health/detail with an unconfigured app', () => {
  it('reports unavailable resources (not zero) for the unavailable app', async () => {
    const h = await createHarness({ withDwarf: true, withMock: false });
    try {
      const { cookie } = await h.login();
      const res = await request(h.app).get('/api/health/detail').set('Cookie', cookie);
      expect(res.status).toBe(200);
      const coins = res.body.apps.coins;
      expect(coins.ok).toBe(false);
      for (const m of [coins.resources.storage, coins.resources.memory]) {
        expect(m.status).toBe('unavailable');
        expect(m.usedBytes).toBeNull();
        expect(m.availableBytes).toBeNull();
        expect(m.percentUsed).toBeNull();
      }
      // The configured app still measures normally alongside it.
      expect(res.body.apps.dwarf.resources.storage.status).toBe('ok');
    } finally {
      await h.cleanup();
    }
  });
});
