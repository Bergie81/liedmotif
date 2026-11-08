import { describe, expect, it } from 'vitest';
import { createDb, createPool } from './index';

// Offline check: building the client wraps a pool without opening a connection.
describe('createDb', () => {
  it('wraps a pool in a schema-typed Drizzle client', async () => {
    const pool = createPool('postgres://u:p@localhost:5432/db');
    try {
      const db = createDb(pool);
      expect(typeof db.transaction).toBe('function');
      // Relational query API is keyed by the bound schema's table exports.
      expect(db.query).toHaveProperty('user');
      expect(db.query).toHaveProperty('session');
    } finally {
      await pool.end();
    }
  });
});
