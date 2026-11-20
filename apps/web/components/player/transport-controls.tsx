'use client';

import type { ReactNode } from 'react';
import { ListMusic, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { nowPlayingSpareRowClass, transportButtonClass } from '@/components/ui/design-system';
import { WithTooltip } from '@/components/ui/tooltip';
import { LiedmotifLoader } from '@/components/ui/loading';
import { cn } from '@/lib/cn';
import type { PlaybackControllerApi } from './playback-controller-api';
import { PlaybackModeControl } from './playback-mode-control';
import { QUEUE_LABEL, type SourceNoun } from './player-presentation';
import { presentTransportToggle, type TransportToggleIcon } from './transport-presentation';

type TransportPlayer = Pick<
  PlaybackControllerApi,
  'status' | 'playIntentPending' | 'playbackMode' | 'cyclePlaybackMode' | 'back' | 'toggle' | 'skip'
>;

interface ActiveTransportControls {
  disabled?: false;
  player: TransportPlayer;
  sourceNoun: SourceNoun;
  /** Opens the engaged source's Tracks, including when no Track is audible yet. */
  onOpenQueue: () => void;
}

interface DisabledTransportControls {
  disabled: true;
  preparing?: boolean;
}

type TransportControlsProps = ActiveTransportControls | DisabledTransportControls;

/** A transport button. One `label` drives both the accessible name and the tip
 * so they cannot drift; `tip` overrides only where the tooltip can afford more
 * detail than the accessible name should carry. */
function TransportButton({
  testId,
  label,
  tip,
  onPress,
  disabled,
  className = cn(transportButtonClass, 'text-paper'),
  children,
}: {
  testId: string;
  label: string;
  tip?: string;
  onPress?: () => void;
  disabled: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <WithTooltip label={tip ?? label}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        onClick={onPress}
        disabled={disabled}
        className={className}
      >
        {children}
      </button>
    </WithTooltip>
  );
}

/** The primary button's glyph for one toggle presentation. */
function ToggleGlyph({ icon }: { icon: TransportToggleIcon }) {
  switch (icon) {
    case 'loading':
      return <LiedmotifLoader size="md" />;
    case 'pause':
      return <Pause className="h-[30px] w-[30px] fill-current" aria-hidden />;
    case 'play':
      return <Play className="h-[30px] w-[30px] translate-x-[2px] fill-current" aria-hidden />;
  }
}

function toggleInput(props: TransportControlsProps) {
  if (props.disabled) {
    const preparing = props.preparing ?? false;
    // With nothing engaged, a preparing frame is already reaching for playback.
    return { isPlaying: false, preparing, playIntentPending: preparing };
  }
  const { status, playIntentPending } = props.player;
  return {
    isPlaying: status === 'playing',
    preparing: status === 'waiting' || status === 'loading',
    playIntentPending,
  };
}

export function TransportControls(props: TransportControlsProps) {
  const active = props.disabled ? null : props;
  const disabled = active === null;
  const player = active?.player;
  const sourceNoun = active?.sourceNoun ?? 'Session';
  const togglePresentation = presentTransportToggle(toggleInput(props));

  return (
    <div
      className={cn(
        'mt-8 grid grid-cols-5 items-center justify-items-center desk:mt-12',
        nowPlayingSpareRowClass,
      )}
    >
      <TransportButton
        testId="player-queue"
        label={QUEUE_LABEL[sourceNoun]}
        onPress={active?.onOpenQueue}
        disabled={disabled}
        className={cn(transportButtonClass, 'text-muted hover:text-paper')}
      >
        <ListMusic className="h-[23px] w-[23px]" aria-hidden />
      </TransportButton>
      <TransportButton
        testId="player-back"
        label="Back — restart or previous track"
        onPress={player?.back}
        disabled={disabled}
      >
        <SkipBack className="h-[26px] w-[26px] fill-current" aria-hidden />
      </TransportButton>
      <TransportButton
        testId="player-toggle"
        label={togglePresentation.label}
        onPress={player?.toggle}
        disabled={disabled}
        className="grid h-[72px] w-[72px] shrink-0 place-items-center rounded-full text-lamp shadow-[var(--shadow-primary)] active:scale-[0.97] disabled:opacity-60"
      >
        <ToggleGlyph icon={togglePresentation.icon} />
      </TransportButton>
      <TransportButton
        testId="player-skip"
        label="Skip — direction unchanged"
        onPress={player?.skip}
        disabled={disabled}
      >
        <SkipForward className="h-[26px] w-[26px] fill-current" aria-hidden />
      </TransportButton>
      <PlaybackModeControl
        mode={player?.playbackMode ?? 'loop-session'}
        disabled={disabled}
        onCycle={player?.cyclePlaybackMode}
        variant="transport"
        sourceNoun={sourceNoun}
      />
    </div>
  );
}
