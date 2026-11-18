// @vitest-environment jsdom

// Settings → AI Providers (and the onboarding provider steps, which share the
// editor) report a Test result and a failed save as toasts, so the buttons
// under the fields stay put. A stored Text AI that cannot be removed says so
// the same way.

import { createElement as h, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { CredentialEditor } from './credential-editor';
import { CredentialMutationGroup } from './credential-mutation-group';
import { StoredLlmCredentialAction } from './stored-llm-credential-action';

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

function inGroup(child: ReactNode) {
  return h(CredentialMutationGroup, null, child);
}

function renderEditor() {
  render(
    inGroup(
      h(CredentialEditor, {
        providerType: 'music',
        options: [{ value: 'suno', label: 'Suno', needsKey: true, needsBaseUrl: false }],
        initialProviderKey: 'suno',
        currentMasked: '••••1234',
        configured: true,
        databaseWritesEnabled: true,
      }),
    ),
  );
}

const testButton = () => screen.getByRole('button', { name: 'Test' });

describe('credential editor — results as toasts', () => {
  it('reports a passing Test as a success toast', async () => {
    stubAnswers({ status: 200, body: { ok: true, message: 'Connection verified.' } });
    renderEditor();

    fireEvent.click(testButton());

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'success', message: 'Connection verified.' }]),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports a failing Test as one error toast that the next Test replaces', async () => {
    stubAnswers(
      { status: 200, body: { ok: false, message: 'The key was rejected.' } },
      { status: 200, body: { ok: true, message: 'Connection verified.' } },
    );
    renderEditor();

    fireEvent.click(testButton());
    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'The key was rejected.' }]),
    );
    expect(screen.queryByRole('status')).toBeNull();
    await waitFor(() => expect((testButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(testButton());

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'success', message: 'Connection verified.' }]),
    );
  });

  it('reports a failed save as an error toast', async () => {
    stubAnswers({ status: 400, body: { ok: false, error: 'The key is malformed.' } });
    renderEditor();

    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'new-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(shown()).toEqual([{ tone: 'error', message: 'The key is malformed.' }]),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('stored Text AI removal — results as toasts', () => {
  it('reports a failed removal as an error toast', async () => {
    stubAnswers({ status: 500, body: { ok: false, error: { message: 'Database offline.' } } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      inGroup(h(StoredLlmCredentialAction, { providerKey: 'openai', environmentActive: false })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable Text AI' }));

    await waitFor(() => expect(shown()).toEqual([{ tone: 'error', message: 'Database offline.' }]));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
