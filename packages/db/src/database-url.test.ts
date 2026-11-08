// Pure unit tests (no database) for the database-name safety guards — the
// app-side half of the app/test DB split.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertNotTestDatabase, databaseNameOf, isTestDatabaseUrl } from './database-url';

describe('databaseNameOf', () => {
  it('extracts the database name from a connection URL', () => {
    expect(databaseNameOf('postgres://u:p@localhost:5433/liedmotif_dev')).toBe('liedmotif_dev');
  });

  it('percent-decodes the database name', () => {
    expect(databaseNameOf('postgres://u:p@localhost:5433/liedmotif_t%65st')).toBe('liedmotif_test');
  });

  it('returns undefined when the URL has no database path', () => {
    expect(databaseNameOf('postgres://u:p@localhost:5433')).toBeUndefined();
    expect(databaseNameOf('postgres://u:p@localhost:5433/')).toBeUndefined();
  });

  it('returns undefined for non-URL connection strings', () => {
    expect(databaseNameOf('host=localhost dbname=liedmotif')).toBeUndefined();
    expect(databaseNameOf('')).toBeUndefined();
  });
});

describe('isTestDatabaseUrl', () => {
  it('is true when the database name contains "test", case-insensitively', () => {
    expect(isTestDatabaseUrl('postgres://u:p@localhost:5433/liedmotif_test')).toBe(true);
    expect(isTestDatabaseUrl('postgres://u:p@localhost:5433/LIEDMOTIF_TEST')).toBe(true);
    expect(isTestDatabaseUrl('postgres://u:p@localhost:5433/testdata')).toBe(true);
    expect(isTestDatabaseUrl('postgres://u:p@localhost:5433/liedmotif_t%65st')).toBe(true);
  });

  it('is false for non-test names and unparseable strings', () => {
    expect(isTestDatabaseUrl('postgres://u:p@localhost:5433/liedmotif_dev')).toBe(false);
    expect(isTestDatabaseUrl('host=localhost dbname=liedmotif_test')).toBe(false);
  });
});

describe('assertNotTestDatabase', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when the app database name contains "test", including percent-encoded', () => {
    expect(() =>
      assertNotTestDatabase('postgres://u:p@localhost:5433/liedmotif_test'),
    ).toThrowError(/Refusing to use database "liedmotif_test"/);
    expect(() =>
      assertNotTestDatabase('postgres://u:p@localhost:5433/liedmotif_t%65st'),
    ).toThrowError(/Refusing to use database "liedmotif_test"/);
  });

  it('allows non-test database names', () => {
    expect(() =>
      assertNotTestDatabase('postgres://u:p@localhost:5433/liedmotif_dev'),
    ).not.toThrow();
    expect(() => assertNotTestDatabase('postgres://u:p@postgres:5432/liedmotif')).not.toThrow();
  });

  it('rejects non-empty values whose database name cannot be determined', () => {
    expect(() => assertNotTestDatabase('host=localhost dbname=liedmotif_test')).toThrowError(
      /Could not determine the database name/,
    );
    expect(() => assertNotTestDatabase('postgres://u:p@localhost:5433/')).toThrowError(
      /Could not determine the database name/,
    );
  });

  it('passes empty values through (presence is validated by callers)', () => {
    expect(() => assertNotTestDatabase('')).not.toThrow();
  });

  it('allows exactly the database named by LIEDMOTIF_ALLOW_TEST_DATABASE (the e2e opt-out)', () => {
    vi.stubEnv('LIEDMOTIF_ALLOW_TEST_DATABASE', 'liedmotif_test');
    expect(() =>
      assertNotTestDatabase('postgres://u:p@localhost:5433/liedmotif_test'),
    ).not.toThrow();
    expect(() => assertNotTestDatabase('postgres://u:p@localhost:5433/other_test')).toThrowError(
      /Refusing to use database "other_test"/,
    );
  });

  it('is not a kill-switch: a stray =1 opens nothing, and unparseable values stay rejected', () => {
    vi.stubEnv('LIEDMOTIF_ALLOW_TEST_DATABASE', '1');
    expect(() =>
      assertNotTestDatabase('postgres://u:p@localhost:5433/liedmotif_test'),
    ).toThrowError(/Refusing to use database "liedmotif_test"/);
    vi.stubEnv('LIEDMOTIF_ALLOW_TEST_DATABASE', 'liedmotif_test');
    expect(() => assertNotTestDatabase('host=localhost dbname=liedmotif_test')).toThrowError(
      /Could not determine the database name/,
    );
  });
});
