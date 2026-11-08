import { describe, expect, it } from 'vitest';
import {
  buildSessionStyle,
  buildTrackPrompt,
  compileStructuredControls,
  sessionStyleSnapshotSchema,
} from '../llm/index';
import { compileMusicGenerationInput, compileRerollInput } from './compile';

// The music-generation input is compiled from the session's
// frozen Style Snapshot. The frozen BPM/key ride INSIDE the style prompt (there
// is no explicit provider BPM field), and the per-track hidden seed flows solely
// from the snapshot's frozen `seedParameters` — never recomputed.
const SNAPSHOT = compileStructuredControls({
  genres: ['lofi', 'hip hop'],
  activity: 'studying',
  energy: 'low',
  vocal: 'instrumental',
});

describe('compileMusicGenerationInput', () => {
  it('carries the session-frozen BPM and key into the style prompt', () => {
    const input = compileMusicGenerationInput(SNAPSHOT, 0);
    expect(SNAPSHOT.bpm).toBeTypeOf('number');
    expect(input.style).toContain(`${SNAPSHOT.bpm} bpm`);
    expect(input.style).toContain(SNAPSHOT.key);
  });

  it('derives the per-track seed solely from the frozen seedParameters', () => {
    const input = compileMusicGenerationInput(SNAPSHOT, 2);
    expect(input.seed).toBe(buildTrackPrompt(SNAPSHOT, 2).seed);
  });

  it('gives sibling tracks distinct seeds and varied styles around one frozen BPM/key', () => {
    const inputs = [0, 1, 2, 3, 4, 5].map((index) => compileMusicGenerationInput(SNAPSHOT, index));
    // The frozen blend parameters never drift across the session...
    for (const input of inputs) {
      expect(input.style).toContain(`${SNAPSHOT.bpm} bpm`);
      expect(input.style).toContain(SNAPSHOT.key);
    }
    // ...while the seed-picked variation makes sibling REQUESTS genuinely differ
    // at the provider — not just an invisible seed the vendor ignores.
    expect(new Set(inputs.map((input) => input.seed)).size).toBe(inputs.length);
    expect(new Set(inputs.map((input) => input.style)).size).toBeGreaterThan(1);
  });

  it('uses custom mode with a style + title so instrumental custom-mode is valid', () => {
    const input = compileMusicGenerationInput(SNAPSHOT, 0);
    expect(input.mode).toBe('custom');
    expect(input.style).toBeTruthy();
    expect(input.title).toBeTruthy();
    expect(input.style?.length ?? 0).toBeGreaterThan(0);
    expect(input.title?.length ?? 0).toBeGreaterThan(0);
    expect(input.instrumental).toBe(true);
  });

  it('passes negative tags through and is vocal when the snapshot is vocal', () => {
    const instr = compileMusicGenerationInput(SNAPSHOT, 0);
    expect(instr.negativeTags).toContain('vocals');

    const vocalSnapshot = compileStructuredControls({ genres: ['pop'], vocal: 'vocal' });
    const vocal = compileMusicGenerationInput(vocalSnapshot, 0);
    expect(vocal.instrumental).toBe(false);
  });

  it('carries the session language and lyric brief for the lyrics-writing path', () => {
    const snapshot = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'intimate indie folk',
      vocalMode: 'vocal',
      language: 'German',
      lyricContext: 'people: John at desk; setting: Berlin late night',
    });
    const input = compileMusicGenerationInput(snapshot, 0);
    expect(input.language).toBe('German');
    expect(input.lyricBrief).toBe('people: John at desk; setting: Berlin late night');
  });

  it('omits language and lyric brief when the snapshot has none', () => {
    const input = compileMusicGenerationInput(SNAPSHOT, 0);
    expect(input.language).toBeUndefined();
    expect(input.lyricBrief).toBeUndefined();
  });

  it('honors an explicit provider model override', () => {
    const input = compileMusicGenerationInput(SNAPSHOT, 0, { model: 'mock-v1' });
    expect(input.model).toBe('mock-v1');
  });

  it('budgets the description to the provider field that carries it, keeping the BPM/key tail', () => {
    const base = { stylePrompt: 'x'.repeat(1000), bpm: 96, key: 'A minor' };
    const caps = { maxStyleLength: 200, maxPromptLength: 500 };

    // Instrumental sessions submit the description as the custom-mode `style`.
    const instrumental = compileMusicGenerationInput(buildSnapshot(base), 0, caps);
    expect(instrumental.style!.length).toBeLessThanOrEqual(200);
    expect(instrumental.style!.endsWith('96 bpm, A minor')).toBe(true);

    // Vocal sessions submit it as the (larger-cap) non-custom `prompt` instead —
    // the budget must target that field, not squeeze it to the style cap.
    const vocal = compileMusicGenerationInput(
      buildSnapshot({ ...base, vocalMode: 'vocal', negativeTerms: [] }),
      0,
      caps,
    );
    expect(vocal.prompt.length).toBeLessThanOrEqual(500);
    expect(vocal.prompt.length).toBeGreaterThan(200);
    expect(vocal.prompt.endsWith('96 bpm, A minor')).toBe(true);

    // A user-voice vocal session submits custom-mode again (the persona field
    // requires it), so the description budgets back to the `style` cap.
    const ownVoice = compileMusicGenerationInput(
      buildSnapshot({ ...base, vocalMode: 'vocal', useOwnVoice: true, negativeTerms: [] }),
      0,
      caps,
    );
    expect(ownVoice.style!.length).toBeLessThanOrEqual(200);
    expect(ownVoice.style!.endsWith('96 bpm, A minor')).toBe(true);
    expect(ownVoice.instrumental).toBe(false);
    expect(ownVoice.title).toBeTruthy();
  });

  it('budgets an own-voice style against the persona model cap, keeping the genre text', () => {
    // Default model V4 (200-char style) while own voice pins a 1000-char model:
    // a long lyric brief in the vocal tail must not crowd the genre out.
    const snapshot = buildSnapshot({
      stylePrompt: 'synth-pop, glossy analog pads',
      vocalMode: 'vocal',
      useOwnVoice: true,
      language: 'German',
      lyricContext: 'l'.repeat(180),
      negativeTerms: [],
      bpm: 111,
      key: 'F major',
    });
    const caps = { maxStyleLength: 200, maxPromptLength: 500, maxOwnVoiceStyleLength: 1000 };

    const ownVoice = compileMusicGenerationInput(snapshot, 0, caps);
    expect(ownVoice.style).toContain('synth-pop');
    expect(ownVoice.style!.length).toBeLessThanOrEqual(1000);

    // Generic vocals and instrumentals keep the default model's caps.
    const instrumental = compileMusicGenerationInput(
      buildSnapshot({ stylePrompt: 'x'.repeat(1000), bpm: 96, key: 'A minor' }),
      0,
      caps,
    );
    expect(instrumental.style!.length).toBeLessThanOrEqual(200);
  });
});

