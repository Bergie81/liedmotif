'use client';

// The header's two retention controls. They look alike and are not: Favorite
// toggles membership of the Favorites system Playlist, while Add to Playlist
// opens the picker over the Playlists the owner curates. Each reports its OWN
// shelf, which is how the Library keeps them apart.
//
// Neither may read `savedAt`: that flag means "member of >= 1 Playlist,
// Favorites included" (`favoritedAt => savedAt`), so lighting Add to
// Playlist from it would answer a star by claiming the Track had been filed
// into Playlists the owner never picked. `inCuratedPlaylist` is the fact that
// excludes Favorites, and the only one this control may light from.

import { Plus, Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import { iconButtonClass } from '@/components/ui/design-system';
import { WithTooltip } from '@/components/ui/tooltip';

/** The shared chassis: one glyph size for the row, and the fill, the lamp and
 *  the pressed state all driven by `pressed` alone — so they can never disagree
 *  with each other, or with the label the caller derived from the same fact. */
function RetentionButton({
  testId,
  label,
  pressed,
  disabled,
  onPress,
  icon: Icon,
}: {
  testId: string;
  label: string;
  pressed: boolean;
  disabled: boolean;
  onPress: () => void;
  icon: typeof Star;
}) {
  return (
    <WithTooltip label={label}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onPress}
        disabled={disabled}
        className={cn(
          iconButtonClass,
          'disabled:opacity-40 aria-pressed:text-lamp aria-pressed:hover:text-lamp',
        )}
      >
        <Icon className={cn('h-[21px] w-[21px]', pressed && 'fill-current')} aria-hidden />
      </button>
    </WithTooltip>
  );
}

export function TrackRetentionActions({
  disabled,
  favorited,
  inCuratedPlaylist,
  onAddToPlaylist,
  onToggleFavorite,
}: {
  disabled: boolean;
  favorited: boolean;
  inCuratedPlaylist: boolean;
  onAddToPlaylist: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div className="flex flex-none">
      <RetentionButton
        testId="player-favorite"
        label={favorited ? 'Favorited — remove Favorite' : 'Favorite this Track'}
        pressed={favorited}
        disabled={disabled}
        onPress={onToggleFavorite}
        icon={Star}
      />
      <RetentionButton
        testId="player-add-to-playlist"
        label={inCuratedPlaylist ? 'In a Playlist — edit Playlists' : 'Add to Playlists'}
        pressed={inCuratedPlaylist}
        disabled={disabled}
        onPress={onAddToPlaylist}
        icon={Plus}
      />
    </div>
  );
}
