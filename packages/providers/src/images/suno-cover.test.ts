import { describe, expect, it, vi } from 'vitest';
import {
  GeneratedImageProviderError,
  type GeneratedImageRequest,
} from './generated-image-contract';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import { sunoCoverImageProvider } from './suno-cover';

const SECRET = 'suno-test-secret';
const MUSIC_TASK_ID = 'music-task-1';
const COVER_TASK_ID = 'cover-task-9';
const IMAGE_URL = 'https://tempfile.example.com/covers/one.png';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Public-address resolver so the egress guard passes for fake test hosts. */
const publicResolve = async () => ['93.184.216.34'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pngResponse(): Response {
  return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
}

function request(overrides: Partial<GeneratedImageRequest> = {}): GeneratedImageRequest {
  return {
    purpose: 'session-cover',
    positivePrompt: 'ignored prompt',
    exclusions: [],
    target: { shape: 'square', quality: 'high' },
    references: [],
    idempotencyKey: 'session-cover:session-1:v1',
    count: 1,
    musicTaskId: MUSIC_TASK_ID,
    ...overrides,
  };
}

function adapter(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return sunoCoverImageProvider({
    apiKey: SECRET,
    fetch: fetchImpl,
    // The image download goes through the egress guard's pinned transport in
    // production; tests route it back to the one stub.
    fetchMedia: fetchImpl,
    resolveHostAddresses: publicResolve,
    sleep: async () => undefined,
    ...overrides,
  });
}

async function expectProviderError(
  promise: Promise<unknown>,
  kind: string,
  disposition: string,
): Promise<void> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(GeneratedImageProviderError);
  const known = error as GeneratedImageProviderError;
  expect(known.kind).toBe(kind);
  expect(known.submissionDisposition).toBe(disposition);
}

