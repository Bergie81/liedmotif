import { describe, expect, it } from 'vitest';
import type { SessionVibe } from '@liedmotif/shared';
import { DEFAULT_NOVELTY, DEFAULT_STYLE_STRENGTH } from '@liedmotif/shared';
import { DEFAULT_GUARDRAIL_DRAFT } from '@/components/create/create-session-model';
import {
  buildChangeVibeIntent,
  buildChangeVibeRequest,
  hasPickChanges,
  vibeToPicks,
  type ChangeVibePicks,
} from './change-vibe-model';

/** What an untouched Guardrails fold contributes to a controls intent. */
const DEFAULT_GUARDRAIL_CONTROLS = {
  styleStrength: DEFAULT_STYLE_STRENGTH,
  novelty: DEFAULT_NOVELTY,
  avoid: '',
};

function vibe(overrides: Partial<SessionVibe> = {}): SessionVibe {
  return {
    genreTags: [],
    energy: null,
    vocalMode: 'instrumental',
    voiceGender: null,
    ownVoice: false,
    language: '',
    styleStrength: null,
    novelty: null,
    avoid: '',
    userPrompt: null,
    controls: null,
    ...overrides,
  };
}

describe('vibeToPicks (overlay preselection)', () => {
  it('maps snapshot facets to picker state', () => {
    expect(
      vibeToPicks(
        vibe({
          genreTags: ['techno', 'deep house'],
          energy: 'high',
          vocalMode: 'vocal',
          voiceGender: 'female',
          language: 'German',
        }),
      ),
    ).toEqual({
      genres: ['techno', 'deep-house'],
      energy: 'high',
      vocal: 'vocal',
      voice: 'female',
      ownVoice: false,
      language: 'German',
      ...DEFAULT_GUARDRAIL_DRAFT,
    });
  });

  it('normalizes LLM genre spellings to vocabulary ids and drops unmatched tags', () => {
    const picks = vibeToPicks(
      vibe({ genreTags: ['Lo-fi', 'Drum & Bass', 'gregorian chant', 'New Age'] }),
    );
    expect(picks.genres).toEqual(['lofi', 'drum-and-bass', 'new-age']);
  });

  it('caps the preselection at the picker limit (first three matches lead)', () => {
    const picks = vibeToPicks(vibe({ genreTags: ['techno', 'house', 'ambient', 'jazz'] }));
    expect(picks.genres).toHaveLength(3);
    expect(picks.genres[0]).toBe('techno');
  });

  it('shows the ACTUAL resolved language, and Auto Detect only when none is resolved', () => {
    expect(vibeToPicks(vibe({ language: 'German' })).language).toBe('German');
    expect(vibeToPicks(vibe({ language: '' })).language).toBe('auto');
    // A detected language outside the 23 selectable ones cannot be represented.
    expect(vibeToPicks(vibe({ language: 'Latin' })).language).toBe('auto');
  });

  it('defaults sensibly with no snapshot at all', () => {
    expect(vibeToPicks(null)).toEqual({
      genres: [],
      energy: null,
      vocal: 'instrumental',
      voice: 'any',
      ownVoice: false,
      language: 'auto',
      ...DEFAULT_GUARDRAIL_DRAFT,
    });
  });
});

