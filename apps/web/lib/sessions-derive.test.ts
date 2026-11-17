import { describe, expect, it, vi } from 'vitest';
import {
  compileStructuredControls,
  deriveSessionTitle,
  ProviderError,
  type ExpansionOptions,
  type LlmProvider,
  type SessionStyleSnapshot,
} from '@liedmotif/providers';
import { DEFAULT_NOVELTY, DEFAULT_STYLE_STRENGTH } from '@liedmotif/shared';

// `deriveSnapshotForIntentSafe` maps the one EXPECTED create/restyle failure to
// a discriminated result the routes turn into a contract error envelope: a
// sanitized LLM-expansion failure (provider_error), so a ProviderError from the
// expansion never escapes the route as an unhandled 500 with its user-safe
// message lost. Without a configured LLM every intent compiles
// deterministically — there is no no-LLM failure to map.

const llmHolder = vi.hoisted(() => ({ provider: null as unknown }));
const peopleHolder = vi.hoisted(() => ({ people: [] as unknown[] }));
vi.mock('./providers', () => ({
  getLlmProvider: async () => llmHolder.provider,
  getMusicProvider: vi.fn(),
}));
// `nameSeededSnapshot` loads the owner's listener context itself; the naming
// merge under test needs no profile, so the db read is stubbed out.
vi.mock('@liedmotif/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@liedmotif/db')>()),
  getListenerContext: async () => null,
  listPeople: async () => peopleHolder.people,
}));

const {
  deriveNamedSnapshotForIntent,
  deriveSnapshotForIntentSafe,
  nameSeededSnapshot,
  nameSessionSnapshot,
  personLyricContextForRequest,
  stripPersonalIngredients,
} = await import('./sessions');

function expansionThrowing(error: Error): LlmProvider {
  return {
    expandSessionIntent: async () => {
      throw error;
    },
    expandSessionIntentWithMetadata: async () => {
      throw error;
    },
  } as unknown as LlmProvider;
}

