// The one client-side wrapper for routes speaking the shared `apiResponse`
// envelope (`{ ok: true, data } | { ok: false, error }`). Never throws: every
// outcome — transport failure included — lands in the same discriminated
// result, and the HTTP status rides along for the few callers that word 429s
// specially.

import { isOnline, reportServerAnswered, reportServerUnreachable } from '@/lib/online-state';

export type ApiFetchResult<T> =
  { ok: true; data: T } | { ok: false; status: number; message: string };

/** Why an action that needs the server was refused without a request. */
export const OFFLINE_MESSAGE = "You're offline. This needs a connection.";

export async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<ApiFetchResult<T>> {
  // Listen-only while offline: an action is refused here, never queued.
  if ((init.method ?? 'GET').toUpperCase() !== 'GET' && !isOnline()) {
    return { ok: false, status: 0, message: OFFLINE_MESSAGE };
  }
  try {
    const response = await fetch(url, init);
    reportServerAnswered();
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      data?: T;
      error?: { message?: string };
    } | null;
    if (response.ok && body?.ok) return { ok: true, data: body.data as T };
    return {
      ok: false,
      status: response.status,
      message: body?.error?.message ?? 'Request failed. Try again.',
    };
  } catch {
    if (!init.signal?.aborted) reportServerUnreachable();
    return { ok: false, status: 0, message: 'Could not reach the server. Try again.' };
  }
}

/** `apiFetch` with a JSON body — the shape every mutation call here takes. */
export function apiFetchJson<T>(
  url: string,
  method: string,
  payload: unknown,
): Promise<ApiFetchResult<T>> {
  return apiFetch<T>(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
