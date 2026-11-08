import { describe, expect, it } from 'vitest';
import { DEFAULT_NOVELTY, DEFAULT_STYLE_STRENGTH } from '@liedmotif/shared';
import { MAX_STYLE_PROMPT_LENGTH, sessionStyleSnapshotSchema } from './snapshot';
import {
  applyGuardrails,
  applyStylePicks,
  buildSessionStyle,
  buildTrackPrompt,
  compilePromptPassthrough,
  compileStructuredControls,
  deriveSiblingTrackTitles,
  deriveTrackMetadata,
  freezeStyleParameters,
} from './template';

describe('compileStructuredControls (deterministic, no LLM)', () => {
  it('compiles controls into a valid Style Snapshot, deterministically', () => {
    const controls = {
      activity: 'focus',
      mood: 'calm',
      energy: 'low' as const,
      genres: ['lofi', 'ambient'],
      vocal: 'instrumental' as const,
    };
    const snapshot = compileStructuredControls(controls);

    // It is a valid snapshot and stable across calls.
    expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(compileStructuredControls(controls)).toEqual(snapshot);

    expect(snapshot.genreTags).toEqual(['lofi', 'ambient']);
    expect(snapshot.vocalMode).toBe('instrumental');
    expect(snapshot.energy).toBe('low');
    for (const term of ['lofi', 'focus', 'calm', 'low']) {
      expect(snapshot.stylePrompt.toLowerCase()).toContain(term);
    }
    // Instrumental sessions steer away from vocals.
    expect(snapshot.negativeTerms).toContain('vocals');
  });

  it('freezes a deterministic bpm/key and hidden seed parameters (no LLM)', () => {
    const controls = { energy: 'low' as const, genres: ['lofi', 'ambient'] };
    const snapshot = compileStructuredControls(controls);

    // One frozen BPM + key per session, derived deterministically.
    expect(typeof snapshot.bpm).toBe('number');
    expect(snapshot.bpm).toBeGreaterThan(0);
    expect(snapshot.key.length).toBeGreaterThan(0);
    expect(typeof snapshot.seedParameters.baseSeed).toBe('number');

    // The SAME controls always compile to the SAME bpm/key (determinism).
    const again = compileStructuredControls(controls);
    expect(again.bpm).toBe(snapshot.bpm);
    expect(again.key).toBe(snapshot.key);
    expect(again.seedParameters).toEqual(snapshot.seedParameters);
  });

  it('overwrites the schema default seed: different controls freeze different baseSeeds', () => {
    // A producer must derive the frozen baseSeed from the (controls-derived) style,
    // not leave the schema's safety-net default — otherwise every session would
    // share one seed. Different controls → different baseSeed → different track seeds.
    const a = compileStructuredControls({ genres: ['lofi'], activity: 'focus' });
    const b = compileStructuredControls({ genres: ['techno'], energy: 'high' });
    expect(a.seedParameters.baseSeed).not.toBe(0); // not the bare-parse default
    expect(a.seedParameters.baseSeed).not.toBe(b.seedParameters.baseSeed);
    expect(buildTrackPrompt(a, 0).seed).not.toBe(buildTrackPrompt(b, 0).seed);
    // ...yet the SAME controls always freeze the SAME baseSeed (determinism).
    expect(
      compileStructuredControls({ genres: ['lofi'], activity: 'focus' }).seedParameters,
    ).toEqual(a.seedParameters);
  });

  it('re-derives a blank or overlong producer key so the style tail always fits a tight cap', () => {
    // The free-text LLM path can hand `freezeStyleParameters` an arbitrary `key`
    // string; an unbounded key would ride the per-track style TAIL — the part the
    // cap-aware budget promises survives every provider clamp.
    const frozen = freezeStyleParameters(
      sessionStyleSnapshotSchema.parse({
        stylePrompt: 'lofi beats',
        bpm: 96,
        key: 'x'.repeat(300),
      }),
    );
    expect(frozen.key.length).toBeLessThanOrEqual(24);
    expect(frozen.bpm).toBe(96);
    const capped = buildTrackPrompt(frozen, 0, 200);
    expect(capped.style.length).toBeLessThanOrEqual(200);
    expect(capped.style.endsWith(frozen.key)).toBe(true);
    // ...while a plausible short key is kept verbatim (trimmed).
    expect(
      freezeStyleParameters(
        sessionStyleSnapshotSchema.parse({ stylePrompt: 'lofi beats', key: ' F# minor ' }),
      ).key,
    ).toBe('F# minor');
  });

  it('derives different frozen BPMs for different energy levels', () => {
    const low = compileStructuredControls({ energy: 'low', genres: ['lofi'] });
    const high = compileStructuredControls({ energy: 'high', genres: ['lofi'] });
    expect(low.bpm).not.toBe(high.bpm);
    expect(low.bpm!).toBeLessThan(high.bpm!);
  });

  it('always yields a non-empty stylePrompt even with no controls', () => {
    const snapshot = compileStructuredControls({});
    expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.stylePrompt.length).toBeGreaterThan(0);
    expect(snapshot.vocalMode).toBe('instrumental'); // default
  });

  it('never throws on overlong input — it clamps to a valid snapshot', () => {
    const snapshot = compileStructuredControls({ mood: 'x'.repeat(5000) });
    expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.stylePrompt.length).toBeLessThanOrEqual(1000);
  });
});