describe('deriveSnapshotForIntentSafe', () => {
  it('compiles a free-text intent deterministically with no configured LLM', async () => {
    llmHolder.provider = null;
    const result = await deriveSnapshotForIntentSafe({ mode: 'prompt', prompt: 'evening chill' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.stylePrompt).toBe('evening chill');
  });

  it('maps a sanitized ProviderError to llm_expansion_failed with its user-safe message', async () => {
    llmHolder.provider = expansionThrowing(
      new ProviderError('Could not turn that description into a music style.', {
        errorName: 'AI_APICallError',
        statusCode: 401,
      }),
    );
    const result = await deriveSnapshotForIntentSafe({ mode: 'prompt', prompt: 'evening chill' });
    expect(result).toEqual({
      ok: false,
      reason: 'llm_expansion_failed',
      message: 'Could not turn that description into a music style.',
    });
  });

  it('still propagates an unexpected (non-Provider) error as a thrown 500', async () => {
    llmHolder.provider = expansionThrowing(new Error('boom'));
    await expect(
      deriveSnapshotForIntentSafe({ mode: 'prompt', prompt: 'evening chill' }),
    ).rejects.toThrow('boom');
  });

  it('compiles structured controls deterministically without touching the LLM', async () => {
    llmHolder.provider = expansionThrowing(new Error('must not be called'));
    const result = await deriveSnapshotForIntentSafe({ mode: 'controls', controls: {} });
    expect(result.ok).toBe(true);
  });
});

describe('personLyricContextForRequest', () => {
  const people = [
    { id: 'owner', role: 'owner', name: 'John', nameMatchKey: 'john', about: 'owner details' },
    {
      id: 'julia',
      role: 'ordinary',
      name: 'Julia',
      nameMatchKey: 'julia',
      about: 'repairs bicycles',
    },
    {
      id: 'li',
      role: 'ordinary',
      name: '李小龍',
      nameMatchKey: '李小龍',
      about: 'collects old film cameras',
    },
    { id: 'blank', role: 'ordinary', name: 'Amina', nameMatchKey: 'amina', about: '' },
  ];
  /** The named People's half of the answer. */
  const namedPeople = (...args: Parameters<typeof personLyricContextForRequest>) =>
    personLyricContextForRequest(...args).people;

  it('returns only exactly named People for an explicit vocal request', () => {
    expect(namedPeople('Sing a duet about Julia and 李小龍', people)).toEqual([
      { name: 'Julia', about: 'repairs bicycles' },
      { name: '李小龍', about: 'collects old film cameras' },
    ]);
  });

  it.each(['An aria for Julia', 'A choir piece celebrating Julia'])(
    'makes named About available for vocal phrasing outside a fixed keyword list: %j',
    (prompt) => {
      expect(namedPeople(prompt, people)).toEqual([{ name: 'Julia', about: 'repairs bicycles' }]);
    },
  );

  it.each([
    'Instrumental focus music for Julia',
    'Rainy focus music with no vocals for Julia',
    'Quiet focus music for Julia',
    'A quiet focus session for my wife',
  ])('does not consume Person About for %j', (prompt) => {
    expect(namedPeople(prompt, people)).toEqual([]);
  });

  it('treats an explicit Vocals pick as a vocal request even when the words do not say so', () => {
    expect(namedPeople('birthday party music for Julia', people, { vocal: 'vocal' })).toEqual([
      { name: 'Julia', about: 'repairs bicycles' },
    ]);
    expect(
      namedPeople('instrumental birthday music for Julia', people, {
        vocal: 'vocal',
      }),
    ).toEqual([]);
    expect(
      namedPeople('birthday party music for my sister', people, {
        vocal: 'vocal',
      }),
    ).toEqual([]);
  });

  it('does not select the owner merely because cover fallback could select them', () => {
    expect(namedPeople('Sing a song for Julia', people)).toEqual([
      { name: 'Julia', about: 'repairs bicycles' },
    ]);
  });

  it('copies matched About into creation context so later edits cannot mutate the frozen input', () => {
    const editable = people.map((person) => ({ ...person }));
    const frozen = namedPeople('Sing a song for Julia', editable);
    editable[1]!.about = 'new details added later';
    expect(frozen).toEqual([{ name: 'Julia', about: 'repairs bicycles' }]);
  });

  // A Change Vibe message is a fragment, not a full request: it neither repeats
  // the vocal keywords nor the names the session already sings about, so the
  // running session answers both questions instead.
  describe('on a Change Vibe adjustment', () => {
    const vocalAnchor = compileStructuredControls({ vocal: 'vocal', genres: ['folk'] });
    const instrumentalAnchor = compileStructuredControls({ genres: ['ambient'] });

    it('takes "vocals are wanted" from the running session, not the change text', () => {
      expect(namedPeople('a verse about Julia', people)).toEqual([]);
      expect(namedPeople('a verse about Julia', people, { adjustFrom: vocalAnchor })).toEqual([
        { name: 'Julia', about: 'repairs bicycles' },
      ]);
    });

    it('matches names over the change text AND the session prompt history', () => {
      expect(
        namedPeople('use berlin instead of london', people, {
          adjustFrom: vocalAnchor,
          promptHistory: 'a song for Julia about her ride from London to Paris',
        }),
      ).toEqual([{ name: 'Julia', about: 'repairs bicycles' }]);
    });

    it('loads none when the change turns the session instrumental', () => {
      expect(
        namedPeople('instrumental only, no vocals', people, {
          adjustFrom: vocalAnchor,
          promptHistory: 'a song for Julia',
        }),
      ).toEqual([]);
    });

    it('shuts the gate on an explicit instrumental pick, whatever the text says', () => {
      expect(
        namedPeople('sing a song for Julia', people, {
          adjustFrom: vocalAnchor,
          vocal: 'instrumental',
        }),
      ).toEqual([]);
    });

    it('still needs an explicit vocal ask when the running session is instrumental', () => {
      expect(
        namedPeople('a bit faster', people, {
          adjustFrom: instrumentalAnchor,
          promptHistory: 'focus music for Julia',
        }),
      ).toEqual([]);
      expect(
        namedPeople('add lyrics about Julia', people, {
          adjustFrom: instrumentalAnchor,
        }),
      ).toEqual([{ name: 'Julia', about: 'repairs bicycles' }]);
    });
  });
});

// Every Session is part of the listener's own soundtrack, so their own About is
// lyric material for every vocal request, whoever else it names.
describe('personLyricContextForRequest for the owner’s own About', () => {
  const people = [
    { id: 'owner', role: 'owner', name: 'John', nameMatchKey: 'john', about: ' owner details ' },
    {
      id: 'julia',
      role: 'ordinary',
      name: 'Julia',
      nameMatchKey: 'julia',
      about: 'repairs bicycles',
    },
  ];

  it("supplies the owner's About for a vocal request that never names them", () => {
    expect(personLyricContextForRequest('Sing about me and Julia on the moon', people)).toEqual({
      people: [{ name: 'Julia', about: 'repairs bicycles' }],
      about: 'owner details',
    });
  });

  it('supplies it on Auto vocals whatever words the request uses, leaving the vocal call to the expansion', () => {
    const request = 'A cappella harmonies about me running by the river';
    expect(personLyricContextForRequest(request, people)).toEqual({
      people: [],
      about: 'owner details',
    });
  });

  it('supplies none when the request is instrumental', () => {
    expect(
      personLyricContextForRequest('Focus music for me and Julia', people, {
        vocal: 'instrumental',
      }).about,
    ).toBe('');
    expect(personLyricContextForRequest('Instrumental focus music for me', people).about).toBe('');
  });

  it('sends a named owner once, as the own About and not among the named People', () => {
    expect(personLyricContextForRequest('Sing about John and Julia', people)).toEqual({
      people: [{ name: 'Julia', about: 'repairs bicycles' }],
      about: 'owner details',
    });
  });

  it('supplies none when the owner has written no About', () => {
    const blank = people.map((person) => ({ ...person, about: '' }));
    expect(personLyricContextForRequest('Sing about me and Julia', blank).about).toBe('');
  });

  it('takes "vocals are wanted" from the running session on a Change Vibe', () => {
    const vocalAnchor = compileStructuredControls({ vocal: 'vocal', genres: ['folk'] });
    expect(
      personLyricContextForRequest('put me in it too', people, { adjustFrom: vocalAnchor }).about,
    ).toBe('owner details');
  });
});

describe('deriveNamedSnapshotForIntent for a request that includes the listener', () => {
  const vocal = compileStructuredControls({ vocal: 'vocal', genres: ['pop'] });

  function stubExpansion(includesListener: boolean) {
    const expand = vi.fn(
      async (
        _intent: string,
        _listener: unknown,
        _picks: unknown,
        _options?: ExpansionOptions,
      ) => ({ snapshot: vocal, coverConcept: '', includesListener }),
    );
    llmHolder.provider = {
      expandSessionIntentWithMetadata: expand,
      createSessionMetadata: vi.fn(),
    } as unknown as LlmProvider;
    return expand;
  }

  function withOwnerAbout<T>(run: () => Promise<T>): Promise<T> {
    peopleHolder.people = [
      { id: 'owner', role: 'owner', name: 'John', nameMatchKey: 'john', about: 'owner details' },
    ];
    return run().finally(() => {
      peopleHolder.people = [];
    });
  }

  it("hands the listener's own About to the expansion and returns its answer", async () => {
    const expand = stubExpansion(true);
    const result = await withOwnerAbout(() =>
      deriveNamedSnapshotForIntent({} as never, 'owner', {
        mode: 'prompt',
        prompt: 'Sing about me on a trip to the moon',
      }),
    );
    expect(expand.mock.calls[0]?.[1]).toEqual({ about: 'owner details' });
    expect(result.ok && result.includesListener).toBe(true);
  });

  it('reads no About for a session started without the profile', async () => {
    const expand = stubExpansion(false);
    await withOwnerAbout(() =>
      deriveNamedSnapshotForIntent(
        {} as never,
        'owner',
        { mode: 'prompt', prompt: 'Sing about me on a trip to the moon' },
        { skipProfile: true },
      ),
    );
    expect(expand.mock.calls[0]?.[1]).toBeNull();
  });

  it('hands a session run without the profile only the People it names, never the owner', async () => {
    const expand = stubExpansion(false);
    peopleHolder.people = [
      { id: 'owner', role: 'owner', name: 'John', nameMatchKey: 'john', about: 'owner details' },
      {
        id: 'julia',
        role: 'ordinary',
        name: 'Julia',
        nameMatchKey: 'julia',
        about: 'repairs bicycles',
      },
    ];
    try {
      await deriveNamedSnapshotForIntent(
        {} as never,
        'owner',
        { mode: 'prompt', prompt: 'Sing a birthday song for Julia, from John' },
        { skipProfile: true },
      );
    } finally {
      peopleHolder.people = [];
    }
    expect(expand.mock.calls[0]?.[1]).toEqual({
      people: [{ name: 'Julia', about: 'repairs bicycles' }],
    });
  });

  it('answers no for a request no text LLM reads', async () => {
    llmHolder.provider = null;
    const result = await deriveNamedSnapshotForIntent({} as never, 'owner', {
      mode: 'prompt',
      prompt: 'Sing about me on a trip to the moon',
    });
    expect(result.ok && result.includesListener).toBe(false);
  });
});

// The naming call doubles as the personalization selector for the create paths
// that never ran an expansion. The PROVIDER contract guarantees the proposal's
// lyricContext is empty unless the session is vocal with a profile (tested at the
// provider level), so the merge here is a plain fill-if-empty.
describe('nameSessionSnapshot listener personalization merge', () => {
  const naming = {
    title: 'Trail Songs',
    trackTitles: ['One'],
    lyricContext: 'kids on trails',
    coverConcept: 'A worn trail marker under moving clouds.',
  };

  it('adopts the naming lyricContext on a snapshot without one', async () => {
    llmHolder.provider = {
      createSessionMetadata: async () => naming,
    } as unknown as LlmProvider;
    const snapshot = compileStructuredControls({ vocal: 'vocal', genres: ['pop'] });
    const { snapshot: stored } = await nameSessionSnapshot(null, snapshot, { name: 'John' });
    expect(stored.lyricContext).toBe('kids on trails');
    expect(stored.title).toBe('Trail Songs');
  });

  it('keeps an expansion-provided lyricContext (naming never overwrites it)', async () => {
    llmHolder.provider = {
      createSessionMetadata: async () => naming,
    } as unknown as LlmProvider;
    const snapshot = {
      ...compileStructuredControls({ vocal: 'vocal', genres: ['pop'] }),
      lyricContext: 'from the expansion',
    };
    const { snapshot: stored } = await nameSessionSnapshot(null, snapshot, { name: 'John' });
    expect(stored.lyricContext).toBe('from the expansion');
  });

  it('never adds a naming call after the free-text expansion call', async () => {
    const createSessionMetadata = vi.fn(async () => naming);
    llmHolder.provider = { createSessionMetadata } as unknown as LlmProvider;
    const snapshot = compileStructuredControls({ genres: ['ambient'] });
    const named = await nameSessionSnapshot(
      'free-text intent',
      snapshot,
      null,
      'A glass prism holding one cloud.',
      false,
    );
    expect(createSessionMetadata).not.toHaveBeenCalled();
    expect(named.coverConcept).toBe('A glass prism holding one cloud.');
  });
});

// The free-text path makes at most ONE LLM call per derivation: the
// expansion returns naming in the same call, so the prompt path never gets a
// separate naming call — with an LLM that means no second call even when the
// expansion returned no naming; without one the deterministic composition names
// the session.
describe('deriveNamedSnapshotForIntent prompt-path naming', () => {
  it('never adds a naming call for a prompt intent, even on an unnamed expansion', async () => {
    const expand = vi.fn(async () => ({
      snapshot: compileStructuredControls({ genres: ['ambient'] }),
      coverConcept: '',
    }));
    const createSessionMetadata = vi.fn();
    llmHolder.provider = {
      expandSessionIntentWithMetadata: expand,
      createSessionMetadata,
    } as unknown as LlmProvider;
    const result = await deriveNamedSnapshotForIntent({} as never, 'owner', {
      mode: 'prompt',
      prompt: 'evening chill',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(createSessionMetadata).not.toHaveBeenCalled();
    expect(result.title.trim()).not.toBe('');
  });

  it('composes a deterministic Name for a no-LLM prompt intent', async () => {
    llmHolder.provider = null;
    const result = await deriveNamedSnapshotForIntent({} as never, 'owner', {
      mode: 'prompt',
      prompt: 'evening chill',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userPrompt).toBe('evening chill');
    expect(result.snapshot.title).toBe('');
    expect(result.title.trim()).not.toBe('');
  });
});

// A Change Vibe adjustment (`adjustFrom`) reuses the running session's creative
// naming: the Name is never touched, the pool follows it, and no
// second naming call runs — only the vibe fields change.
describe('deriveNamedSnapshotForIntent adjustment naming', () => {
  it('keeps the running session naming and skips the naming call', async () => {
    const expand = vi.fn(
      async (
        _intent: string,
        _listener: unknown,
        _picks: unknown,
        options?: { adjustFrom?: unknown },
      ) => ({
        snapshot: {
          ...compileStructuredControls({ genres: ['ambient'] }),
          title: 'Model Title',
          trackTitles: ['Model One'],
        },
        coverConcept: 'a new concept',
        _options: options,
      }),
    );
    const createSessionMetadata = vi.fn();
    llmHolder.provider = {
      expandSessionIntentWithMetadata: expand,
      createSessionMetadata,
    } as unknown as LlmProvider;
    const adjustFrom = {
      ...compileStructuredControls({ genres: ['pop'] }),
      title: 'Evening Glow',
      trackTitles: ['Dusk', 'Ember'],
    };
    const result = await deriveNamedSnapshotForIntent(
      {} as never,
      'owner',
      { mode: 'prompt', prompt: 'a bit faster' },
      { adjustFrom },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.title).toBe('Evening Glow');
    expect(result.snapshot.trackTitles).toEqual(['Dusk', 'Ember']);
    expect(result.title).toBe('Evening Glow');
    expect(createSessionMetadata).not.toHaveBeenCalled();
    expect(expand.mock.calls[0]?.[3]?.adjustFrom).toBe(adjustFrom);
  });
});

// A Change Vibe adjusts the lyrical direction instead of rebuilding it: the
// running notes and the session's prompt history reach the expansion, and the
// preservation backstop decides what survives a weak or instrumental reply.
describe('deriveNamedSnapshotForIntent adjustment lyric continuity', () => {
  const NOTES = 'people: John + Tina, partners; story moments: bike trip London to Paris';
  const HISTORY = 'a song for John and Tina about their bike trip from London to Paris';
  const vocalFolk = compileStructuredControls({ vocal: 'vocal', genres: ['folk'] });
  const anchor: SessionStyleSnapshot = {
    ...vocalFolk,
    lyricContext: NOTES,
    title: 'Two Wheels',
    trackTitles: ['Roll On'],
  };
  function vocalReply(lyricContext: string): SessionStyleSnapshot {
    return { ...vocalFolk, lyricContext };
  }

  function stubExpansion(snapshot: SessionStyleSnapshot) {
    const expand = vi.fn(
      async (
        _intent: string,
        _listener: unknown,
        _picks: unknown,
        _options?: ExpansionOptions,
      ) => ({ snapshot, coverConcept: '' }),
    );
    llmHolder.provider = {
      expandSessionIntentWithMetadata: expand,
      createSessionMetadata: vi.fn(),
    } as unknown as LlmProvider;
    return expand;
  }

  function adjust(options?: Partial<ExpansionOptions>) {
    return deriveNamedSnapshotForIntent(
      {} as never,
      'owner',
      { mode: 'prompt', prompt: 'use berlin instead of london' },
      { adjustFrom: anchor, promptHistory: HISTORY, ...options },
    );
  }

  it('hands the running notes and the prompt history to the expansion', async () => {
    const expand = stubExpansion(vocalReply('edited'));
    await adjust();
    const options = expand.mock.calls[0]?.[3];
    expect(options?.adjustFrom?.lyricContext).toBe(NOTES);
    expect(options?.promptHistory).toBe(HISTORY);
  });

  it('keeps the notes the model edited', async () => {
    const edited = 'people: John + Tina, partners; story moments: bike trip Berlin to Paris';
    stubExpansion(vocalReply(edited));
    const result = await adjust();
    expect(result.ok && result.snapshot.lyricContext).toBe(edited);
  });

  it('falls back to the current notes when a vocal reply returns none', async () => {
    stubExpansion(vocalReply(''));
    const result = await adjust();
    expect(result.ok && result.snapshot.lyricContext).toBe(NOTES);
  });

  it('clears the notes when the adjustment turns the session instrumental', async () => {
    stubExpansion(compileStructuredControls({ genres: ['ambient'] }));
    const result = await adjust();
    expect(result.ok && result.snapshot.lyricContext).toBe('');
  });
});

// More Like This must not clone its source's names: the seed snapshot arrives
// WITH the source session's title and track-title pool, and reusing them
// verbatim would make every seeded session (and its first tracks) read
// identically to the source.
describe('nameSeededSnapshot', () => {
  const seed = {
    stylePrompt: 'mellow lofi beats',
    title: 'Focus Flow',
    trackTitles: ['Quiet Desk', 'Slow Rain'],
  };

  it('names the seeded session fresh, passing the source names as taken', async () => {
    const createSessionMetadata = vi.fn(
      async (_input: {
        snapshot: { title: string; trackTitles: string[] };
        avoidTitles?: string[];
      }) => ({
        title: 'Deep Focus Drift',
        trackTitles: ['First Light', 'Second Wind'],
        lyricContext: '',
        coverConcept: 'A quiet desk at dawn.',
      }),
    );
    llmHolder.provider = { createSessionMetadata } as unknown as LlmProvider;
    const named = await nameSeededSnapshot({} as never, 'owner', seed);
    expect(createSessionMetadata).toHaveBeenCalledOnce();
    const input = createSessionMetadata.mock.calls[0]![0];
    expect(input.snapshot.title).toBe('');
    expect(input.snapshot.trackTitles).toEqual([]);
    expect(input.avoidTitles).toEqual(['Focus Flow', 'Quiet Desk', 'Slow Rain']);
    expect(named.title).toBe('Deep Focus Drift');
    expect(named.snapshot.title).toBe('Deep Focus Drift');
    expect(named.snapshot.trackTitles).toEqual(['First Light', 'Second Wind']);
    expect(named.snapshot.stylePrompt).toBe('mellow lofi beats');
    expect(named.coverConcept).toBe('A quiet desk at dawn.');
  });

  it('composes a deterministic name — never the source name — without an LLM', async () => {
    llmHolder.provider = null;
    const named = await nameSeededSnapshot({} as never, 'owner', seed);
    expect(named.title).not.toBe('Focus Flow');
    expect(named.snapshot.title).toBe('');
    expect(named.snapshot.trackTitles).toEqual([]);
  });

  // Guardrails are part of what "this" sounds like, so a seeded session inherits
  // the source's; but MLT creates a NEW session, and those always carry concrete
  // values — so a pre-guardrails source seeds the domain defaults.
  it('inherits the source guardrails without merging its Avoid terms in twice', async () => {
    llmHolder.provider = null;
    const named = await nameSeededSnapshot({} as never, 'owner', {
      ...seed,
      vocalMode: 'instrumental',
      // The stored terms are the source's already-merged ones, in the spelling
      // the merge normalized — re-merging must recognize them as the same terms.
      negativeTerms: ['vocals', 'saxophone'],
      styleStrength: 0.9,
      novelty: 0.05,
      userAvoid: 'Saxophone',
    });
    expect(named.snapshot.styleStrength).toBe(0.9);
    expect(named.snapshot.novelty).toBe(0.05);
    expect(named.snapshot.userAvoid).toBe('Saxophone');
    expect(named.snapshot.negativeTerms).toEqual(['vocals', 'saxophone']);
  });

  it('seeds the domain defaults from a pre-guardrails source', async () => {
    llmHolder.provider = null;
    const named = await nameSeededSnapshot({} as never, 'owner', {
      ...seed,
      vocalMode: 'instrumental',
      negativeTerms: ['vocals'],
    });
    expect(named.snapshot.styleStrength).toBe(DEFAULT_STYLE_STRENGTH);
    expect(named.snapshot.novelty).toBe(DEFAULT_NOVELTY);
    expect(named.snapshot.userAvoid).toBeUndefined();
    expect(named.snapshot.negativeTerms).toEqual(['vocals']);
  });

  // A FOREIGN seed: the visitor's new session carries the vibe, never
  // the sharer's identity. Without the strip, the stored snapshot would make the
  // worker resolve the VISITOR's voice profile for the SHARER's "own voice"
  // intent, and the sharer's personal lyric notes (their People) would ride into
  // the visitor's lyrics.
  it('strips a foreign seed of the owner’s personal ingredients, keeping the musical identity', () => {
    const stripped = stripPersonalIngredients({
      stylePrompt: 'warm synthwave, night drive',
      genreTags: ['synthwave'],
      energy: 'high',
      vocalMode: 'vocal',
      voiceGender: 'female',
      language: 'German',
      bpm: 112,
      key: 'F minor',
      styleStrength: 0.8,
      novelty: 0.2,
      userAvoid: 'saxophone',
      negativeTerms: ['saxophone'],
      useOwnVoice: true,
      lyricContext: 'people: Mira, my sister; scene: rooftop at dusk',
    });
    expect(stripped.useOwnVoice).toBe(false);
    expect(stripped.lyricContext).toBe('');
    // The generic vocal pick survives — stripping degrades to generic vocals,
    // never to a different vibe; blocking More Like This would be a dead end.
    expect(stripped).toMatchObject({
      stylePrompt: 'warm synthwave, night drive',
      genreTags: ['synthwave'],
      energy: 'high',
      vocalMode: 'vocal',
      voiceGender: 'female',
      language: 'German',
      bpm: 112,
      key: 'F minor',
      styleStrength: 0.8,
      novelty: 0.2,
      userAvoid: 'saxophone',
      negativeTerms: ['saxophone'],
    });
  });

  it('steps aside when the deterministic composition would clone the source', async () => {
    // A deterministically-named source composes its Name from the same vibe
    // fields the seeded session inherits — identical inputs, identical Name.
    llmHolder.provider = null;
    const deterministicSeed = {
      stylePrompt: 'mellow lofi beats',
      mood: 'calm',
      activity: 'studying',
      genreTags: ['lofi'],
    };
    const named = await nameSeededSnapshot({} as never, 'owner', deterministicSeed);
    const sourceTitle = deriveSessionTitle({ snapshot: deterministicSeed });
    expect(named.title).not.toBe(sourceTitle);
    expect(named.title).toBe(`${sourceTitle} II`);
  });
});
