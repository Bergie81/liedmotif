// The player's options sheet as data: ONE compact list under the tile row,
// grouped by the two subjects a listener can act on — the Track, and the
// Playback source it plays inside. A scope rail is read once and every row
// beneath it inherits that subject, so a row never has to name what it acts on.
//
// Both Playback sources render the SAME skeleton, so the muscle
// memory carries across; only what a Session or a Playlist can be asked to do
// differs. A Playlist has no generation, so it has no mode, nothing to stop,
// and none of the Session's direction actions (Reroll, More Like This from the
// current Track, Change Vibe); Delete Track destroys audio under either source.
//
// Availability is a state of a row, never a reason to move or hide it: roadmap
// rows keep their place, tagged. The one exception is a row that could never
// apply — Favorites is app-made, so the rows that would rewrite or end it leave
// the list instead of sitting permanently dead in it.

import { MENU_COPY } from '@/components/ui/menu-copy';
import { isOwnerNamedPlaylist, type PlaylistKind } from '@liedmotif/shared';
import type { SourceNoun } from './player-presentation';

type TrackOptionsRowId =
  | 'lyrics'
  | 'reroll-track'
  | 'more-like-this-track'
  | 'rename-track'
  | 'track-data'
  | 'section-loop'
  | 'download-track'
  | 'delete-track';
type SessionOptionsRowId =
  | 'change-vibe'
  | 'sleep-timer'
  | 'rename-session'
  | 'convert-session-to-playlist'
  | 'download-session'
  | 'delete-session';
type PlaylistOptionsRowId =
  | 'sleep-timer'
  | 'remove-from-playlist'
  | 'go-to-playlist'
  | 'rename-playlist'
  | 'download-playlist'
  | 'more-like-this'
  | 'delete-playlist';
export type OptionsRowId = TrackOptionsRowId | SessionOptionsRowId | PlaylistOptionsRowId;

export type OptionsRowIcon =
  | 'pencil'
  | 'info'
  | 'download'
  | 'trash'
  | 'mic-vocal'
  | 'section-loop'
  | 'list-music'
  | 'list-minus'
  | 'more-like-this'
  | 'thumbs-down'
  | 'change-vibe'
  | 'timer';

export interface OptionsRowSpec {
  id: OptionsRowId;
  label: string;
  icon: OptionsRowIcon;
  availability: 'available' | 'coming-later';
  /** Only a row that destroys something takes warn red. */
  tone: 'neutral' | 'danger';
  /** What the row does, including what it costs or cannot undo. */
  description: string;
}

/** The rows that stay usable offline: they show what the player already holds,
 *  or pause it. Every other row needs the server. */
export const LISTEN_ONLY_ROW_IDS: ReadonlySet<OptionsRowId> = new Set([
  'lyrics',
  'track-data',
  'section-loop',
  'sleep-timer',
]);

export interface OptionsScopeSpec {
  /** The rail above the group — the subject every row under it acts on. */
  label: string;
  rows: readonly OptionsRowSpec[];
}

/** The Track rows every source shares; what a source adds between them —
 *  dropping a membership, and what its Delete Track means — is stated where it
 *  applies. */
const LYRICS_ROW = {
  id: 'lyrics',
  label: 'Lyrics',
  icon: 'mic-vocal',
  availability: 'available',
  tone: 'neutral',
  description: 'Read along with this track',
} as const satisfies OptionsRowSpec;

const RENAME_TRACK_ROW = {
  id: 'rename-track',
  label: 'Rename Track',
  icon: 'pencil',
  availability: 'available',
  tone: 'neutral',
  description: 'Give this track a new title',
} as const satisfies OptionsRowSpec;

const TRACK_DATA_ROW = {
  id: 'track-data',
  label: 'Track Data',
  icon: 'info',
  availability: 'available',
  tone: 'neutral',
  description: 'See everything this track was generated from',
} as const satisfies OptionsRowSpec;

const SECTION_LOOP_ROW = {
  id: 'section-loop',
  label: 'Loop a Part',
  icon: 'section-loop',
  availability: 'available',
  tone: 'neutral',
  description: 'Drag across the waveform to repeat a part of this track',
} as const satisfies OptionsRowSpec;

