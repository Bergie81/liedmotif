// @vitest-environment jsdom

// The own-voice offer on the create card's fine-tune fold: `hidden` renders
// neither the toggle nor the Settings → My voice hint (a capability the viewer
// can never hold is absent, not disabled), `setup` renders the
// disabled toggle with the hint, `ready` renders the enabled toggle alone. The
// hidden branch lives inside the shared controls, so no call site can render
// half a hidden control.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnVoiceOffer } from '@/lib/voice';
import type { DescribeFineTune } from './create-session-model';
import { DescribeFineTuneSection } from './describe-session-panel';

afterEach(cleanup);

const HINT_TEXT = /Settings → My voice/;
const noop = () => {};

const DESCRIBE_PICKS: DescribeFineTune = {
  genres: [],
  energy: 'auto',
  vocal: 'auto',
  voice: 'any',
  ownVoice: false,
  language: 'auto',
};

function renderDescribeSection(
  offer: OwnVoiceOffer,
  { onPicksChange = noop }: { onPicksChange?: (patch: Partial<DescribeFineTune>) => void } = {},
) {
  return render(
    h(DescribeFineTuneSection, {
      picks: DESCRIBE_PICKS,
      onPicksChange,
      ownVoiceOffer: offer,
      forYouGenres: [],
    }),
  );
}

function ownVoiceButton(): HTMLButtonElement | null {
  return screen.queryByRole('button', { name: 'Own Voice' });
}

describe('own-voice offer on the fine-tune fold', () => {
  it('hidden renders neither the toggle nor the hint', () => {
    renderDescribeSection('hidden');
    expect(ownVoiceButton()).toBeNull();
    expect(screen.queryByText(HINT_TEXT)).toBeNull();
  });

  it('setup renders the toggle disabled with the hint', () => {
    renderDescribeSection('setup');
    expect(ownVoiceButton()).toHaveProperty('disabled', true);
    expect(screen.getByText(HINT_TEXT)).toBeTruthy();
  });

  it('ready renders the toggle enabled with no hint, and a click opts in', () => {
    const onPicksChange = vi.fn();
    renderDescribeSection('ready', { onPicksChange });
    const button = ownVoiceButton();
    expect(button).toHaveProperty('disabled', false);
    expect(screen.queryByText(HINT_TEXT)).toBeNull();
    fireEvent.click(button!);
    expect(onPicksChange).toHaveBeenCalledWith({ ownVoice: true });
  });
});
