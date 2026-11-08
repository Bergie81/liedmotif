'use client';

// The Lounge: the "record fair" — a cover-forward grid of every
// non-empty In-Lounge playlist across all owners, the viewer's Pins first, then
// newest-shared first. Tiles are the one playlist-card chassis with Lounge
// attribution in the body; the viewer's own shares are listed like everyone
// else's, marked "Yours" inline. The search box and the sharer cards narrow this
// one list — filter semantics, never a re-rank — with the winning field named on
// each row via the shared Match context vocabulary. With nothing shared anywhere,
// the page teaches the one move that fills the room instead of presenting a dead
// grid.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Armchair, ArrowRight, EllipsisVertical, Lock, Pin } from 'lucide-react';
import { MenuMoreLikeThisGlyph } from '@/components/ui/glyphs';
import type { LoungePlaylistItem } from '@liedmotif/shared';
import {
  getAllPlaylistMembers,
  getLoungePlaylist,
  listLoungePlaylists,
  moderateLoungePlaylist,
  pinLoungePlaylist,
} from '@/lib/api-client';
import { appendUniqueById } from '@/lib/append-unique';
import { cn } from '@/lib/cn';
import { AvatarBadge } from '@/components/avatar-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { LibrarySearchField } from '@/components/library/library-search-field';
import { MatchContextLine } from '@/components/search/match-context';
import { usePageEpoch } from '@/components/use-page-epoch';
import { useServerSeed } from '@/components/use-server-seed';
import { AlertBanner, menuTriggerClass } from '@/components/ui/design-system';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { MenuRow } from '@/components/ui/menu-row';
import { OnlineOnly } from '@/components/ui/online-only';
import { Sheet, SheetTrigger } from '@/components/ui/sheet';
import {
  PlaylistCardShell,
  playlistCardMetaLineClass,
  playlistCardPinFlagClass,
} from '@/components/playlists/playlist-card-shell';
import { PlaylistOptionsSheetContent } from '@/components/playlists/playlist-options-sheet-content';
import {
  formatPlaylistCardMeta,
  pinToggleFailure,
} from '@/components/playlists/playlist-view-model';
import { usePlayPlaylist } from '@/components/playlists/use-play-playlist';
import { OfflineMark } from '@/components/offline/offline-mark';
import { RelativeTime } from '@/components/relative-time';
import { useSeedMoreLikeThis } from '@/components/sessions/use-seed-more-like-this';
import { buildSharerCards, loungeOwnerDisplayName, type LoungeSharer } from './lounge-view-model';
import { LoungeMemberFilter } from './lounge-member-filter';

export interface LoungeFirstPage {
  playlists: LoungePlaylistItem[];
  nextCursor: string | null;
}

/** How many members seed a playlist-level More Like This — the seed route's
 *  request cap, and the same count the playlist player seeds with. */
const MLT_SEED_TRACKS = 10;

