// `GET /api/listening/stats?range=7d|30d|all` → the caller's own listening stats.
// Owner-scoped for every role: the Admin reads only their own, like any Member.

import { NextResponse } from 'next/server';
import { listeningStatsQuerySchema } from '@liedmotif/shared';
import { apiOk, requireOwnerId, validateInput } from '@/lib/api-response';
import { loadListeningStats } from '@/lib/listening-stats-data';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const range = new URL(request.url).searchParams.get('range');
  const query = validateInput(
    listeningStatsQuerySchema,
    range === null ? {} : { range },
    'Invalid stats range.',
  );
  if (query instanceof NextResponse) return query;

  return apiOk(await loadListeningStats(ownerUserId, query.range));
}
