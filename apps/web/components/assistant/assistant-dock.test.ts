// @vitest-environment jsdom

// Opening and closing the Assistant, by pointer and by keyboard: where focus
// goes, what Escape does, what the launcher is while the panel is open, and
// what following a link in an answer does to the panel.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ASSISTANT_STREAM_CONTENT_TYPE,
  encodeAssistantStreamEvent,
  type AssistantPlayerState,
  type AssistantReceipt,
  type AssistantStreamEvent,
} from '@liedmotif/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AnswerLinkTargets } from '@/lib/assistant/answer-links';
import { onOutsideLibraryWrite } from '@/lib/offline/library-writes';
import { AssistantDock } from './assistant-dock';
import type { PlayerCommandOutcome, PlayerCommands } from './player-command';

const navigation = vi.hoisted(() => ({
  push: vi.fn<(path: string) => void>(),
  refresh: vi.fn<() => void>(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigation.push.mockClear();
  navigation.refresh.mockClear();
});

/** Where a Member's answers may lead. */
const LINKS: AnswerLinkTargets = {
  appPaths: ['/library', '/settings/playback'],
  docsPages: ['members'],
};

/** jsdom has no media queries: say which side of the `desk` breakpoint the window is on. */
function renderDock({
  desk,
  launcherHidden,
  player,
  onReceipt,
  playerCommands,
}: {
  desk: boolean;
  launcherHidden?: boolean;
  player?: AssistantPlayerState;
  onReceipt?: (receipt: AssistantReceipt) => void;
  playerCommands?: PlayerCommands;
}) {
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: desk, addEventListener: () => {}, removeEventListener: () => {} }) as never,
  );
  return render(
    h(
      TooltipProvider,
      null,
      h('button', { type: 'button' }, 'Something on the page'),
      h(AssistantDock, { links: LINKS, launcherHidden, player, onReceipt, playerCommands }),
    ),
  );
}

/** Ask a question the Assistant answers at once with `markdown`. */
function askAndGetAnswer(markdown: string): void {
  askAndGetReply([{ type: 'text', text: markdown }]);
}

/** Ask a question the Assistant answers at once with `events`, then ends. */
function askAndGetReply(events: AssistantStreamEvent[]): void {
  const reply = [...events, { type: 'done' } as const].map(encodeAssistantStreamEvent).join('');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(reply, { headers: { 'Content-Type': ASSISTANT_STREAM_CONTENT_TYPE } }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));
  fireEvent.click(screen.getByRole('button', { name: 'What does New music do?' }));
}

it('sends what the player has engaged along with a question', () => {
  const player = {
    source: { kind: 'playlist' as const, id: '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11' },
    trackId: '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22',
    playing: true,
  };
  renderDock({ desk: true, player });

  askAndGetAnswer('Night Drive.');

  const [, init] = vi.mocked(fetch).mock.calls[0]!;
  expect(JSON.parse(String(init?.body))).toMatchObject({ player });
});

it('opens from the launcher with a greeting and questions to start from', () => {
  renderDock({ desk: true });
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  const panel = screen.getByRole('dialog', { name: 'Mo' });
  expect(panel.textContent).toContain("Hi, I'm Mo. Ask me anything about your Liedmotif.");
  expect(screen.getByRole('button', { name: 'What does New music do?' })).toBeTruthy();
});

it('puts the cursor in the question field when it opens beside the page', () => {
  renderDock({ desk: true });

  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Ask Mo' }));
});

it('moves focus into the panel, not the field, when it covers the page', () => {
  renderDock({ desk: false });

  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Mo' }));
});

it('turns the launcher into the close button while the sidebar is open', () => {
  renderDock({ desk: true });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));
  expect(document.documentElement.classList.contains('assistant-open')).toBe(true);

  // The panel's own header carries a close button of the same name; the
  // launcher is the one outside the panel.
  const launcher = screen
    .getAllByRole('button', { name: 'Close Mo' })
    .find((button) => !screen.getByRole('dialog').contains(button))!;
  fireEvent.click(launcher);

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.documentElement.classList.contains('assistant-open')).toBe(false);
  expect(screen.getByRole('button', { name: 'Ask Mo' })).toBeTruthy();
});

