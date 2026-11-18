import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mockLlmProvider } from './mock';
import { sessionStyleSnapshotSchema } from './snapshot';

describe('mockLlmProvider', () => {
  const provider = mockLlmProvider();

  it('is an LLM provider that needs no credentials', async () => {
    expect(provider.providerType).toBe('llm');
    expect(provider.providerKey).toBe('mock');
    expect((await provider.validateCredentials()).ok).toBe(true);
    expect(provider.getCapabilities().model).toBe('mock');
  });

  it('expands an intent into a valid, deterministic Style Snapshot (no network)', async () => {
    const snapshot = await provider.expandSessionIntent('mellow lofi for studying');
    expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.stylePrompt.length).toBeGreaterThan(0);
    expect(await provider.expandSessionIntent('mellow lofi for studying')).toEqual(snapshot);
  });

  it('fills a deterministic frozen bpm/key and hidden seed parameters', async () => {
    const snapshot = await provider.expandSessionIntent('mellow lofi for studying');
    expect(typeof snapshot.bpm).toBe('number');
    expect(snapshot.bpm).toBeGreaterThan(0);
    expect(snapshot.key.length).toBeGreaterThan(0);
    expect(typeof snapshot.seedParameters.baseSeed).toBe('number');
    // Deterministic: the same intent freezes the same blend parameters.
    const again = await provider.expandSessionIntent('mellow lofi for studying');
    expect(again.bpm).toBe(snapshot.bpm);
    expect(again.key).toBe(snapshot.key);
  });

  it('leads genreTags and the style with explicit genre picks', async () => {
    const snapshot = await provider.expandSessionIntent('rainy night drive', null, {
      genres: ['techno', 'ambient'],
    });
    expect(snapshot.genreTags.slice(0, 2)).toEqual(['techno', 'ambient']);
    expect(snapshot.stylePrompt).toContain('techno');
    expect(snapshot.stylePrompt).toContain('ambient');
    // The picks are enforced, not intent-derived: the same words without picks
    // produce different tags, and the picked snapshot still validates.
    const unpicked = await provider.expandSessionIntent('rainy night drive');
    expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(unpicked.genreTags).not.toEqual(snapshot.genreTags);
  });

  it('enforces explicit energy, vocal, and voice picks over the words', async () => {
    const snapshot = await provider.expandSessionIntent('calm piano for reading', null, {
      energy: 'high',
      vocal: 'vocal',
      voice: 'female',
    });
    expect(snapshot.energy).toBe('high');
    expect(snapshot.vocalMode).toBe('vocal');
    expect(snapshot.voiceGender).toBe('female');
    expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
    // The picks are enforced, not word-derived: the same words alone stay a
    // calm instrumental session at a slower frozen tempo.
    const unpicked = await provider.expandSessionIntent('calm piano for reading');
    expect(unpicked.vocalMode).toBe('instrumental');
    expect(snapshot.bpm!).toBeGreaterThan(unpicked.bpm!);
  });

  it('a forced instrumental pick beats singing words and clears the vocal fields', async () => {
    const snapshot = await provider.expandSessionIntent('ein Lied mit Gesang', null, {
      vocal: 'instrumental',
    });
    expect(snapshot.vocalMode).toBe('instrumental');
    expect(snapshot.language).toBe('');
    expect(snapshot.negativeTerms).toContain('vocals');
  });

  it('a forced vocal pick still detects the request language', async () => {
    // No vocal-hint words at all — only the pick asks for vocals, and the
    // language detection must follow the FORCED mode, not the word-derived one.
    const snapshot = await provider.expandSessionIntent('ruhige Musik für die Berge', null, {
      vocal: 'vocal',
    });
    expect(snapshot.vocalMode).toBe('vocal');
    expect(snapshot.language).toBe('German');
  });

  it('anchors an adjustment on the current snapshot (Change Vibe parity)', async () => {
    const anchor = await provider.expandSessionIntent('mellow german lofi singen für den abend');
    expect(anchor.vocalMode).toBe('vocal');
    expect(anchor.language).toBe('German');
    const adjusted = await provider.expandSessionIntent('a bit faster', null, undefined, {
      adjustFrom: anchor,
    });
    // The anchor's facets hold; only the change text rides onto the style.
    expect(adjusted.vocalMode).toBe('vocal');
    expect(adjusted.language).toBe('German');
    expect(adjusted.genreTags).toEqual(anchor.genreTags);
    expect(adjusted.bpm).toBe(anchor.bpm);
    expect(adjusted.key).toBe(anchor.key);
    expect(adjusted.stylePrompt).toContain(anchor.stylePrompt);
    expect(adjusted.stylePrompt).toContain('a bit faster');
    // An explicit pick still wins over the anchor (energy re-freezes the tempo).
    const repicked = await provider.expandSessionIntent(
      'a bit faster',
      null,
      { energy: 'high' },
      { adjustFrom: anchor },
    );
    expect(repicked.energy).toBe('high');
    expect(repicked.bpm).not.toBe(anchor.bpm);
  });

  it('holds the anchor’s style on a picks-only adjustment, which has no change text', async () => {
    const anchor = await provider.expandSessionIntent('calm solo piano for reading');
    const adjusted = await provider.expandSessionIntent('', null, undefined, {
      adjustFrom: anchor,
    });
    expect(adjusted.stylePrompt).toBe(anchor.stylePrompt);
    expect(adjusted.genreTags).toEqual(anchor.genreTags);
  });

  it('derives cosmetic metadata deterministically', async () => {
    const snapshot = await provider.expandSessionIntent('ambient focus');
    const meta = await provider.createTrackMetadata(snapshot, 1);
    expect(meta.title.length).toBeGreaterThan(0);
  });
});

