export type TransportToggleIcon = 'loading' | 'pause' | 'play';

export function presentTransportToggle({
  isPlaying,
  preparing,
  playIntentPending,
}: {
  isPlaying: boolean;
  preparing: boolean;
  playIntentPending: boolean;
}): { label: 'Pause' | 'Play'; icon: TransportToggleIcon } {
  const willPause = isPlaying || playIntentPending;
  return {
    label: willPause ? 'Pause' : 'Play',
    icon: preparing && playIntentPending ? 'loading' : willPause ? 'pause' : 'play',
  };
}
