import { describe, expect, it } from 'vitest';
import { IMAGE_PROVIDERS, providerDisplayName, providerPicker } from './configurable-providers';
import { LLM_PROVIDERS } from './llm-providers';

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

describe('providerPicker', () => {
  const labels = (options: readonly { label: string }[]) => options.map((option) => option.label);

  it('shows the main Text AI presets first and keeps the rest behind More options', () => {
    const picker = providerPicker(LLM_PROVIDERS, {
      selectedKey: 'openai',
      loadedKey: 'openai',
      moreOptionsOpened: false,
    });

    expect(labels(picker.shown)).toEqual(['OpenAI', 'Gemini', 'Ollama']);
    expect(picker.moreOptionsHidden).toBe(true);
  });

  it('lists OpenRouter and OpenAI-compatible after the main presets once More options opens', () => {
    const picker = providerPicker(LLM_PROVIDERS, {
      selectedKey: 'openai',
      loadedKey: 'openai',
      moreOptionsOpened: true,
    });

    expect(labels(picker.shown)).toEqual([
      'OpenAI',
      'Gemini',
      'Ollama',
      'OpenRouter',
      'OpenAI-compatible',
    ]);
    expect(picker.moreOptionsHidden).toBe(false);
  });

  it('never hides the preset an Instance already uses', () => {
    const picker = providerPicker(LLM_PROVIDERS, {
      selectedKey: 'openai-compatible',
      loadedKey: 'openai',
      moreOptionsOpened: false,
    });

    expect(labels(picker.shown)).toEqual([
      'OpenAI',
      'Gemini',
      'Ollama',
      'OpenRouter',
      'OpenAI-compatible',
    ]);
    expect(picker.moreOptionsHidden).toBe(false);
  });

  it('keeps a stored advanced preset shown after the Admin selects a main one', () => {
    const picker = providerPicker(LLM_PROVIDERS, {
      selectedKey: 'openai',
      loadedKey: 'openrouter',
      moreOptionsOpened: false,
    });

    expect(labels(picker.shown)).toEqual([
      'OpenAI',
      'Gemini',
      'Ollama',
      'OpenRouter',
      'OpenAI-compatible',
    ]);
    expect(picker.moreOptionsHidden).toBe(false);
  });

  it('shows OpenAI, then Gemini for Cover images and keeps OpenRouter behind More options', () => {
    const picker = providerPicker(IMAGE_PROVIDERS, {
      selectedKey: 'openai',
      loadedKey: 'openai',
      moreOptionsOpened: false,
    });

    expect(labels(picker.shown)).toEqual(['OpenAI', 'Gemini']);
    expect(picker.moreOptionsHidden).toBe(true);
    expect(IMAGE_PROVIDERS[0]).toMatchObject({
      value: 'openai',
      needsKey: true,
      needsBaseUrl: false,
      defaultModel: 'gpt-image-2.6-flare',
    });
    expect(IMAGE_PROVIDERS[1]).toMatchObject({
      value: 'gemini',
      needsKey: true,
      needsBaseUrl: false,
      defaultModel: 'gemini-nano-banana-2.1',
    });
    expect(providerDisplayName('image', 'gemini')).toBe('Gemini');
  });

  it('keeps an Instance stored on OpenRouter Covers shown and selected', () => {
    const picker = providerPicker(IMAGE_PROVIDERS, {
      selectedKey: 'openrouter',
      loadedKey: 'openrouter',
      moreOptionsOpened: false,
    });

    expect(labels(picker.shown)).toEqual(['OpenAI', 'Gemini', 'OpenRouter']);
    expect(picker.moreOptionsHidden).toBe(false);
  });
});
