import { describe, expect, it } from 'vitest';
import { mockMusicProvider } from './mock';
import type { MusicGenerationInput } from './index';

const INPUT: MusicGenerationInput = {
  mode: 'custom',
  prompt: 'mellow lofi beats, warm analog texture',
  style: 'mellow lofi beats',
  title: 'Focus 1',
  instrumental: true,
};

describe('mockMusicProvider', () => {
  const provider = mockMusicProvider();

  it('is a music provider that needs no credentials', async () => {
    expect(provider.providerType).toBe('music');
    expect(provider.providerKey).toBe('mock');
    expect((await provider.validateCredentials()).ok).toBe(true);
  });

  it('reports capabilities and a tracks-per-request count', () => {
    const caps = provider.getCapabilities();
    expect(caps.typicalTracksPerRequest).toBe(2);
    expect(caps.supportsInstrumental).toBe(true);
  });

  it('estimates cost in provider calls and tracks', () => {
    expect(provider.estimateGenerationCost(INPUT)).toMatchObject({
      providerCalls: 1,
      expectedTracks: 2,
    });
  });

  it('creates a task with a persisted id and redacted diagnostics', async () => {
    const task = await provider.createGenerationTask(INPUT);
    expect(task.providerTaskId.length).toBeGreaterThan(0);
    expect(task.provider.providerKey).toBe('mock');
    // Deterministic id for the same input.
    expect((await provider.createGenerationTask(INPUT)).providerTaskId).toBe(task.providerTaskId);
  });

  it('returns two normalized sibling tracks on status', async () => {
    const task = await provider.createGenerationTask(INPUT);
    const status = await provider.getGenerationStatus(task.providerTaskId);
    expect(status.status).toBe('complete');
    expect(status.tracks).toHaveLength(2);
    const [a, b] = status.tracks;
    expect(a?.providerTrackId).not.toBe(b?.providerTrackId);
    expect(a?.audioUrl).toBeTruthy();
  });

  it('returns tracks carrying deterministic lyric text', async () => {
    const task = await provider.createGenerationTask(INPUT);
    const status = await provider.getGenerationStatus(task.providerTaskId);
    for (const track of status.tracks) {
      expect(track.lyrics).toContain('[Verse]');
      expect(track.lyrics).toContain('[Chorus]');
    }
  });

  it('serves word-level lyric timing matching its lyric text', async () => {
    const task = await provider.createGenerationTask(INPUT);
    const status = await provider.getGenerationStatus(task.providerTaskId);
    const timing = await provider.getTimestampedLyrics!({
      providerTaskId: task.providerTaskId,
      providerTrackId: status.tracks[0]!.providerTrackId,
    });
    expect(timing).not.toBeNull();
    expect(timing!.alignmentErrorScore).not.toBeNull();
    // The joined word stream reproduces the lyric text, so line grouping works.
    expect(timing!.words.map((w) => w.word).join('')).toBe(`${status.tracks[0]!.lyrics!}\n`);
    // Section tags are unaligned filler; sung words carry increasing times.
    for (const word of timing!.words) {
      expect(word.success).toBe(!word.word.startsWith('['));
    }
    const starts = timing!.words.filter((w) => w.success).map((w) => w.startSeconds);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('normalizes a raw provider track shape', () => {
    const normalized = provider.normalizeProviderTrack({
      providerTrackId: 'x-1',
      title: 'T',
      audioUrl: 'file:///sample.mp3',
    });
    expect(normalized.providerTrackId).toBe('x-1');
    expect(normalized.title).toBe('T');
  });
});
