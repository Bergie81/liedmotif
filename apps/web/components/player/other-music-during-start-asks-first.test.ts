// @vitest-environment jsdom

// Choosing other music while a Start is still setting the vibe would throw
// away a Start the listener asked for, so the player asks first: "Play this
// instead" cancels the Start (it can neither buy music nor take the player
// over when its request lands), "Keep starting" drops the tap. Only the ask
// cancels: an engage that lands late never touches a newer Start.

import { createElement, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@liedmotif/shared';

vi.mock('./use-playback-controller', () => ({
  usePlaybackController: () => fakeController,
}));

const fakeController = {
  status: 'idle',
  sessionStatus: 'active',
  blendSettled: true,
  blendEnabled: true,
  deckARef: { current: null },
  deckBRef: { current: null },
  refreshQueue: () => undefined,
  pause: () => undefined,
  setOutputVolume: () => undefined,
};

const { PlayerProvider, usePlayerActions } = await import('./player-provider');
const { beginPendingStart, cancelPendingStart, currentPendingStart } =
  await import('./session-handoff');

const resumed = { id: 'resumed-session' } as SessionSummary;

function Choices() {
  const { engage, beginOtherMusic } = usePlayerActions();
  const [answer, setAnswer] = useState<string>('none');
  return createElement(
    'div',
    null,
    createElement('button', { onClick: () => engage(resumed, { autoplay: true }) }, 'Resume'),
    createElement(
      'button',
      { onClick: () => void beginOtherMusic().then((ok) => setAnswer(String(ok))) },
      'Ask',
    ),
    createElement('output', null, answer),
  );
}

function startInFlight(): AbortSignal {
  beginPendingStart(
    () => new Promise(() => undefined),
    () => undefined,
  );
  return currentPendingStart()!.signal;
}

describe('other music during a Start', () => {
  beforeEach(() => {
    cancelPendingStart();
    render(createElement(PlayerProvider, null, createElement(Choices)));
  });
  afterEach(() => {
    cleanup();
    cancelPendingStart();
  });

  it('plays at once when no Start is in flight', async () => {
    fireEvent.click(screen.getByText('Ask'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('true'));
    expect(screen.queryByText('Your new Session is currently starting')).toBeNull();
  });

  it('"Play this instead" cancels the Start and plays', async () => {
    const signal = startInFlight();
    fireEvent.click(screen.getByText('Ask'));
    fireEvent.click(await screen.findByText('Play this instead'));

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('true'));
    expect(signal.aborted).toBe(true);
    expect(currentPendingStart()).toBeNull();
  });

  it('"Keep starting" drops the tap and keeps the Start', async () => {
    const signal = startInFlight();
    fireEvent.click(screen.getByText('Ask'));
    fireEvent.click(await screen.findByText('Keep starting'));

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('false'));
    expect(signal.aborted).toBe(false);
    expect(currentPendingStart()).not.toBeNull();
  });

  it('a Start that settles while asking closes the question and drops the tap', async () => {
    let settle!: () => void;
    beginPendingStart(
      () =>
        new Promise((resolve) => {
          settle = () =>
            resolve({
              ok: false,
              error: { code: 'internal_error', message: 'Failed.', retryable: true },
            });
        }),
      () => undefined,
    );
    fireEvent.click(screen.getByText('Ask'));
    await screen.findByText('Play this instead');

    settle();

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('false'));
    expect(screen.queryByText('Your new Session is currently starting')).toBeNull();
  });

  it('a late engage of other music keeps a newer Start', () => {
    const signal = startInFlight();
    fireEvent.click(screen.getByText('Resume'));
    expect(signal.aborted).toBe(false);
  });
});
