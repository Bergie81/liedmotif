import type { AssistantCard } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { answerLanguageLine } from './answer-language';
import { withoutAppRecords } from './app-records';
import { cardRecord } from './card-note';
import { playerCommandRecord } from './player-command-note';
import { receiptRecord } from './receipt-note';

const TRACK = { id: '0a74a178-d646-4539-8faa-a09324e0eb06', name: 'Vier im Mondorbit' };
const PLAYLIST = { id: 'ccb8df8e-7baa-4d7a-9b11-39c0a8acccaf', name: 'Running' };
const CARD: AssistantCard = {
  kind: 'moreLikeThis',
  tracks: [TRACK],
  targetDurationMinutes: 30,
  context: 'for cooking',
};

async function* stream(chunks: readonly string[]) {
  for (const chunk of chunks) yield chunk;
}

/** What the user is shown of an answer written in these chunks. */
async function shown(chunks: readonly string[]): Promise<string> {
  let text = '';
  for await (const chunk of withoutAppRecords(stream(chunks))) text += chunk;
  return text;
}

/** A text cut into chunks of `size` characters, as a model might stream it. */
const cut = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );

describe("an answer as the user is shown it, when the model writes the app's record of an action", () => {
  it('drops the record at the end, however the model streams it', async () => {
    // A record split into a chunk per word, its closing quote and bracket in one.
    expect(
      await shown([
        '„Vier im Mondorbit“ ist in „Running“. Passt.\n\n',
        '[',
        'Done',
        ' by',
        ' the',
        ' app',
        ':',
        ' added the Track to the Playlist "Running"',
        '"]',
      ]),
    ).toBe('„Vier im Mondorbit“ ist in „Running“. Passt.');
    const answer = `Passt.\n\n${receiptRecord({ action: 'addToPlaylist', playlist: PLAYLIST, retention: 'curated', tracks: [TRACK] })}`;
    for (const size of [1, 2, 3, 7]) expect(await shown(cut(answer, size))).toBe('Passt.');
  });

  it.each([
    ['a receipt', receiptRecord({ action: 'favoriteTrack', track: TRACK, playlist: PLAYLIST })],
    ['a player command', playerCommandRecord({ name: 'pause' })],
    ['a player command that was blocked', playerCommandRecord({ name: 'pause' }, 'blocked')],
    ['a player command that failed', playerCommandRecord({ name: 'next' }, 'failed')],
    ['a card', cardRecord(CARD)],
    ['a confirmed card', cardRecord(CARD, 'confirmed')],
    ["the line that names the answer's language", answerLanguageLine('English')],
  ])('drops %s, in the very form the app writes it', async (_what, record) => {
    expect(await shown([`Done.\n\n${record}`])).toBe('Done.');
    expect(await shown([record])).toBe('');
  });

  it('drops a record inside a line and keeps the words around it', async () => {
    expect(
      await shown(['Passt. ', '[Done by the app: added the Track to Favorites]', ' Weiter.']),
    ).toBe('Passt. Weiter.');
  });

  it('keeps what follows a record line', async () => {
    expect(
      await shown([
        'Paused.\n\n',
        '[Done by the app: the player was told to pause the music]\n\nAs ordered.',
      ]),
    ).toBe('Paused.\n\nAs ordered.');
  });

  it('ends a record at its closing bracket, before a link later on its line', async () => {
    expect(
      await shown([
        '[Done by the app: Added "Song [Remix]" to Favorites] See [Playback](/settings/playback).',
      ]),
    ).toBe('See [Playback](/settings/playback).');
  });

  it('keeps the words after a record closed right before punctuation', async () => {
    expect(await shown(['[Done by the app: added the Track to Favorites]. Weiter.'])).toBe(
      '. Weiter.',
    );
    expect(await shown(['[Done by the app: paused]. See [Playback](/settings/playback).'])).toBe(
      '. See [Playback](/settings/playback).',
    );
  });

  it('drops the whole record when a name in it holds a bracket and a space', async () => {
    const track = { ...TRACK, name: 'Night [Live] Edit "2"' };
    const record = receiptRecord({ action: 'favoriteTrack', track, playlist: PLAYLIST });
    expect(await shown([`Done.\n\n${record}`])).toBe('Done.');
    expect(await shown(cut(`${record} See [Playback](/settings/playback).`, 3))).toBe(
      'See [Playback](/settings/playback).',
    );
  });

  it('drops every record of a last line', async () => {
    expect(
      await shown(['[Done by the app: paused] [Done by the app: looped] Playback is ready.']),
    ).toBe('Playback is ready.');
  });

  it('keeps words and paragraphs apart where a record stood between them', async () => {
    expect(await shown(['Paused.[Done by the app: paused] Next.'])).toBe('Paused. Next.');
    expect(await shown(['Paused. [Done by the app: paused]\n\n- Next Track is ready'])).toBe(
      'Paused.\n\n- Next Track is ready',
    );
    expect(await shown(['[Done by the app: paused]\n\nAs ordered.'])).toBe('As ordered.');
  });

  it('shows the words after a record on its line without waiting for the line to end', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow() {
      yield '[Done by the app: paused] Open Settings';
      await waiting;
    }
    const reader = withoutAppRecords(slow())[Symbol.asyncIterator]();

    expect((await reader.next()).value).toBe('Open Settings');
    release();
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });

  it('leaves links and other brackets as written', async () => {
    const answer =
      'Open **Settings › Playback** [sic] to change it.\n\n[Settings › Playback](/settings/playback)';
    expect(await shown(cut(answer, 3))).toBe(answer);
    expect(await shown(['It says [Done', '] there.'])).toBe('It says [Done] there.');
    expect(await shown(['Ends on [Done by the'])).toBe('Ends on [Done by the');
  });

  it('shows the text as it comes, holding back only what could still be a record', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow() {
      yield 'Paused. ';
      yield '[Settings › Playback](/settings/playback)';
      yield '\n\n[Done';
      await waiting;
      yield ' by the app: the player was told to pause the music]';
    }
    const reader = withoutAppRecords(slow())[Symbol.asyncIterator]();

    expect((await reader.next()).value).toBe('Paused.');
    expect((await reader.next()).value).toBe(' [Settings › Playback](/settings/playback)');
    release();
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });
});
