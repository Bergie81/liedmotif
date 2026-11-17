import { describe, expect, it } from 'vitest';
import {
  MAX_LYRIC_CONTEXT_LENGTH,
  sessionStyleSnapshotSchema,
  trackTitleRefillCount,
  type SessionStyleSnapshot,
} from './snapshot';

describe('sessionStyleSnapshotSchema', () => {
  it('requires only stylePrompt and fills the rest with safe defaults', () => {
    const parsed = sessionStyleSnapshotSchema.parse({ stylePrompt: 'lofi beats' });
    expect(parsed).toEqual<SessionStyleSnapshot>({
      stylePrompt: 'lofi beats',
      negativeTerms: [],
      mood: '',
      activity: '',
      genreTags: [],
      vocalMode: 'instrumental',
      energy: 'medium',
      titleScheme: '',
      title: '',
      trackTitles: [],
      lyricContext: '',
      language: '',
      voiceGender: '',
      useOwnVoice: false,
      safetyWarnings: [],
      // The frozen-blend fields default so a weak model response still
      // validates: BPM/key are "unknown" (a producer freezes them). The hidden seed
      // defaults to a frozen base so even a bare parse has a defined `baseSeed` —
      // `buildTrackPrompt` never has to recompute one from stylePrompt.
      bpm: null,
      key: '',
      seedParameters: { baseSeed: 0, rerollSalt: 0 },
    });
  });

  it('defaults a defined, deterministic frozen baseSeed (the one seed source)', () => {
    const a = sessionStyleSnapshotSchema.parse({ stylePrompt: 'lofi beats' });
    const b = sessionStyleSnapshotSchema.parse({ stylePrompt: 'dark techno' });
    // A bare parse always yields a numeric baseSeed — never undefined.
    expect(typeof a.seedParameters.baseSeed).toBe('number');
    // It is a fixed default (a producer overwrites it for per-session variety), so
    // it is identical regardless of stylePrompt and stable across parses.
    expect(a.seedParameters.baseSeed).toBe(0);
    expect(a.seedParameters).toEqual(b.seedParameters);
  });

  it('accepts a frozen bpm/key and hidden seed parameters when provided', () => {
    const parsed = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'dark techno',
      bpm: 128,
      key: 'A minor',
      seedParameters: { baseSeed: 7, rerollSalt: 0 },
    });
    expect(parsed.bpm).toBe(128);
    expect(parsed.key).toBe('A minor');
    expect(parsed.seedParameters).toEqual({ baseSeed: 7, rerollSalt: 0 });
  });

  it('rejects a non-positive or non-numeric bpm but allows null (unknown)', () => {
    expect(sessionStyleSnapshotSchema.safeParse({ stylePrompt: 'x', bpm: null }).success).toBe(
      true,
    );
    expect(sessionStyleSnapshotSchema.safeParse({ stylePrompt: 'x', bpm: 0 }).success).toBe(false);
    expect(
      sessionStyleSnapshotSchema.safeParse({ stylePrompt: 'x', bpm: '120' as never }).success,
    ).toBe(false);
  });

  it('rejects an empty stylePrompt (the one hard requirement)', () => {
    expect(sessionStyleSnapshotSchema.safeParse({ stylePrompt: '' }).success).toBe(false);
    expect(sessionStyleSnapshotSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an out-of-vocabulary vocalMode or energy', () => {
    expect(
      sessionStyleSnapshotSchema.safeParse({ stylePrompt: 'x', vocalMode: 'humming' }).success,
    ).toBe(false);
    expect(
      sessionStyleSnapshotSchema.safeParse({ stylePrompt: 'x', energy: 'extreme' }).success,
    ).toBe(false);
  });

  it('keeps provided values and is tolerant of extra fields a model may add', () => {
    const parsed = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'dark techno',
      genreTags: ['techno', 'industrial'],
      vocalMode: 'vocal',
      energy: 'high',
      extraneous: 'ignored',
    });
    expect(parsed.genreTags).toEqual(['techno', 'industrial']);
    expect(parsed.vocalMode).toBe('vocal');
    expect('extraneous' in parsed).toBe(false);
  });
});

