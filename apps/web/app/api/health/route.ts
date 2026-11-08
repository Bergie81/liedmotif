import { NextResponse } from 'next/server';
import { ping } from '@liedmotif/db';
import { createLogger } from '@liedmotif/shared';
import { getPool } from '@/lib/db';

const log = createLogger({ name: 'web' });

// Liveness + database connectivity. The healthcheck DOES gate on Postgres
// reachability: this route returns 200 only when the database is reachable, else
// 503. The Docker healthcheck's `r.ok` check therefore marks web healthy only
// when it can reach Postgres; the compose `retries`/`start_period` window absorbs
// transient blips so a momentary hiccup doesn't flap the container.
export const dynamic = 'force-dynamic';

export async function GET() {
  let database = false;
  try {
    database = await ping(getPool());
  } catch (err) {
    log.error('health check could not reach database', { err });
  }

  return NextResponse.json(
    {
      status: database ? 'ok' : 'unavailable',
      database,
      time: new Date().toISOString(),
    },
    { status: database ? 200 : 503 },
  );
}
