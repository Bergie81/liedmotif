// `GET /api/settings/cost-comparison?range=7d|30d|all` → the Admin's estimated
// cost comparison. Admin-only: money is never a Member surface, and
// the payload is counts per payer — nothing of anyone's music or listening.

import { NextResponse } from 'next/server';
import { costComparisonQuerySchema } from '@liedmotif/shared';
import { apiOk, requireAdminOwnerId, validateInput } from '@/lib/http/api-response';
import { loadCostComparison } from '@/lib/stats/cost-comparison-data';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const adminUserId = await requireAdminOwnerId(request);
  if (adminUserId instanceof NextResponse) return adminUserId;

  const range = new URL(request.url).searchParams.get('range');
  const query = validateInput(
    costComparisonQuerySchema,
    range === null ? {} : { range },
    'Invalid cost range.',
  );
  if (query instanceof NextResponse) return query;

  return apiOk(await loadCostComparison(adminUserId, query.range));
}