export function LoungeView({
  initial,
  sharers,
  viewerUserId,
  viewerIsAdmin,
}: {
  initial: LoungeFirstPage;
  /** Members who currently share (repo-ordered by display name). */
  sharers: LoungeSharer[];
  viewerUserId: string;
  /** Server-resolved: unlocks the Return to Private moderation row.
   *  Members never see the row — the route refuses them regardless. */
  viewerIsAdmin: boolean;
}) {
  const [playlists, setPlaylists] = useState(initial.playlists);
  const [nextCursor, setNextCursor] = useState(initial.nextCursor);
  /** Applied (debounced, trimmed) query — what the shown list was narrowed by. */
  const [query, setQuery] = useState('');
  /** The single-selected sharer card; null = Everyone. */
  const [member, setMember] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { loadingMore, beginFirstPage, beginNextPage, settle } = usePageEpoch();
  const playback = usePlayPlaylist(setError);
  const seedMoreLikeThis = useSeedMoreLikeThis();
  const [seeding, setSeeding] = useState(false);
  /** The foreign share awaiting the Admin's Return to Private confirmation. */
  const [moderating, setModerating] = useState<LoungePlaylistItem | null>(null);
  const consumeServerSeed = useServerSeed(true);
  const router = useRouter();
  const cards = useMemo(() => buildSharerCards(sharers, viewerUserId), [sharers, viewerUserId]);
  // A refreshed sharer list (after moderation) can drop the selected member.
  useEffect(() => {
    if (member && !sharers.some((sharer) => sharer.userId === member)) setMember(null);
  }, [member, sharers]);
  // The teach panel means "nothing shared anywhere" — a fact of the UNFILTERED
  // server render, never of a narrowed result (that gets the no-match card).
  const roomEmpty = initial.playlists.length === 0;

  const load = useCallback(async () => {
    const token = beginFirstPage();
    setError(null);
    const result = await listLoungePlaylists({ query: query || undefined, owner: member });
    if (!settle(token)) return;
    if (!result.ok) {
      setError(`Couldn’t load the Lounge: ${result.error.message}`);
      return;
    }
    setPlaylists(result.data.playlists);
    setNextCursor(result.data.nextCursor);
  }, [query, member, beginFirstPage, settle]);
  // A pin can land after the filters changed; its reload must use the current ones.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (consumeServerSeed()) return;
    void load();
  }, [load, consumeServerSeed]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const token = beginNextPage();
    if (token === null) return;
    setError(null);
    const result = await listLoungePlaylists({
      cursor: nextCursor,
      query: query || undefined,
      owner: member,
    });
    if (!settle(token)) return;
    if (!result.ok) {
      setError(`Couldn’t load more shared playlists: ${result.error.message}`);
      return;
    }
    // A share can move while paging (unshare + re-share): append id-unique so
    // a tile never renders twice.
    setPlaylists((current) => appendUniqueById(current, result.data.playlists));
    setNextCursor(result.data.nextCursor);
  }

  /** The Pin toggle, idempotent server-side. A Pin decides
   *  the tile's place, so the list reloads from the server's order, and the
   *  router cache's pre-pin seed goes with it before back-navigation can replay it. */
  async function togglePin(item: LoungePlaylistItem) {
    const pinned = !item.pinned;
    const result = await pinLoungePlaylist(item.id, pinned);
    if (!result.ok) {
      setError(pinToggleFailure(pinned, result.error.message));
      return;
    }
    router.refresh();
    await loadRef.current();
  }

  /** More Like This from a foreign tile: a NEW Session on
   *  the VIEWER's budget, seeded from the shared playlist's tracks — the seed
   *  route strips the owner's personal ingredients and answers the uniform 404
   *  the moment the share is revoked under the tap. */
  async function seedFromShared(item: LoungePlaylistItem) {
    if (seeding) return;
    setSeeding(true);
    const page = await getLoungePlaylist(item.id, null, MLT_SEED_TRACKS);
    const failure = !page.ok
      ? `More Like This didn’t start: ${page.error.message}`
      : await seedMoreLikeThis(page.data.items.slice(0, MLT_SEED_TRACKS).map((m) => m.id));
    setSeeding(false);
    if (failure) setError(failure);
  }

  /** The Admin's single cross-owner write: return a foreign share
   *  to Private through the owner's own unshare path — references and Pins
   *  purge with it, the owner keeps the playlist and can re-share. */
  async function returnToPrivate(item: LoungePlaylistItem) {
    const result = await moderateLoungePlaylist(item.id);
    setModerating(null);
    if (!result.ok) {
      setError(`Couldn’t return the playlist to Private: ${result.error.message}`);
      return;
    }
    setPlaylists((current) => current.filter((p) => p.id !== item.id));
    // The sharer cards and their counts are server-rendered.
    router.refresh();
  }

  /** Own tiles only: playlist playback through the generic transport. Foreign
   *  playback arrives with the visitor view. */
  async function playOwn(item: LoungePlaylistItem) {
    const result = await getAllPlaylistMembers(item.id);
    if (!result.ok) {
      setError(`Couldn’t load the playlist: ${result.error.message}`);
      return;
    }
    playback.play(result.data.playlist, result.data.items);
  }

  if (roomEmpty) {
    return <LoungeTeach />;
  }

  return (
    <>
      <LibrarySearchField
        placeholder="Search shared playlists, tracks or genres"
        onSearch={setQuery}
      />
      <LoungeMemberFilter cards={cards} selected={member} onSelect={setMember} />
      {error ? <AlertBanner className="mt-4">{error}</AlertBanner> : null}
      {playlists.length === 0 ? (
        <NothingSetOut />
      ) : (
        <div
          data-testid="lounge-grid"
          className="mt-2 grid grid-cols-2 gap-4 desk:grid-cols-3 wide:grid-cols-4"
        >
          {playlists.map((item) => (
            <LoungeTile
              key={item.id}
              item={item}
              query={query}
              onPlayOwn={() => void playOwn(item)}
              onTogglePin={() => void togglePin(item)}
              onMoreLikeThis={() => void seedFromShared(item)}
              onReturnToPrivate={viewerIsAdmin ? () => setModerating(item) : undefined}
            />
          ))}
        </div>
      )}
      {nextCursor ? (
        <LoadMoreButton loading={loadingMore} onClick={() => void loadMore()} className="mt-4" />
      ) : null}
      <p className="mt-6 font-mono text-[10.5px] uppercase leading-[1.7] tracking-[0.05em] text-dim">
        Shared music stays its owner&rsquo;s · making it Private again removes it from everyone
        else&rsquo;s Library
      </p>
      {moderating ? (
        <ConfirmDialog
          heading="Return to Private"
          body={returnToPrivateModerationBody(moderating)}
          confirmLabel="Return to Private"
          onConfirm={() => returnToPrivate(moderating)}
          onClose={() => setModerating(null)}
        />
      ) : null}
    </>
  );
}