describe('compileStructuredControls is total — never throws on malformed input', () => {
  function expectValid(snapshot: ReturnType<typeof compileStructuredControls>): void {
    expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.stylePrompt.length).toBeGreaterThan(0);
  }

  it('tolerates undefined controls', () => {
    expect(() => compileStructuredControls(undefined as never)).not.toThrow();
    expectValid(compileStructuredControls(undefined as never));
  });

  it('ignores genres that are not an array of strings', () => {
    expectValid(compileStructuredControls({ genres: 'lofi' as never }));
    expect(compileStructuredControls({ genres: 'lofi' as never }).genreTags).toEqual([]);
    expect(
      compileStructuredControls({ genres: ['lofi', 5 as never, '', null as never] }).genreTags,
    ).toEqual(['lofi']);
  });

  it('tolerates non-string mood/activity', () => {
    const snapshot = compileStructuredControls({ mood: 5 as never, activity: {} as never });
    expectValid(snapshot);
    expect(snapshot.mood).toBe('');
    expect(snapshot.activity).toBe('');
  });

  it('coerces an out-of-set energy/vocal to the defaults', () => {
    const snapshot = compileStructuredControls({
      energy: 'extreme' as never,
      vocal: 'humming' as never,
    });
    expectValid(snapshot);
    expect(snapshot.energy).toBe('medium');
    expect(snapshot.vocalMode).toBe('instrumental');
  });

  it('returns the fallback (never throws) for a throwing getter / proxy input', () => {
    const evil = Object.defineProperty({}, 'genres', {
      get() {
        throw new Error('boom');
      },
    }) as never;
    expect(() => compileStructuredControls(evil)).not.toThrow();
    expectValid(compileStructuredControls(evil));
  });

  it('caps each genre tag length so a huge tag cannot bloat the snapshot', () => {
    const snapshot = compileStructuredControls({ genres: ['x'.repeat(5000)] });
    expectValid(snapshot);
    expect((snapshot.genreTags[0] ?? '').length).toBeLessThanOrEqual(60);
    expect(snapshot.titleScheme.length).toBeLessThanOrEqual(60);
  });

  it('drops the vocals negative and marks vocal mode when vocals are requested', () => {
    const snapshot = compileStructuredControls({ genres: ['pop'], vocal: 'vocal' });
    expect(snapshot.vocalMode).toBe('vocal');
    expect(snapshot.negativeTerms).not.toContain('vocals');
  });
});

describe('compileStructuredControls Voice pick', () => {
  it('carries a Voice pick as voiceGender on a vocal session', () => {
    const snapshot = compileStructuredControls({ vocal: 'vocal', voice: 'female' });
    expect(snapshot.voiceGender).toBe('female');
    // The gender rides the per-track vocal tail (like `language`), not the base
    // style — so the base still reads "with vocals" without duplication.
    expect(snapshot.stylePrompt).toContain('with vocals');
  });

  it('ignores a Voice pick on an instrumental session and coerces junk to unset', () => {
    expect(compileStructuredControls({ voice: 'female' }).voiceGender).toBe('');
    expect(compileStructuredControls({ vocal: 'vocal', voice: 'robot' as never }).voiceGender).toBe(
      '',
    );
  });
});

describe('compileStructuredControls own-voice opt-in', () => {
  it('carries ownVoice on a vocal session and clears the gender tag', () => {
    const snapshot = compileStructuredControls({ vocal: 'vocal', ownVoice: true, voice: 'female' });
    expect(snapshot.useOwnVoice).toBe(true);
    // The user's own voice defines the singer — a gender tag would fight it.
    expect(snapshot.voiceGender).toBe('');
  });

  it('ignores ownVoice on an instrumental session', () => {
    expect(compileStructuredControls({ ownVoice: true }).useOwnVoice).toBe(false);
    expect(compileStructuredControls({}).useOwnVoice).toBe(false);
  });
});

