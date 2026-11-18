import { describe, expect, it, vi } from 'vitest';
import { ProviderConfigError } from '../errors';
import { pinnedProviderFetch } from '../validation/provider-fetch';
import {
  DISCOVERY_RETRY_COOLDOWN_MS,
  FALLBACK_MAX_REFERENCE_BYTES,
  GeneratedImageProviderError,
  openRouterImageProvider,
  OPENROUTER_DEFAULT_COVER_MODEL,
  type GeneratedImageRequest,
} from './generated';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');
const SECRET = 'sk-or-test-secret';
const PROMPT = 'specific private prompt';
const REFERENCE_BYTES = new Uint8Array([1, 2, 3]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function endpointDescriptor(supportedParameters: string[]): Response {
  const descriptors = Object.fromEntries(
    supportedParameters.map((parameter) => [
      parameter,
      parameter === 'n'
        ? { type: 'range', min: 1, max: 4 }
        : parameter === 'resolution'
          ? { type: 'enum', values: ['1K', '2K'] }
          : parameter === 'aspect_ratio'
            ? { type: 'enum', values: ['1:1', '16:9'] }
            : parameter === 'quality'
              ? { type: 'enum', values: ['auto', 'high'] }
              : parameter === 'input_references'
                ? {
                    type: 'array',
                    max_items: 3,
                    roles: ['subject', 'style'],
                    media_types: ['image/jpeg', 'image/png', 'image/webp'],
                    max_bytes_per_item: 2_000_000,
                    max_total_bytes: 4_000_000,
                  }
                : { type: parameter === 'seed' ? 'integer' : 'string' },
    ]),
  );
  return json({
    id: OPENROUTER_DEFAULT_COVER_MODEL,
    endpoints: [
      {
        name: 'default',
        provider_tag: 'google-ai-studio',
        supported_parameters: {
          prompt: { type: 'string', max_length: 8_000 },
          ...descriptors,
        },
        pricing: { image: '0.014' },
      },
    ],
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
  return openRouterImageProvider({ apiKey: SECRET, fetch: fetchImpl, ...overrides });
}

describe('openRouter generated-image adapter', () => {
  it('discovers the definitive endpoint descriptor once and uses it for generation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        endpointDescriptor([
          'resolution',
          'aspect_ratio',
          'quality',
          'n',
          'seed',
          'input_references',
        ]),
      )
      .mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }], usage: { cost: 0.014 } }));
    const provider = adapter(fetchImpl as unknown as typeof fetch);

    const capabilities = await provider.getCapabilities();
    const result = await provider.generate(
      request({
        references: [
          {
            id: 'ref-1',
            role: 'subject',
            mediaType: 'image/webp',
            bytes: REFERENCE_BYTES,
          },
        ],
      }),
    );

    expect(capabilities).toMatchObject({
      provider: { providerKey: 'openrouter', model: OPENROUTER_DEFAULT_COVER_MODEL },
      maxPromptCharacters: 8_000,
      exclusions: 'inline',
      nativeSeed: true,
      idempotency: 'absent',
      squareOutput: 'native',
      maxCandidates: 4,
      costReporting: true,
      references: { maxCount: 3, roles: ['subject', 'style'] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://openrouter.ai/api/v1/images/models/google/gemini-3.1-flash-image/endpoints',
    );
    const generation = fetchImpl.mock.calls[1]! as unknown as [string, RequestInit];
    expect(generation[0]).toBe('https://openrouter.ai/api/v1/images');
    const body = JSON.parse(generation[1].body as string);
    expect(body).toMatchObject({
      model: OPENROUTER_DEFAULT_COVER_MODEL,
      resolution: '1K',
      aspect_ratio: '1:1',
      quality: 'high',
      n: 1,
      seed: 42,
      provider: { only: ['google-ai-studio'], allow_fallbacks: false },
    });
    expect(body.prompt).toContain(PROMPT);
    expect(body.prompt).toContain('logos');
    expect(body.input_references).toHaveLength(1);
    expect(result).toMatchObject({
      provider: { providerKey: 'openrouter', model: OPENROUTER_DEFAULT_COVER_MODEL },
      mediaType: 'image/png',
      reportedCostUsd: 0.014,
      appliedControls: {
        exclusions: 'inline',
        square: 'native',
        references: 1,
        seed: true,
        candidateCount: 1,
      },
      downgradeCodes: ['exclusions_inlined', 'idempotency_unavailable'],
    });
    expect(result.bytes).toEqual(PNG_BYTES);
  });

  it('intersects operator restrictions with discovery and never uses model aggregates', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          id: OPENROUTER_DEFAULT_COVER_MODEL,
          supported_parameters: { resolution: { type: 'string' }, seed: { type: 'integer' } },
          endpoints: [
            {
              name: 'chosen',
              provider_tag: 'chosen-provider',
              supported_parameters: {
                aspect_ratio: { type: 'enum', values: ['1:1'] },
                n: { type: 'range', min: 1, max: 2 },
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const provider = adapter(fetchImpl as unknown as typeof fetch, {
      capabilityAssertion: { supportedParameters: ['resolution', 'aspect_ratio', 'seed'] },
    });

    await provider.generate(request());

    const body = JSON.parse(
      (fetchImpl.mock.calls[1]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toEqual({
      model: OPENROUTER_DEFAULT_COVER_MODEL,
      prompt: `${PROMPT}\n\nExclude: logos; watermarks.`,
      aspect_ratio: '1:1',
      provider: { only: ['chosen-provider'], allow_fallbacks: false },
    });
  });

  it('preserves portable multi-Person reference order in the outbound array', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(endpointDescriptor(['input_references']))
      .mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const provider = adapter(fetchImpl as unknown as typeof fetch);
    const orderedBytes = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];

    await provider.generate(
      request({
        references: orderedBytes.map((bytes, index) => ({
          id: `person-${index + 1}`,
          role: 'subject',
          mediaType: 'image/webp',
          bytes,
        })),
      }),
    );

    const body = JSON.parse(
      (fetchImpl.mock.calls[1]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(
      body.input_references.map(
        (reference: { image_url: { url: string } }) => reference.image_url.url,
      ),
    ).toEqual(
      orderedBytes.map(
        (bytes) => `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`,
      ),
    );
  });

  it('never lets an operator assertion broaden discovered reference limits', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(endpointDescriptor(['input_references']));
    const capabilities = await adapter(fetchImpl as unknown as typeof fetch, {
      capabilityAssertion: {
        supportedParameters: ['input_references'],
        referenceLimits: {
          roles: ['subject', 'style'],
          maxCount: 10,
          multiSubjectIdentity: true,
          mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
          maxBytesPerReference: 10_000_000,
          maxTotalBytes: 10_000_000,
        },
      },
    }).getCapabilities();

    expect(capabilities.references).toMatchObject({
      maxCount: 3,
      multiSubjectIdentity: false,
      maxBytesPerReference: 2_000_000,
      maxTotalBytes: 4_000_000,
    });
  });

  it('never lets a bare input_references assertion narrow discovered reference limits', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(endpointDescriptor(['input_references']));
    const capabilities = await adapter(fetchImpl as unknown as typeof fetch, {
      capabilityAssertion: { supportedParameters: ['input_references'] },
    }).getCapabilities();

    expect(capabilities.references).toMatchObject({
      roles: ['subject', 'style'],
      maxCount: 3,
      maxBytesPerReference: 2_000_000,
    });
  });

  it('allows an operator assertion to narrow discovered reference limits', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(endpointDescriptor(['input_references']));
    const capabilities = await adapter(fetchImpl as unknown as typeof fetch, {
      capabilityAssertion: {
        supportedParameters: ['input_references'],
        referenceLimits: {
          roles: ['subject'],
          maxCount: 2,
          multiSubjectIdentity: false,
          mediaTypes: ['image/webp'],
          maxBytesPerReference: 1_000,
          maxTotalBytes: 1_500,
        },
      },
    }).getCapabilities();

    expect(capabilities.references).toEqual({
      roles: ['subject'],
      maxCount: 2,
      multiSubjectIdentity: false,
      mediaTypes: ['image/webp'],
      maxBytesPerReference: 1_000,
      maxTotalBytes: 1_500,
    });
  });

  it('uses an assertion when discovery is unavailable', async () => {
    // Every probe fails: an outage is retried, so the count is not fixed here.
    const generations: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/endpoints')) {
        return new Response('private discovery body', { status: 503 });
      }
      generations.push(String(init?.body));
      return json({ data: [{ b64_json: PNG_B64 }] });
    });
    const provider = adapter(fetchImpl as unknown as typeof fetch, {
      capabilityAssertion: {
        supportedParameters: ['n', 'seed'],
        maxPromptCharacters: 5_000,
        maxCandidates: 1,
      },
    });

    const capabilities = await provider.getCapabilities();
    await provider.generate(request());

    expect(capabilities).toMatchObject({ nativeSeed: true, maxCandidates: 1 });
    expect(JSON.parse(generations[0]!)).toMatchObject({ n: 1, seed: 42 });
  });

  it('uses conservative reference limits for an asserted discovery fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }));
    const provider = adapter(fetchImpl as unknown as typeof fetch, {
      capabilityAssertion: { supportedParameters: ['input_references'] },
    });
    await expect(provider.getCapabilities()).resolves.toMatchObject({
      references: {
        roles: ['subject', 'style'],
        maxCount: 1,
        mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
        // Fallbacks must never drop the byte cap: an uncapped reference would
        // ride into the JSON body unbounded.
        maxBytesPerReference: FALLBACK_MAX_REFERENCE_BYTES,
      },
    });
  });

  it('sends only the conservative core when discovery and assertion are absent', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const provider = adapter(fetchImpl as unknown as typeof fetch);

    const result = await provider.generate(request());

    const body = JSON.parse(
      (fetchImpl.mock.calls[1]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toEqual({
      model: OPENROUTER_DEFAULT_COVER_MODEL,
      prompt: `${PROMPT}\n\nExclude: logos; watermarks.`,
    });
    expect(result.downgradeCodes).toEqual([
      'capabilities_conservative',
      'exclusions_inlined',
      'square_requires_local_crop',
      'resolution_omitted',
      'quality_omitted',
      'candidate_count_omitted',
      'seed_omitted',
      'idempotency_unavailable',
    ]);
  });

  it('refuses before the paid request when discovery is down and a reference would be dropped', async () => {
    // A fallback cannot tell an outage from a real capability change, so it never
    // buys a cover without the photos it was handed: the conservative floor takes
    // none, an asserted floor only one.
    const fallbacks: Array<{ assertion?: object; references: number }> = [
      { references: 1 },
      { assertion: { supportedParameters: ['input_references'] }, references: 2 },
    ];
    for (const { assertion, references } of fallbacks) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
      const provider = adapter(
        fetchImpl as unknown as typeof fetch,
        assertion ? { capabilityAssertion: assertion } : {},
      );

      const failure = provider.generate(
        request({
          references: Array.from({ length: references }, (_, index) => ({
            id: `ref-${index}`,
            role: 'subject' as const,
            mediaType: 'image/webp' as const,
            bytes: REFERENCE_BYTES,
          })),
        }),
      );

      await expect(failure).rejects.toBeInstanceOf(GeneratedImageProviderError);
      await expect(failure).rejects.toMatchObject({
        kind: 'unavailable',
        submissionDisposition: 'not_started',
      });
      expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
        expect.stringMatching(/\/endpoints$/),
      ]);
    }
  });

  it('reuses an outage fallback for the cooldown, then re-probes and recovers', async () => {
    // A discovery outage is transient, so its fallback must not be pinned for the
    // process lifetime — that would drop the operator's resolution and aspect
    // ratio from every later cover until a restart. But retrying on EVERY cover
    // makes a sustained outage cost each one the probe timeout, so the retry is
    // rate-limited rather than immediate.
    // Routed by URL, not by call order: what is under test is whether a second
    // probe happens at all, so the stub must answer correctly either way.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let probes = 0;
      const generations: string[] = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/endpoints')) {
          probes += 1;
          return probes === 1
            ? new Response(null, { status: 503 })
            : endpointDescriptor(['resolution', 'aspect_ratio']);
        }
        generations.push(String(init?.body));
        return json({ data: [{ b64_json: PNG_B64 }] });
      });
      const provider = adapter(fetchImpl as unknown as typeof fetch);

      await provider.generate(request());
      await provider.generate(request());
      expect(probes).toBe(1);

      vi.setSystemTime(Date.now() + DISCOVERY_RETRY_COOLDOWN_MS + 1);
      await provider.generate(request());

      expect(probes).toBe(2);
      expect(JSON.parse(generations[0]!)).not.toHaveProperty('resolution');
      expect(JSON.parse(generations[1]!)).not.toHaveProperty('resolution');
      expect(JSON.parse(generations[2]!)).toMatchObject({ resolution: '1K', aspect_ratio: '1:1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-probe after a rejected key: the failure is configuration, not an outage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const provider = adapter(fetchImpl as unknown as typeof fetch);

    await expect(provider.getCapabilities()).rejects.toBeInstanceOf(GeneratedImageProviderError);
    await expect(provider.getCapabilities()).rejects.toBeInstanceOf(GeneratedImageProviderError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses as unsupported references when a live descriptor cannot take a requested reference', async () => {
    const subject = { id: 'ref-1', role: 'subject' as const, mediaType: 'image/png' as const };
    const cases = [
      { name: 'too large', references: [{ ...subject, bytes: new Uint8Array(2_000_001) }] },
      {
        name: 'media type',
        references: [{ ...subject, mediaType: 'image/webp' as const, bytes: REFERENCE_BYTES }],
      },
      {
        name: 'role',
        references: [{ ...subject, role: 'style' as const, bytes: REFERENCE_BYTES }],
      },
      {
        name: 'count',
        references: Array.from({ length: 3 }, (_, index) => ({
          ...subject,
          id: `ref-${index}`,
          bytes: REFERENCE_BYTES,
        })),
      },
    ];
    for (const { name, references } of cases) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        json({
          id: OPENROUTER_DEFAULT_COVER_MODEL,
          endpoints: [
            {
              provider_tag: 'google-ai-studio',
              supported_parameters: {
                input_references: {
                  type: 'array',
                  max_items: 2,
                  roles: ['subject'],
                  media_types: ['image/png'],
                  max_bytes_per_item: 2_000_000,
                },
              },
            },
          ],
        }),
      );
      const provider = adapter(fetchImpl as unknown as typeof fetch);

      const failure = provider.generate(request({ references }));

      await expect(failure, name).rejects.toBeInstanceOf(GeneratedImageProviderError);
      await expect(failure, name).rejects.toMatchObject({
        kind: 'references_unsupported',
        submissionDisposition: 'not_started',
      });
      expect(fetchImpl, name).toHaveBeenCalledTimes(1);
    }
  });

  it('uses conservative reference limits when the endpoint exposes only boolean support', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          id: OPENROUTER_DEFAULT_COVER_MODEL,
          endpoints: [
            {
              provider_tag: 'boolean-reference-provider',
              supported_parameters: { input_references: { type: 'boolean' } },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const provider = adapter(fetchImpl as unknown as typeof fetch);

    await expect(provider.getCapabilities()).resolves.toMatchObject({
      references: {
        roles: ['subject', 'style'],
        maxCount: 1,
        mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
      },
    });
    await expect(
      provider.generate(
        request({
          references: [
            { id: 'subject', role: 'subject', mediaType: 'image/webp', bytes: REFERENCE_BYTES },
            { id: 'style', role: 'style', mediaType: 'image/png', bytes: REFERENCE_BYTES },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      kind: 'references_unsupported',
      submissionDisposition: 'not_started',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await provider.generate(
      request({
        references: [
          { id: 'subject', role: 'subject', mediaType: 'image/webp', bytes: REFERENCE_BYTES },
        ],
      }),
    );
    const body = JSON.parse(
      (fetchImpl.mock.calls[1]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.input_references).toHaveLength(1);
  });

  it('discovers the reference count from an official range descriptor', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      json({
        id: OPENROUTER_DEFAULT_COVER_MODEL,
        endpoints: [
          {
            provider_tag: 'range-reference-provider',
            supported_parameters: {
              input_references: { type: 'range', min: 0, max: 16 },
            },
          },
        ],
      }),
    );
    const capabilities = await adapter(fetchImpl as unknown as typeof fetch).getCapabilities();
    expect(capabilities.references).toMatchObject({
      roles: ['subject', 'style'],
      maxCount: 16,
      multiSubjectIdentity: false,
      mediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
    });
  });

  it('advertises multi-subject identity only from an explicit endpoint capability', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      json({
        id: OPENROUTER_DEFAULT_COVER_MODEL,
        endpoints: [
          {
            provider_tag: 'explicit-multi-subject-provider',
            supported_parameters: {
              input_references: {
                type: 'array',
                max_items: 4,
                roles: ['subject'],
                media_types: ['image/webp'],
                multi_subject_identity: true,
              },
            },
          },
        ],
      }),
    );

    await expect(
      adapter(fetchImpl as unknown as typeof fetch, {
        capabilityAssertion: { supportedParameters: ['input_references'] },
      }).getCapabilities(),
    ).resolves.toMatchObject({
      references: {
        roles: ['subject'],
        maxCount: 4,
        multiSubjectIdentity: true,
        mediaTypes: ['image/webp'],
      },
    });
  });

  it.each([
    [401, 'configuration', 'not_started'],
    [429, 'rate_limit', 'not_started'],
    [402, 'rejection', 'not_started'],
    [503, 'unavailable', 'outcome_unknown'],
    [504, 'timeout', 'outcome_unknown'],
    [404, 'configuration', 'not_started'],
    [413, 'rejection', 'not_started'],
    [422, 'rejection', 'not_started'],
  ] as const)(
    'classifies HTTP %s without leaking provider data',
    async (status, kind, disposition) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(endpointDescriptor([]))
        .mockResolvedValueOnce(
          new Response(`raw body ${SECRET} ${PROMPT} signed=https://x?token=secret`, { status }),
        );

      try {
        await adapter(fetchImpl as unknown as typeof fetch).generate(request());
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(GeneratedImageProviderError);
        expect(error).toMatchObject({ kind, submissionDisposition: disposition });
        const serialized = `${(error as Error).message} ${JSON.stringify(error)}`;
        expect(serialized).not.toContain(SECRET);
        expect(serialized).not.toContain(PROMPT);
        expect(serialized).not.toContain('raw body');
        expect(serialized).not.toContain('token=secret');
        expect(serialized).not.toContain(Buffer.from(REFERENCE_BYTES).toString('base64'));
      }
    },
  );

  it('classifies timeout and transport ambiguity with fixed safe messages', async () => {
    const timeout = Object.assign(new Error(`timeout ${SECRET} ${PROMPT}`), {
      name: 'TimeoutError',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(endpointDescriptor([]))
      .mockRejectedValueOnce(timeout);

    await expect(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
    ).rejects.toMatchObject({
      kind: 'timeout',
      submissionDisposition: 'outcome_unknown',
      message: 'Generated image request timed out.',
    });
  });

  it('never logs or throws request/reference/provider response detail', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(endpointDescriptor(['input_references']))
      .mockResolvedValueOnce(
        new Response(`raw ${SECRET} ${PROMPT} https://signed.example/x?token=secret`, {
          status: 502,
        }),
      );
    const failure = adapter(fetchImpl as unknown as typeof fetch).generate(
      request({
        references: [
          { id: 'private-ref', role: 'subject', mediaType: 'image/webp', bytes: REFERENCE_BYTES },
        ],
      }),
    );

    await expect(failure).rejects.toMatchObject({
      message: 'Generated image provider is unavailable.',
    });
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PROMPT);
    expect(logged).not.toContain(Buffer.from(REFERENCE_BYTES).toString('base64'));
    expect(logged).not.toContain('token=secret');
    for (const spy of spies) spy.mockRestore();
  });

  it('classifies a refused dial as a not-started configuration failure', async () => {
    // The egress guard refuses before a byte leaves the process, so counting it
    // as ambiguous would charge a cover-spend window for a request that could
    // not have been billed.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(endpointDescriptor([]))
      .mockRejectedValueOnce(new ProviderConfigError('blocked'));

    await expect(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
    ).rejects.toMatchObject({
      kind: 'configuration',
      submissionDisposition: 'not_started',
    });
  });

  it('classifies a host whose name does not resolve as unavailable and not started', async () => {
    // The lookup fails before any connection, so nothing could have been billed
    // and nothing is misconfigured: a later attempt may simply resolve.
    const fetchImpl = pinnedProviderFetch({
      providerKey: 'openrouter',
      resolve: async () => {
        throw new Error('getaddrinfo EAI_AGAIN openrouter.ai');
      },
    });

    await expect(adapter(fetchImpl).generate(request())).rejects.toMatchObject({
      kind: 'unavailable',
      submissionDisposition: 'not_started',
    });
  });

  it('keeps any other transport failure as possibly paid', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(endpointDescriptor([]))
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      submissionDisposition: 'outcome_unknown',
    });
  });

  it('classifies malformed success responses as outcome unknown', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(endpointDescriptor([]))
      .mockResolvedValueOnce(json({ raw: `${SECRET} ${PROMPT}` }));

    await expect(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
    ).rejects.toMatchObject({
      kind: 'invalid_response',
      submissionDisposition: 'outcome_unknown',
    });
  });

  it('fails before submission when the positive prompt exceeds the endpoint limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      json({
        id: OPENROUTER_DEFAULT_COVER_MODEL,
        endpoints: [
          {
            provider_tag: 'small-prompt-provider',
            supported_parameters: { prompt: { type: 'string', max_length: 5 } },
          },
        ],
      }),
    );

    await expect(
      adapter(fetchImpl as unknown as typeof fetch).generate(request()),
    ).rejects.toMatchObject({ kind: 'rejection', submissionDisposition: 'not_started' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('maps portable standard quality to the documented auto value', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(endpointDescriptor(['quality']))
      .mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    await adapter(fetchImpl as unknown as typeof fetch).generate(
      request({ target: { shape: 'square', quality: 'standard' } }),
    );
    const body = JSON.parse(
      (fetchImpl.mock.calls[1]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.quality).toBe('auto');
  });

  it('omits configured controls excluded by definitive endpoint enums', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          id: OPENROUTER_DEFAULT_COVER_MODEL,
          endpoints: [
            {
              provider_tag: 'enum-limited-provider',
              supported_parameters: {
                resolution: { type: 'enum', values: ['4K'] },
                aspect_ratio: { type: 'enum', values: ['16:9'] },
                quality: { type: 'enum', values: ['low'] },
                n: { type: 'range', min: 2, max: 4 },
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const result = await adapter(fetchImpl as unknown as typeof fetch).generate(request());
    const body = JSON.parse(
      (fetchImpl.mock.calls[1]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toEqual({
      model: OPENROUTER_DEFAULT_COVER_MODEL,
      prompt: `${PROMPT}\n\nExclude: logos; watermarks.`,
      provider: { only: ['enum-limited-provider'], allow_fallbacks: false },
    });
    expect(result.downgradeCodes).toEqual(
      expect.arrayContaining([
        'square_requires_local_crop',
        'resolution_omitted',
        'quality_omitted',
        'candidate_count_omitted',
      ]),
    );
  });

  it('uses native exclusions only when negative_prompt is discovered', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(endpointDescriptor(['negative_prompt']))
      .mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const result = await adapter(fetchImpl as unknown as typeof fetch).generate(request());
    const body = JSON.parse(
      (fetchImpl.mock.calls[1]! as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.prompt).toBe(PROMPT);
    expect(body.negative_prompt).toBe('logos; watermarks');
    expect(result.appliedControls.exclusions).toBe('native');
    expect(result.downgradeCodes).not.toContain('exclusions_inlined');
  });

  it('rejects requests with any candidate count other than one before network access', async () => {
    const fetchImpl = vi.fn();
    await expect(
      adapter(fetchImpl as unknown as typeof fetch).generate(request({ count: 2 as 1 })),
    ).rejects.toMatchObject({ kind: 'configuration', submissionDisposition: 'not_started' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects missing credentials and private base URLs without network access', async () => {
    expect(() => openRouterImageProvider({ apiKey: '   ' })).toThrow(GeneratedImageProviderError);
    const fetchImpl = vi.fn();
    const provider = adapter(fetchImpl as unknown as typeof fetch, {
      baseUrl: 'http://169.254.169.254/api/v1',
    });
    await expect(provider.getCapabilities()).rejects.toMatchObject({
      kind: 'configuration',
      submissionDisposition: 'not_started',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('checks the key, then uses discovery during validation and caches it for generation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { label: 'sk-or-v1-abc...' } }))
      .mockResolvedValueOnce(endpointDescriptor(['n']))
      .mockResolvedValueOnce(json({ data: [{ b64_json: PNG_B64 }] }));
    const provider = adapter(fetchImpl as unknown as typeof fetch);

    await expect(provider.validateCredentials()).resolves.toEqual({
      ok: true,
      message: 'Image provider credentials and endpoint look valid.',
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/key');
    await provider.generate(request());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  // The model's endpoints listing answers any key, so only the key endpoint refuses a wrong one.
  it('fails validation for a key OpenRouter does not know', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/key')
        ? json({ error: { message: 'User not found.', code: 401 } }, 401)
        : endpointDescriptor(['n']),
    );
    const provider = adapter(fetchImpl as unknown as typeof fetch);

    await expect(provider.validateCredentials()).resolves.toMatchObject({ ok: false });
  });
});
