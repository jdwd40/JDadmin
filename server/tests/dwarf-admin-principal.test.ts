import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  NODE_ENV: 'test',
  ADMIN_DATABASE_URL: 'postgres://localhost:5432/admin',
};

describe('Dwarf admin principal configuration', () => {
  it('parses a valid UUID principal id', () => {
    const config = loadConfig({
      ...baseEnv,
      DWARF_ADMIN_PRINCIPAL_ID: '33333333-3333-3333-3333-333333333333',
    });
    expect(config.dwarfAdminPrincipalId).toBe('33333333-3333-3333-3333-333333333333');
  });

  it('is undefined when unset', () => {
    expect(loadConfig({ ...baseEnv }).dwarfAdminPrincipalId).toBeUndefined();
  });

  it('rejects a non-UUID principal id', () => {
    expect(() =>
      loadConfig({ ...baseEnv, DWARF_ADMIN_PRINCIPAL_ID: 'not-a-uuid' }),
    ).toThrow();
  });
});
