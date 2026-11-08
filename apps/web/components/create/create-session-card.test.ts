// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurpriseProposal } from '@liedmotif/shared';

const api = vi.hoisted(() => ({ proposeSurprise: vi.fn(), dismissSurprise: vi.fn() }));
vi.mock('@/lib/api-client', () => api);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { CreateSessionCard } = await import('./create-session-card');

const EMBER: SurpriseProposal = {
  id: '22222222-2222-4222-8222-222222222222',
  adventurous: false,
  title: 'Ember Choir',
  mood: 'warm',
  genres: ['indie'],
  energy: 'medium',
  vocalMode: 'vocal',
  voiceGender: 'female',
  language: 'German',
  skipProfile: false,
  edit: {
    prompt: 'Surprise me with a fresh Indie session.',
    genres: ['indie'],
    energy: 'medium',
    vocal: 'vocal',
    language: 'German',
    durationMinutes: 45,
  },
};

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Start Session duration controls', () => {
  it('starts on Auto and submits no explicit target', () => {
    const onStart = vi.fn();
    render(
      createElement(CreateSessionCard, {
        onStart,
        llmConfigured: false,
        initialPrompt: 'Quiet music',
      }),
    );

    expect(
      screen
        .getByLabelText(/Session duration/, { selector: 'input' })
        .getAttribute('aria-valuetext'),
    ).toBe('Auto');
    expect(screen.getByText(/Without one, generation stays continuous/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0]![0]).not.toHaveProperty('targetDurationMinutes');
  });

  function mountWithTarget() {
    const onStart = vi.fn();
    render(
      createElement(CreateSessionCard, {
        onStart,
        llmConfigured: true,
        initialPrompt: 'Thirty minutes of quiet music',
      }),
    );
    const duration = screen.getByLabelText(/Session duration/, { selector: 'input' });
    fireEvent.change(duration, { target: { value: '20' } });
    return { onStart, duration };
  }

  it('submits a selected target', () => {
    const { onStart, duration } = mountWithTarget();

    expect(duration.getAttribute('aria-valuetext')).toBe('20 min');
    expect(
      screen.getByText('A selected duration overrides any duration in your prompt.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));
    expect(onStart.mock.calls[0]![0]).toMatchObject({ targetDurationMinutes: 20 });
  });

  it('returns to Auto when the target is cleared', () => {
    const { onStart, duration } = mountWithTarget();

    fireEvent.change(duration, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));
    expect(onStart.mock.calls[0]![0]).not.toHaveProperty('targetDurationMinutes');
  });
});

