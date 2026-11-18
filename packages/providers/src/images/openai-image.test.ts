import { describe, expect, it, vi } from 'vitest';
import { OPENAI_DEFAULT_COVER_MODEL } from '@liedmotif/shared';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import { GeneratedImageProviderError, type GeneratedImageRequest } from './generated';
import { openAiImageProvider } from './openai-image';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');
const SECRET = 'sk-proj-test-secret';
const PROMPT = 'specific private prompt';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function request(overrides: Partial<GeneratedImageRequest> = {}): GeneratedImageRequest {
  return {
    purpose: 'session-cover',
    positivePrompt: PROMPT,
    exclusions: ['logos', 'watermarks'],
    target: { shape: 'square', quality: 'high' },
    references: [],
    idempotencyKey: 'session-cover:session-1:v1',
    seed: 42,
    count: 1,
    ...overrides,
  };
}

function adapter(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return openAiImageProvider({ apiKey: SECRET, fetch: fetchImpl, ...overrides });
}

function sent(fetchImpl: ReturnType<typeof vi.fn>, call = 0) {
  const [url, init] = fetchImpl.mock.calls[call]! as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
}

describe('OpenAI generated-image adapter', () => {
  it('generates one square 1024px image at high quality from the prompt alone', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));

    const result = await adapter(fetchImpl as unknown as typeof fetch).generate(request());

    const { url, init, body } = sent(fetchImpl);
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(init.redirect).toBe('manual');
    expect(body).toEqual({
      model: OPENAI_DEFAULT_COVER_MODEL,
      prompt: `${PROMPT}\n\nExclude: logos; watermarks.`,
      size: '1024x1024',
      quality: 'high',
      n: 1,
    });
    expect(result).toMatchObject({
      provider: { providerType: 'image', providerKey: 'openai', model: OPENAI_DEFAULT_COVER_MODEL },
      bytes: PNG_BYTES,
      mediaType: 'image/png',
      appliedControls: {
        exclusions: 'inline',
        square: 'native',
        references: 0,
        seed: false,
        idempotency: 'absent',
        candidateCount: 1,
      },
    });
    expect(result.reportedCostUsd).toBeUndefined();
    expect(result.downgradeCodes).toEqual(
      expect.arrayContaining(['exclusions_inlined', 'seed_omitted', 'idempotency_unavailable']),
    );
  });

  it('edits with the reference photos attached in the order given', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const ordered = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];

    const result = await adapter(fetchImpl as unknown as typeof fetch).generate(
      request({
        references: [
          { id: 'person-1', role: 'subject', mediaType: 'image/webp', bytes: ordered[0]! },
          { id: 'person-2', role: 'subject', mediaType: 'image/jpeg', bytes: ordered[1]! },
          { id: 'style-1', role: 'style', mediaType: 'image/png', bytes: ordered[2]! },
        ],
      }),
    );

    const { url, body } = sent(fetchImpl);
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    expect(body).toMatchObject({ model: OPENAI_DEFAULT_COVER_MODEL, size: '1024x1024', n: 1 });
    expect(body.images).toEqual([
      { image_url: `data:image/webp;base64,${Buffer.from(ordered[0]!).toString('base64')}` },
      { image_url: `data:image/jpeg;base64,${Buffer.from(ordered[1]!).toString('base64')}` },
      { image_url: `data:image/png;base64,${Buffer.from(ordered[2]!).toString('base64')}` },
    ]);
    expect(result.appliedControls.references).toBe(3);
    expect(result.downgradeCodes).not.toContain('references_omitted');
  });

  it('sends standard quality as medium, never auto, and uses a configured model', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));

    await adapter(fetchImpl as unknown as typeof fetch, {
      model: ' gpt-image-2.5-flare ',
    }).generate(request({ target: { shape: 'square', quality: 'standard' }, exclusions: [] }));

    expect(sent(fetchImpl).body).toEqual({
      model: 'gpt-image-2.5-flare',
      prompt: PROMPT,
      size: '1024x1024',
      quality: 'medium',
      n: 1,
    });
  });

  it('declares inline exclusions, no seed, idempotency or cost, and references without multi-subject identity', async () => {
    const fetchImpl = vi.fn();
    const capabilities = await adapter(fetchImpl as unknown as typeof fetch).getCapabilities();

    expect(capabilities).toMatchObject({
      provider: { providerType: 'image', providerKey: 'openai', model: OPENAI_DEFAULT_COVER_MODEL },
      exclusions: 'inline',
      nativeSeed: false,
      idempotency: 'absent',
      squareOutput: 'native',
      maxCandidates: 1,
      costReporting: false,
      references: {
        roles: ['subject', 'style'],
        multiSubjectIdentity: false,
        mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
      },
    });
    expect(capabilities.references!.maxCount).toBeGreaterThan(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits a reference over the per-photo byte cap and says so', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const provider = adapter(fetchImpl as unknown as typeof fetch);
    const cap = (await provider.getCapabilities()).references!.maxBytesPerReference!;

    const result = await provider.generate(
      request({
        references: [
          { id: 'huge', role: 'subject', mediaType: 'image/png', bytes: new Uint8Array(cap + 1) },
        ],
      }),
    );

    expect(sent(fetchImpl).url).toBe('https://api.openai.com/v1/images/generations');
    expect(result.appliedControls.references).toBe(0);
    expect(result.downgradeCodes).toContain('references_omitted');
  });

  it('bounds the references it sends in total, not just per photo', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const provider = adapter(fetchImpl as unknown as typeof fetch);
    const limits = (await provider.getCapabilities()).references!;
    const total = limits.maxTotalBytes!;
    const perPhoto = limits.maxBytesPerReference!;
    expect(total).toBeLessThan(limits.maxCount * perPhoto);
    const photos = Array.from({ length: Math.ceil(total / perPhoto) + 1 }, (_, index) => ({
      id: `photo-${index}`,
      role: 'subject' as const,
      mediaType: 'image/webp' as const,
      bytes: new Uint8Array(perPhoto),
    }));

    const result = await provider.generate(request({ references: photos }));

    const sentBytes = (sent(fetchImpl).body.images as unknown[]).length * perPhoto;
    expect(sentBytes).toBeLessThanOrEqual(total);
    expect(result.downgradeCodes).toContain('references_omitted');
  });

  it.each([
    [401, 'configuration', 'not_started'],
    [403, 'configuration', 'not_started'],
    [404, 'configuration', 'not_started'],
    [400, 'rejection', 'not_started'],
    [429, 'rate_limit', 'not_started'],
    [500, 'unavailable', 'outcome_unknown'],
    [503, 'unavailable', 'outcome_unknown'],
    [504, 'timeout', 'outcome_unknown'],
  ] as const)(
    'classifies HTTP %s without leaking the key, prompt, photo or reply',
    async (status, kind, disposition) => {
      const photo = new Uint8Array([9, 8, 7, 6]);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(`raw body ${SECRET} ${PROMPT} https://x?token=secret`, { status }),
        );

      const failure = await adapter(fetchImpl as unknown as typeof fetch)
        .generate(
          request({
            references: [{ id: 'p', role: 'subject', mediaType: 'image/png', bytes: photo }],
          }),
        )
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GeneratedImageProviderError);
      expect(failure).toMatchObject({ kind, submissionDisposition: disposition });
      const serialized = `${(failure as Error).message} ${JSON.stringify(failure)}`;
      for (const secret of [SECRET, PROMPT, 'raw body', 'token=secret']) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toContain(Buffer.from(photo).toString('base64'));
    },
  );

  it('classifies a timeout and a dropped connection as outcome unknown', async () => {
    const timeout = Object.assign(new Error(`timeout ${SECRET}`), { name: 'TimeoutError' });
    const timedOut = vi.fn().mockRejectedValueOnce(timeout);
    const dropped = vi.fn().mockRejectedValueOnce(new TypeError(`socket ${SECRET}`));

    await expect(
      adapter(timedOut as unknown as typeof fetch).generate(request()),
    ).rejects.toMatchObject({
      kind: 'timeout',
      submissionDisposition: 'outcome_unknown',
      message: 'Generated image request timed out.',
    });
    await expect(
      adapter(dropped as unknown as typeof fetch).generate(request()),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      submissionDisposition: 'outcome_unknown',
      message: 'Generated image provider is unavailable.',
    });
  });

  it('classifies a malformed or imageless success as an invalid response', async () => {
    for (const reply of [
      json({ data: [] }),
      json({ data: [{ url: 'https://example.com/image.png' }] }),
      new Response('not json', { status: 200 }),
    ]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(reply);
      await expect(
        adapter(fetchImpl as unknown as typeof fetch).generate(request()),
      ).rejects.toMatchObject({
        kind: 'invalid_response',
        submissionDisposition: 'outcome_unknown',
      });
    }
  });

  it('refuses a host that resolves to a private address before anything is sent', async () => {
    const guarded = pinnedProviderFetch({
      providerKey: 'openai',
      resolve: async () => ['169.254.169.254'],
    });

    await expect(adapter(guarded).generate(request())).rejects.toMatchObject({
      kind: 'configuration',
      submissionDisposition: 'not_started',
    });
  });

  it('rejects a blank key and any candidate count but one before network access', async () => {
    expect(() => openAiImageProvider({ apiKey: '  ' })).toThrow(GeneratedImageProviderError);
    const fetchImpl = vi.fn();
    await expect(
      adapter(fetchImpl as unknown as typeof fetch).generate(request({ count: 2 as 1 })),
    ).rejects.toMatchObject({ kind: 'configuration', submissionDisposition: 'not_started' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails before submission when the prompt exceeds OpenAI’s limit', async () => {
    const fetchImpl = vi.fn();
    await expect(
      adapter(fetchImpl as unknown as typeof fetch).generate(
        request({ positivePrompt: 'x'.repeat(32_001), exclusions: [] }),
      ),
    ).rejects.toMatchObject({ kind: 'rejection', submissionDisposition: 'not_started' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never logs the key, prompt or photo bytes', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const photo = new Uint8Array([5, 4, 3, 2]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(`raw ${SECRET} ${PROMPT}`, { status: 502 }));

    await adapter(fetchImpl as unknown as typeof fetch)
      .generate(
        request({
          references: [{ id: 'p', role: 'subject', mediaType: 'image/png', bytes: photo }],
        }),
      )
      .catch(() => undefined);

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PROMPT);
    expect(logged).not.toContain(Buffer.from(photo).toString('base64'));
    for (const spy of spies) spy.mockRestore();
  });

  it('validates the key and model with a free model lookup', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith(`/models/${OPENAI_DEFAULT_COVER_MODEL}`)
        ? json({ id: OPENAI_DEFAULT_COVER_MODEL, object: 'model' })
        : json({}, 404),
    );
    await expect(
      adapter(fetchImpl as unknown as typeof fetch).validateCredentials(),
    ).resolves.toEqual({
      ok: true,
      message: 'Image provider credentials and endpoint look valid.',
    });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.openai.com/v1/models/${OPENAI_DEFAULT_COVER_MODEL}`);
    expect(init.method ?? 'GET').toBe('GET');

    const refused = vi.fn().mockResolvedValueOnce(json({ error: { message: SECRET } }, 401));
    const outcome = await adapter(refused as unknown as typeof fetch).validateCredentials();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).not.toContain(SECRET);
  });
});
