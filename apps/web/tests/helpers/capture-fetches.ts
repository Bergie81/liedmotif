// jsdom fetch stub shared by the client fetch-hygiene tests: every call is
// captured as a pending request the test settles explicitly, with the request's
// AbortSignal exposed so cancellation of superseded fetches is observable.

import { vi } from 'vitest';

export interface PendingRequest {
  path: string;
  signal: AbortSignal | undefined;
  respond(body: unknown): void;
}

export function captureFetches(): PendingRequest[] {
  const requests: PendingRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (path: string, init?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          requests.push({
            path,
            signal: init?.signal,
            respond: (body) => resolve({ json: async () => body }),
          });
        }),
    ),
  );
  return requests;
}
