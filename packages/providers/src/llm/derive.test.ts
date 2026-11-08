import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOVELTY, DEFAULT_STYLE_STRENGTH } from '@liedmotif/shared';
import { deriveSessionMetadata, deriveSessionSnapshot, type SessionIntentInput } from './derive';
import type { LlmProvider } from './index';
import { sessionStyleSnapshotSchema, type SessionStyleSnapshot } from './snapshot';
import { deriveTrackMetadata } from './template';

// The create-path snapshot derivation is the ONE place a session's single
// Style Snapshot is produced: a configured text LLM always expands free text;
// without one, structured controls compile via the deterministic template and
// free text via the prompt passthrough. These tests pin the
// "no LLM configured still derives every intent" invariant that lets the music
// path run with no LLM configured.

/** A spy LlmProvider whose `expandSessionIntent` records its calls. */
function spyLlm(snapshot: SessionStyleSnapshot): {
  llm: LlmProvider;
  expand: ReturnType<typeof vi.fn>;
} {
  const expand = vi.fn(async (_intent: string) => snapshot);
  const llm = {
    providerType: 'llm',
    providerKey: 'spy',
    getCapabilities: () => ({ supportsStructuredOutputs: true, model: 'spy' }),
    validateCredentials: async () => ({ ok: true }),
    expandSessionIntent: expand,
    createTrackMetadata: async () => ({ title: 't', artistName: 'a' }),
  } as unknown as LlmProvider;
  return { llm, expand };
}

const FREE_TEXT_SNAPSHOT = sessionStyleSnapshotSchema.parse({
  stylePrompt: 'from the llm',
  negativeTerms: ['vocals'],
});

describe('deriveSessionSnapshot', () => {
  it('compiles structured controls deterministically and makes NO LLM call', async () => {
    const { llm, expand } = spyLlm(FREE_TEXT_SNAPSHOT);
    const input: SessionIntentInput = {
      mode: 'controls',
      controls: { genres: ['lofi'], energy: 'low', vocal: 'instrumental' },
    };

    const snapshot = await deriveSessionSnapshot(input, llm);

    expect(expand).not.toHaveBeenCalled();
    // The structured path freezes a concrete BPM/key for blend-for-free.
    expect(typeof snapshot.bpm).toBe('number');
    expect(snapshot.key).not.toBe('');
    expect(snapshot.stylePrompt).not.toBe('from the llm');
  });

  it('works with NO LLM configured for the structured path', async () => {
    const snapshot = await deriveSessionSnapshot({ mode: 'controls', controls: {} }, null);
    expect(typeof snapshot.bpm).toBe('number');
    expect(snapshot.key).not.toBe('');
  });

  it('compiles free text deterministically when no LLM is configured (passthrough)', async () => {
    const snapshot = await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'rainy night drive', genres: ['techno'] },
      null,
    );
    // The words reach the style as written; the pick is enforced; blend
    // parameters are frozen — all with NO LLM configured.
    expect(snapshot.stylePrompt).toContain('rainy night drive');
    expect(snapshot.genreTags[0]).toBe('techno');
    expect(typeof snapshot.bpm).toBe('number');
    expect(snapshot.key).not.toBe('');
    // Deterministic: the same intent derives the same snapshot, seed included.
    expect(
      await deriveSessionSnapshot(
        { mode: 'prompt', prompt: 'rainy night drive', genres: ['techno'] },
        null,
      ),
    ).toEqual(snapshot);
  });

  it('names no-LLM tracks after the words, so Sessions do not share track titles', async () => {
    const titleOf = async (input: SessionIntentInput, index: number) =>
      deriveTrackMetadata(await deriveSessionSnapshot(input, null), index).title;

    expect(
      await titleOf(
        { mode: 'prompt', prompt: 'something like a rainy sunday in a coffee shop' },
        2,
      ),
    ).toBe('Rainy Sunday Coffee 3');
    expect(await titleOf({ mode: 'prompt', prompt: 'deep focus coding, late night' }, 0)).toBe(
      'Deep Focus Coding 1',
    );
    // A genre pick still names the tracks.
    expect(await titleOf({ mode: 'prompt', prompt: 'chill', genres: ['lo-fi'] }, 0)).toBe(
      'Lo-Fi 1',
    );
  });

  it('expands free text through the text LLM exactly once', async () => {
    const { llm, expand } = spyLlm(FREE_TEXT_SNAPSHOT);
    const snapshot = await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'rainy night drive' },
      llm,
    );
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith('rainy night drive', undefined, undefined, undefined);
    expect(snapshot.stylePrompt).toBe('from the llm');
  });

  it('hands a prompt intent’s explicit fine-tune picks to the expansion', async () => {
    const { llm, expand } = spyLlm(FREE_TEXT_SNAPSHOT);
    await deriveSessionSnapshot(
      {
        mode: 'prompt',
        prompt: 'rainy night drive',
        genres: ['techno', 'ambient'],
        energy: 'high',
        vocal: 'vocal',
        voice: 'female',
      },
      llm,
    );
    expect(expand).toHaveBeenCalledWith(
      'rainy night drive',
      undefined,
      {
        genres: ['techno', 'ambient'],
        energy: 'high',
        vocal: 'vocal',
        voice: 'female',
      },
      undefined,
    );
  });
});