/** The purge is irreversible for everyone but the owner: a re-share restores
 *  the playlist's Lounge presence, never the Members' Pins or Shared
 *  references — so the confirmation says so before it runs. */
function returnToPrivateModerationBody(item: LoungePlaylistItem): string {
  const owner = loungeOwnerDisplayName(item.ownerArtistName, item.ownerName);
  return `“${item.name}” by ${owner} leaves the Lounge. Other Members lose their Pins of it and any saved Shared references to its Tracks that no other shared playlist of ${owner}’s still holds — sharing it again won’t bring them back. ${owner} keeps the playlist and its Tracks.`;
}

function LoungeTile({
  item,
  query,
  onPlayOwn,
  onTogglePin,
  onMoreLikeThis,
  onReturnToPrivate,
}: {
  item: LoungePlaylistItem;
  query: string;
  onPlayOwn: () => void;
  onTogglePin: () => void;
  onMoreLikeThis: () => void;
  /** Set only for the Admin — the moderation row is member-invisible. */
  onReturnToPrivate?: () => void;
}) {
  const ownerLabel = item.yours
    ? 'you'
    : loungeOwnerDisplayName(item.ownerArtistName, item.ownerName);
  return (
    <PlaylistCardShell
      // Own share → the normal detail; foreign → the visitor view.
      href={item.yours ? `/library/playlist/${item.id}` : `/lounge/playlist/${item.id}`}
      openLabel={`Open ${item.name} by ${ownerLabel}`}
      coverImageId={item.coverImageId}
      mosaicCoverImageIds={item.mosaicCoverImageIds}
      onPlay={item.yours ? onPlayOwn : undefined}
      playLabel={`Play ${item.name}`}
      playTestId={`lounge-play-${item.id}`}
      testId={`lounge-tile-${item.id}`}
      coverFlag={
        <OnlineOnly>
          <button
            type="button"
            aria-pressed={item.pinned}
            aria-label={item.pinned ? `Unpin ${item.name}` : `Pin ${item.name} in the Lounge`}
            data-testid={`lounge-pin-${item.id}`}
            onClick={onTogglePin}
            className={cn(
              playlistCardPinFlagClass,
              'z-20 transition',
              item.pinned ? 'text-lamp' : 'text-dim hover:text-paper',
            )}
          >
            <Pin className={cn('h-[13px] w-[13px]', item.pinned && 'fill-current')} aria-hidden />
          </button>
        </OnlineOnly>
      }
      trailing={
        item.yours ? undefined : (
          <LoungeTileMenu
            item={item}
            onTogglePin={onTogglePin}
            onMoreLikeThis={onMoreLikeThis}
            onReturnToPrivate={onReturnToPrivate}
          />
        )
      }
    >
      <div className="truncate text-[14px] font-semibold">{item.name}</div>
      <div className={cn('mt-1', playlistCardMetaLineClass)}>
        <OfflineMark kind="playlist" id={item.id} />
        {formatPlaylistCardMeta(item)}
      </div>
      {/* Relative time drifts between the server render and hydration
          whenever a minute boundary passes in between. */}
      <div
        className={cn(playlistCardMetaLineClass, 'flex items-center gap-1')}
        suppressHydrationWarning
      >
        {item.yours ? (
          <span
            data-testid={`lounge-yours-${item.id}`}
            className="inline-block rounded-[4px] border border-lamp/45 px-1 text-[8px] leading-[1.6] tracking-[0.12em] text-lamp"
          >
            Yours
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <AvatarBadge
              name={ownerLabel}
              imageUrl={item.ownerImageUrl}
              className="h-[18px] w-[18px] text-[9px]"
            />
            <span className="truncate">{ownerLabel}</span>
          </span>
        )}
        <span className="shrink-0">
          · <RelativeTime iso={item.sharedAt} />
        </span>
      </div>
      {item.matchContext ? <MatchContextLine context={item.matchContext} query={query} /> : null}
    </PlaylistCardShell>
  );
}