describe('mockLlmProvider.createSessionMetadata', () => {
  const provider = mockLlmProvider();

  it('proposes a deterministic name plus a distinct creative title pool', async () => {
    const snapshot = await provider.expandSessionIntent('mellow lofi for studying');
    const naming = await provider.createSessionMetadata({
      userPrompt: 'mellow lofi for studying',
      snapshot,
    });
    expect(naming.title.length).toBeGreaterThan(0);
    expect(naming.trackTitles.length).toBeGreaterThanOrEqual(2);
    expect(new Set(naming.trackTitles).size).toBe(naming.trackTitles.length);
    // Deterministic: the mock never varies for the same input.
    expect(
      await provider.createSessionMetadata({ userPrompt: 'mellow lofi for studying', snapshot }),
    ).toEqual(naming);
  });

  it('steps aside from a taken title (the seeded-session avoid list)', async () => {
    const snapshot = await provider.expandSessionIntent('mellow lofi for studying');
    const base = await provider.createSessionMetadata({ snapshot });
    const naming = await provider.createSessionMetadata({
      snapshot,
      avoidTitles: [base.title.toUpperCase()],
    });
    expect(naming.title).not.toBe(base.title);
    expect(naming.title).toContain(base.title);
  });
});

describe('mockLlmProvider listener personalization', () => {
  const provider = mockLlmProvider();

  it('proposes compact labeled lyric notes for a vocal session with a listener profile', async () => {
    const snapshot = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'acoustic pop, with vocals',
      vocalMode: 'vocal',
    });
    const naming = await provider.createSessionMetadata({
      userPrompt: 'a song about our runs',
      snapshot,
      listener: { name: 'John', city: 'Riverton' },
    });
    expect(naming.lyricContext).toBe('people: John; setting: Riverton');
  });

  it("weaves a fitting fact from the listener's own About into a vocal expansion", async () => {
    await expect(
      provider.expandSessionIntent('sing about me running beside the river', {
        about: 'weekend trail runs beside the river. restores vintage radios',
      }),
    ).resolves.toMatchObject({
      lyricContext: 'listener: weekend trail runs beside the river',
    });
  });

  it('uses matched Person context only in a vocal expansion', async () => {
    const listener = {
      people: [
        {
          name: 'Tina',
          about: 'weekend trail runs beside the river. restores vintage radios',
        },
      ],
    };
    await expect(
      provider.expandSessionIntent(
        'sing a song for Tina about trail runs beside the river',
        listener,
      ),
    ).resolves.toMatchObject({
      lyricContext: 'people: Tina; story moments: weekend trail runs beside the river',
    });
    await expect(
      provider.expandSessionIntent('instrumental focus for Tina', listener),
    ).resolves.toMatchObject({ lyricContext: '' });
  });

  it('never proposes lyricContext without a profile or on instrumental sessions', async () => {
    const vocal = sessionStyleSnapshotSchema.parse({ stylePrompt: 'pop', vocalMode: 'vocal' });
    expect(
      (await provider.createSessionMetadata({ userPrompt: null, snapshot: vocal })).lyricContext,
    ).toBe('');
    const instrumental = sessionStyleSnapshotSchema.parse({ stylePrompt: 'piano' });
    expect(
      (
        await provider.createSessionMetadata({
          userPrompt: null,
          snapshot: instrumental,
          listener: { name: 'John' },
        })
      ).lyricContext,
    ).toBe('');
  });
});

describe('mockLlmProvider vocal-language stand-in', () => {
  const provider = mockLlmProvider();

  it('detects an obviously German vocal request (deterministic dev stand-in)', async () => {
    const snapshot = await provider.expandSessionIntent('ein Lied über unsere Wochenendläufe');
    expect(snapshot.vocalMode).toBe('vocal');
    expect(snapshot.language).toBe('German');
  });

  it('keeps English/instrumental requests untagged', async () => {
    const instrumental = await provider.expandSessionIntent('mellow lofi for studying');
    expect(instrumental.vocalMode).toBe('instrumental');
    expect(instrumental.language).toBe('');
    const englishVocal = await provider.expandSessionIntent('a song about summer');
    expect(englishVocal.vocalMode).toBe('vocal');
    expect(englishVocal.language).toBe('');
  });

  it('honors an explicit language pick over the naive detection, on either mode', async () => {
    const vocal = await provider.expandSessionIntent('a song about summer', null, {
      language: 'Japanese',
    });
    expect(vocal.language).toBe('Japanese');
    const instrumental = await provider.expandSessionIntent('mellow lofi for studying', null, {
      language: 'Japanese',
    });
    expect(instrumental.vocalMode).toBe('instrumental');
    expect(instrumental.language).toBe('Japanese');
  });
});