describe('compilePromptPassthrough (deterministic, no LLM)', () => {
  it('compiles the trimmed user text as the style core, deterministically', () => {
    const snapshot = compilePromptPassthrough('  rainy night drive, tape hiss  ');

    expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
    // The words reach the music model as written — no template prose around them.
    expect(snapshot.stylePrompt).toBe('rainy night drive, tape hiss');
    // Same input ⇒ same snapshot, including the frozen seed (determinism).
    expect(compilePromptPassthrough('  rainy night drive, tape hiss  ')).toEqual(snapshot);

    // App default: instrumental, with the anti-vocals steer.
    expect(snapshot.vocalMode).toBe('instrumental');
    expect(snapshot.negativeTerms).toEqual(['vocals']);

    // A concrete frozen BPM/key + a text-derived baseSeed.
    expect(typeof snapshot.bpm).toBe('number');
    expect(snapshot.key.length).toBeGreaterThan(0);
    expect(snapshot.seedParameters.baseSeed).not.toBe(0);

    // No LLM ran: nothing cosmetic or personal is filled.
    expect(snapshot.mood).toBe('');
    expect(snapshot.activity).toBe('');
    expect(snapshot.lyricContext).toBe('');
    expect(snapshot.title).toBe('');
    expect(snapshot.trackTitles).toEqual([]);
    expect(snapshot.titleScheme).toBe('rainy night drive');
  });

  it('freezes different baseSeeds for different texts', () => {
    const a = compilePromptPassthrough('rainy night drive');
    const b = compilePromptPassthrough('sunny beach morning');
    expect(a.seedParameters.baseSeed).not.toBe(b.seedParameters.baseSeed);
  });

  it('enforces the fine-tune picks exactly as the describe path does', () => {
    const snapshot = compilePromptPassthrough('rainy night drive', {
      genres: ['techno', 'ambient'],
      energy: 'high',
      vocal: 'vocal',
      voice: 'female',
      language: 'German',
    });
    // Genre picks lead the tags and the style; the first pick names the scheme.
    expect(snapshot.genreTags.slice(0, 2)).toEqual(['techno', 'ambient']);
    expect(snapshot.stylePrompt).toContain('techno');
    expect(snapshot.stylePrompt).toContain('rainy night drive');
    expect(snapshot.titleScheme).toBe('techno');
    // A vocal pick flips the instrumental default and drops the anti-vocals steer.
    expect(snapshot.vocalMode).toBe('vocal');
    expect(snapshot.negativeTerms).not.toContain('vocals');
    expect(snapshot.voiceGender).toBe('female');
    expect(snapshot.language).toBe('German');
    // A forced energy freezes its own tempo, not the medium default's.
    expect(snapshot.energy).toBe('high');
    expect(snapshot.bpm!).toBeGreaterThan(120);
  });

  it('anchors an adjustment on the running snapshot: only the words and the explicit picks move', () => {
    const anchor = compilePromptPassthrough('summer road trip', {
      genres: ['pop'],
      vocal: 'vocal',
      voice: 'female',
      language: 'German',
    });
    const running = { ...anchor, lyricContext: 'people: Ada', useOwnVoice: true };

    const adjusted = compilePromptPassthrough('slower and dreamier', undefined, running);
    expect(adjusted.stylePrompt).toBe('pop, slower and dreamier');
    expect(adjusted).toMatchObject({
      genreTags: ['pop'],
      vocalMode: 'vocal',
      voiceGender: 'female',
      language: 'German',
      lyricContext: 'people: Ada',
      bpm: anchor.bpm,
      key: anchor.key,
      titleScheme: 'pop',
    });
    // Own voice rides only as an explicit pick, so the caller re-checks the profile.
    expect(adjusted.useOwnVoice).toBe(false);

    const faster = compilePromptPassthrough('slower and dreamier', { energy: 'high' }, running);
    expect(faster.bpm!).toBeGreaterThan(anchor.bpm!);
    expect(faster.key).toBe(anchor.key);

    const instrumental = compilePromptPassthrough('ambient', { vocal: 'instrumental' }, running);
    expect(instrumental).toMatchObject({
      vocalMode: 'instrumental',
      voiceGender: '',
      lyricContext: '',
      negativeTerms: ['vocals'],
      genreTags: ['pop'],
    });

    // A genre pick replaces the running genres, so a deselected one stays gone.
    const regenred = compilePromptPassthrough('slower and dreamier', { genres: ['jazz'] }, running);
    expect(regenred.genreTags).toEqual(['jazz']);
    expect(regenred.stylePrompt).toBe('jazz, slower and dreamier');
  });

  it('clamps the text to the snapshot style cap without throwing', () => {
    const snapshot = compilePromptPassthrough('y'.repeat(5000));
    expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.stylePrompt).toBe('y'.repeat(MAX_STYLE_PROMPT_LENGTH));
  });

  it('is total — malformed input yields the fallback, never a throw', () => {
    for (const junk of [undefined, 42, {}, '', '   ']) {
      expect(() => compilePromptPassthrough(junk as never)).not.toThrow();
      const snapshot = compilePromptPassthrough(junk as never);
      expect(sessionStyleSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.stylePrompt.length).toBeGreaterThan(0);
    }
    const evil = Object.defineProperty({}, 'genres', {
      get() {
        throw new Error('boom');
      },
    }) as never;
    expect(() => compilePromptPassthrough('rainy night drive', evil)).not.toThrow();
    expect(
      sessionStyleSnapshotSchema.safeParse(compilePromptPassthrough('rainy night drive', evil))
        .success,
    ).toBe(true);
  });
});

