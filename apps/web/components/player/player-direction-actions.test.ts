// @vitest-environment jsdom
import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlayerDirectionActions } from './player-direction-actions';

vi.mock('@/components/app-chrome-context', () => ({
  useAppChrome: () => ({ ownVoiceOffered: false }),
}));

afterEach(cleanup);

function renderActions({
  disabled,
  changeVibeAvailable,
}: {
  disabled: boolean;
  changeVibeAvailable: boolean;
}) {
  render(
    h(
      TooltipProvider,
      null,
      h(PlayerDirectionActions, {
        trackTitle: null,
        vibe: null,
        targetDurationMinutes: null,
        generatedDurationSeconds: 0,
        disabled,
        changeVibeAvailable,
        busyAction: null,
        changeVibePending: false,
        changeVibeOpen: false,
        onChangeVibeOpenChange: vi.fn(),
        onReroll: vi.fn(),
        onChangeVibe: vi.fn(),
        moreLikeThisOpen: false,
        onMoreLikeThisOpenChange: vi.fn(),
        onMoreLikeThis: async () => true,
      }),
    ),
  );
}

const isDisabled = (name: RegExp) =>
  (screen.getByRole('button', { name }) as HTMLButtonElement).disabled;

it('keeps Change Vibe open with no current Track, as after a reload before play', () => {
  renderActions({ disabled: true, changeVibeAvailable: true });
  expect(isDisabled(/^Change Vibe/)).toBe(false);
  expect(isDisabled(/^Reroll Track/)).toBe(true);
  expect(isDisabled(/^More Like This/)).toBe(true);
});

it('holds Change Vibe when it is not available, whatever the Track', () => {
  renderActions({ disabled: false, changeVibeAvailable: false });
  expect(isDisabled(/^Change Vibe/)).toBe(true);
  expect(isDisabled(/^Reroll Track/)).toBe(false);
});
