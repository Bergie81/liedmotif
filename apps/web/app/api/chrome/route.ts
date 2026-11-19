// `GET /api/chrome` → getChrome (Member-or-Admin, SAFE status only).
//
// The app shell's per-navigation refetch: exactly the `{ usage, activeSession }`
// slice the chrome consumes, without the admin-only worker diagnostics that
// `/api/diagnostics` assembles for the settings page. Member-accessible — a
// Member's usage chrome refreshes like the Admin's.

import { NextResponse } from 'next/server';
import { apiOk, requireOwnerId } from '@/lib/http/api-response';
import { loadAppChrome } from '@/lib/app-chrome';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  return apiOk(await loadAppChrome(getDb(), ownerUserId));
}