describe('applyStylePicks (deterministic fine-tune enforcement on a produced snapshot)', () => {
  const base = () =>
    sessionStyleSnapshotSchema.parse({
      stylePrompt: 'calm lofi beats, low energy, instrumental',
      genreTags: ['lofi'],
      vocalMode: 'instrumental',
      energy: 'low',
      negativeTerms: ['vocals'],
      bpm: 70,
      key: 'A minor',
    });

  it('returns the snapshot unchanged when there are no picks', () => {
    expect(applyStylePicks(base(), undefined)).toEqual(base());
    expect(applyStylePicks(base(), {})).toEqual(base());
  });

  it('leads genreTags and the style with explicit genre picks', () => {
    const picked = applyStylePicks(base(), { genres: ['techno', 'ambient'] });
    expect(picked.genreTags.slice(0, 2)).toEqual(['techno', 'ambient']);
    expect(picked.stylePrompt).toContain('techno');
    expect(picked.stylePrompt).toContain('ambient');
  });

  it('a forced energy overrides the model and re-freezes the tempo from it', () => {
    const forced = freezeStyleParameters(applyStylePicks(base(), { energy: 'high' }));
    expect(forced.energy).toBe('high');
    // The model's BPM reflected ITS energy reading; a forced energy re-derives
    // the frozen tempo so the session actually pushes harder.
    expect(forced.bpm).not.toBe(70);
    expect(forced.bpm!).toBeGreaterThan(120);
    // The style text follows: the stale "low energy" tag is rewritten.
    expect(forced.stylePrompt).toContain('high energy');
    expect(forced.stylePrompt).not.toContain('low energy');
  });

  it('a matching energy pick keeps the model tempo (nothing to correct)', () => {
    const kept = freezeStyleParameters(applyStylePicks(base(), { energy: 'low' }));
    expect(kept.bpm).toBe(70);
  });

  it('a forced vocal mode flips the snapshot to vocals', () => {
    const forced = applyStylePicks(base(), { vocal: 'vocal' });
    expect(forced.vocalMode).toBe('vocal');
    expect(forced.negativeTerms).not.toContain('vocals');
    // The contradicting "instrumental" style tag is removed and vocals appear.
    expect(forced.stylePrompt).not.toMatch(/\binstrumental\b/i);
    expect(forced.stylePrompt).toMatch(/vocals/i);
  });

  it('a vocal pick drops an echoed anti-vocals steer even when the model already went vocal', () => {
    const echoed = { ...base(), vocalMode: 'vocal' as const, negativeTerms: ['vocals', 'piano'] };
    expect(applyStylePicks(echoed, { vocal: 'vocal' }).negativeTerms).toEqual(['piano']);
  });

  it('a forced vocal mode never mangles a compound instrumental-family genre pick', () => {
    // "instrumental hip hop" is a real genre; only the BARE mode tag may be
    // dropped from the style — a word-level strip would mangle the pick the
    // user just made to "hip hop".
    const picked = applyStylePicks(base(), {
      genres: ['instrumental hip hop'],
      vocal: 'vocal',
    });
    expect(picked.stylePrompt).toContain('instrumental hip hop');
    expect(picked.genreTags[0]).toBe('instrumental hip hop');
    // ...while the base style's own bare "instrumental" segment is still gone.
    expect(picked.stylePrompt).not.toMatch(/\binstrumental\b(?! hip hop)/i);
  });

  it('a forced vocal mode drops a bare contradicting genre tag too', () => {
    // The model may echo "instrumental" as a genre tag; stamped on tracks it
    // would contradict the forced mode in the shortlist history. Compound tags
    // ("instrumental hip hop") are real genres and stay.
    const tagged = sessionStyleSnapshotSchema.parse({
      ...base(),
      genreTags: ['instrumental', 'instrumental hip hop', 'lofi'],
    });
    expect(applyStylePicks(tagged, { vocal: 'vocal' }).genreTags).toEqual([
      'instrumental hip hop',
      'lofi',
    ]);
  });

  it('a forced instrumental strips the vocal fields the words asked for', () => {
    const vocalSnapshot = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'dream pop with vocals',
      vocalMode: 'vocal',
      energy: 'medium',
      language: 'German',
      lyricContext: 'people: Tina',
      voiceGender: 'female',
    });
    const forced = applyStylePicks(vocalSnapshot, { vocal: 'instrumental' });
    expect(forced.vocalMode).toBe('instrumental');
    expect(forced.negativeTerms).toContain('vocals');
    // No lyrics exist on an instrumental session: lyric notes and the voice pick
    // are cleared so no vocal tail reaches the provider. The language is kept —
    // it also steers title language, and the vocal tail is mode-gated anyway.
    expect(forced.language).toBe('German');
    expect(forced.lyricContext).toBe('');
    expect(forced.voiceGender).toBe('');
    expect(forced.stylePrompt).not.toContain('with vocals');
    expect(forced.stylePrompt).toMatch(/\binstrumental\b/i);
  });

  it('a Voice pick sets voiceGender on a vocal result and is ignored on instrumental', () => {
    expect(applyStylePicks(base(), { vocal: 'vocal', voice: 'male' }).voiceGender).toBe('male');
    expect(applyStylePicks(base(), { voice: 'male' }).voiceGender).toBe('');
  });

  it('an ownVoice pick is honored on vocal results only and clears the gender tag', () => {
    const picked = applyStylePicks(base(), { vocal: 'vocal', voice: 'male', ownVoice: true });
    expect(picked.useOwnVoice).toBe(true);
    expect(picked.voiceGender).toBe('');
    // Without a vocal pick the base stays instrumental, so ownVoice is dropped.
    expect(applyStylePicks(base(), { ownVoice: true }).useOwnVoice).toBe(false);
    // A vocal → instrumental flip clears a producer-set ownVoice too.
    const vocalBase = applyStylePicks(base(), { vocal: 'vocal', ownVoice: true });
    expect(applyStylePicks(vocalBase, { vocal: 'instrumental' }).useOwnVoice).toBe(false);
  });

  it('a language pick lands on vocal AND instrumental results (it steers titles too)', () => {
    expect(applyStylePicks(base(), { language: 'Japanese' }).language).toBe('Japanese');
    expect(applyStylePicks(base(), { vocal: 'vocal', language: 'Japanese' }).language).toBe(
      'Japanese',
    );
  });

  it('a language pick overrides the producer language; junk leaves it untouched', () => {
    const detected = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'dream pop with vocals',
      vocalMode: 'vocal',
      language: 'Spanish',
    });
    expect(applyStylePicks(detected, { language: 'German' }).language).toBe('German');
    // An off-allowlist pick is never passed through — and never wipes a good value.
    expect(applyStylePicks(detected, { language: 'German exactly like Adele' }).language).toBe(
      'Spanish',
    );
  });
});

