// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurpriseProposal } from '@liedmotif/shared';
import { shownToasts, toast } from '@/lib/toast';

const api = vi.hoisted(() => ({
  proposeSurprise: vi.fn(),
  dismissSurprise: vi.fn(),
  getPendingSurprise: vi.fn(),
}));
vi.mock('@/lib/http/api-client', () => api);
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

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
  api.proposeSurprise.mockReset();
  api.getPendingSurprise.mockReset();
  router.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toast.dismiss();
});

describe('Start Session duration controls', () => {
  function durationText() {
    return screen
      .getByLabelText(/Session duration/, { selector: 'input' })
      .getAttribute('aria-valuetext');
  }

  it('shows the default Session duration Auto stands for and submits no explicit target', () => {
    const onStart = vi.fn();
    render(
      createElement(CreateSessionCard, {
        onStart,
        llmConfigured: false,
        initialPrompt: 'Quiet music',
        defaultSessionDurationMinutes: 60,
      }),
    );

    expect(durationText()).toBe('Auto · 60 min');
    expect(screen.getByText(/otherwise your default/)).toBeTruthy();
    expect(screen.getByText(/Settings → Generation/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0]![0]).not.toHaveProperty('targetDurationMinutes');
  });

  it('shows Auto as No limit when that is the default, and still submits no target', () => {
    const onStart = vi.fn();
    render(
      createElement(CreateSessionCard, {
        onStart,
        llmConfigured: true,
        initialPrompt: 'Quiet music',
        defaultSessionDurationMinutes: null,
      }),
    );

    expect(durationText()).toBe('Auto · No limit');
    fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));
    expect(onStart.mock.calls[0]![0]).not.toHaveProperty('targetDurationMinutes');
  });

  it('shows the shipped 30 min default when the page passes none', () => {
    render(createElement(CreateSessionCard, { onStart: vi.fn(), llmConfigured: false }));

    expect(durationText()).toBe('Auto · 30 min');
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
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Describe a vibe first.' }),
    ]);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Start Session');
  });

  it('clears a refused start once the next start is handed off', () => {
    const onStart = vi.fn();
    render(createElement(CreateSessionCard, { onStart, llmConfigured: false }));
    fireEvent.click(screen.getByTestId('start-vibe'));

    fireEvent.change(screen.getByTestId('vibe-prompt'), { target: { value: 'Quiet music' } });
    fireEvent.click(screen.getByTestId('start-vibe'));

    expect(onStart).toHaveBeenCalledOnce();
    expect(shownToasts()).toEqual([]);
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
      useStandardCover: false,
    });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('shows a proposal without a language as Auto Detect under a German Default language and starts it by identity', () => {
    const onStart = vi.fn();
    const onStartSurprise = vi.fn();
    const noLanguage: SurpriseProposal = {
      ...EMBER,
      language: null,
      edit: { ...EMBER.edit, language: null },
    };
    render(
      createElement(CreateSessionCard, {
        onStart,
        llmConfigured: true,
        defaultLanguage: 'German',
        surprise: { pending: noLanguage, onStart: onStartSurprise },
      }),
    );

    expect(screen.getByTestId('session-language').textContent).toContain('Auto Detect');
    fireEvent.click(screen.getByTestId('start-vibe'));
    expect(onStartSurprise).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ proposalId: EMBER.id }),
    );
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

  it('leaves a proposal without a length on Auto and starts it with no target', () => {
    const onStartSurprise = vi.fn();
    render(
      createElement(CreateSessionCard, {
        onStart: vi.fn(),
        llmConfigured: true,
        defaultSessionDurationMinutes: 15,
        surprise: {
          pending: { ...EMBER, edit: { ...EMBER.edit, durationMinutes: null } },
          onStart: onStartSurprise,
        },
      }),
    );

    expect(
      screen
        .getByLabelText(/Session duration/, { selector: 'input' })
        .getAttribute('aria-valuetext'),
    ).toBe('Auto · 15 min');
    fireEvent.click(screen.getByTestId('start-vibe'));
    expect(onStartSurprise.mock.calls[0]![0]).not.toHaveProperty('targetDurationMinutes');
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
    fireEvent.click(await screen.findByRole('button', { name: 'Find a Surprise' }));
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
      useStandardCover: false,
    });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('shows a suggestion made elsewhere once the page re-reads it, and tries another from it', async () => {
    const harbor: SurpriseProposal = {
      ...EMBER,
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Harbor Morning',
      edit: { ...EMBER.edit, prompt: 'Surprise me with a slow harbor morning.' },
    };
    const props = { onStart: vi.fn(), llmConfigured: true };
    const onStartSurprise = vi.fn();
    const { rerender } = render(
      createElement(CreateSessionCard, {
        ...props,
        surprise: { pending: EMBER, onStart: onStartSurprise },
      }),
    );

    rerender(
      createElement(CreateSessionCard, {
        ...props,
        surprise: { pending: harbor, onStart: onStartSurprise },
      }),
    );

    expect((screen.getByTestId('vibe-prompt') as HTMLTextAreaElement).value).toBe(
      harbor.edit.prompt,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Surprise Me' }));
    expect(await screen.findByText('Harbor Morning')).toBeTruthy();
    api.proposeSurprise.mockResolvedValue({ ok: true, data: { proposal: EMBER } });
    fireEvent.click(screen.getByRole('button', { name: 'Try Another' }));
    expect(api.proposeSurprise.mock.calls.at(-1)![0]).toMatchObject({ replaces: harbor.id });
  });

  it('the modal’s Start starts the previewed proposal, never a search hand-off’s words', async () => {
    function mountHandOff() {
      const onStart = vi.fn();
      const onStartSurprise = vi.fn();
      render(
        createElement(CreateSessionCard, {
          onStart,
          llmConfigured: true,
          initialPrompt: 'rainy day piano',
          surprise: { pending: EMBER, onStart: onStartSurprise },
        }),
      );
      return { onStart, onStartSurprise };
    }

    const untouched = mountHandOff();
    fireEvent.click(screen.getByRole('button', { name: 'Surprise Me' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start Session' }));
    expect(untouched.onStartSurprise).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ proposalId: EMBER.id, targetDurationMinutes: 45 }),
    );
    expect(untouched.onStart).not.toHaveBeenCalled();
    cleanup();

    const flipped = mountHandOff();
    fireEvent.click(screen.getByTestId('skip-profile'));
    fireEvent.click(screen.getByRole('button', { name: 'Surprise Me' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start Session' }));
    expect(flipped.onStartSurprise).not.toHaveBeenCalled();
    expect(flipped.onStart.mock.calls[0]![0]).toMatchObject({
      skipProfile: true,
      targetDurationMinutes: 45,
      input: { mode: 'prompt', prompt: EMBER.edit.prompt, genres: ['indie'], language: 'German' },
    });
  });
  describe('after a late Surprise Me cancel', () => {
    const HARBOR: SurpriseProposal = {
      ...EMBER,
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Harbor Morning',
      energy: 'low',
      edit: {
        ...EMBER.edit,
        prompt: 'Surprise me with a slow harbor morning.',
        energy: 'low',
        durationMinutes: 30,
      },
    };

    /** Try another from EMBER, Cancel it, and the server has kept HARBOR meanwhile. */
    async function cancelLate() {
      const mounted = mount();
      fireEvent.change(screen.getByLabelText(/Session duration/, { selector: 'input' }), {
        target: { value: '20' },
      });
      api.proposeSurprise.mockReturnValueOnce(new Promise(() => {}));
      api.getPendingSurprise.mockResolvedValueOnce({ ok: true, data: { proposal: HARBOR } });
      fireEvent.click(screen.getByRole('button', { name: 'Surprise Me' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Try Another' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(api.getPendingSurprise).toHaveBeenCalledOnce());
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await new Promise((resolve) => setTimeout(resolve));
      return mounted;
    }

    it('leaves the form exactly as the User left it', async () => {
      await cancelLate();

      expect((screen.getByTestId('vibe-prompt') as HTMLTextAreaElement).value).toBe(
        EMBER.edit.prompt,
      );
      expect(
        screen
          .getByLabelText(/Session duration/, { selector: 'input' })
          .getAttribute('aria-valuetext'),
      ).toBe('20 min');
    });

    it('Start Session sends the form as the User’s own request, never the old id', async () => {
      const { onStart, onStartSurprise } = await cancelLate();

      fireEvent.click(screen.getByTestId('start-vibe'));

      expect(onStartSurprise).not.toHaveBeenCalled();
      expect(onStart).toHaveBeenCalledOnce();
      expect(onStart.mock.calls[0]![0]).toMatchObject({
        targetDurationMinutes: 20,
        input: { mode: 'prompt', prompt: EMBER.edit.prompt, energy: 'medium' },
      });
    });

    it('the modal’s Start starts the proposal the server kept, with its own length', async () => {
      const { onStart, onStartSurprise } = await cancelLate();

      fireEvent.click(screen.getByRole('button', { name: 'Surprise Me' }));
      expect(await screen.findByText('Harbor Morning')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Start Session' }));

      expect(onStartSurprise).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ proposalId: HARBOR.id, targetDurationMinutes: 30 }),
      );
      expect(onStart).not.toHaveBeenCalled();
    });
  });

  it('a Start refused as no longer pending re-reads the page and starts nothing else', async () => {
    const onStartSurprise = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: 'conflict' as const,
          message: 'This suggestion is no longer available. Ask for a new one.',
          retryable: false,
        },
      }),
    );
    render(
      createElement(CreateSessionCard, {
        onStart: vi.fn(),
        llmConfigured: true,
        surprise: { pending: EMBER, onStart: onStartSurprise },
      }),
    );

    fireEvent.click(screen.getByTestId('start-vibe'));

    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(onStartSurprise).toHaveBeenCalledOnce();
    expect(api.proposeSurprise).not.toHaveBeenCalled();
  });
});
