import type { AssistantPlayCommand } from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import { playerCommandRecord, type PlayerCommandOutcome } from './player-command-note';

const PLAY_RUNNING: AssistantPlayCommand = {
  name: 'play',
  source: {
    kind: 'playlist',
    id: '0c9d4b7a-8a41-4b0e-b1a3-5a2d9d6c7e22',
    name: 'Running',
    trackCount: 24,
    foreign: false,
  },
};
const PLAY_TRACK: AssistantPlayCommand = {
  name: 'play',
  source: { kind: 'session', id: '7b0a1c5e-3f0d-4a55-9d0e-2f6f3f1f8a11', name: 'Deep Focus' },
  track: { id: '5e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b', name: 'Night Drive' },
};

describe('what the next request is told about a player command', () => {
  const record = (outcome?: PlayerCommandOutcome) =>
    playerCommandRecord({ name: 'continue' }, outcome);

  it('is the command as the tool worded it, once it is done or still on its way', () => {
    expect(record('done')).toBe('[Done by the app: the player was told to play on]');
    expect(record()).toBe('[Done by the app: the player was told to play on]');
  });

  it('says the browser refused to start the audio, and what the user was shown', () => {
    expect(record('blocked')).toBe(
      '[Not done by the app: the browser refused to start the audio when the player was told to play on. The user was shown a "Tap to play" button.]',
    );
  });

  it('says the player could not do it', () => {
    expect(record('failed')).toBe('[Not done by the app: the player could not play on]');
  });

  it('names what a play command played, as the tool worded it', () => {
    expect(playerCommandRecord(PLAY_TRACK, 'done')).toBe(
      '[Done by the app: the player was told to play the Track "Night Drive" in the Session "Deep Focus"]',
    );
  });

  it('says the user chose the Session that was starting over a play command', () => {
    expect(playerCommandRecord(PLAY_RUNNING, 'declined')).toBe(
      '[Not done by the app: the user kept the new Session that was starting, so the player did not play the Playlist "Running"]',
    );
  });
});
