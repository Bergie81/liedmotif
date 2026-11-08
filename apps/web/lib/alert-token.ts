// The gate on `GET /api/alerts/check` (server-only). The route triggers outbound
// messages, so `ALERT_CHECK_TOKEN` is the feature's switch: unset, the route
// answers 404 and nothing is sent. Neither the configured token nor a presented
// one is logged or echoed anywhere.

import { NextResponse } from 'next/server';
import { ALERT_TOKEN_HEADER } from '@/lib/constants';
import { alertCheckToken } from '@/lib/env';
import { requestCarriesToken } from '@/lib/token-compare';

/**
 * The refusal the check route must return, or null when the request may proceed.
 * One response covers a missing and a wrong token, so nothing confirms that a
 * guess got closer.
 */
export function alertTokenRefusal(request: Request): NextResponse | null {
  const configured = alertCheckToken();
  if (!configured) return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 });
  if (requestCarriesToken(request, ALERT_TOKEN_HEADER, configured)) return null;
  return NextResponse.json({ ok: false, error: 'Not available.' }, { status: 403 });
}