it('closes on Escape and hands focus back to the launcher', async () => {
  renderDock({ desk: true });
  const launcher = screen.getByRole('button', { name: 'Ask Mo' });
  fireEvent.click(launcher);

  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Ask Mo' }), { key: 'Escape' });

  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(launcher));
});

it('leaves Escape to the page while focus is in the page beside the sidebar', () => {
  renderDock({ desk: true });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));
  const pageButton = screen.getByRole('button', { name: 'Something on the page' });

  pageButton.focus();
  fireEvent.keyDown(pageButton, { key: 'Escape' });

  expect(screen.getByRole('dialog', { name: 'Mo' })).toBeTruthy();
});

it('keeps the conversation while the panel is closed', () => {
  renderDock({ desk: true });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask Mo' }), {
    target: { value: 'How do I invite' },
  });

  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Ask Mo' }), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  expect((screen.getByRole('textbox', { name: 'Ask Mo' }) as HTMLTextAreaElement).value).toBe(
    'How do I invite',
  );
});

it('shows no launcher on a page that keeps controls in that corner', () => {
  renderDock({ desk: false, launcherHidden: true });

  expect(screen.queryByRole('button', { name: 'Ask Mo' })).toBeNull();
});

it('asks a suggested question and can stop the answer from the field', () => {
  // The request never settles: the answer stays "being written".
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  renderDock({ desk: true });
  fireEvent.click(screen.getByRole('button', { name: 'Ask Mo' }));

  fireEvent.click(screen.getByRole('button', { name: 'What does New music do?' }));

  expect(screen.getByRole('log').textContent).toContain('What does New music do?');
  expect(screen.getByRole('status').textContent).toContain('Mo is looking it up');
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Stop the answer' }));

  // Nothing was answered: the question is back in the field, ready to send again.
  const field = screen.getByRole('textbox', { name: 'Ask Mo' }) as HTMLTextAreaElement;
  expect(field.value).toBe('What does New music do?');
  expect(document.activeElement).toBe(field);
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
});

it('opens the page an answer links to and keeps the sidebar open beside it', async () => {
  renderDock({ desk: true });
  askAndGetAnswer('Set it in [Settings › Playback](/settings/playback).');

  fireEvent.click(await screen.findByRole('button', { name: 'Settings › Playback' }));

  expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/settings/playback');
  expect(screen.getByRole('dialog', { name: 'Mo' })).toBeTruthy();
});

it('closes the panel that covers the page when a link in an answer is followed', async () => {
  renderDock({ desk: false });
  askAndGetAnswer('Set it in [Settings › Playback](/settings/playback).');

  fireEvent.click(await screen.findByRole('button', { name: 'Settings › Playback' }));

  expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/settings/playback');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it("offers no button for a page that is not among this user's link targets", async () => {
  renderDock({ desk: true });
  askAndGetAnswer('Ask your Admin to open [Settings › Members](/settings/members).');

  await waitFor(() => expect(screen.getByRole('log').textContent).toContain('Settings › Members'));

  expect(screen.queryByRole('button', { name: 'Settings › Members' })).toBeNull();
  expect(screen.getByRole('log').querySelector('a')).toBeNull();
});

const PLAYLIST = { id: '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11', name: 'Sunday' };
const CREATED: AssistantReceipt = { action: 'createPlaylist', playlist: PLAYLIST };
const receiptFor = (receipt: AssistantReceipt): AssistantStreamEvent => ({
  type: 'action',
  action: { status: 'done', receipt },
});

it('shows a receipt in the app’s words for what the Assistant did, next to what it wrote', async () => {
  renderDock({ desk: true });

  askAndGetReply([receiptFor(CREATED), { type: 'text', text: 'All set, as “Weekend”.' }]);

  const log = await screen.findByRole('log', { name: 'Conversation' });
  await waitFor(() => expect(log.textContent).toContain('Created Playlist: Sunday'));
  expect(log.textContent).toContain('All set, as “Weekend”.');
});

