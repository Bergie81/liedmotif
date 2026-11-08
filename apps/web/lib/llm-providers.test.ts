import { describe, expect, it } from 'vitest';
import { llmEffectiveModel, llmProviderMeta } from './llm-providers';

describe('LLM provider model resolution', () => {
  it('uses the preset default when OpenAI has no explicit model', () => {
    expect(llmEffectiveModel(llmProviderMeta('openai'), '')).toBe(
      llmProviderMeta('openai')?.defaultModel,
    );
  });

  it('keeps providers without a default explicitly model-less', () => {
    expect(llmEffectiveModel(llmProviderMeta('openrouter'), '')).toBeNull();
  });

  it('prefers and trims an explicit model', () => {
    expect(llmEffectiveModel(llmProviderMeta('openai'), '  custom-model  ')).toBe('custom-model');
  });
});