describe('buildChangeVibeIntent', () => {
  const initial: ChangeVibePicks = {
    genres: ['techno'],
    energy: 'high',
    vocal: 'vocal',
    voice: 'female',
    ownVoice: false,
    language: 'German',
    ...DEFAULT_GUARDRAIL_DRAFT,
  };

  it('message + untouched picks → prompt intent with the message only (text steers)', () => {
    const result = buildChangeVibeIntent({
      message: 'slower and darker',
      vibe: vibe({ userPrompt: 'warehouse techno' }),
      initial,
      picks: initial,
    });
    expect(result).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'slower and darker' },
    });
  });

  it('message + changed picks → prompt intent carrying ONLY the changed picks', () => {
    const result = buildChangeVibeIntent({
      message: 'slower and darker',
      vibe: vibe({ userPrompt: 'warehouse techno' }),
      initial,
      picks: { ...initial, energy: 'low', language: 'French' },
    });
    expect(result).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'slower and darker', energy: 'low', language: 'French' },
    });
  });

  it('switching a resolved language to Auto Detect sends the explicit auto marker', () => {
    const picks: ChangeVibePicks = { ...initial, language: 'auto' };
    expect(
      buildChangeVibeIntent({
        message: '',
        vibe: vibe({ userPrompt: 'warehouse techno' }),
        initial,
        picks,
      }),
    ).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'warehouse techno', language: 'auto' },
    });
    expect(
      buildChangeVibeIntent({
        message: '',
        vibe: vibe({ controls: { mood: 'Calm', language: 'German' } }),
        initial,
        picks,
      }),
    ).toMatchObject({ ok: true, intent: { mode: 'controls', controls: { language: 'auto' } } });
  });

  it('a vocal-mode flip pins vocal (and a picked voice) onto the intent', () => {
    const result = buildChangeVibeIntent({
      message: 'add a singer',
      vibe: vibe({ userPrompt: 'warehouse techno' }),
      initial: { ...initial, vocal: 'instrumental', voice: 'any' },
      picks: { ...initial, vocal: 'vocal', voice: 'male' },
    });
    expect(result).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'add a singer', vocal: 'vocal', voice: 'male' },
    });
  });

  it('turning Own Voice on pins the vocal group and drops the gender pick', () => {
    const result = buildChangeVibeIntent({
      message: '',
      vibe: vibe({ userPrompt: 'warehouse techno' }),
      initial,
      picks: { ...initial, ownVoice: true },
    });
    expect(result).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'warehouse techno', vocal: 'vocal', ownVoice: true },
    });
  });

  it('turning Own Voice off sends the explicit false so the server cannot carry it', () => {
    const result = buildChangeVibeIntent({
      message: 'brighter',
      vibe: vibe({ userPrompt: 'warehouse techno' }),
      initial: { ...initial, ownVoice: true },
      picks: { ...initial, ownVoice: false },
    });
    expect(result).toEqual({
      ok: true,
      intent: {
        mode: 'prompt',
        prompt: 'brighter',
        vocal: 'vocal',
        ownVoice: false,
        voice: 'female',
      },
    });
  });

  it('picks-only over a prompt-mode session re-expands the stored prompt with the changes', () => {
    const result = buildChangeVibeIntent({
      message: '',
      vibe: vibe({ userPrompt: 'warehouse techno' }),
      initial,
      picks: { ...initial, genres: ['techno', 'trance'] },
    });
    expect(result).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'warehouse techno', genres: ['techno', 'trance'] },
    });
  });

  it('picks-only over a controls-mode session merges into the stored controls (WYSIWYG facets)', () => {
    const result = buildChangeVibeIntent({
      message: '',
      vibe: vibe({
        controls: { activity: 'Focus', mood: 'Calm', energy: 'low', genres: ['jazz'] },
      }),
      initial: {
        genres: ['jazz'],
        energy: 'low',
        vocal: 'instrumental',
        voice: 'any',
        ownVoice: false,
        language: 'auto',
        ...DEFAULT_GUARDRAIL_DRAFT,
      },
      picks: {
        genres: ['jazz', 'soul'],
        energy: 'medium',
        vocal: 'vocal',
        voice: 'female',
        ownVoice: false,
        language: 'French',
        ...DEFAULT_GUARDRAIL_DRAFT,
      },
    });
    expect(result).toEqual({
      ok: true,
      intent: {
        mode: 'controls',
        controls: {
          activity: 'Focus',
          mood: 'Calm',
          energy: 'medium',
          genres: ['jazz', 'soul'],
          vocal: 'vocal',
          voice: 'female',
          language: 'French',
          ...DEFAULT_GUARDRAIL_CONTROLS,
        },
      },
    });
  });

  it('clearing every genre omits the pick (the text/template decides again)', () => {
    const result = buildChangeVibeIntent({
      message: '',
      vibe: vibe({ controls: { genres: ['jazz'], energy: 'low' } }),
      initial: {
        genres: ['jazz'],
        energy: 'low',
        vocal: 'instrumental',
        voice: 'any',
        ownVoice: false,
        language: 'auto',
        ...DEFAULT_GUARDRAIL_DRAFT,
      },
      picks: {
        genres: [],
        energy: 'low',
        vocal: 'instrumental',
        voice: 'any',
        ownVoice: false,
        language: 'auto',
        ...DEFAULT_GUARDRAIL_DRAFT,
      },
    });
    expect(result).toEqual({
      ok: true,
      intent: {
        mode: 'controls',
        controls: { energy: 'low', vocal: 'instrumental', ...DEFAULT_GUARDRAIL_CONTROLS },
      },
    });
  });

  it('no message and no changes → not submittable', () => {
    const result = buildChangeVibeIntent({
      message: '   ',
      vibe: vibe({ userPrompt: 'warehouse techno' }),
      initial,
      picks: initial,
    });
    expect(result.ok).toBe(false);
  });

  it('picks-only with neither stored prompt nor controls falls back to a pure controls intent', () => {
    const result = buildChangeVibeIntent({
      message: '',
      vibe: vibe(),
      initial: {
        genres: [],
        energy: null,
        vocal: 'instrumental',
        voice: 'any',
        ownVoice: false,
        language: 'auto',
        ...DEFAULT_GUARDRAIL_DRAFT,
      },
      picks: {
        genres: ['ambient'],
        energy: null,
        vocal: 'instrumental',
        voice: 'any',
        ownVoice: false,
        language: 'auto',
        ...DEFAULT_GUARDRAIL_DRAFT,
      },
    });
    expect(result).toEqual({
      ok: true,
      intent: {
        mode: 'controls',
        controls: { genres: ['ambient'], vocal: 'instrumental', ...DEFAULT_GUARDRAIL_CONTROLS },
      },
    });
  });
});

