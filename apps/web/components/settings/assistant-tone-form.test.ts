// @vitest-environment jsdom

// The tone a user gives the Assistant, on its settings page: the saved tone is
// in the field, a ready-made tone fills it, the Assistant's own tone empties
// it, and Save sends what the field holds.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_TONE_MAX_LENGTH, assistantToneSchema, makeApiError } from '@liedmotif/shared';
import { TONE_PRESETS } from '@/lib/assistant/persona';
import { AssistantToneForm } from './assistant-tone-form';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The settings route: answers every save with the tone it was sent. */
function serve(): { saved: string[] } {
  const server = { saved: [] as string[] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: { body: string }) => {
      expect(path).toBe('/api/settings/assistant-tone');
      const { tone } = assistantToneSchema.parse(JSON.parse(init.body));
      server.saved.push(tone);
      return Response.json({ ok: true, data: { tone } });
    }),
  );
  return server;
}

const field = () => screen.getByRole('textbox', { name: 'Tone' }) as HTMLTextAreaElement;

describe('the tone form', () => {
  it('shows the tone the user saved', () => {
    render(h(AssistantToneForm, { initial: { tone: 'Talk like a ship captain.' } }));
    expect(field().value).toBe('Talk like a ship captain.');
  });

  it.each(TONE_PRESETS)('fills the field with the $label tone and saves it', async (preset) => {
    const server = serve();
    render(h(AssistantToneForm, { initial: { tone: '' } }));

    fireEvent.click(screen.getByRole('button', { name: preset.label }));
    expect(field().value).toBe(preset.tone);
    fireEvent.click(screen.getByRole('button', { name: 'Save tone' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Tone saved.'));
    expect(server.saved).toEqual([preset.tone]);
  });

  it("empties the field for Roadie's own tone, and saves that", async () => {
    const server = serve();
    render(h(AssistantToneForm, { initial: { tone: 'Talk like a ship captain.' } }));

    fireEvent.click(screen.getByRole('button', { name: "Roadie's own" }));
    expect(field().value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save tone' }));

    await waitFor(() => expect(server.saved).toEqual(['']));
  });

  it('saves a tone the user wrote themselves, after a ready-made one', async () => {
    const server = serve();
    render(h(AssistantToneForm, { initial: { tone: '' } }));

    fireEvent.click(screen.getByRole('button', { name: TONE_PRESETS[0]!.label }));
    fireEvent.change(field(), { target: { value: 'Polite, but in rhymes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tone' }));

    await waitFor(() => expect(server.saved).toEqual(['Polite, but in rhymes.']));
  });

  it('holds the field and the ready-made tones still while a save is on its way', async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    );
    render(h(AssistantToneForm, { initial: { tone: 'Calm.' } }));
    const presetButton = () =>
      screen.getByRole('button', { name: TONE_PRESETS[0]!.label }) as HTMLButtonElement;

    fireEvent.click(screen.getByRole('button', { name: 'Save tone' }));
    await waitFor(() => expect(field().disabled).toBe(true));
    expect(presetButton().disabled).toBe(true);

    answer(Response.json({ ok: true, data: { tone: 'Calm.' } }));
    await waitFor(() => expect(field().disabled).toBe(false));
    expect(presetButton().disabled).toBe(false);
    expect(field().value).toBe('Calm.');
  });

  it('says why a tone was not saved, and keeps it in the field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(makeApiError('internal_error', 'Could not save the tone.'), { status: 500 }),
      ),
    );
    render(h(AssistantToneForm, { initial: { tone: 'Talk like a ship captain.' } }));

    fireEvent.click(screen.getByRole('button', { name: 'Save tone' }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Could not save the tone.'),
    );
    expect(field().value).toBe('Talk like a ship captain.');
  });

  it('says how much of the length is used, and takes no more than the longest tone', () => {
    render(h(AssistantToneForm, { initial: { tone: 'Calm.' } }));
    expect(screen.getByText(`5/${ASSISTANT_TONE_MAX_LENGTH}`)).toBeTruthy();
    expect(field().maxLength).toBe(ASSISTANT_TONE_MAX_LENGTH);
  });
});