it('shows the receipt alone when the Assistant acted and wrote nothing', async () => {
  renderDock({ desk: true });

  askAndGetReply([receiptFor(CREATED)]);

  const log = await screen.findByRole('log', { name: 'Conversation' });
  await waitFor(() => expect(log.textContent).toContain('Created Playlist: Sunday'));
  expect(log.textContent).not.toContain('looking it up');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('links a receipt to where the thing now is, a page no answer of the model could link to', async () => {
  renderDock({ desk: false });
  askAndGetReply([receiptFor(CREATED)]);

  fireEvent.click(await screen.findByRole('button', { name: 'Open Sunday' }));

  expect(navigation.push).toHaveBeenCalledWith(`/library/playlist/${PLAYLIST.id}`);
  // Over the page, the panel would hide the page the receipt led to.
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('has the pages re-read the Library when a receipt arrives, and tells the app shell', async () => {
  const outsideWrites = vi.fn();
  const stopListening = onOutsideLibraryWrite(outsideWrites);
  const onReceipt = vi.fn();
  renderDock({ desk: true, onReceipt });

  askAndGetReply([receiptFor(CREATED), { type: 'text', text: 'Done.' }]);

  await waitFor(() => expect(onReceipt).toHaveBeenCalledWith(CREATED));
  expect(navigation.refresh).toHaveBeenCalledTimes(1);
  expect(outsideWrites).toHaveBeenCalledTimes(1);
  stopListening();
});

it('leaves the Library pages alone when a receipt changed nothing they show', async () => {
  const onReceipt = vi.fn();
  renderDock({ desk: true, onReceipt });
  const off: AssistantReceipt = {
    action: 'newMusicOff',
    session: { id: '5d2f8e1b-6c3a-4f7e-8b9d-1a2b3c4d5e6f', name: 'Rainy Window' },
  };

  askAndGetReply([receiptFor(off)]);

  await waitFor(() => expect(onReceipt).toHaveBeenCalledWith(off));
  expect(navigation.refresh).not.toHaveBeenCalled();
});

/** The app shell's player, as the dock is handed it: every command comes to `outcome`. */
function playerThat(outcome: PlayerCommandOutcome) {
  return {
    prime: vi.fn<PlayerCommands['prime']>(),
    run: vi.fn<PlayerCommands['run']>(async () => outcome),
    tapToPlay: vi.fn<PlayerCommands['tapToPlay']>(async () => 'done'),
  };
}

const commandFor = (name: 'pause' | 'continue'): AssistantStreamEvent => ({
  type: 'action',
  action: { status: 'player', command: { name } },
});

it('hands a player command to the player the moment it arrives, and shows one line for it', async () => {
  const playerCommands = playerThat('done');
  renderDock({ desk: true, playerCommands });

  askAndGetReply([commandFor('pause'), { type: 'text', text: 'Paused.' }]);

  const log = await screen.findByRole('log', { name: 'Conversation' });
  await waitFor(() => expect(log.textContent).toContain('Paused'));
  expect(playerCommands.run).toHaveBeenCalledExactlyOnceWith({ name: 'pause' });
  expect(screen.queryByRole('button', { name: 'Tap to play' })).toBeNull();
});

it('offers "Tap to play" when the browser refused the audio, and plays inside that tap', async () => {
  const playerCommands = playerThat('blocked');
  renderDock({ desk: true, playerCommands });

  askAndGetReply([commandFor('continue')]);

  const tap = await screen.findByRole('button', { name: 'Tap to play' });
  const log = screen.getByRole('log', { name: 'Conversation' });
  expect(log.textContent).toContain('Your browser did not start the audio.');

  fireEvent.click(tap);

  expect(playerCommands.tapToPlay).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Tap to play' })).toBeNull());
  expect(log.textContent).toContain('Playing');
  expect(playerCommands.run).toHaveBeenCalledOnce();
});

it('primes the player’s audio inside the gesture that sends a message: the button and Enter', async () => {
  const playerCommands = playerThat('done');
  renderDock({ desk: true, playerCommands });
  expect(playerCommands.prime).not.toHaveBeenCalled();

  askAndGetAnswer('It keeps the music coming.');
  expect(playerCommands.prime).toHaveBeenCalledTimes(1);
  const field = screen.getByRole('textbox', { name: 'Ask Mo' });
  fireEvent.change(field, { target: { value: 'Continue.' } });
  // The first answer is through: the field sends again.
  await screen.findByRole('button', { name: 'Send' });

  fireEvent.keyDown(field, { key: 'Enter' });
  expect(playerCommands.prime).toHaveBeenCalledTimes(2);

  fireEvent.change(field, { target: { value: 'And next.' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
  expect(playerCommands.prime).toHaveBeenCalledTimes(3);
});