describe('applyGuardrails (Session Guardrails stamped onto a produced snapshot)', () => {
  const base = () =>
    sessionStyleSnapshotSchema.parse({
      stylePrompt: 'calm lofi beats, instrumental',
      negativeTerms: ['vocals'],
    });

  it('stamps the domain defaults when the intent carries no guardrails', () => {
    // "Always send": from creation forward the snapshot is self-contained, so a
    // Dislike reroll a week later compiles the same levels as its siblings.
    const stamped = applyGuardrails(base(), undefined);
    expect(stamped.styleStrength).toBe(DEFAULT_STYLE_STRENGTH);
    expect(stamped.novelty).toBe(DEFAULT_NOVELTY);
    expect(stamped.userAvoid).toBeUndefined();
    expect(stamped.negativeTerms).toEqual(['vocals']);
  });

  it('takes the intent levels over the defaults, clamped to the domain range', () => {
    // 0 is a real level (fully loose / fully safe), not "unset".
    expect(applyGuardrails(base(), { styleStrength: 0.9, novelty: 0 })).toMatchObject({
      styleStrength: 0.9,
      novelty: 0,
    });
    expect(applyGuardrails(base(), { styleStrength: 4 }).styleStrength).toBe(1);
  });

  it('appends the Avoid terms AFTER the system terms, deduped case-insensitively', () => {
    const stamped = applyGuardrails(base(), { avoid: ' Saxophone , , saxophone , VOCALS, brass ' });
    // System terms lead: the compiled negative tags are a bounded provider field,
    // so the instrumental steer must never be what a truncation drops. Empty
    // segments would otherwise ship as blank tags.
    expect(stamped.negativeTerms).toEqual(['vocals', 'Saxophone', 'brass']);
    // The Avoid text stays VERBATIM — it is the editable identity Change Vibe
    // re-seeds from, never the merge result.
    expect(stamped.userAvoid).toBe('Saxophone , , saxophone , VOCALS, brass');
  });
});

