import { describe, expect, it } from 'vitest';
import { DEFAULT_NOVELTY, DEFAULT_STYLE_STRENGTH } from '@liedmotif/shared';
import {
  buildPromptIntent,
  buildStartRequest,
  DEFAULT_GUARDRAIL_DRAFT,
  type GuardrailDraft,
} from './create-session-model';

/** The contract levels an intent with untouched sliders must carry. */
const DEFAULT_GUARDRAIL_CONTROLS = {
  styleStrength: DEFAULT_STYLE_STRENGTH,
  novelty: DEFAULT_NOVELTY,
};

describe('create Session model', () => {
  it('trims a free-text prompt and keeps prompt mode contract-pure', () => {
    expect(buildPromptIntent('  rainy night drive  ')).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'rainy night drive' },
    });
  });

  it('sends fine-tune genre picks with a free-text intent, omitted when none', () => {
    expect(buildPromptIntent('rainy night drive', { genres: ['techno', ' ambient '] })).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'rainy night drive', genres: ['techno', 'ambient'] },
    });
    expect(buildPromptIntent('rainy night drive', { genres: [' ', ''] })).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'rainy night drive' },
    });
  });

  it('sends energy, vocal, and voice picks with a free-text intent; Auto/Any is omission', () => {
    expect(
      buildPromptIntent('rainy night drive', {
        energy: 'high',
        vocal: 'vocal',
        voice: 'female',
      }),
    ).toEqual({
      ok: true,
      intent: {
        mode: 'prompt',
        prompt: 'rainy night drive',
        energy: 'high',
        vocal: 'vocal',
        voice: 'female',
      },
    });
    expect(
      buildPromptIntent('rainy night drive', { energy: 'auto', vocal: 'auto', voice: 'any' }),
    ).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'rainy night drive' },
    });
  });

  it('sends a voice pick only when the vocal pick asks for vocals', () => {
    expect(
      buildPromptIntent('rainy night drive', { vocal: 'instrumental', voice: 'female' }),
    ).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'rainy night drive', vocal: 'instrumental' },
    });
    expect(buildPromptIntent('rainy night drive', { vocal: 'auto', voice: 'female' })).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'rainy night drive' },
    });
  });

  it('Own Voice pins vocals, rides the request, and supersedes a gender pick', () => {
    expect(
      buildPromptIntent('rainy night drive', {
        genres: ['techno'],
        energy: 'low',
        vocal: 'auto',
        voice: 'female',
        ownVoice: true,
      }),
    ).toEqual({
      ok: true,
      intent: {
        mode: 'prompt',
        prompt: 'rainy night drive',
        genres: ['techno'],
        energy: 'low',
        vocal: 'vocal',
        ownVoice: true,
      },
    });
  });

  it('sends a language pick with a free-text intent even for instrumental; Auto Detect is omission', () => {
    expect(
      buildPromptIntent('rainy night drive', { vocal: 'instrumental', language: 'German' }),
    ).toEqual({
      ok: true,
      intent: {
        mode: 'prompt',
        prompt: 'rainy night drive',
        vocal: 'instrumental',
        language: 'German',
      },
    });
    expect(buildPromptIntent('rainy night drive', { language: 'auto' })).toEqual({
      ok: true,
      intent: { mode: 'prompt', prompt: 'rainy night drive' },
    });
  });

  it('rejects empty free text', () => {
    expect(buildPromptIntent('   ')).toEqual({
      ok: false,
      error: 'Describe a vibe first.',
    });
  });

  describe('Session Guardrails', () => {
    function promptIntent(guardrails: GuardrailDraft) {
      const result = buildPromptIntent('rainy night drive', { guardrails });
      if (!result.ok) throw new Error(result.error);
      return result.intent;
    }

    it('converts the sliders from their 0-100 units to the contract 0-1 levels', () => {
      expect(
        promptIntent({ ...DEFAULT_GUARDRAIL_DRAFT, followStyle: 90, surprise: 5 }),
      ).toMatchObject({ styleStrength: 0.9, novelty: 0.05 });
    });

    it('starts the sliders exactly on the shared domain defaults', () => {
      // The slider units and the domain defaults are two representations of one
      // number: an untouched slider must send precisely what an intent omitting
      // the field would have been given.
      expect(promptIntent(DEFAULT_GUARDRAIL_DRAFT)).toMatchObject(DEFAULT_GUARDRAIL_CONTROLS);
    });

    it('sends the Avoid text trimmed, and omits it when blank', () => {
      expect(
        promptIntent({ ...DEFAULT_GUARDRAIL_DRAFT, avoid: '  saxophone, heavy bass  ' }),
      ).toMatchObject({ avoid: 'saxophone, heavy bass' });
      expect(promptIntent({ ...DEFAULT_GUARDRAIL_DRAFT, avoid: '   ' })).not.toHaveProperty(
        'avoid',
      );
    });

    it('rides the free-text intent beside the picks', () => {
      const result = buildPromptIntent('rainy night drive', {
        guardrails: { followStyle: 20, surprise: 80, avoid: ' saxophone ' },
      });
      expect(result).toEqual({
        ok: true,
        intent: {
          mode: 'prompt',
          prompt: 'rainy night drive',
          styleStrength: 0.2,
          novelty: 0.8,
          avoid: 'saxophone',
        },
      });
    });
  });

  it('keeps request-envelope defaults off the wire, but the cover toggle always rides', () => {
    const input = { mode: 'prompt', prompt: 'rainy night drive' } as const;
    expect(
      buildStartRequest(input, 'client-1', {
        coverStyle: 'auto',
        skipProfile: false,
        useStandardCover: false,
      }),
    ).toEqual({ input, clientId: 'client-1', useStandardCover: false });
  });

  it('sends a non-default cover style and the skip-profile flag on the envelope', () => {
    const input = { mode: 'prompt', prompt: 'rainy night drive' } as const;
    expect(
      buildStartRequest(input, 'client-1', {
        coverStyle: 'drawing',
        skipProfile: true,
        useStandardCover: false,
      }),
    ).toEqual({
      input,
      clientId: 'client-1',
      coverStyle: 'drawing',
      skipProfile: true,
      useStandardCover: false,
    });
  });

  it('sends the standard-cover toggle in either state', () => {
    const input = { mode: 'prompt', prompt: 'rainy night drive' } as const;
    expect(
      buildStartRequest(input, 'client-1', {
        coverStyle: 'auto',
        skipProfile: false,
        useStandardCover: true,
      }),
    ).toEqual({ input, clientId: 'client-1', useStandardCover: true });
  });
});
