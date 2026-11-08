// @vitest-environment jsdom
import { createElement as h } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@liedmotif/shared';
import { SessionDurationEditor } from './session-duration-editor';

const session: SessionSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'active',
  title: 'Calm',
  createdAt: '2026-09-13T10:00:00Z',
  updatedAt: '2026-09-13T10:00:00Z',
  generationStatus: 'ok',
  generationStatusScope: null,
  sessionMode: 'keep_going',
  coverImageId: null,
  statusMessageSafe: null,
  targetDurationMinutes: 480,
  generatedDurationSeconds: 1320,
  unknownDurationTrackCount: 0,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('existing Session duration editor', () => {
  it('opens from progress with the exact off-preset target and saves unchanged without snapping', async () => {
    const onSessionChange = vi.fn();
    const fetch = vi.fn(async (_url: string, _init: { body: string }) => ({
      json: async () => ({ ok: true, data: { session } }),
    }));
    vi.stubGlobal('fetch', fetch);
    render(h(SessionDurationEditor, { session, onSessionChange }));
    fireEvent.click(screen.getByRole('button', { name: /Edit Session duration/ }));
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('480 min');
    expect(screen.queryByText('Auto')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save duration' })));
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body)).toEqual({
      sessionId: session.id,
      targetDurationMinutes: 480,
    });
    expect(onSessionChange).toHaveBeenCalledWith(session);
  });
  it('clears to No limit only when the slider is deliberately moved', async () => {
    const cleared = { ...session, targetDurationMinutes: null };
    const fetch = vi.fn(async (_url: string, _init: { body: string }) => ({
      json: async () => ({ ok: true, data: { session: cleared } }),
    }));
    vi.stubGlobal('fetch', fetch);
    render(
      h(SessionDurationEditor, {
        session: { ...session, targetDurationMinutes: 12 },
        onSessionChange: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit Session duration/ }));
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('12 min');
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('No limit');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save duration' })));
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body).targetDurationMinutes).toBeNull();
  });
});
