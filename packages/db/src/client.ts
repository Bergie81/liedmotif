// Typed Drizzle client factory, shared by web and worker.
//
// Each process owns exactly one `pg.Pool` (see `createPool`) and wraps it with
// `createDb` to get a schema-typed Drizzle instance. Web and worker are separate
// processes and therefore keep separate pools — they pass their own pool in here;
// this module never creates or caches a pool of its own.

import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema';

/** The full Drizzle schema object (Better Auth tables and app tables). */
export type Schema = typeof schema;

/** A schema-typed Drizzle database handle backed by a `pg.Pool`. */
export type Database = NodePgDatabase<Schema>;

/** Wrap a process-owned `pg.Pool` in a schema-typed Drizzle client. */
export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}

/**
 * Drizzle-level connectivity check (`select 1`). Distinct from the pg-level
 * `ping`: this proves the typed client itself can round-trip a query, which is
 * what web route handlers and worker jobs actually use.
 */
export async function pingDb(db: Database): Promise<boolean> {
  const result = (await db.execute(sql`select 1 as ok`)) as { rows?: Array<{ ok?: number }> };
  return result.rows?.[0]?.ok === 1;
}