const DOWNLOAD_TRACK_ROW = {
  id: 'download-track',
  label: 'Download Track',
  icon: 'download',
  availability: 'available',
  tone: 'neutral',
  description: 'Save this track as a fully tagged MP3',
} as const satisfies OptionsRowSpec;

/** Pauses whatever is playing; one row shared by every source, visitor included. */
const SLEEP_TIMER_ROW = {
  id: 'sleep-timer',
  label: 'Sleep Timer',
  icon: 'timer',
  availability: 'available',
  tone: 'neutral',
  description: 'Fade out and pause the music after a set time',
} as const satisfies OptionsRowSpec;

export const SESSION_OPTIONS_SCOPES = [
  {
    label: 'This Track',
    rows: [
      RENAME_TRACK_ROW,
      TRACK_DATA_ROW,
      SECTION_LOOP_ROW,
      // The direction actions the player bar also carries (Reroll is
      // the dislike; More Like This is the track-seeded Start Session).
      {
        id: 'reroll-track',
        label: 'Reroll Track',
        icon: 'thumbs-down',
        availability: 'available',
        tone: 'neutral',
        description: 'Dislike this track and get another in the same vibe',
      },
      {
        id: 'more-like-this-track',
        label: 'More Like This',
        icon: 'more-like-this',
        availability: 'available',
        tone: 'neutral',
        description: 'Start a new session seeded from this track',
      },
      DOWNLOAD_TRACK_ROW,
      {
        id: 'delete-track',
        label: 'Delete Track',
        icon: 'trash',
        availability: 'available',
        tone: 'danger',
        description: 'Delete its audio for good; it leaves this session and your library',
      },
    ],
  },
  {
    label: 'This Session',
    rows: [
      // The one steering action.
      {
        id: 'change-vibe',
        label: 'Change Vibe',
        icon: 'change-vibe',
        availability: 'available',
        tone: 'neutral',
        description: 'Steer newly generated tracks without starting a new session',
      },
      SLEEP_TIMER_ROW,
      {
        id: 'rename-session',
        label: 'Rename Session',
        icon: 'pencil',
        availability: 'available',
        tone: 'neutral',
        description: 'Give this session a new name',
      },
      {
        id: 'convert-session-to-playlist',
        label: 'Convert to Playlist',
        icon: 'list-music',
        availability: 'available',
        tone: 'neutral',
        description: 'Keep the tracks so far as a new playlist; the session stays',
      },
      {
        id: 'download-session',
        label: 'Download Session',
        icon: 'download',
        availability: 'available',
        tone: 'neutral',
        description: MENU_COPY.downloadAllTracks,
      },
      {
        id: 'delete-session',
        label: 'Delete Session',
        icon: 'trash',
        availability: 'available',
        tone: 'danger',
        description: 'Stop it and delete it for good; saved tracks stay',
      },
    ],
  },
] as const satisfies readonly OptionsScopeSpec[];

export const PLAYLIST_OPTIONS_SCOPES = [
  {
    label: 'This Track',
    rows: [
      LYRICS_ROW,
      RENAME_TRACK_ROW,
      TRACK_DATA_ROW,
      SECTION_LOOP_ROW,
      DOWNLOAD_TRACK_ROW,
      // Curation while listening: a membership goes, the audio stays. It sits
      // above Delete Track so the reversible way out is met first.
      {
        id: 'remove-from-playlist',
        label: 'Remove from this Playlist',
        icon: 'list-minus',
        availability: 'available',
        tone: 'neutral',
        description: 'It leaves your library if this is its only playlist',
      },
      {
        id: 'delete-track',
        label: 'Delete Track',
        icon: 'trash',
        availability: 'available',
        tone: 'danger',
        description: 'Delete its audio for good, from every playlist and your library',
      },
    ],
  },
  {
    label: 'This Playlist',
    rows: [
      {
        id: 'go-to-playlist',
        label: 'Go to Playlist',
        icon: 'list-music',
        availability: 'available',
        tone: 'neutral',
        description: 'Reorder, add and remove tracks',
      },
      SLEEP_TIMER_ROW,
      {
        id: 'rename-playlist',
        label: 'Rename Playlist',
        icon: 'pencil',
        availability: 'available',
        tone: 'neutral',
        description: MENU_COPY.renamePlaylist,
      },
      {
        id: 'download-playlist',
        label: 'Download Playlist',
        icon: 'download',
        availability: 'available',
        tone: 'neutral',
        description: MENU_COPY.downloadAllTracks,
      },
      // The only row here that spends money, and it lands somewhere else.
      {
        id: 'more-like-this',
        label: 'More Like This',
        icon: 'more-like-this',
        availability: 'available',
        tone: 'neutral',
        description: 'Start a new session in the style of this playlist',
      },
      {
        id: 'delete-playlist',
        label: 'Delete Playlist',
        icon: 'trash',
        availability: 'available',
        tone: 'danger',
        description: MENU_COPY.deletePlaylist,
      },
    ],
  },
] as const satisfies readonly OptionsScopeSpec[];

