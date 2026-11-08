import { describe, expect, it } from 'vitest';
import { providerDisplayName } from './configurable-providers';

describe('providerDisplayName', () => {
  it('names a preset from the matrix rather than the raw key', () => {
    expect(providerDisplayName('llm', 'openai')).toBe('OpenAI');
    expect(providerDisplayName('llm', 'openai-compatible')).toBe('OpenAI-compatible');
    expect(providerDisplayName('music', 'suno')).toBe('Suno-compatible');
  });

  it('ignores a stored display name that merely repeats the key', () => {
    expect(providerDisplayName('llm', 'openrouter', 'openrouter')).toBe('OpenRouter');
    expect(providerDisplayName('music', 'suno', 'suno')).toBe('Suno-compatible');
  });

  it('falls back to the stored name, then the key, for a preset this build lacks', () => {
    expect(providerDisplayName('llm', 'future-llm', '  Future LLM  ')).toBe('Future LLM');
    expect(providerDisplayName('llm', 'future-llm', '   ')).toBe('future-llm');
    expect(providerDisplayName('llm', 'future-llm')).toBe('future-llm');
  });
});
