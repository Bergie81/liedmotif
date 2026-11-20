// Playlists: hand-curated,
// user-ordered collections of Durable Tracks — the non-generative Playback
// source. Retention IS membership: a track is Durable iff it belongs to >= 1
// playlist, and the `tracks.savedAt`/`favoritedAt` flags are denormalizations
// maintained in the same transaction as every membership write (the playlists
// repo is the single chokepoint). Favorites is a per-owner system playlist
// (`kind='favorites'`): fixed name, undeletable, unrenamable, reorderable.

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, ownerUserId, pk, updatedAt } from './_columns';
import { user } from './auth';
import { coverImages } from './covers';
import { playlistKind, playlistShareAudience } from './enums';
import { tracks } from './tracks';

export const playlists = pgTable(
  'playlists',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    name: text('name').notNull(),
    kind: playlistKind('kind').notNull().default('user'),
    // False hides the row from the Playlists tab: Favorites and the one-time
    // "Saved tracks" backfill collection are reached from their own Library
    // surfaces instead. Ordinary user playlists are always listed.
    listedInPlaylists: boolean('listed_in_playlists').notNull().default(true),
    // Custom cover (upload or generation). Null = the
    // derived 2x2 member-cover mosaic, which is always the fallback.
    coverImageId: uuid('cover_image_id').references((): AnyPgColumn => coverImages.id, {
      onDelete: 'set null',
    }),
    // When playlist playback last engaged. Together with `updatedAt` it forms
    // the Playlists tab's activity sort key. `updatedAt` moves when the owner
    // curates that Playlist directly. Purging a Track from every Playlist at
    // once (Remove from Library via `unsaveTrackEverywhere`, Dislike, Delete
    // Track) and the Lounge revocation purge remove memberships without moving
    // it, because a Library-wide removal is not curation of each Playlist and a
    // reorder must not reveal that a Track was removed or revoked.
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    // The Lounge share state: null = Private, set = In Lounge —
    // live, revocable, reaching `shareAudience`. Doubles as the Lounge's
    // newest-first sort key, so re-sharing an already-shared playlist must
    // never bump it. Only curated user playlists and Favorites may carry it
    // (unlisted collections are refused at the repo chokepoint).
    sharedAt: timestamp('shared_at', { withTimezone: true }),
    // Who the share reaches; read only while `sharedAt` is set, and reset to
    // the default whenever the playlist returns to Private. A `selected`
    // audience is the `playlist_share_members` rows.
    shareAudience: playlistShareAudience('share_audience').notNull().default('everyone'),
    // The owner's Library pin: set = first in their own Playlists tab, newest
    // pin first. Private to the owner and independent of the Lounge, so it
    // survives unsharing. Only curated user playlists may carry it.
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('playlists_owner_user_id_idx').on(table.ownerUserId),
    // Playlists-tab keyset pagination: the expression must stay byte-identical
    // to `playlistActivityExpr` in playlist-reads or the planner will not match.
    index('playlists_owner_activity_idx')
      .on(
        table.ownerUserId,
        sql`(greatest(${table.updatedAt}, ${table.lastPlayedAt})) desc`,
        table.id,
      )
      .where(sql`${table.kind} = 'user'`),
    // Cover-reclamation pointer probe (partial — most playlists use the mosaic).
    index('playlists_cover_image_id_idx')
      .on(table.coverImageId)
      .where(sql`${table.coverImageId} is not null`),
    // The other half of that reclamation check reads the id out of the cover's
    // JSON provenance, as text — which the uuid primary key cannot serve.
    index('playlists_id_text_idx').on(sql`(${table.id}::text)`),
    // At most one Favorites system playlist per owner.
    uniqueIndex('playlists_owner_favorites_unique')
      .on(table.ownerUserId)
      .where(sql`${table.kind} = 'favorites'`),
  ],
);

/**
 * Playlist membership. Order is position-keyed (0..n-1, transactionally
 * resequenced on every insert/remove/reorder); a track appears at most once per
 * playlist (adds are idempotent).
 */
export const playlistTracks = pgTable(
  'playlist_tracks',
  {
    id: pk(),
    playlistId: uuid('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    trackId: uuid('track_id')
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // Serves both the membership lookup (playlist_id prefix) and the playlist
    // detail's position keyset, so no separate playlist_id-only index exists.
    index('playlist_tracks_playlist_position_idx').on(table.playlistId, table.position),
    index('playlist_tracks_track_id_idx').on(table.trackId),
    uniqueIndex('playlist_tracks_playlist_track_unique').on(table.playlistId, table.trackId),
  ],
);

/**
 * Pins: a viewer's bookmark of a playlist in their Lounge,
 * their own shares included — it lists first in that viewer's Lounge, newest
 * pin (`createdAt`) first, and is pure navigation, never a grant (Lounge-audible
 * governs playback) and never an edit surface. One row per (viewer, playlist)
 * pair; both FKs cascade, and the unshare chokepoint hard-purges rows in the
 * same transaction, so a Pin can never outlive the share it points at.
 */
export const playlistPins = pgTable(
  'playlist_pins',
  {
    id: pk(),
    visitorUserId: text('visitor_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    playlistId: uuid('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    // Idempotence anchor and the visitor-side lookup (visitor prefix).
    uniqueIndex('playlist_pins_visitor_playlist_unique').on(table.visitorUserId, table.playlistId),
    // The unshare purge deletes by playlist.
    index('playlist_pins_playlist_id_idx').on(table.playlistId),
  ],
);

/**
 * A `selected` share audience: the Users an In-Lounge
 * playlist reaches besides its owner. These rows ARE the share state, not a
 * derived grant — they exist only while the playlist is shared with audience
 * `selected`, and the share chokepoint replaces or clears them in the same
 * transaction as the revocation purge. Both FKs cascade.
 */
export const playlistShareMembers = pgTable(
  'playlist_share_members',
  {
    id: pk(),
    playlistId: uuid('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    // The per-viewer visibility probe (playlist prefix + viewer).
    uniqueIndex('playlist_share_members_playlist_user_unique').on(table.playlistId, table.userId),
    // The user-delete cascade.
    index('playlist_share_members_user_id_idx').on(table.userId),
  ],
);