/** A validated snapshot from partial fields (schema fills the defaults). */
function buildSnapshot(fields: Record<string, unknown>) {
  return sessionStyleSnapshotSchema.parse(fields);
}

describe('compileMusicGenerationInput Session Guardrails', () => {
  it('passes the snapshot levels through, a 0 included', () => {
    const input = compileMusicGenerationInput(
      buildSnapshot({ stylePrompt: 'mellow lofi', styleStrength: 0.9, novelty: 0 }),
      0,
    );
    // 0 is a real level (fully loose / fully safe), never "unset".
    expect(input.styleStrength).toBe(0.9);
    expect(input.novelty).toBe(0);
  });

  it('omits both parameters for a pre-guardrails snapshot', () => {
    // A legacy vibe must keep sounding like itself: injecting today's defaults
    // would make a Dislike reroll diverge from the siblings it replaces.
    const input = compileMusicGenerationInput(SNAPSHOT, 0);
    expect('styleStrength' in input).toBe(false);
    expect('novelty' in input).toBe(false);
  });

  it('reproduces the guardrails when a reroll re-parses the STORED snapshot', () => {
    // The canonical reroll re-runs this compiler over the persisted jsonb with a
    // fresh index, so the guardrails must survive both the jsonb round trip and
    // the schema parse — a snapshot field the schema does not declare is stripped.
    const stored: unknown = JSON.parse(
      JSON.stringify(
        buildSnapshot({ stylePrompt: 'mellow lofi', styleStrength: 0.9, novelty: 0.1 }),
      ),
    );
    const input = compileMusicGenerationInput(sessionStyleSnapshotSchema.parse(stored), 7);
    expect(input.styleStrength).toBe(0.9);
    expect(input.novelty).toBe(0.1);
  });
});