describe('deriveSessionSnapshot Session Guardrails', () => {
  it('stamps guardrails on the structured path, merging Avoid after the system terms', async () => {
    const snapshot = await deriveSessionSnapshot(
      { mode: 'controls', controls: { vocal: 'instrumental', avoid: 'saxophone' } },
      null,
    );
    expect(snapshot.styleStrength).toBe(DEFAULT_STYLE_STRENGTH);
    expect(snapshot.novelty).toBe(DEFAULT_NOVELTY);
    expect(snapshot.userAvoid).toBe('saxophone');
    expect(snapshot.negativeTerms).toEqual(['vocals', 'saxophone']);
  });

  it('stamps guardrails on the free-text path too, the intent’s values winning', async () => {
    const { llm } = spyLlm(FREE_TEXT_SNAPSHOT);
    const snapshot = await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'rainy night drive', styleStrength: 0.9, avoid: 'saxophone' },
      llm,
    );
    expect(snapshot.styleStrength).toBe(0.9);
    // An omitted level still lands: the snapshot must be self-contained.
    expect(snapshot.novelty).toBe(DEFAULT_NOVELTY);
    expect(snapshot.negativeTerms).toEqual(['vocals', 'saxophone']);
  });

  it('stamps guardrails identically on the no-LLM passthrough path', async () => {
    const snapshot = await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'rainy night drive', styleStrength: 0.9, avoid: 'saxophone' },
      null,
    );
    expect(snapshot.styleStrength).toBe(0.9);
    expect(snapshot.novelty).toBe(DEFAULT_NOVELTY);
    expect(snapshot.userAvoid).toBe('saxophone');
    expect(snapshot.negativeTerms).toEqual(['vocals', 'saxophone']);
  });

  it('hands the Avoid text to the expansion as a creative constraint', async () => {
    const { llm, expand } = spyLlm(FREE_TEXT_SNAPSHOT);
    await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'rainy night drive', avoid: 'saxophone' },
      llm,
    );
    // The levels are provider parameters: naming them in prose would apply them twice.
    expect(expand).toHaveBeenCalledWith(
      'rainy night drive',
      undefined,
      { avoid: 'saxophone' },
      undefined,
    );
  });

  it('carries the running Session’s guardrails through an untouched Change Vibe', async () => {
    // The anchored derivation is the Change Vibe path. A change that never
    // touches a guardrail must not silently re-stamp the domain defaults.
    const adjustFrom = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'warehouse techno',
      negativeTerms: ['vocals', 'saxophone'],
      styleStrength: 0.9,
      novelty: 0.05,
      userAvoid: 'saxophone',
    });
    const { llm } = spyLlm(FREE_TEXT_SNAPSHOT);
    const snapshot = await deriveSessionSnapshot({ mode: 'prompt', prompt: 'warmer' }, llm, null, {
      adjustFrom,
    });
    expect(snapshot.styleStrength).toBe(0.9);
    expect(snapshot.novelty).toBe(0.05);
    expect(snapshot.userAvoid).toBe('saxophone');
    expect(snapshot.negativeTerms).toEqual(['vocals', 'saxophone']);
  });

  it('inherits the anchor’s guardrails on a no-LLM Change Vibe (passthrough)', async () => {
    // An anchored derivation with NO LLM is a Change Vibe on a passthrough
    // session: the recompile is deterministic, but the running Session's
    // guardrails must still fill what the change leaves untouched.
    const adjustFrom = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'warehouse techno',
      negativeTerms: ['vocals', 'saxophone'],
      styleStrength: 0.9,
      novelty: 0.05,
      userAvoid: 'saxophone',
    });
    const snapshot = await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'warehouse techno, warmer' },
      null,
      null,
      { adjustFrom },
    );
    expect(snapshot.stylePrompt).toContain('warehouse techno, warmer');
    expect(snapshot.styleStrength).toBe(0.9);
    expect(snapshot.novelty).toBe(0.05);
    expect(snapshot.userAvoid).toBe('saxophone');
    expect(snapshot.negativeTerms).toEqual(['vocals', 'saxophone']);
  });

  it('lets an explicit guardrail pick overwrite the anchored one', async () => {
    const adjustFrom = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'warehouse techno',
      negativeTerms: ['vocals'],
      styleStrength: 0.9,
      novelty: 0.05,
    });
    const { llm } = spyLlm(FREE_TEXT_SNAPSHOT);
    const snapshot = await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'warmer', novelty: 0.6 },
      llm,
      null,
      { adjustFrom },
    );
    expect(snapshot.novelty).toBe(0.6);
    expect(snapshot.styleStrength).toBe(0.9); // untouched, still carried
  });

  it('drops the previous Avoid terms when the Avoid text is edited or cleared', async () => {
    const adjustFrom = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'warehouse techno',
      negativeTerms: ['vocals', 'saxophone'],
      userAvoid: 'saxophone',
    });
    // The expansion is shown the CURRENT negative terms and echoes them back,
    // so without the replacement an edited Avoid would only ever accumulate.
    const echoed = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'warmer warehouse techno',
      negativeTerms: ['vocals', 'saxophone'],
    });
    const { llm } = spyLlm(echoed);
    const edited = await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'warmer', avoid: 'harsh noise' },
      llm,
      null,
      { adjustFrom },
    );
    expect(edited.userAvoid).toBe('harsh noise');
    expect(edited.negativeTerms).toEqual(['vocals', 'harsh noise']);

    const cleared = await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'warmer', avoid: '' },
      llm,
      null,
      { adjustFrom },
    );
    expect(cleared.userAvoid).toBeUndefined();
    // The system steer stays: only the user's half is replaced.
    expect(cleared.negativeTerms).toEqual(['vocals']);
  });

  it('never lets a cleared Avoid unsuppress vocals on an instrumental Session', async () => {
    const adjustFrom = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'warehouse techno',
      negativeTerms: ['vocals'],
      vocalMode: 'instrumental',
      userAvoid: 'vocals',
    });
    const { llm } = spyLlm(FREE_TEXT_SNAPSHOT);
    const snapshot = await deriveSessionSnapshot(
      { mode: 'prompt', prompt: 'warmer', avoid: '' },
      llm,
      null,
      { adjustFrom },
    );
    expect(snapshot.negativeTerms).toEqual(['vocals']);
  });

  it('stamps guardrails through the metadata twin the create routes call', async () => {
    const { snapshot } = await deriveSessionMetadata(
      { mode: 'controls', controls: { novelty: 0.8 } },
      null,
    );
    expect(snapshot.novelty).toBe(0.8);
    expect(snapshot.styleStrength).toBe(DEFAULT_STYLE_STRENGTH);
  });

  it('serves a no-LLM prompt intent through the metadata twin with no cover concept', async () => {
    const { snapshot, coverConcept } = await deriveSessionMetadata(
      { mode: 'prompt', prompt: 'rainy night drive', novelty: 0.8 },
      null,
    );
    expect(snapshot.stylePrompt).toContain('rainy night drive');
    expect(snapshot.novelty).toBe(0.8);
    expect(coverConcept).toBe('');
  });
});
