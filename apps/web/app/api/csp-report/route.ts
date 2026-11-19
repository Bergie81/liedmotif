// The `report-uri` sink both policy copies point at (see `next.config.mjs` and
// the Caddyfile). An enforcing CSP with nowhere to report is undiagnosable: the
// browser blocks something, the page half-works, and nothing says which
// directive fired. This writes the violation to the app log and answers empty —
// it stores nothing and returns no body a page could read.

import { NextResponse } from 'next/server';
import { createLogger } from '@liedmotif/shared';
import { apiError, apiRateLimited, readJsonBody, refuseCrossOrigin } from '@/lib/http/api-response';
import { readCspViolation } from '@/lib/http/csp-report';
import { clientIp } from '@/lib/http/http';
import { cspReportLimiter } from '@/lib/http/request-limits';

export const dynamic = 'force-dynamic';

const log = createLogger({ name: 'csp' });

/** A violation document is a few hundred bytes; this ceiling protects the heap. */
const MAX_REPORT_BYTES = 32 * 1024;

export async function POST(request: Request) {
  // Browsers differ in what they attach to a report post — the document's
  // origin, an opaque `null`, or no `Origin` at all — and a refusal here is
  // indistinguishable from a policy that never fires, which is the exact failure
  // this endpoint exists to end. So an opaque origin passes alongside the absent
  // one; a page that names another site is still refused.
  if (request.headers.get('origin') !== 'null') {
    const crossOrigin = refuseCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
  }

  const limit = cspReportLimiter.check(clientIp(request));
  if (!limit.allowed) return apiRateLimited(limit.retryAfterMs);

  const body = await readJsonBody(request, MAX_REPORT_BYTES);
  if (!body.ok && body.tooLarge) {
    return apiError('validation_error', 'The violation report is too large.', { status: 413 });
  }

  // A body that is not JSON and a body that is not a violation document are the
  // same refusal — neither says anything a policy author could act on.
  const violation = body.ok ? readCspViolation(body.value) : null;
  if (!violation) return apiError('validation_error', 'Invalid violation report.');

  log.warn('csp violation reported', violation);
  return new NextResponse(null, { status: 204 });
}