// A Dislike FRESH-CALL reroll resubmits the
// original request's STORED session style — re-budgeted against the current
// provider caps with the frozen BPM/key tail (rebuilt from the persisted
// targets) kept intact, plus the title/negative-terms custom mode needs.
describe('compileRerollInput', () => {
  const storedStyle = buildSessionStyle(SNAPSHOT); // ends with ", <bpm> bpm, <key>"
  const context = {
    stylePrompt: storedStyle,
    targetBpm: SNAPSHOT.bpm,
    targetKey: SNAPSHOT.key,
    vocalMode: 'instrumental' as const,
    title: null,
  };

  it('resubmits the stored style verbatim when the caps allow it', () => {
    const input = compileRerollInput(context, { maxStyleLength: 1000 });
    expect(input.style).toBe(storedStyle);
    expect(input.prompt).toBe(storedStyle);
    expect(input.mode).toBe('custom');
    expect(input.instrumental).toBe(true);
  });

  it('a tighter model cap truncates the base, never the frozen BPM/key tail', () => {
    // V4's 200-char style cap is tighter than the stored 1000-char budget.
    const longBase = 'x'.repeat(400);
    const tailed = `${longBase}, ${SNAPSHOT.bpm} bpm, ${SNAPSHOT.key}`;
    const input = compileRerollInput({ ...context, stylePrompt: tailed }, { maxStyleLength: 200 });
    expect(input.style!.length).toBeLessThanOrEqual(200);
    expect(input.style).toContain(`${SNAPSHOT.bpm} bpm`);
    expect(input.style).toContain(SNAPSHOT.key);
  });

  it('fills the title custom mode requires when the disliked track had none', () => {
    const input = compileRerollInput(context, {});
    expect(input.title).toBeTruthy(); // instrumental custom mode REQUIRES a title
    const titled = compileRerollInput({ ...context, title: 'My Track' }, {});
    expect(titled.title).toBe('My Track');
  });

  it('fills the required title when the disliked track stored a blank one', () => {
    const fallback = compileRerollInput(context, {}).title;
    expect(compileRerollInput({ ...context, title: '' }, {}).title).toBe(fallback);
    expect(compileRerollInput({ ...context, title: '   ' }, {}).title).toBe(fallback);
  });

  it('mirrors the deterministic template: instrumental rerolls carry the vocals negative', () => {
    expect(compileRerollInput(context, {}).negativeTags).toBe('vocals');
    expect(compileRerollInput({ ...context, vocalMode: 'vocal' }, {}).negativeTags).toBeUndefined();
  });

  it('prefers the request PERSISTED negative tags over the template default', () => {
    const input = compileRerollInput({ ...context, negativePrompt: 'vocals, spoken word' }, {});
    expect(input.negativeTags).toBe('vocals, spoken word');
  });

  it('budgets a VOCAL reroll against the prompt cap (non-custom description field)', () => {
    const longBase = 'y'.repeat(600);
    const input = compileRerollInput(
      {
        ...context,
        vocalMode: 'vocal',
        stylePrompt: `${longBase}, 96 bpm, A minor`,
        targetBpm: 96,
        targetKey: 'A minor',
      },
      { maxPromptLength: 300, maxStyleLength: 1000 },
    );
    expect(input.prompt.length).toBeLessThanOrEqual(300);
    expect(input.prompt).toContain('96 bpm');
  });

  it('sends no guardrails at all — this path predates the Style Snapshot', () => {
    // There is no snapshot to read them from, and fabricating today's defaults
    // would re-style the very take the reroll is meant to reproduce.
    const input = compileRerollInput(context, {});
    expect('styleStrength' in input).toBe(false);
    expect('novelty' in input).toBe(false);
  });

  it('handles a stored style without a recognizable tail (legacy formats)', () => {
    const input = compileRerollInput(
      { ...context, stylePrompt: 'plain old style', targetBpm: null, targetKey: null },
      { maxStyleLength: 200 },
    );
    expect(input.style).toBe('plain old style');
  });
});
