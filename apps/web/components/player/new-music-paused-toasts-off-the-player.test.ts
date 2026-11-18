// @vitest-environment jsdom

// Off the Player, nothing shows the generation banner, so a playing Session
// whose new music pauses would go quiet without a word. A toast says what the
// banner would, once per status change; on the Player the banner says it.

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import type { GenerationBannerPlayer } from './generation-banner';
import { useGenerationStatusToast } from './use-generation-status-toast';

afterEach(() => {
  cleanup();
  toast.dismiss();
});

function player(overrides: Partial<GenerationBannerPlayer> = {}): GenerationBannerPlayer {
  return {
    generationStatus: 'ok',
    generationStatusScope: null,
    statusMessageSafe: null,
    queueLength: 3,
    pendingGeneration: null,
    ...overrides,
  };
}

type Props = { current: GenerationBannerPlayer | null; onPlayer: boolean; sessionId?: string };

function mount(initial: GenerationBannerPlayer, onPlayerPage = false) {
  return renderHook(
    ({ current, onPlayer, sessionId = 'session-1' }: Props) =>
      useGenerationStatusToast(current, onPlayer, sessionId),
    { initialProps: { current: initial, onPlayer: onPlayerPage } as Props },
  );
}

describe('new music paused, seen off the Player', () => {
  it('shows the banner title and message once when generation turns blocked on another page', () => {
    const view = mount(player());

    view.rerender({ current: player({ generationStatus: 'provider_error' }), onPlayer: false });

    expect(shownToasts()).toEqual([
      expect.objectContaining({
        tone: 'error',
        title: 'Generation error',
        message: 'Generation hit a problem — playing your ready tracks while it recovers.',
      }),
    ]);
  });

  it('does not show it again when the next poll brings the same status', () => {
    const view = mount(player());
    view.rerender({ current: player({ generationStatus: 'provider_credits' }), onPlayer: false });
    toast.dismiss();

    view.rerender({ current: player({ generationStatus: 'provider_credits' }), onPlayer: false });

    expect(shownToasts()).toEqual([]);
  });

  it('follows the banner when the first poll brings the ready Tracks of a resumed Session', () => {
    const view = mount(player({ generationStatus: 'provider_error', queueLength: 0 }));

    view.rerender({
      current: player({ generationStatus: 'provider_error', queueLength: 3 }),
      onPlayer: false,
    });

    expect(shownToasts().map((shown) => shown.message)).toEqual([
      'Generation hit a problem — playing your ready tracks while it recovers.',
    ]);
  });

  it('says it again for another Session that pauses the same way', () => {
    const view = mount(player());
    view.rerender({ current: player({ generationStatus: 'provider_credits' }), onPlayer: false });
    toast.dismiss();

    view.rerender({
      current: player({ generationStatus: 'provider_credits' }),
      onPlayer: false,
      sessionId: 'session-2',
    });

    expect(shownToasts()).toEqual([expect.objectContaining({ title: 'Generation paused' })]);
  });

  it('stays quiet on the Player, where the banner says it, and after leaving it', () => {
    const view = mount(player(), true);

    view.rerender({ current: player({ generationStatus: 'provider_credits' }), onPlayer: true });
    expect(shownToasts()).toEqual([]);

    view.rerender({ current: player({ generationStatus: 'provider_credits' }), onPlayer: false });
    expect(shownToasts()).toEqual([]);
  });

  it('closes its toast when the Player opens, where the banner says the same', () => {
    const view = mount(player());
    view.rerender({ current: player({ generationStatus: 'provider_credits' }), onPlayer: false });

    view.rerender({ current: player({ generationStatus: 'provider_credits' }), onPlayer: true });

    expect(shownToasts()).toEqual([]);
  });

  it('shows nothing when generation is back to ok', () => {
    const view = mount(player({ generationStatus: 'provider_error' }), true);

    view.rerender({ current: player(), onPlayer: false });

    expect(shownToasts()).toEqual([]);
  });

  it.each([
    ['provider_credits', 'warning', 'Generation paused'],
    ['repeat_cost_limit', 'warning', 'Session Repeat'],
    ['provider_error', 'error', 'Generation error'],
  ] as const)('shows %s as a %s toast', (status, tone, title) => {
    const view = mount(player());

    view.rerender({ current: player({ generationStatus: status }), onPlayer: false });

    expect(shownToasts()).toEqual([expect.objectContaining({ tone, title })]);
  });

  it('links the Admin to the cost limits when a limit paused it', () => {
    const view = mount(player());

    view.rerender({ current: player({ generationStatus: 'repeat_cost_limit' }), onPlayer: false });

    expect(shownToasts()).toEqual([
      expect.objectContaining({
        link: { label: 'Adjust cost limits', href: '/settings/limits' },
      }),
    ]);
  });

  it('links a Member to their budget when their budget paused it', () => {
    const view = mount(player());

    view.rerender({
      current: player({ generationStatus: 'repeat_cost_limit', generationStatusScope: 'member' }),
      onPlayer: false,
    });

    expect(shownToasts()).toEqual([
      expect.objectContaining({
        link: { label: 'See your budget', href: '/settings/my-budget' },
      }),
    ]);
  });

  it('carries no link for a block a cost setting cannot lift', () => {
    const view = mount(player());

    view.rerender({ current: player({ generationStatus: 'provider_credits' }), onPlayer: false });

    expect(shownToasts()[0]?.link).toBeUndefined();
  });
});
