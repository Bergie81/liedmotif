import { describe, expect, it, vi } from 'vitest';
import { GEMINI_DEFAULT_COVER_MODEL } from '@liedmotif/shared';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import { GeneratedImageProviderError, type GeneratedImageRequest } from './generated';
import { geminiImageProvider } from './gemini-image';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');
const SECRET = 'AIza-test-secret';
const PROMPT = 'specific private prompt';
const GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_DEFAULT_COVER_MODEL}:generateContent`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function imageReply(parts: unknown[] = [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]) {
  return json({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
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
  return geminiImageProvider({ apiKey: SECRET, fetch: fetchImpl, ...overrides });
}

function sent(fetchImpl: ReturnType<typeof vi.fn>, call = 0) {
  const [url, init] = fetchImpl.mock.calls[call]! as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
}

describe('Gemini generated-image adapter', () => {
  it('generates one square 1K image from the prompt alone, the key in a header', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(imageReply());

    const result = await adapter(fetchImpl as unknown as typeof fetch).generate(request());

    const { url, init, body } = sent(fetchImpl);
    expect(url).toBe(GENERATE_URL);
    expect(url).not.toContain(SECRET);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(SECRET);
    expect(headers.authorization).toBeUndefined();
    expect(init.redirect).toBe('manual');
    expect(body).toEqual({
      contents: [{ role: 'user', parts: [{ text: `${PROMPT}\n\nExclude: logos; watermarks.` }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '1:1', imageSize: '1K' },
      },
    });
    expect(result).toMatchObject({
      provider: { providerType: 'image', providerKey: 'gemini', model: GEMINI_DEFAULT_COVER_MODEL },
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

  it('sends the prompt, then each Person photo as an inline part in the order given', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(imageReply());
    const ordered = [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
      new Uint8Array([4]),
    ];

    const result = await adapter(fetchImpl as unknown as typeof fetch).generate(
      request({
        exclusions: [],
        references: [
          { id: 'person-1', role: 'subject', mediaType: 'image/webp', bytes: ordered[0]! },
          { id: 'person-2', role: 'subject', mediaType: 'image/jpeg', bytes: ordered[1]! },
          { id: 'person-3', role: 'subject', mediaType: 'image/png', bytes: ordered[2]! },
          { id: 'person-4', role: 'subject', mediaType: 'image/webp', bytes: ordered[3]! },
        ],
      }),
    );

    const { url, body } = sent(fetchImpl);
    expect(url).toBe(GENERATE_URL);
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
    expect(body.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: PROMPT },
          { inlineData: { mimeType: 'image/webp', data: b64(ordered[0]!) } },
          { inlineData: { mimeType: 'image/jpeg', data: b64(ordered[1]!) } },
          { inlineData: { mimeType: 'image/png', data: b64(ordered[2]!) } },
          { inlineData: { mimeType: 'image/webp', data: b64(ordered[3]!) } },
        ],
      },
    ]);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
    expect(result.appliedControls.references).toBe(4);
    expect(result.downgradeCodes).not.toContain('references_omitted');
  });

  it('declares inline exclusions, no seed, idempotency or cost, and four subjects with multi-subject identity', async () => {
    const fetchImpl = vi.fn();
    const capabilities = await adapter(fetchImpl as unknown as typeof fetch).getCapabilities();

    expect(capabilities).toMatchObject({
      provider: { providerType: 'image', providerKey: 'gemini', model: GEMINI_DEFAULT_COVER_MODEL },
      exclusions: 'inline',
      nativeSeed: false,
      idempotency: 'absent',
      squareOutput: 'native',
      maxCandidates: 1,
      costReporting: false,
      references: {
        roles: ['subject'],
        maxCount: 4,
        multiSubjectIdentity: true,
        mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits references past the declared count or byte caps and says so', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(imageReply());
    const provider = adapter(fetchImpl as unknown as typeof fetch);
    const limits = (await provider.getCapabilities()).references!;
    const perPhoto = limits.maxBytesPerReference!;
    expect(limits.maxTotalBytes!).toBeLessThan(limits.maxCount * perPhoto);
    const photo = (id: string, size: number) => ({
      id,
      role: 'subject' as const,
      mediaType: 'image/webp' as const,
      bytes: new Uint8Array(size),
    });

    const result = await provider.generate(
      request({
        references: [
          photo('too-big', perPhoto + 1),
          ...Array.from({ length: limits.maxCount + 1 }, (_, index) =>
            photo(`p-${index}`, perPhoto),
          ),
        ],
      }),
    );

    const images = (sent(fetchImpl).body.contents[0].parts as unknown[]).slice(1);
    expect(images.length * perPhoto).toBeLessThanOrEqual(limits.maxTotalBytes!);
    expect(images.length).toBeLessThanOrEqual(limits.maxCount);
    expect(result.appliedControls.references).toBe(images.length);
    expect(result.downgradeCodes).toContain('references_omitted');
  });

  it('returns the final image, never an interim thought image', async () => {
    const thought = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString(
      'base64',
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        imageReply([
          { text: 'thinking', thought: true },
          { inlineData: { mimeType: 'image/jpeg', data: thought }, thought: true },
          { text: 'Here is your cover.' },
          { inlineData: { mimeType: 'image/png', data: PNG_B64 } },
        ]),
      );

    const result = await adapter(fetchImpl as unknown as typeof fetch).generate(request());

    expect(result).toMatchObject({ bytes: PNG_BYTES, mediaType: 'image/png' });
  });

  it.each([
    [401, 'configuration', 'not_started'],
    [403, 'configuration', 'not_started'],
    [404, 'configuration', 'not_started'],
    [400, 'rejection', 'not_started'],
    [402, 'rejection', 'not_started'],
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
          json(
            { error: { code: status, message: `raw body ${SECRET} ${PROMPT}`, status: 'X' } },
            status,
          ),
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
      for (const secret of [SECRET, PROMPT, 'raw body']) {
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

  it('classifies a safety block as a rejection that may have been billed', async () => {
    for (const reply of [
      json({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
      json({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }),
      json({
        candidates: [
          { content: { parts: [{ text: `refused ${PROMPT}` }] }, finishReason: 'SAFETY' },
        ],
      }),
    ]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(reply);
      const failure = await adapter(fetchImpl as unknown as typeof fetch)
        .generate(request())
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        kind: 'rejection',
        submissionDisposition: 'outcome_unknown',
      });
      expect(JSON.stringify(failure)).not.toContain(PROMPT);
    }
  });

  it('classifies a malformed or imageless success as an invalid response', async () => {
    for (const reply of [
      json({ candidates: [] }),
      json({ candidates: [{ content: { parts: [{ text: 'no image' }] }, finishReason: 'STOP' }] }),
      json({ candidates: [{ finishReason: 'NO_IMAGE' }] }),
      imageReply([{ inlineData: { mimeType: 'image/png', data: '' } }]),
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
      providerKey: 'gemini',
      resolve: async () => ['169.254.169.254'],
    });

    await expect(adapter(guarded).generate(request())).rejects.toMatchObject({
      kind: 'configuration',
      submissionDisposition: 'not_started',
    });
  });

  it('rejects a blank key and any candidate count but one before network access', async () => {
    expect(() => geminiImageProvider({ apiKey: '  ' })).toThrow(GeneratedImageProviderError);
    const fetchImpl = vi.fn();
    await expect(
      adapter(fetchImpl as unknown as typeof fetch).generate(request({ count: 2 as 1 })),
    ).rejects.toMatchObject({ kind: 'configuration', submissionDisposition: 'not_started' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses a configured model in the request path', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(imageReply());

    const provider = adapter(fetchImpl as unknown as typeof fetch, {
      model: ' gemini-3-pro-image ',
    });
    await provider.generate(request());

    expect(provider.model).toBe('gemini-3-pro-image');
    expect(sent(fetchImpl).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent',
    );
  });

  it("accepts a model named in Google's models/<id> form, as the key Test does", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(imageReply());

    const provider = adapter(fetchImpl as unknown as typeof fetch, {
      model: 'models/gemini-3-pro-image',
    });
    await provider.generate(request());

    expect(provider.model).toBe('gemini-3-pro-image');
    expect(sent(fetchImpl).url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent',
    );
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

  it('validates the key and model with a free model lookup, the key in a header', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith(`/models/${GEMINI_DEFAULT_COVER_MODEL}`)
        ? json({ name: `models/${GEMINI_DEFAULT_COVER_MODEL}` })
        : json({}, 404),
    );
    await expect(
      adapter(fetchImpl as unknown as typeof fetch).validateCredentials(),
    ).resolves.toEqual({
      ok: true,
      message: 'Image provider credentials and endpoint look valid.',
    });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_DEFAULT_COVER_MODEL}`,
    );
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(SECRET);

    const refused = vi.fn().mockResolvedValueOnce(json({ error: { message: SECRET } }, 400));
    const outcome = await adapter(refused as unknown as typeof fetch).validateCredentials();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).not.toContain(SECRET);
  });
});
