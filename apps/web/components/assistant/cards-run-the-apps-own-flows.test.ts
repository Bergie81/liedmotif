// @vitest-environment jsdom

// The cards for a Change Vibe, a More Like This and New Music on, and the
// click on each: the card is worded from its values, and confirming runs the
// flow the app's own control runs. The dock is wired to the app as the app
// shell wires it; the routes are a stubbed `fetch`. Of the player provider,
// the Change Vibe request is the real one and the rest are spies.

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeApiError, type AssistantCard, type SessionSummary } from '@liedmotif/shared';
import { beginPendingStart, cancelPendingStart } from '@/components/player/session-handoff';
import { askAgain, askForCard, cardEvent } from '@/tests/helpers/assistant-card-chat';

const navigation = vi.hoisted(() => ({
  push: vi.fn<(path: string) => void>(),
  refresh: vi.fn<() => void>(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

const player = vi.hoisted(() => ({
  beginStart: vi.fn<() => void>(),
  beginOtherMusic: vi.fn<() => Promise<boolean>>(),
  engage: vi.fn<(session: unknown, options: unknown) => void>(),
  /** What the provider does with a restyled Session: it lands on the engaged source. */
  applyRestyledSession: vi.fn<(session: unknown) => void>(),
  /** The Session the player has engaged, as far as a card's flow reads it. */
  playback: null as { session: { id: string } | null } | null,
}));
vi.mock('@/components/player/player-provider', async () => {
  const { useVibeChangeRequest } = await import('@/components/player/use-vibe-change-request');
  const usePlayer = () => ({
    ...player,
    ...useVibeChangeRequest(player.applyRestyledSession),
  });
  return { usePlayerActions: usePlayer, usePlayerContext: usePlayer };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  cancelPendingStart();
  player.playback = null;
});

const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const RAINY = { id: SESSION_ID, name: 'Rainy Window' };
const NIGHT_DRIVE = { id: '00000000-0000-4000-8000-000000000011', name: 'Night Drive' };
const LOW_TIDE = { id: '00000000-0000-4000-8000-000000000012', name: 'Low Tide' };

const summary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: SESSION_ID,
  status: 'active',
  title: 'Rainy Window',
  createdAt: '2026-11-10T10:00:00Z',
  updatedAt: '2026-11-10T10:00:00Z',
  generationStatus: 'ok',
  generationStatusScope: null,
  sessionMode: 'keep_going',
  coverImageId: null,
  statusMessageSafe: null,
  targetDurationMinutes: null,
  generatedDurationSeconds: 0,
  unknownDurationTrackCount: 0,
  ...overrides,
});

const saved = (session: SessionSummary) => Response.json({ ok: true, data: { session } });

const refused = (message: string) =>
  Response.json(makeApiError('session_headroom_blocked', message), { status: 429 });

const button = (name: string) => screen.getByRole('button', { name });

describe('a Change Vibe card', () => {
  const SLOWER: AssistantCard = {
    kind: 'changeVibe',
    session: RAINY,
    prompt: 'slower, with a cello',
  };
  const ask = (options?: Parameters<typeof askForCard>[2]) =>
    askForCard('Change Vibe', [cardEvent(SLOWER)], options);

  it('is worded from its values, with the budget line, and changes nothing until it is clicked', async () => {
    const { card, server } = await ask();

    expect(card.textContent).toContain('“slower, with a cello”');
    expect(card.textContent).toContain('In Rainy Window');
    expect(card.textContent).toContain(
      'Changing the vibe generates new tracks from your budget. 38 tracks left today.',
    );
    expect(within(card).getAllByRole('button')).toEqual([button('Change Vibe')]);
    expect(server.sent).toEqual([]);
  });

  it('runs the player’s Change Vibe: the card’s words to the Change Vibe route, the Session refreshed in place', async () => {
    const { card, server } = await ask({ desk: false });

    fireEvent.click(button('Change Vibe'));

    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]!.path).toBe('/api/sessions/change-vibe');
    expect(server.sent[0]!.body).toEqual({
      sessionId: SESSION_ID,
      input: { mode: 'prompt', prompt: 'slower, with a cello' },
    });
    expect(button('Changing…')).toHaveProperty('disabled', true);
    // The same Session plays on: there is no other page to show, on the phone either.
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Roadie' })).toBeTruthy();

    const restyled = summary({ updatedAt: '2026-11-10T10:05:00Z' });
    server.sent[0]!.answer(saved(restyled));

    await waitFor(() => expect(card.textContent).toContain('Vibe changed'));
    expect(within(card).queryByRole('button')).toBeNull();
    expect(player.applyRestyledSession).toHaveBeenCalledExactlyOnceWith(restyled);
  });

  it('says the vibe did not change when the app refuses', async () => {
    const { card, server } = await ask();
    fireEvent.click(button('Change Vibe'));

    server.sent[0]!.answer(refused('You have reached your generation headroom for now.'));

    await waitFor(() => expect(card.textContent).toContain('The vibe did not change'));
    expect(within(card).queryByRole('button')).toBeNull();
    expect(player.applyRestyledSession).not.toHaveBeenCalled();
  });

  it('works once, and sends nothing while another Change Vibe is still in flight', async () => {
    const { server } = await ask();
    askAgain('And another.');
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Change Vibe' })).toHaveLength(2),
    );
    const [first, second] = screen.getAllByRole('button', { name: 'Change Vibe' });

    fireEvent.click(first!);
    fireEvent.click(first!);
    // The second card of the conversation, while the first one's request is out.
    fireEvent.click(second!);

    expect(server.sent).toHaveLength(1);
    expect(second).toHaveProperty('disabled', true);
    expect(screen.getAllByRole('button', { name: 'Change Vibe' })).toEqual([second]);

    server.sent[0]!.answer(saved(summary()));

    await waitFor(() => expect(second).toHaveProperty('disabled', false));
    expect(server.sent).toHaveLength(1);
  });

  it('cannot be confirmed while another Change Vibe is in flight, says so, and can be confirmed again once that one ended', async () => {
    const { server } = await ask();
    askAgain('And another.');
    await waitFor(() =>
      expect(screen.getAllByRole('group', { name: 'Change Vibe' })).toHaveLength(2),
    );
    const [firstCard, secondCard] = screen.getAllByRole('group', { name: 'Change Vibe' });

    fireEvent.click(within(firstCard!).getByRole('button', { name: 'Change Vibe' }));

    // The card whose own request is out keeps its own state.
    expect(within(firstCard!).getByRole('button', { name: 'Changing…' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(firstCard!.textContent).not.toContain('Changing vibe…');
    // The other one waits, and says why, in the player's own words.
    const waiting = within(secondCard!).getByRole('button', { name: 'Change Vibe' });
    expect(waiting).toHaveProperty('disabled', true);
    expect(secondCard!.textContent).toContain('Changing vibe…');
    fireEvent.click(waiting);
    expect(server.sent).toHaveLength(1);

    server.sent[0]!.answer(refused('You have reached your generation headroom for now.'));

    await waitFor(() => expect(waiting).toHaveProperty('disabled', false));
    expect(firstCard!.textContent).toContain('The vibe did not change');
    // The waiting card was never settled, and nothing went out by itself.
    expect(secondCard!.textContent).not.toContain('Changing vibe…');
    expect(secondCard!.textContent).not.toContain('The vibe did not change');
    expect(server.sent).toHaveLength(1);

    askAgain('Is it still there?');
    await waitFor(() => expect(server.asked).toHaveLength(3));
    expect(server.asked[2]!.join('\n')).toContain(
      'The user has not confirmed it, so it has not happened.',
    );

    fireEvent.click(waiting);

    expect(server.sent).toHaveLength(2);
    expect(server.sent[1]!.path).toBe('/api/sessions/change-vibe');
    expect(within(secondCard!).getByRole('button', { name: 'Changing…' })).toBeTruthy();
  });
});

describe('a More Like This card', () => {
  const LIKE_THESE: AssistantCard = {
    kind: 'moreLikeThis',
    tracks: [NIGHT_DRIVE, LOW_TIDE],
    targetDurationMinutes: 30,
  };
  const NEW_SESSION = summary({ id: '00000000-0000-4000-8000-000000000004', title: 'Dusk Roads' });
  const ask = (options?: Parameters<typeof askForCard>[2]) =>
    askForCard('More Like This', [cardEvent(LIKE_THESE)], options);

  it('names its seed Tracks, with the budget line, and starts nothing until it is clicked', async () => {
    const { card, server } = await ask();

    expect(card.textContent).toContain('A new session seeded from 2 tracks: Night Drive, Low Tide');
    expect(card.textContent).toContain(
      'Generates up to 30 min of new music. 38 tracks left today.',
    );
    // A card without words of the user's shows no quote.
    expect(card.textContent).not.toMatch(/[“”]/);
    expect(within(card).getAllByRole('button')).toEqual([button('Start New Session')]);
    expect(within(card).getByRole('slider', { name: /session duration/i })).toHaveProperty(
      'value',
      '30',
    );
    expect(server.sent).toEqual([]);
    expect(player.beginOtherMusic).not.toHaveBeenCalled();
  });

  it('runs the app’s More Like This: asked in the click, seeded from the card’s Tracks, engaged and on to the Player', async () => {
    player.beginOtherMusic.mockResolvedValue(true);
    const { card, server } = await ask({ desk: false });

    fireEvent.click(button('Start New Session'));

    // Inside the click: the browser lets audio start only from the gesture.
    expect(player.beginOtherMusic).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.path).toBe('/api/sessions/more-like-this');
    expect(server.sent[0]!.body).toEqual({
      seedTrackIds: [NIGHT_DRIVE.id, LOW_TIDE.id],
      targetDurationMinutes: 30,
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(button('Starting Session…')).toHaveProperty('disabled', true);
    // Nothing to show yet: the music that plays goes on until the new Session exists.
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Roadie' })).toBeTruthy();

    server.sent[0]!.answer(
      Response.json({ ok: true, data: { session: NEW_SESSION, supersededSessionId: SESSION_ID } }),
    );

    await waitFor(() => expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/player'));
    expect(player.engage).toHaveBeenCalledExactlyOnceWith(NEW_SESSION, { autoplay: false });
    // The panel that covers the page gets out of the Player's way.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(button('Ask Roadie'));
    expect(screen.getByRole('group', { name: 'More Like This' }).textContent).toContain(
      'Session started',
    );
    expect(card.isConnected).toBe(false);
  });

  it.each<[string, number | null, Record<string, unknown>]>([
    ['sends the card’s length with the seeds', 45, { targetDurationMinutes: 45 }],
    ['sends No limit as an explicit null', null, { targetDurationMinutes: null }],
  ])('%s', async (_, targetDurationMinutes, length) => {
    player.beginOtherMusic.mockResolvedValue(true);
    const { card, server } = await askForCard(
      'More Like This',
      [cardEvent({ ...LIKE_THESE, targetDurationMinutes })],
      { desk: false },
    );
    expect(card.textContent).toContain(targetDurationMinutes === null ? 'No Limit' : '45 min');

    fireEvent.click(button('Start New Session'));

    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.path).toBe('/api/sessions/more-like-this');
    expect(server.sent[0]!.body).toEqual({
      seedTrackIds: [NIGHT_DRIVE.id, LOW_TIDE.id],
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      ...length,
    });
  });

  it('shows the card’s context as its words and sends it with the seeds', async () => {
    player.beginOtherMusic.mockResolvedValue(true);
    const { card, server } = await askForCard(
      'More Like This',
      [cardEvent({ ...LIKE_THESE, context: 'for cooking' })],
      { desk: false },
    );
    expect(card.textContent).toContain('“for cooking”');

    fireEvent.click(button('Start New Session'));

    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.body).toEqual({
      seedTrackIds: [NIGHT_DRIVE.id, LOW_TIDE.id],
      targetDurationMinutes: 30,
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      context: 'for cooking',
    });
  });

  it('sends the length set on its slider with the seeds', async () => {
    player.beginOtherMusic.mockResolvedValue(true);
    const { card, server } = await ask({ desk: false });

    fireEvent.change(within(card).getByRole('slider', { name: /session duration/i }), {
      target: { value: '120' },
    });
    expect(card.textContent).toContain('Generates up to 120 min of new music.');
    fireEvent.click(button('Start New Session'));

    await waitFor(() => expect(server.sent).toHaveLength(1));
    expect(server.sent[0]!.body).toMatchObject({ targetDurationMinutes: 120 });
  });

  it('shows the app’s own refusal on the card, and stays where it is', async () => {
    player.beginOtherMusic.mockResolvedValue(true);
    const { card, server } = await ask({ desk: false });
    fireEvent.click(button('Start New Session'));
    await waitFor(() => expect(server.sent).toHaveLength(1));

    server.sent[0]!.answer(refused('You have reached your generation headroom for now.'));

    await waitFor(() =>
      expect(card.textContent).toContain(
        'More Like This didn’t start: You have reached your generation headroom for now.',
      ),
    );
    expect(within(card).queryByRole('button')).toBeNull();
    expect(player.engage).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Roadie' })).toBeTruthy();
  });

  it('sends nothing while a Start is still in flight: it goes to the Player, and stays to be confirmed', async () => {
    const { server } = await ask();
    // A Start from Home that has not settled.
    beginPendingStart(() => new Promise(() => {}), vi.fn());

    fireEvent.click(button('Start New Session'));

    expect(server.sent).toEqual([]);
    expect(player.beginOtherMusic).not.toHaveBeenCalled();
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/player');
    expect(button('Start New Session')).toHaveProperty('disabled', false);
  });
});

describe('a New Music card', () => {
  const UP_TO_90: AssistantCard = {
    kind: 'newMusicOn',
    session: RAINY,
    targetDurationMinutes: 90,
  };
  const ask = (card = UP_TO_90, options?: Parameters<typeof askForCard>[2]) =>
    askForCard('Switch New Music On', [cardEvent(card)], options);

  it('words the choice as the New Music control does, with the budget line, and saves nothing until it is clicked', async () => {
    const { card, server } = await ask();

    expect(card.textContent).toContain('Rainy Window · Up to 90 min');
    expect(card.textContent).toContain('Buys music until the target. 38 tracks left today.');
    expect(within(card).getAllByRole('button')).toEqual([button('Save · Up to 90 min')]);
    expect(server.sent).toEqual([]);
  });

  it('saves through the route the New Music control saves through, and the player follows', async () => {
    player.playback = { session: { id: SESSION_ID } };
    const { card, server, refresh } = await ask(UP_TO_90, { desk: false });
    refresh.mockClear();

    fireEvent.click(button('Save · Up to 90 min'));

    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]!.path).toBe('/api/sessions/duration');
    expect(server.sent[0]!.body).toEqual({
      sessionId: SESSION_ID,
      targetDurationMinutes: 90,
      sessionMode: 'keep_going',
    });
    expect(button('Saving…')).toHaveProperty('disabled', true);

    const on = summary({ targetDurationMinutes: 90 });
    server.sent[0]!.answer(saved(on));

    await waitFor(() => expect(card.textContent).toContain('New Music is on'));
    expect(within(card).queryByRole('button')).toBeNull();
    // The engaged Session takes the saved summary in place, as after the sheet's Save.
    expect(player.engage).toHaveBeenCalledExactlyOnceWith(on, { autoplay: false });
    // The shell reads its own copy of the active Session again, for the mini player.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Roadie' })).toBeTruthy();
  });

  it('saves No limit as a cleared target', async () => {
    const { card, server } = await ask({ ...UP_TO_90, targetDurationMinutes: null });
    expect(card.textContent).toContain('Rainy Window · No Limit');
    expect(card.textContent).toContain(
      'Keeps buying while you listen until you stop or your budget is gone.',
    );

    fireEvent.click(button('Save · No Limit'));

    expect(server.sent[0]!.body).toEqual({
      sessionId: SESSION_ID,
      targetDurationMinutes: null,
      sessionMode: 'keep_going',
    });
  });

  it('leaves other music the player has engaged alone', async () => {
    player.playback = { session: { id: '00000000-0000-4000-8000-000000000009' } };
    const { card, server } = await ask();
    fireEvent.click(button('Save · Up to 90 min'));

    server.sent[0]!.answer(saved(summary({ targetDurationMinutes: 90 })));

    await waitFor(() => expect(card.textContent).toContain('New Music is on'));
    expect(player.engage).not.toHaveBeenCalled();
  });

  it('shows the app’s refusal on the card, where the control shows it in its sheet', async () => {
    const { card, server } = await ask();
    fireEvent.click(button('Save · Up to 90 min'));

    server.sent[0]!.answer(
      Response.json(makeApiError('not_found', 'Session not found.'), { status: 404 }),
    );

    await waitFor(() =>
      expect(card.textContent).toContain('New Music didn’t switch on: Session not found.'),
    );
    expect(within(card).queryByRole('button')).toBeNull();
    expect(player.engage).not.toHaveBeenCalled();
  });

  it('works once: a second click sends no second request', async () => {
    const { server } = await ask();
    const save = button('Save · Up to 90 min');

    fireEvent.click(save);
    fireEvent.click(save);

    expect(server.sent).toHaveLength(1);
  });
});

describe('what the next request is told of a card', () => {
  it('says the app refused it and told the user why', async () => {
    const { card, server } = await askForCard('Switch New Music On', [
      cardEvent({ kind: 'newMusicOn', session: RAINY, targetDurationMinutes: null }),
    ]);
    fireEvent.click(button('Save · No Limit'));
    server.sent[0]!.answer(
      Response.json(makeApiError('not_found', 'Session not found.'), { status: 404 }),
    );
    await waitFor(() => expect(card.textContent).toContain('Session not found.'));

    askAgain('What happened?');

    await waitFor(() => expect(server.asked).toHaveLength(2));
    expect(server.asked[1]![1]).toBe(
      '[Card shown by the app: switch New Music on for the Session "Rainy Window", with no limit. The user confirmed it, but the app did not carry it out and told them why.]',
    );
  });
});
