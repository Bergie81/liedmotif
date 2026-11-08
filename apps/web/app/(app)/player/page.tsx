import { PlayerView } from '@/components/player/player-view';

export default function PlayerPage() {
  // The player's two columns split on the content width, not the viewport, so
  // the nav rail's width is accounted for.
  return (
    <div className="@container">
      <PlayerView />
    </div>
  );
}
