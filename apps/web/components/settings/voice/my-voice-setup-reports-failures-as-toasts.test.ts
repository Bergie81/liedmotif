// @vitest-environment jsdom

// Settings → My voice reports a failed step as a toast its next success clears,
// so the setup cards stay put. A profile whose setup failed says so on its own
// card, because that is the state it is in until a new recording goes in.

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceProfileView } from '@liedmotif/shared';
import { shownToasts, toast } from '@/lib/toast';
import { MyVoiceSetup } from './my-voice-setup';

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
});

const NONE: VoiceProfileView = {
  status: 'none',
  displayName: 'My voice',
  language: '',
  verificationPhrase: null,
  errorMessageSafe: null,
  hasSourceRecording: false,
  hasVerificationRecording: false,
  setupSupported: true,
  generationSupported: true,
  availableForSessions: false,
};

/** Answers each request in turn with the next of `answers`. */
function stubAnswers(...answers: Array<{ status: number; body: unknown }>) {
  const queue = [...answers];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const answer = queue.shift() ?? { status: 500, body: {} };
      return Response.json(answer.body, { status: answer.status });
    }),
  );
}

function shown() {
  return shownToasts().map(({ tone, message }) => ({ tone, message }));
}

function setUp() {
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Set up my voice' }));
}

describe('MyVoiceSetup — failures as toasts', () => {
  it('reports a failed step as an error toast that the next success clears', async () => {
    stubAnswers(
      {
        status: 503,
        body: {
          ok: false,
          error: {
            code: 'provider_error',
            message: 'The provider is unavailable.',
            retryable: true,
          },
        },
      },
      { status: 200, body: { ok: true, data: { profile: { ...NONE, status: 'draft' } } } },
    );
    render(createElement(MyVoiceSetup, { initial: NONE }));

    setUp();
    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'The provider is unavailable.' }]),
    );
    expect(screen.queryByRole('status')).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Set up my voice' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set up my voice' }));

    expect(await screen.findByText('Source sample')).toBeTruthy();
    expect(shown()).toEqual([]);
  });

  it('reports a recording that could not start as an error toast', async () => {
    stubAnswers();
    render(createElement(MyVoiceSetup, { initial: { ...NONE, status: 'draft' } }));

    fireEvent.click(screen.getAllByRole('button', { name: 'Start recording' })[0]!);

    await waitFor(() =>
      expect(shown()).toEqual([
        {
          tone: 'error',
          message:
            'Microphone access was blocked — allow it in the browser settings and try again.',
        },
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a failed setup on its card', () => {
    stubAnswers();
    render(
      createElement(MyVoiceSetup, {
        initial: { ...NONE, status: 'failed', errorMessageSafe: 'The sample was too noisy.' },
      }),
    );

    expect(screen.getByText('The sample was too noisy.')).toBeTruthy();
    expect(shown()).toEqual([]);
  });
});