describe('Start Session button', () => {
  it('reads Starting… and ignores further clicks once a start is handed off', () => {
    const onStart = vi.fn();
    render(
      createElement(CreateSessionCard, {
        onStart,
        llmConfigured: false,
        initialPrompt: 'Quiet music',
      }),
    );

    const button = screen.getByTestId('start-vibe') as HTMLButtonElement;
    fireEvent.click(button);

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Starting…');
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('stays ready when the request is refused before a start', () => {
    const onStart = vi.fn();
    render(createElement(CreateSessionCard, { onStart, llmConfigured: false }));

    const button = screen.getByTestId('start-vibe') as HTMLButtonElement;
    fireEvent.click(button);

    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByTestId('create-error')).toBeTruthy();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Start Session');
  });
});

describe('Surprise Me in the creation card', () => {
  function mount() {
    const onStart = vi.fn();
    const onStartSurprise = vi.fn();
    render(
      createElement(CreateSessionCard, {
        onStart,
        llmConfigured: true,
        surprise: { pending: EMBER, onStart: onStartSurprise },
      }),
    );
    return { onStart, onStartSurprise };
  }

  it('Start Session starts the untouched proposal by identity with the card’s duration and cover choices', () => {
    const { onStart, onStartSurprise } = mount();
    fireEvent.change(screen.getByLabelText(/Session duration/, { selector: 'input' }), {
      target: { value: '20' },
    });
    fireEvent.click(screen.getByTestId('start-vibe'));

    expect(onStartSurprise).toHaveBeenCalledExactlyOnceWith({
      proposalId: EMBER.id,
      targetDurationMinutes: 20,
      coverStyle: 'poster_art',
      useStandardCover: false,
    });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('sets the duration to the proposal’s own and starts with it', () => {
    const { onStartSurprise } = mount();
    expect(
      screen
        .getByLabelText(/Session duration/, { selector: 'input' })
        .getAttribute('aria-valuetext'),
    ).toBe('45 min');
    fireEvent.click(screen.getByTestId('start-vibe'));
    expect(onStartSurprise.mock.calls[0]![0]).toMatchObject({ targetDurationMinutes: 45 });
  });

  it('opens on the pending proposal’s words and leaves a search hand-off alone', () => {
    mount();
    expect((screen.getByTestId('vibe-prompt') as HTMLTextAreaElement).value).toBe(
      EMBER.edit.prompt,
    );
    cleanup();

    render(
      createElement(CreateSessionCard, {
        onStart: vi.fn(),
        llmConfigured: true,
        initialPrompt: 'rainy day piano',
        surprise: { pending: EMBER, onStart: vi.fn() },
      }),
    );
    expect((screen.getByTestId('vibe-prompt') as HTMLTextAreaElement).value).toBe(
      'rainy day piano',
    );
  });

  it('starts an edited proposal as an ordinary request', () => {
    const { onStart, onStartSurprise } = mount();
    fireEvent.change(screen.getByTestId('vibe-prompt'), {
      target: { value: `${EMBER.edit.prompt} With a choir.` },
    });
    fireEvent.click(screen.getByTestId('start-vibe'));

    expect(onStartSurprise).not.toHaveBeenCalled();
    expect(onStart.mock.calls[0]![0].input).toMatchObject({
      mode: 'prompt',
      prompt: `${EMBER.edit.prompt} With a choir.`,
      genres: ['indie'],
      energy: 'medium',
      vocal: 'vocal',
      language: 'German',
    });
  });

  it('starts an ordinary request when Start without profile differs from the proposal’s', () => {
    const { onStart, onStartSurprise } = mount();
    fireEvent.click(screen.getByTestId('skip-profile'));
    fireEvent.click(screen.getByTestId('start-vibe'));

    expect(onStartSurprise).not.toHaveBeenCalled();
    expect(onStart.mock.calls[0]![0]).toMatchObject({ skipProfile: true });
  });

  it('fills the form with a new proposal and starts it from the one Start button', async () => {
    api.proposeSurprise.mockResolvedValue({ ok: true, data: { proposal: EMBER } });
    const onStart = vi.fn();
    const onStartSurprise = vi.fn();
    render(
      createElement(CreateSessionCard, {
        onStart,
        llmConfigured: true,
        surprise: { pending: null, onStart: onStartSurprise },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Surprise Me' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Find a surprise' }));
    await screen.findByTestId('surprise-preview');

    expect((screen.getByTestId('vibe-prompt') as HTMLTextAreaElement).value).toBe(
      EMBER.edit.prompt,
    );
    fireEvent.click(screen.getByTestId('start-vibe'));
    expect(onStartSurprise).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ proposalId: EMBER.id }),
    );
    expect(onStart).not.toHaveBeenCalled();
  });

  it('the modal’s Start honors a Start without profile flipped after the proposal was made', async () => {
    const { onStart, onStartSurprise } = mount();
    fireEvent.click(screen.getByTestId('skip-profile'));
    fireEvent.click(screen.getByRole('button', { name: 'Surprise Me' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start Session' }));

    expect(onStartSurprise).not.toHaveBeenCalled();
    expect(onStart.mock.calls[0]![0]).toMatchObject({
      skipProfile: true,
      input: { mode: 'prompt', prompt: EMBER.edit.prompt },
    });
  });

  it('the modal’s Start starts the proposal with the card’s cover and the proposal’s length', async () => {
    const { onStart, onStartSurprise } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Surprise Me' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start Session' }));

    expect(onStartSurprise).toHaveBeenCalledExactlyOnceWith({
      proposalId: EMBER.id,
      targetDurationMinutes: 45,
      coverStyle: 'poster_art',
      useStandardCover: false,
    });
    expect(onStart).not.toHaveBeenCalled();
  });
});