/** Rows only a playlist the owner made and named can answer for. */
const NAMED_PLAYLIST_ROW_IDS: readonly OptionsRowId[] = ['rename-playlist', 'delete-playlist'];

export function playlistOptionsScopes(kind: PlaylistKind): readonly OptionsScopeSpec[] {
  if (isOwnerNamedPlaylist(kind)) return PLAYLIST_OPTIONS_SCOPES;
  return PLAYLIST_OPTIONS_SCOPES.map((scope) => ({
    ...scope,
    rows: scope.rows.filter((row) => !NAMED_PLAYLIST_ROW_IDS.includes(row.id)),
  }));
}

/** What only the playlist's owner can be offered: every act that
 *  writes — curation, naming, ending — and the downloads, which never widen.
 *  Absent for a visitor, never disabled (the member-invisible rule). */
const OWNER_ONLY_PLAYLIST_ROW_IDS: readonly OptionsRowId[] = [
  'rename-track',
  'download-track',
  'remove-from-playlist',
  'delete-track',
  'rename-playlist',
  'download-playlist',
  'delete-playlist',
];

/** Where a row means something else on another owner's playlist: its page is
 *  read-only there, and More Like This spends the visitor's money, not the
 *  sharer's. */
const VISITOR_ROW_DESCRIPTIONS: Partial<Record<OptionsRowId, string>> = {
  'go-to-playlist': 'See all its tracks in the lounge',
  'more-like-this': 'Start a new session in this style, on your own budget',
};

/**
 * The scopes for a Visitor playing a foreign In-Lounge playlist: the owner
 * scopes minus the owner-only rows, on the same skeleton.
 */
export function visitorPlaylistOptionsScopes(): readonly OptionsScopeSpec[] {
  return PLAYLIST_OPTIONS_SCOPES.map((scope) => ({
    ...scope,
    rows: scope.rows
      .filter((row) => !OWNER_ONLY_PLAYLIST_ROW_IDS.includes(row.id))
      .map((row) => ({
        ...row,
        description: VISITOR_ROW_DESCRIPTIONS[row.id] ?? row.description,
      })),
  }));
}

/** The scopes for the Offline Library: only the rows that need no server. */
export function offlineOptionsScopes(noun: SourceNoun): readonly OptionsScopeSpec[] {
  return [
    { label: 'This Track', rows: [LYRICS_ROW, TRACK_DATA_ROW] },
    { label: `This ${noun}`, rows: [SLEEP_TIMER_ROW] },
  ];
}

/** The ids a scope list marks `available` — a sheet must wire exactly these,
 *  so shipping a row without a handler is a type error. */
type AvailableRowId<Scopes extends readonly OptionsScopeSpec[]> = Extract<
  Scopes[number]['rows'][number],
  { availability: 'available' }
>['id'];

export type AvailableSessionOptionsId = AvailableRowId<typeof SESSION_OPTIONS_SCOPES>;
export type AvailablePlaylistOptionsId = AvailableRowId<typeof PLAYLIST_OPTIONS_SCOPES>;