describe('Session Guardrails as fine-tune picks', () => {
  const initial: ChangeVibePicks = {
    genres: [],
    energy: null,
    vocal: 'instrumental',
    voice: 'any',
    ownVoice: false,
    language: 'auto',
    followStyle: 40,
    surprise: 70,
    avoid: 'saxophone',
  };

  it('seeds the sliders from the frozen levels and the Avoid text verbatim', () => {
    const picks = vibeToPicks(vibe({ styleStrength: 0.4, novelty: 0.7, avoid: 'saxophone' }));
    expect(picks.followStyle).toBe(40);
    expect(picks.surprise).toBe(70);
    expect(picks.avoid).toBe('saxophone');
  });

  it('shows the domain defaults for a vibe created before Guardrails existed', () => {
    const picks = vibeToPicks(vibe({ styleStrength: null, novelty: null }));
    expect(picks.followStyle).toBe(DEFAULT_GUARDRAIL_DRAFT.followStyle);
    expect(picks.surprise).toBe(DEFAULT_GUARDRAIL_DRAFT.surprise);
  });

  it('makes any single guardrail edit submittable', () => {
    expect(hasPickChanges(initial, initial)).toBe(false);
    expect(hasPickChanges(initial, { ...initial, followStyle: 41 })).toBe(true);
    expect(hasPickChanges(initial, { ...initial, surprise: 0 })).toBe(true);
    expect(hasPickChanges(initial, { ...initial, avoid: '' })).toBe(true);
  });

  it('sends ONLY the changed guardrail on a free-text change', () => {
    const result = buildChangeVibeIntent({
      message: 'warmer',
      vibe: vibe({ userPrompt: 'warehouse techno' }),
      initial,
      picks: { ...initial, surprise: 10 },
    });
    // An untouched level must stay off the intent, or the server would stop
    // carrying the running Session's own value forward.
    expect(result).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'warmer', novelty: 0.1 },
    });
  });

  it('sends a cleared Avoid as an empty string, not as an omission', () => {
    const result = buildChangeVibeIntent({
      message: '',
      vibe: vibe({ userPrompt: 'warehouse techno', avoid: 'saxophone' }),
      initial,
      picks: { ...initial, avoid: '  ' },
    });
    expect(result).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'warehouse techno', avoid: '' },
    });
  });

  it('a guardrails-only change over a controls vibe is a real, submittable change', () => {
    const result = buildChangeVibeIntent({
      message: '',
      vibe: vibe({ controls: { mood: 'Calm', styleStrength: 0.9 } }),
      initial,
      picks: { ...initial, followStyle: 90 },
    });
    // The stored controls are the intent that CREATED the vibe; the overlay
    // state (seeded from the live snapshot) is what the change must carry.
    expect(result).toEqual({
      ok: true,
      intent: {
        mode: 'controls',
        controls: {
          mood: 'Calm',
          vocal: 'instrumental',
          styleStrength: 0.9,
          novelty: 0.7,
          avoid: 'saxophone',
        },
      },
    });
  });
});

