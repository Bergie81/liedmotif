import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderEgressError } from '../errors';
import { fetchProviderMedia, resetEgressVerdictCacheForTests } from './egress';
import type { ResolveHostAddresses } from './ssrf';

// The guard between provider-RETURNED media URLs and any server-side fetch:
// http(s) only, no private/metadata hosts (literal or resolved), and every
// redirect hop re-validated. DNS and fetch are injected — zero network.

const publicResolve: ResolveHostAddresses = async () => ['93.184.216.34'];

// The verdict memo is module-level; hostnames recur across these tests.
beforeEach(() => {
  resetEgressVerdictCacheForTests();
  vi.unstubAllEnvs();
});

function fetchReturning(...responses: Response[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => queue.shift()!) as unknown as typeof fetch;
}

const ok = () => new Response('bytes', { status: 200 });
const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

describe('fetchProviderMedia — URL validation', () => {
  it('fetches an allowed public URL and returns the response', async () => {
    const fetchImpl = fetchReturning(ok());
    const res = await fetchProviderMedia('https://cdn.example/a.mp3', {
      fetchImpl,
      resolve: publicResolve,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.example/a.mp3',
      expect.objectContaining({ redirect: 'manual' }),
      ['93.184.216.34'],
    );
  });

  it('hands the transport the vetted addresses so the fetch cannot re-resolve', async () => {
    // The rebinding window: whatever the hostname resolves
    // to at connect time, only these addresses may be dialed.
    const fetchImpl = fetchReturning(ok());
    await fetchProviderMedia('https://cdn.example/a.mp3', {
      fetchImpl,
      resolve: async () => ['93.184.216.34', '2606:2800:220:1::1'],
    });
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toEqual([
      '93.184.216.34',
      '2606:2800:220:1::1',
    ]);
  });

  it('rejects plaintext http media unless the escape hatch is set', async () => {
    // Provider media becomes a stored track: on http a network MITM chooses
    // those bytes, and a stored-XSS payload rides the same response.
    const fetchImpl = fetchReturning(ok());
    await expect(
      fetchProviderMedia('http://cdn.example/a.mp3', { fetchImpl, resolve: publicResolve }),
    ).rejects.toThrow(ProviderEgressError);
    expect(fetchImpl).not.toHaveBeenCalled();

    vi.stubEnv('ALLOW_INSECURE_PROVIDER_MEDIA', '1');
    const allowed = await fetchProviderMedia('http://cdn.example/a.mp3', {
      fetchImpl: fetchReturning(ok()),
      resolve: publicResolve,
    });
    expect(allowed.status).toBe(200);
  });

  it('rejects an https URL that redirects down to plaintext http', async () => {
    const fetchImpl = fetchReturning(redirectTo('http://cdn.example/downgraded.mp3'));
    await expect(
      fetchProviderMedia('https://cdn.example/a.mp3', { fetchImpl, resolve: publicResolve }),
    ).rejects.toThrow(ProviderEgressError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects non-http(s) and unparseable URLs without fetching', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://cdn.example/a', 'not a url']) {
      const fetchImpl = fetchReturning();
      await expect(fetchProviderMedia(url, { fetchImpl, resolve: publicResolve })).rejects.toThrow(
        ProviderEgressError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('rejects private/metadata hosts, literal or resolved, without fetching', async () => {
    const fetchImpl = fetchReturning();
    await expect(
      fetchProviderMedia('https://169.254.169.254/latest/meta-data', {
        fetchImpl,
        resolve: publicResolve,
      }),
    ).rejects.toThrow(ProviderEgressError);
    await expect(
      fetchProviderMedia('https://rebind.example/a.mp3', {
        fetchImpl,
        resolve: async () => ['10.0.0.5'],
      }),
    ).rejects.toThrow(ProviderEgressError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never echoes the media URL in the sanitized error', async () => {
    const err = await fetchProviderMedia('https://127.0.0.1/signed?token=SECRET', {
      fetchImpl: fetchReturning(),
      resolve: publicResolve,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderEgressError);
    expect((err as Error).message).not.toContain('SECRET');
    expect((err as Error).message).not.toContain('127.0.0.1');
  });
});

describe('fetchProviderMedia — redirect handling', () => {
  it('follows redirects, re-validating each hop (relative Locations resolve)', async () => {
    const fetchImpl = fetchReturning(redirectTo('/moved/a.mp3', 301), ok());
    const res = await fetchProviderMedia('https://cdn.example/a.mp3', {
      fetchImpl,
      resolve: publicResolve,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example/moved/a.mp3',
      { redirect: 'manual' },
      ['93.184.216.34'],
    );
  });

  it('re-pins on a cross-host redirect instead of reusing the first hop addresses', async () => {
    const fetchImpl = fetchReturning(redirectTo('https://other-cdn.example/b.mp3'), ok());
    await fetchProviderMedia('https://cdn.example/a.mp3', {
      fetchImpl,
      resolve: async (hostname) =>
        hostname === 'cdn.example' ? ['93.184.216.34'] : ['198.51.101.7'],
    });
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![2]).toEqual(['93.184.216.34']);
    expect(calls[1]![2]).toEqual(['198.51.101.7']);
  });

  it('rejects a redirect that targets a private host', async () => {
    const fetchImpl = fetchReturning(redirectTo('https://192.168.1.10/internal'));
    await expect(
      fetchProviderMedia('https://cdn.example/a.mp3', { fetchImpl, resolve: publicResolve }),
    ).rejects.toThrow(ProviderEgressError);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never fetched the private target
  });

  it('gives up after the redirect budget and on a redirect without Location', async () => {
    const loops = Array.from({ length: 7 }, () => redirectTo('https://cdn.example/loop'));
    await expect(
      fetchProviderMedia('https://cdn.example/a.mp3', {
        fetchImpl: fetchReturning(...loops),
        resolve: publicResolve,
      }),
    ).rejects.toThrow(ProviderEgressError);

    await expect(
      fetchProviderMedia('https://cdn.example/a.mp3', {
        fetchImpl: fetchReturning(new Response(null, { status: 302 })),
        resolve: publicResolve,
      }),
    ).rejects.toThrow(ProviderEgressError);
  });

  it('forwards headers and signal to every hop', async () => {
    const fetchImpl = fetchReturning(redirectTo('https://cdn.example/b.mp3'), ok());
    const controller = new AbortController();
    await fetchProviderMedia('https://cdn.example/a.mp3', {
      fetchImpl,
      resolve: publicResolve,
      headers: { Range: 'bytes=0-9' },
      signal: controller.signal,
    });
    for (const call of (fetchImpl as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toMatchObject({
        redirect: 'manual',
        headers: { Range: 'bytes=0-9' },
        signal: controller.signal,
      });
    }
  });

  it('returns non-redirect upstream errors to the caller instead of throwing', async () => {
    const res = await fetchProviderMedia('https://cdn.example/a.mp3', {
      fetchImpl: fetchReturning(new Response(null, { status: 416 })),
      resolve: publicResolve,
    });
    expect(res.status).toBe(416);
  });

  it('memoizes resolver verdicts within the TTL and re-resolves after it', async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn(publicResolve);
      const fetchTwice = () =>
        fetchProviderMedia('https://cdn.example/a.mp3', {
          fetchImpl: fetchReturning(ok()),
          resolve,
        });
      await fetchTwice();
      await fetchTwice();
      expect(resolve).toHaveBeenCalledTimes(1);

      // The memo must never outlive its TTL (30 s).
      vi.advanceTimersByTime(30_001);
      await fetchTwice();
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a blocked verdict served from the memo still blocks', async () => {
    const resolve = vi.fn(async () => ['10.0.0.5']);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        fetchProviderMedia('https://rebound.example/a.mp3', {
          fetchImpl: fetchReturning(),
          resolve,
        }),
      ).rejects.toThrow(ProviderEgressError);
    }
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('never memoizes a resolver failure — the next fetch resolves again', async () => {
    const resolve = vi
      .fn<ResolveHostAddresses>()
      .mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN'))
      .mockImplementation(publicResolve);
    const fetchOnce = () =>
      fetchProviderMedia('https://cdn.example/a.mp3', { fetchImpl: fetchReturning(ok()), resolve });
    await expect(fetchOnce()).rejects.toThrow(ProviderEgressError);
    expect((await fetchOnce()).status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('aborts a stalled DNS resolution via the signal (no fetch, caller not pinned)', async () => {
    // `node:dns` lookups take no signal — the guard must not out-wait the caller's
    // own timeout when a hostname is delegated to dead nameservers.
    const stalledResolve: ResolveHostAddresses = () => new Promise(() => {});
    const fetchImpl = fetchReturning();
    const controller = new AbortController();

    const pending = fetchProviderMedia('https://cdn.example/a.mp3', {
      fetchImpl,
      resolve: stalledResolve,
      signal: controller.signal,
    });
    controller.abort(new Error('header timeout'));

    await expect(pending).rejects.toThrow('header timeout');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