/** The foreign tile's options sheet — the same sheet model as the Library's
 *  playlist card menu. Available offline, the Pin toggle and More Like This (on
 *  the VIEWER's budget); for the Admin only, the Return to
 *  Private moderation row (the one cross-owner write — foreign tiles only, on
 *  their own shares the Admin unshares through the normal owner row). */
function LoungeTileMenu({
  item,
  onTogglePin,
  onMoreLikeThis,
  onReturnToPrivate,
}: {
  item: LoungePlaylistItem;
  onTogglePin: () => void;
  onMoreLikeThis: () => void;
  onReturnToPrivate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ownerLabel = loungeOwnerDisplayName(item.ownerArtistName, item.ownerName);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label={`Options for ${item.name}`}
        data-testid={`lounge-menu-${item.id}`}
        className={cn(menuTriggerClass, 'relative z-20 -mr-1 -mt-1')}
      >
        <EllipsisVertical className="h-[17px] w-[17px]" aria-hidden />
      </SheetTrigger>
      <PlaylistOptionsSheetContent playlist={item} owner={ownerLabel}>
        <MenuRow
          onlineOnly
          icon={<Pin className={cn(item.pinned && 'fill-current')} />}
          label={item.pinned ? 'Unpin Playlist' : 'Pin in the Lounge'}
          description={item.pinned ? 'Stop listing it first' : 'List it first in your lounge'}
          data-testid={`lounge-menu-pin-${item.id}`}
          onClick={() => {
            setOpen(false);
            onTogglePin();
          }}
        />
        <MenuRow
          onlineOnly
          icon={<MenuMoreLikeThisGlyph />}
          label="More Like This"
          description="Start a new session in this style, on your own budget"
          data-testid={`lounge-menu-more-like-this-${item.id}`}
          onClick={() => {
            setOpen(false);
            onMoreLikeThis();
          }}
        />
        {onReturnToPrivate ? (
          <MenuRow
            onlineOnly
            icon={<Lock />}
            label="Return to Private"
            description="Admin: make it private and remove it from everyone else's library"
            tone="danger"
            data-testid={`lounge-menu-return-to-private-${item.id}`}
            onClick={() => {
              setOpen(false);
              onReturnToPrivate();
            }}
          />
        ) : null}
      </PlaylistOptionsSheetContent>
    </Sheet>
  );
}