describe('compileStructuredControls language control', () => {
  it('carries the language on instrumental and vocal compiles alike', () => {
    expect(compileStructuredControls({ language: 'German' }).language).toBe('German');
    expect(compileStructuredControls({ vocal: 'vocal', language: 'German' }).language).toBe(
      'German',
    );
  });

  it('drops an off-allowlist language to unset', () => {
    expect(compileStructuredControls({ language: 'not a language' }).language).toBe('');
  });

  it('keeps an instrumental session language OUT of the compiled description', () => {
    const params = buildTrackPrompt(compileStructuredControls({ language: 'German' }), 0);
    expect(params.prompt).not.toContain('German');
    expect(params.instrumental).toBe(true);
  });

  it('folds the language into the vocal tail of a vocal compile', () => {
    const params = buildTrackPrompt(
      compileStructuredControls({ vocal: 'vocal', voice: 'female', language: 'German' }),
      0,
    );
    expect(params.prompt).toContain('female German vocals');
  });
});

describe('buildTrackPrompt (per-track variation, no LLM per track)', () => {
  const snapshot = compileStructuredControls({ genres: ['house'], activity: 'running' });

  it('is deterministic for a given snapshot + track index', () => {
    expect(buildTrackPrompt(snapshot, 0)).toEqual(buildTrackPrompt(snapshot, 0));
  });

  it('folds a seed-picked variation into the compiled style without moving BPM/key', () => {
    const params = [0, 1, 2, 3, 4, 5].map((index) => buildTrackPrompt(snapshot, index));
    // Every track keeps the session-frozen base style + BPM/key...
    for (const p of params) {
      expect(p.style).toContain(snapshot.stylePrompt);
      expect(p.style).toContain(snapshot.key);
      expect(p.style).toContain(String(snapshot.bpm));
      // One description per track — custom mode sends it as `style`, non-custom
      // (vocal) mode as `prompt`, so the variation reaches the provider either way.
      expect(p.prompt).toBe(p.style);
      expect(p.instrumental).toBe(true);
    }
    // ...while the seed-picked variation makes the compiled requests genuinely
    // differ across indices (sibling requests are never byte-identical).
    expect(new Set(params.map((p) => p.style)).size).toBeGreaterThan(1);
    expect(new Set(params.map((p) => p.seed)).size).toBe(params.length);
  });

  it('derives the per-track seed from the snapshot seed parameters (a reroll varies it)', () => {
    const base = buildTrackPrompt(snapshot, 0);
    // Bumping the hidden seed (what a Dislike reroll does) changes the track seed
    // for the SAME index — proving the seed flows from `seedParameters`, not a
    // parallel stylePrompt+index hash.
    const rerolled = buildTrackPrompt(
      { ...snapshot, seedParameters: { ...snapshot.seedParameters, rerollSalt: 1 } },
      0,
    );
    expect(rerolled.seed).not.toBe(base.seed);
  });

  it('a bumped rerollSalt changes the compiled style, not just the invisible seed', () => {
    // The variation is picked BY the seed, so a reroll actually changes what the
    // music provider receives — across a few salts at the same index,
    // more than one distinct style must appear.
    const styles = new Set(
      [0, 1, 2, 3, 4, 5].map(
        (rerollSalt) =>
          buildTrackPrompt(
            { ...snapshot, seedParameters: { ...snapshot.seedParameters, rerollSalt } },
            0,
          ).style,
      ),
    );
    expect(styles.size).toBeGreaterThan(1);
  });

  it('derives the per-track seed SOLELY from seedParameters, never from stylePrompt', () => {
    // Two snapshots that share a frozen baseSeed but differ in stylePrompt must
    // yield the SAME per-track seed: `seedParameters` is the one and only seed
    // source. There is no parallel stylePrompt-derived fallback.
    const a = sessionStyleSnapshotSchema.parse({ stylePrompt: 'lofi beats' });
    const b = sessionStyleSnapshotSchema.parse({ stylePrompt: 'totally different style words' });
    expect(typeof a.seedParameters.baseSeed).toBe('number');
    expect(buildTrackPrompt(a, 0).seed).toBe(buildTrackPrompt(b, 0).seed);
    expect(buildTrackPrompt(a, 1).seed).toBe(buildTrackPrompt(b, 1).seed);

    // ...while a different frozen baseSeed (same stylePrompt) DOES vary the seed.
    const reseeded = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'lofi beats',
      seedParameters: { baseSeed: 999, rerollSalt: 0 },
    });
    expect(buildTrackPrompt(reseeded, 0).seed).not.toBe(buildTrackPrompt(a, 0).seed);
  });

  it('passes negative terms through as provider negative tags', () => {
    const params = buildTrackPrompt(snapshot, 0);
    expect(params.negativeTags).toContain('vocals');
  });
});