describe('lyricContext (personal lyric details, LLM-selected)', () => {
  it('defaults empty and clamps an overlong value at parse (bounded prompt tail)', () => {
    expect(sessionStyleSnapshotSchema.parse({ stylePrompt: 'x' }).lyricContext).toBe('');
    const parsed = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'x',
      lyricContext: `  ${'a'.repeat(500)}`,
    });
    expect(parsed.lyricContext).toHaveLength(MAX_LYRIC_CONTEXT_LENGTH);
  });

  it('keeps notes that give each of six People a part in the scene', () => {
    const notes = [
      'theme: six friends on a moon adventure',
      'scene: Emma plots a calm crater route, Linh maps the terrain in light, ' +
        "Clara's alto answers Jonas's portable speaker, Kai fixes the rover radio, " +
        'Ana sings in Portuguese over the comms',
      'imagery: silver dust, blue Earth, bootprints circling a crater, neon visor glow',
      'arc: nervous countdown to weightless joy',
      'people: Emma, Jonas, Linh, Clara, Kai, Ana',
    ].join('; ');
    expect(notes.length).toBeGreaterThan(350);
    expect(
      sessionStyleSnapshotSchema.parse({ stylePrompt: 'x', lyricContext: notes }).lyricContext,
    ).toBe(notes);
  });
});

describe('voiceGender (explicit Voice pick for vocal sessions)', () => {
  it('defaults empty and keeps only the known genders (junk is dropped, not passed through)', () => {
    expect(sessionStyleSnapshotSchema.parse({ stylePrompt: 'x' }).voiceGender).toBe('');
    expect(
      sessionStyleSnapshotSchema.parse({ stylePrompt: 'x', voiceGender: 'female' }).voiceGender,
    ).toBe('female');
    expect(
      sessionStyleSnapshotSchema.parse({ stylePrompt: 'x', voiceGender: 'male' }).voiceGender,
    ).toBe('male');
    // The value rides a provider prompt tail, so anything out-of-vocabulary is
    // dropped at parse — mirrors `language`.
    for (const junk of ['robot', 'FEMALE like Adele', 'x'.repeat(80)]) {
      expect(
        sessionStyleSnapshotSchema.parse({ stylePrompt: 'x', voiceGender: junk }).voiceGender,
      ).toBe('');
    }
  });
});

describe('language (request language for vocals, LLM-detected)', () => {
  it('defaults empty and canonicalizes known names (chatty quoting stripped, aliases mapped)', () => {
    expect(sessionStyleSnapshotSchema.parse({ stylePrompt: 'x' }).language).toBe('');
    for (const [raw, canonical] of [
      [' "German". ', 'German'],
      ['german', 'German'],
      ['Deutsch', 'German'],
      ['Swiss  German', 'Swiss German'],
      ['Brazilian Portuguese', 'Brazilian Portuguese'],
      ['Welsh', 'Welsh'],
    ] as const) {
      expect(sessionStyleSnapshotSchema.parse({ stylePrompt: 'x', language: raw }).language).toBe(
        canonical,
      );
    }
  });

  it('drops anything outside the allowlist (the tag rides the provider prompt)', () => {
    for (const junk of [
      'German, exactly like Adele', // punctuation injection
      'German exactly like Adele', // all-word injection — syntax checks miss this
      'English like Drake',
      'German vocals by Adele',
      'Deutsch (bitte!)',
      'Klingon', // unknown language
      'a'.repeat(80), // junk/overlength
    ]) {
      expect(sessionStyleSnapshotSchema.parse({ stylePrompt: 'x', language: junk }).language).toBe(
        '',
      );
    }
  });
});

describe('trackTitles (the creative title pool)', () => {
  it('capitalizes a title written all in lowercase, word by word', () => {
    const parsed = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'lofi beats',
      trackTitles: ['midnight rain', 'über den wolken', '"the last tram" home', "don't stop"],
    });
    expect(parsed.trackTitles).toEqual([
      'Midnight Rain',
      'Über Den Wolken',
      '"The Last Tram" Home',
      "Don't Stop",
    ]);
  });

  it('keeps a title that already carries a capital exactly as written', () => {
    const titles = ['La nuit tombe', 'Sommer am See', 'iPhone Dreams'];
    const parsed = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'lofi beats',
      trackTitles: titles,
    });
    expect(parsed.trackTitles).toEqual(titles);
  });
});

describe('trackTitleRefillCount (when a pool refill runs, and how big)', () => {
  it('asks for nothing while the pool covers every sibling ordinal of the request', () => {
    expect(trackTitleRefillCount(10, 4, 2)).toBe(0); // ordinals 8 and 9
  });

  it('asks for a fixed batch once the request would run past the pool', () => {
    expect(trackTitleRefillCount(10, 5, 2)).toBe(12); // ordinals 10 and 11
  });

  it('never refills a Session without a creative pool', () => {
    expect(trackTitleRefillCount(0, 5, 2)).toBe(0);
  });

  it('skips a pool one batch cannot bring up to the request (titles would land on played ordinals)', () => {
    expect(trackTitleRefillCount(10, 40, 2)).toBe(0);
  });

  it('never grows the pool past its cap', () => {
    expect(trackTitleRefillCount(195, 97, 2)).toBe(5); // ordinals 194 and 195
    expect(trackTitleRefillCount(200, 100, 2)).toBe(0);
  });
});