describe('hasPickChanges', () => {
  const base: ChangeVibePicks = {
    genres: ['techno'],
    energy: 'high',
    vocal: 'vocal',
    voice: 'female',
    ownVoice: false,
    language: 'German',
    ...DEFAULT_GUARDRAIL_DRAFT,
  };

  it('detects each facet change, including genre order', () => {
    expect(hasPickChanges(base, base)).toBe(false);
    expect(hasPickChanges(base, { ...base, genres: ['techno', 'house'] })).toBe(true);
    expect(hasPickChanges(base, { ...base, energy: 'low' })).toBe(true);
    expect(hasPickChanges(base, { ...base, vocal: 'instrumental' })).toBe(true);
    expect(hasPickChanges(base, { ...base, voice: 'any' })).toBe(true);
    expect(hasPickChanges(base, { ...base, ownVoice: true })).toBe(true);
    expect(hasPickChanges(base, { ...base, language: 'auto' })).toBe(true);
  });
});

describe('duration edits stay separate from creative intent', () => {
  it('preserves an off-preset target when unrelated picks change and clears only explicitly', () => {
    const initial = vibeToPicks(null);
    const built = buildChangeVibeRequest({
      message: '',
      vibe: null,
      initial,
      picks: { ...initial, energy: 'high' },
      initialTarget: 480,
      target: 480,
      generatedDurationSeconds: 0,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.targetDurationMinutes).toBeUndefined();
      expect(built.input).toBeDefined();
    }
    expect(
      buildChangeVibeRequest({
        message: '',
        vibe: null,
        initial,
        picks: initial,
        initialTarget: 12,
        target: null,
        generatedDurationSeconds: 0,
      }),
    ).toEqual({ ok: true, targetDurationMinutes: null });
  });

  it('at the target, holds a creative change unless the same edit lifts the target past the generated music', () => {
    const initial = vibeToPicks(null);
    // 150 s generated against a 2-minute target.
    const request = (target: number | null, message = 'darker') =>
      buildChangeVibeRequest({
        message,
        vibe: null,
        initial,
        picks: initial,
        initialTarget: 2,
        target,
        generatedDurationSeconds: 150,
      });
    expect(request(2).ok).toBe(false);
    expect(request(1).ok).toBe(false);
    expect(request(3)).toMatchObject({ ok: true, targetDurationMinutes: 3 });
    expect(request(null)).toMatchObject({ ok: true, targetDurationMinutes: null });
    // A duration-only save is never held.
    expect(request(1, '')).toEqual({ ok: true, targetDurationMinutes: 1 });
  });
});
