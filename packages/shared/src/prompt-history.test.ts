import { describe, expect, it } from 'vitest';
import { MAX_USER_PROMPT_LENGTH } from './contracts/endpoints';
import {
  extendPromptHistory,
  MAX_TRACK_DATA_PROMPT_LENGTH,
  truncateTrackDataPrompt,
} from './prompt-history';

describe('extendPromptHistory', () => {
  it('stores the first prompt trimmed', () => {
    expect(extendPromptHistory(null, '  calm music for late-night coding  ')).toBe(
      'calm music for late-night coding',
    );
  });

  it('appends a change with an empty line between the prompts', () => {
    expect(extendPromptHistory('calm music for coding', 'mehr rockiger')).toBe(
      'calm music for coding\n\nmehr rockiger',
    );
  });

  it('extends the history again on a second change', () => {
    const afterFirst = extendPromptHistory('calm music for coding', 'mehr rockiger');
    expect(extendPromptHistory(afterFirst, 'with electronic vibes')).toBe(
      'calm music for coding\n\nmehr rockiger\n\nwith electronic vibes',
    );
  });

  it('does not double the history when the whole stored prompt is resent', () => {
    const stored = 'calm music for coding\n\nmehr rockiger';
    expect(extendPromptHistory(stored, stored)).toBe(stored);
  });

  it('does not repeat a change that just landed', () => {
    const stored = 'calm music for coding\n\nmehr rockiger';
    expect(extendPromptHistory(stored, '  mehr rockiger ')).toBe(stored);
  });

  it('leaves the stored history untouched for blank incoming text', () => {
    expect(extendPromptHistory('calm music for coding', '   ')).toBe('calm music for coding');
  });

  it('keeps the origin when the history outgrows the storage bound', () => {
    const origin = 'o'.repeat(MAX_USER_PROMPT_LENGTH - 10);
    const extended = extendPromptHistory(origin, 'x'.repeat(50));

    expect(extended).toHaveLength(MAX_USER_PROMPT_LENGTH);
    expect(extended.startsWith(origin)).toBe(true);
    expect(extended.endsWith('…')).toBe(true);
  });
});

describe('truncateTrackDataPrompt', () => {
  it('passes a prompt at or below the cap through unchanged', () => {
    expect(truncateTrackDataPrompt('calm music')).toBe('calm music');
    const atCap = 'a'.repeat(MAX_TRACK_DATA_PROMPT_LENGTH);
    expect(truncateTrackDataPrompt(atCap)).toBe(atCap);
  });

  it('cuts an over-long prompt to exactly the cap, ending in an ellipsis', () => {
    const truncated = truncateTrackDataPrompt('a'.repeat(MAX_TRACK_DATA_PROMPT_LENGTH + 500))!;

    expect(truncated).toHaveLength(MAX_TRACK_DATA_PROMPT_LENGTH);
    expect(truncated).toBe(`${'a'.repeat(MAX_TRACK_DATA_PROMPT_LENGTH - 1)}…`);
  });

  it('never cuts a character in half', () => {
    // A 2-code-unit emoji straddling the cut: the pair goes, not half of it.
    const truncated = truncateTrackDataPrompt(
      `${'a'.repeat(MAX_TRACK_DATA_PROMPT_LENGTH - 2)}🎵🎵`,
    )!;

    expect(truncated).toBe(`${'a'.repeat(MAX_TRACK_DATA_PROMPT_LENGTH - 2)}…`);
  });

  it('has nothing to truncate for a session that never carried a prompt', () => {
    expect(truncateTrackDataPrompt(null)).toBeNull();
  });
});