describe('buildSessionStyle (the index-independent session style identity)', () => {
  const snapshot = compileStructuredControls({ genres: ['house'], activity: 'running' });

  it('carries the base style and frozen BPM/key but NO per-track variation', () => {
    const style = buildSessionStyle(snapshot);
    expect(style).toBe(`${snapshot.stylePrompt}, ${snapshot.bpm} bpm, ${snapshot.key}`);
    expect(style).toBe(buildSessionStyle(snapshot)); // deterministic
    // Index-independent by construction: per-track styles extend it with a
    // variation, so none of them may be mistaken for the session identity.
    for (const index of [0, 1, 2]) {
      expect(buildTrackPrompt(snapshot, index).style).not.toBe(style);
    }
  });

  it('budgets the BASE so the BPM/key tail survives a maximum-length stylePrompt', () => {
    const long = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'x'.repeat(MAX_STYLE_PROMPT_LENGTH),
      bpm: 96,
      key: 'A minor',
    });
    for (const style of [buildSessionStyle(long), buildTrackPrompt(long, 0).style]) {
      expect(style.length).toBeLessThanOrEqual(MAX_STYLE_PROMPT_LENGTH);
      expect(style.endsWith('96 bpm, A minor')).toBe(true);
    }
  });

  it('budgets a per-track description to a tighter provider cap, tail intact', () => {
    // A provider/model with a tight field cap (e.g. Suno V4 style: 200) must get a
    // description the adapter's boundary clamp never has to touch — the base
    // shrinks, the variation + BPM/key tail survives.
    const long = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'x'.repeat(MAX_STYLE_PROMPT_LENGTH),
      bpm: 96,
      key: 'A minor',
    });
    const capped = buildTrackPrompt(long, 0, 200);
    expect(capped.style.length).toBeLessThanOrEqual(200);
    expect(capped.style.endsWith('96 bpm, A minor')).toBe(true);
    expect(capped.style).toBe(capped.prompt);
  });
});

describe('deriveTrackMetadata (cosmetic, deterministic)', () => {
  it('produces a non-empty title and artist name without an LLM', () => {
    const snapshot = compileStructuredControls({ activity: 'studying', genres: ['lofi'] });
    const meta = deriveTrackMetadata(snapshot, 0);
    expect(meta.title.length).toBeGreaterThan(0);
    expect(meta.artistName.length).toBeGreaterThan(0);
    expect(deriveTrackMetadata(snapshot, 0)).toEqual(meta); // deterministic
  });
});

describe('deriveTrackMetadata / deriveSiblingTrackTitles (creative title pool)', () => {
  const pooled = {
    ...compileStructuredControls({ activity: 'studying', genres: ['lofi'] }),
    trackTitles: ['Amber Rain', 'Night Signal', 'Paper Tide'],
  };

  it('names each ordinal from the pool, numbering repeats past it by ordinal', () => {
    expect(deriveTrackMetadata(pooled, 0).title).toBe('Amber Rain');
    expect(deriveTrackMetadata(pooled, 2).title).toBe('Paper Tide');
    expect(deriveTrackMetadata(pooled, 3).title).toBe('Amber Rain 4');
    expect(deriveTrackMetadata(pooled, 7).title).toBe('Night Signal 8');
  });

  it('never repeats a numbered title when a partial refill grows the pool between calls', () => {
    const short = { ...pooled, trackTitles: ['Amber Rain', 'Night Signal'] };
    const grown = { ...pooled, trackTitles: ['Amber Rain', 'Night Signal', 'Paper Tide'] };
    const titles = [
      ...deriveSiblingTrackTitles(short, 1, 2),
      ...deriveSiblingTrackTitles(grown, 2, 2),
    ];
    expect(new Set(titles).size).toBe(4);
  });

  it('falls back to the numbered scheme without a pool', () => {
    const plain = compileStructuredControls({ activity: 'studying' });
    expect(deriveTrackMetadata(plain, 4).title).toBe('Studying 5');
  });

  it('gets a pool the schema already clamped (blanks dropped, overlong entries capped)', () => {
    const parsed = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'lofi beats',
      trackTitles: ['  ', 'Real Title', 'x'.repeat(500)],
    });
    expect(deriveTrackMetadata(parsed, 0).title).toBe('Real Title');
    expect(deriveTrackMetadata(parsed, 1).title.length).toBeLessThanOrEqual(80);
  });

  it('titles one call’s siblings distinctly, within a call and across calls', () => {
    const call0 = deriveSiblingTrackTitles(pooled, 0, 2);
    const call1 = deriveSiblingTrackTitles(pooled, 1, 2);
    expect(call0).toEqual(['Amber Rain', 'Night Signal']);
    expect(call1).toEqual(['Paper Tide', 'Amber Rain 4']);
    expect(new Set([...call0, ...call1]).size).toBe(4);

    // Same guarantee with NO pool: the numbered scheme keeps siblings distinct.
    const plain = compileStructuredControls({ activity: 'studying' });
    expect(deriveSiblingTrackTitles(plain, 3, 2)).toEqual(['Studying 7', 'Studying 8']);
  });
});