describe('suno cover-image adapter', () => {
  it('declares a music-task-driven capability profile', async () => {
    const provider = adapter(vi.fn() as unknown as typeof fetch);
    const capabilities = await provider.getCapabilities();
    expect(capabilities.musicTaskSource).toEqual({ musicProviderKey: 'suno' });
    expect(capabilities.idempotency).toBe('recoverable');
    expect(capabilities.references).toBeNull();
    expect(capabilities.squareOutput).toBe('local_crop');
    expect(capabilities.costReporting).toBe(false);
    expect(capabilities.provider.providerKey).toBe('suno-cover');
  });

  it('submits the music task, polls to success, and downloads the first image', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/v1/suno/cover/generate')) {
        return json({ code: 200, msg: 'ok', data: { taskId: COVER_TASK_ID } });
      }
      if (url.includes('/api/v1/suno/cover/record-info')) {
        // First poll still pending, second poll done.
        const pending = calls.filter((c) => c.url.includes('record-info')).length === 1;
        return pending
          ? json({ code: 200, msg: 'ok', data: { taskId: COVER_TASK_ID, successFlag: 2 } })
          : json({
              code: 200,
              msg: 'ok',
              data: {
                taskId: COVER_TASK_ID,
                successFlag: 1,
                response: { images: [IMAGE_URL, 'https://tempfile.example.com/two.png'] },
              },
            });
      }
      if (url === IMAGE_URL) return pngResponse();
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const provider = adapter(fetchImpl);
    const result = await provider.generate(request());

    expect(result.bytes).toEqual(PNG_BYTES);
    expect(result.mediaType).toBe('image/png');
    expect(result.operationId).toBe(COVER_TASK_ID);
    expect(result.reportedCostUsd).toBeUndefined();
    expect(result.appliedControls).toEqual({
      exclusions: 'inline',
      square: 'local_crop',
      references: 0,
      seed: false,
      idempotency: 'recoverable',
      candidateCount: 1,
    });

    const submit = calls.find((c) => c.url.endsWith('/cover/generate'))!;
    const submitBody = JSON.parse(String(submit.init?.body)) as Record<string, unknown>;
    expect(submitBody.taskId).toBe(MUSIC_TASK_ID);
    expect(typeof submitBody.callBackUrl).toBe('string');
    expect((submit.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);

    // The image host is not the API — the Bearer key must never ride along.
    const download = calls.find((c) => c.url === IMAGE_URL)!;
    const downloadHeaders = (download.init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(downloadHeaders).join(' ').toLowerCase()).not.toContain('authorization');
  });

  it('reuses the existing cover task when the provider reports a duplicate', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/cover/generate')) {
        return json(
          { code: 400, msg: 'Cover already generated', data: { taskId: COVER_TASK_ID } },
          400,
        );
      }
      if (url.includes('record-info')) {
        return json({
          code: 200,
          msg: 'ok',
          data: { taskId: COVER_TASK_ID, successFlag: 1, response: { images: [IMAGE_URL] } },
        });
      }
      return pngResponse();
    }) as unknown as typeof fetch;

    const result = await adapter(fetchImpl).generate(request());
    expect(result.operationId).toBe(COVER_TASK_ID);
    expect(result.bytes).toEqual(PNG_BYTES);
  });

  it('rejects a request without a music task before any network call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expectProviderError(
      adapter(fetchImpl).generate(request({ musicTaskId: undefined })),
      'configuration',
      'not_started',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps an insufficient-credit submit to a terminal rejection', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 402, msg: 'insufficient credits' }, 402));
    await expectProviderError(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
      'rejection',
      'not_started',
    );
  });

  it('maps an out-of-credits refusal sent under HTTP 200 to a not-started failure', async () => {
    // Nothing was created, so the attempt must not count as possibly-paid Cover spend.
    const fetchImpl = vi.fn(async () =>
      json({ code: 429, msg: 'credits insufficient', data: null }),
    );
    await expectProviderError(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
      'rate_limit',
      'not_started',
    );
  });

  it('maps a call-frequency refusal (405, 430) to a retryable rate limit', async () => {
    for (const code of [405, 430]) {
      const fetchImpl = vi.fn(async () => json({ code, msg: 'too frequent', data: null }));
      await expectProviderError(
        adapter(fetchImpl as unknown as typeof fetch).generate(request()),
        'rate_limit',
        'not_started',
      );
    }
  });

  it('maps a maintenance-window submit (455) to a retryable unavailable error', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 455, msg: 'maintenance' }, 455));
    await expectProviderError(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
      'unavailable',
      'outcome_unknown',
    );
  });

  it('maps a host whose name does not resolve to a not-started unavailable error', async () => {
    // The lookup fails before any connection, so no cover task can exist.
    const fetchImpl = pinnedProviderFetch({
      providerKey: 'suno-cover',
      resolve: async () => [],
    });
    await expectProviderError(adapter(fetchImpl).generate(request()), 'unavailable', 'not_started');
  });

  it('keeps a submit that fails in transport as possibly paid', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expectProviderError(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
      'unavailable',
      'outcome_unknown',
    );
  });

  it('maps an auth failure to a configuration error', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 401, msg: 'unauthorized' }, 401));
    await expectProviderError(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
      'configuration',
      'not_started',
    );
  });

  it('reports a failed cover generation as a terminal rejection', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/cover/generate')) {
        return json({ code: 200, msg: 'ok', data: { taskId: COVER_TASK_ID } });
      }
      return json({ code: 200, msg: 'ok', data: { taskId: COVER_TASK_ID, successFlag: 3 } });
    }) as unknown as typeof fetch;
    await expectProviderError(
      adapter(fetchImpl).generate(request()),
      'rejection',
      'outcome_unknown',
    );
  });

  it('times out a poll loop that never completes with a safely retryable error', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/cover/generate')) {
        return json({ code: 200, msg: 'ok', data: { taskId: COVER_TASK_ID } });
      }
      return json({ code: 200, msg: 'ok', data: { taskId: COVER_TASK_ID, successFlag: 0 } });
    }) as unknown as typeof fetch;
    const provider = adapter(fetchImpl, {
      pollIntervalMs: 1_000,
      maxPollMs: 3_000,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    await expectProviderError(provider.generate(request()), 'timeout', 'outcome_unknown');
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('tolerates transient poll failures and still completes', async () => {
    let polls = 0;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/cover/generate')) {
        return json({ code: 200, msg: 'ok', data: { taskId: COVER_TASK_ID } });
      }
      if (url.includes('record-info')) {
        polls += 1;
        if (polls === 1) throw new Error('flaky network');
        if (polls === 2) return new Response('oops', { status: 500 });
        return json({
          code: 200,
          msg: 'ok',
          data: { taskId: COVER_TASK_ID, successFlag: 1, response: { images: [IMAGE_URL] } },
        });
      }
      return pngResponse();
    }) as unknown as typeof fetch;
    const result = await adapter(fetchImpl).generate(request());
    expect(result.bytes).toEqual(PNG_BYTES);
  });

  it('rejects an image URL that resolves to a private host', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/cover/generate')) {
        return json({ code: 200, msg: 'ok', data: { taskId: COVER_TASK_ID } });
      }
      if (url.includes('record-info')) {
        return json({
          code: 200,
          msg: 'ok',
          data: { taskId: COVER_TASK_ID, successFlag: 1, response: { images: [IMAGE_URL] } },
        });
      }
      throw new Error('the blocked download must never be fetched');
    }) as unknown as typeof fetch;
    const provider = sunoCoverImageProvider({
      apiKey: SECRET,
      fetch: fetchImpl,
      sleep: async () => undefined,
      resolveHostAddresses: async (hostname: string) =>
        hostname.startsWith('tempfile.') ? ['10.0.0.5'] : ['93.184.216.34'],
    });
    await expectProviderError(provider.generate(request()), 'invalid_response', 'outcome_unknown');
  });

  it('maps a failing image download to an unavailable error', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/cover/generate')) {
        return json({ code: 200, msg: 'ok', data: { taskId: COVER_TASK_ID } });
      }
      if (url.includes('record-info')) {
        return json({
          code: 200,
          msg: 'ok',
          data: { taskId: COVER_TASK_ID, successFlag: 1, response: { images: [IMAGE_URL] } },
        });
      }
      return new Response('gone', { status: 404 });
    }) as unknown as typeof fetch;
    await expectProviderError(
      adapter(fetchImpl).generate(request()),
      'unavailable',
      'outcome_unknown',
    );
  });

  it('validates credentials via the credit endpoint', async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toContain('/api/v1/generate/credit');
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
      return json({ code: 200, msg: 'ok', data: 25 });
    }) as unknown as typeof fetch;
    const result = await adapter(fetchImpl).validateCredentials();
    expect(result.ok).toBe(true);
  });

  it('refuses a private base URL without any network call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = adapter(fetchImpl, { baseUrl: 'http://169.254.169.254' });
    await expectProviderError(provider.generate(request()), 'configuration', 'not_started');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