/** A narrowed list with no survivors — the filters' honest answer; the room
 *  itself is not empty (that state is the teach panel). */
function NothingSetOut() {
  return (
    <div className="mt-4 rounded-card border border-dashed border-line-2 px-8 py-8 text-center">
      <span className="mx-auto mb-4 grid h-[58px] w-[58px] place-items-center rounded-full border border-dashed border-line-2 text-dim">
        <Armchair className="h-6 w-6" aria-hidden />
      </span>
      <h2 className="font-display text-[19px] font-bold">Nothing set out for that</h2>
      <p className="mt-2 text-[13.5px] text-muted">
        No shared playlist or sharing member matches. Clear the search or pick another member.
      </p>
    </div>
  );
}

/** First visit, nothing shared anywhere: teach the one move that fills the room. */
function LoungeTeach() {
  return (
    <div className="mt-6 rounded-card border border-dashed border-line-2 px-6 py-10 text-center">
      <span className="mx-auto mb-5 grid h-[72px] w-[72px] place-items-center rounded-full border border-dashed border-lamp/45 bg-[radial-gradient(70%_70%_at_50%_35%,rgba(255,178,92,0.08),transparent_70%)] text-lamp shadow-[0_0_34px_-10px_var(--lamp-glow)]">
        <Armchair className="h-[30px] w-[30px]" aria-hidden />
      </span>
      <h2 className="font-display text-[22px] font-extrabold tracking-[-0.015em]">
        The Lounge is open
      </h2>
      <p className="mt-2 text-[14px] text-muted">
        Nobody has shared a playlist yet. Anything placed here plays for everyone on this instance —
        and stays theirs to take back.
      </p>
      <div className="mx-auto mt-7 grid max-w-[640px] gap-3 text-left desk:grid-cols-3">
        <TeachStep number="01" title="Open one of your playlists">
          In your Library, under Playlists.
        </TeachStep>
        <TeachStep number="02" title="Share it to the Lounge">
          Tap{' '}
          <span
            aria-hidden
            className="inline-grid h-[18px] w-[18px] -translate-y-[3px] place-items-center rounded-[5px] border border-line-2 bg-[var(--control-bg)] align-middle text-paper"
          >
            <EllipsisVertical className="h-[13px] w-[13px]" />
          </span>{' '}
          on the playlist and pick “Share to the Lounge”. It stays live — you keep curating,
          everyone hears the latest.
        </TeachStep>
        <TeachStep number="03" title="Take it back anytime">
          Return it to Private and it leaves every Library the same moment.
        </TeachStep>
      </div>
      <Link
        href="/library"
        className="mt-7 inline-flex items-center gap-2 rounded-[13px] px-5 py-3 text-[15px] font-semibold text-[var(--on-lamp)] shadow-[var(--shadow-primary)] [background:var(--gradient-primary)]"
      >
        Open your Library
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

function TeachStep({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-[var(--control-bg)] p-4 desk:flex-col desk:gap-2">
      <span className="flex-none rounded-md border border-lamp/40 px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-lamp">
        {number}
      </span>
      <div>
        <b className="block text-[13.5px] font-semibold">{title}</b>
        <span className="mt-0.5 block text-[12.5px] text-muted">{children}</span>
      </div>
    </div>
  );
}