describe('buildTrackPrompt lyric personalization (vocal sessions only)', () => {
  const vocal = compileStructuredControls({ vocal: 'vocal', genres: ['pop'] });

  it('passes the compact lyric brief to the music model', () => {
    const params = buildTrackPrompt(
      {
        ...vocal,
        lyricContext:
          'people: John + Tina, parent/child; scene: rainy mountain climb; arc: strain to pride',
      },
      0,
    );
    expect(params.prompt).toContain(
      'Lyric brief: people: John + Tina, parent/child; scene: rainy mountain climb; arc: strain to pride',
    );
    // Both submitted shapes carry the one compiled description.
    expect(params.style).toBe(params.prompt);
  });

  it('never references lyric context on an instrumental session', () => {
    const instrumental = compileStructuredControls({ genres: ['pop'] });
    const params = buildTrackPrompt({ ...instrumental, lyricContext: 'stray context' }, 0);
    expect(params.prompt).not.toContain('stray context');
  });

  it('omits the clause entirely when a vocal session has no lyric context', () => {
    const params = buildTrackPrompt(vocal, 0);
    expect(params.prompt).not.toContain('Lyric brief');
  });

  it('keeps the lyric brief inside a tight provider cap (it rides the surviving tail)', () => {
    const long = {
      ...vocal,
      stylePrompt: 'x'.repeat(MAX_STYLE_PROMPT_LENGTH),
      lyricContext: 'people: John + Tina, parent/child',
    };
    const params = buildTrackPrompt(long, 0, 500);
    expect(params.prompt.length).toBeLessThanOrEqual(500);
    expect(params.prompt).toContain('Lyric brief: people: John + Tina, parent/child');
  });
});

describe('buildTrackPrompt vocal language tag (sing in the request language)', () => {
  const vocal = compileStructuredControls({ vocal: 'vocal', genres: ['pop'] });

  it('tags a vocal track description with the detected language', () => {
    const params = buildTrackPrompt({ ...vocal, language: 'German' }, 0);
    expect(params.prompt).toContain(', German vocals');
  });

  it('emits no tag when the language is unspecified or the session is instrumental', () => {
    // No "<Language> vocals" tag — the "with vocals" in the compiled controls
    // style is the vocal MODE, not a language tag.
    expect(buildTrackPrompt(vocal, 0).prompt).not.toMatch(/, [A-Z]\w+ vocals/);
    const instrumental = compileStructuredControls({ genres: ['pop'] });
    expect(buildTrackPrompt({ ...instrumental, language: 'German' }, 0).prompt).not.toContain(
      'German vocals',
    );
  });

  it('keeps the language tag before the lyric context when both are present', () => {
    const params = buildTrackPrompt(
      { ...vocal, language: 'German', lyricContext: 'people: John + Tina; scene: Radtour' },
      0,
    );
    expect(params.prompt).toMatch(
      /, German vocals\. Lyric brief: people: John \+ Tina; scene: Radtour$/,
    );
  });

  it('tags a vocal track with the picked voice gender, merged with the language', () => {
    expect(buildTrackPrompt({ ...vocal, voiceGender: 'female' }, 0).prompt).toContain(
      ', female vocals',
    );
    // One merged tag, never two: "female German vocals", not "German vocals, female vocals".
    const both = buildTrackPrompt({ ...vocal, voiceGender: 'female', language: 'German' }, 0);
    expect(both.prompt).toContain(', female German vocals');
    expect(both.prompt).not.toContain('German vocals, female');
    // Instrumental sessions never carry a voice tag.
    const instrumental = compileStructuredControls({ genres: ['pop'] });
    expect(buildTrackPrompt({ ...instrumental, voiceGender: 'female' }, 0).prompt).not.toContain(
      'female vocals',
    );
  });
});