describe('mock enhanceCoverDirection', () => {
  it('rewrites deterministically and reports the enhancement as applied', async () => {
    const provider = mockLlmProvider();
    const result = await provider.enhanceCoverDirection({
      text: 'warm dusk light over a paper skyline',
      context: { sessionName: 'Rain', style: 'minimal', mood: 'calm', genres: ['ambient'] },
    });
    expect(result.applied).toBe(true);
    expect(result.text).toContain('warm dusk light over a paper skyline');
    expect(result.text).toContain('minimal');
  });

  it('returns empty input unchanged without applying', async () => {
    const provider = mockLlmProvider();
    await expect(provider.enhanceCoverDirection({ text: '   ', context: {} })).resolves.toEqual({
      text: '   ',
      applied: false,
    });
  });
});

describe('mock createTrackLyricBrief', () => {
  const provider = mockLlmProvider();
  const input = {
    lyricContext: 'theme: night rides; people: Mia',
    language: '',
    stylePrompt: 'mellow indie pop',
    mood: '',
    previousBriefs: [] as string[],
  };

  it('varies deterministically with the number of previous briefs', async () => {
    const first = await provider.createTrackLyricBrief(input);
    const second = await provider.createTrackLyricBrief({
      ...input,
      previousBriefs: ['scene: one'],
    });
    const third = await provider.createTrackLyricBrief({
      ...input,
      previousBriefs: ['scene: two', 'scene: one'],
    });
    expect(new Set([first, second, third]).size).toBe(3);
    // Deterministic: the same inputs reproduce the same brief.
    expect(await provider.createTrackLyricBrief(input)).toBe(first);
  });

  it('clamps the brief to 200 chars', async () => {
    const brief = await provider.createTrackLyricBrief({
      ...input,
      lyricContext: `theme: ${'x'.repeat(300)}`,
    });
    expect(brief.length).toBe(200);
  });
});

describe('mock createTrackTitles', () => {
  const provider = mockLlmProvider();
  const input = {
    takenTitles: ['Velvet Harbor', 'Silver Harbor'],
    count: 5,
    stylePrompt: 'mellow synthwave',
    mood: '',
    language: '',
  };

  it('proposes the requested number of distinct titles, none already taken', async () => {
    const titles = await provider.createTrackTitles(input);
    expect(titles).toHaveLength(5);
    expect(new Set(titles).size).toBe(5);
    for (const title of titles) expect(input.takenTitles).not.toContain(title);
    expect(await provider.createTrackTitles(input)).toEqual(titles);
  });
});

describe('mock streamAssistantReply', () => {
  const question = { role: 'user' as const, content: 'How do I invite someone?' };
  const collect = async (stream: AsyncIterable<string>) => {
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  };

  it('answers in several chunks without a script, naming the question', async () => {
    const chunks = await collect(
      mockLlmProvider().streamAssistantReply({
        system: 's',
        messages: [question],
        tools: [],
        maxToolSteps: 4,
      }),
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe('Mock answer to: How do I invite someone?');
  });

  it('runs its scripted tool calls and answers from what they returned', async () => {
    const asked: unknown[] = [];
    const provider = mockLlmProvider({
      assistantScript: {
        toolCalls: [{ name: 'lookup', input: { topic: 'invites' } }],
        reply: ([found]) => `The docs say: ${found}`,
      },
    });

    const chunks = await collect(
      provider.streamAssistantReply({
        system: 's',
        messages: [question],
        tools: [
          {
            name: 'lookup',
            description: 'Look a topic up.',
            inputSchema: z.object({ topic: z.string() }),
            async execute(input) {
              asked.push(input);
              return 'Invites are made under Members.';
            },
          },
        ],
        maxToolSteps: 4,
      }),
    );

    expect(asked).toEqual([{ topic: 'invites' }]);
    expect(chunks.join('')).toBe('The docs say: Invites are made under Members.');
  });
});

describe('mockLlmProvider reading whether a request includes the listener', () => {
  const provider = mockLlmProvider();
  const answer = async (intent: string) =>
    (await provider.expandSessionIntentWithMetadata(intent)).includesListener;

  it.each([
    'Me, Jonas and Clara on a trip to the moon',
    'sing a song about me',
    'put me in it too',
  ])('puts the listener in the scene of %j', async (intent) => {
    expect(await answer(intent)).toBe(true);
  });

  it.each(['play me something calm', 'give me focus music', 'sing a gentle song about the sea'])(
    'gives no answer for %j, which only asks for music',
    async (intent) => {
      expect(await answer(intent)).toBeUndefined();
    },
  );
});
