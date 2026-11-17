'use client';

// The Playlist's identity, the way back out of it, Play, and the one menu that
// manages it. What is left on the surface is the Playlist itself — artwork,
// name, count, duration — because every act that curates rather than plays sits
// behind the `⋯`. The cover is artwork here, not a control: it is managed from
// that menu like everything else, so there is one place to look for a change.
// Available offline leads that menu, for a Lounge visitor too, whose rows are
// the same ones the playlist's Lounge tile offers.

import {
  ArrowLeft,
  Download,
  GripVertical,
  ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { PlaylistSummaryItem } from '@liedmotif/shared';
import { eyebrowClass, iconButtonClass } from '@/components/ui/design-system';
import { MenuRow } from '@/components/ui/menu-row';
import { Sheet, SheetTrigger } from '@/components/ui/sheet';
import { OfflineMark } from '@/components/offline/offline-mark';
import { useOfflineSupported } from '@/components/offline/offline-menu-row';
import { LoungeVisitorRows, type LoungeVisitorActions } from '@/components/lounge/lounge-menu-rows';
import { PlaylistCover } from './playlist-cover';
import { PlaylistOptionsSheetContent } from './playlist-options-sheet-content';
import {
  formatPlaylistCardMeta,
  playlistMenuRows,
  type PlaylistMenuRowId,
} from './playlist-view-model';

/** The Lounge visitor view's rows: listening moves on someone else's share. */
interface VisitorMenu {
  pinned: boolean;
  actions: LoungeVisitorActions;
}

const MENU_ICONS: Record<PlaylistMenuRowId, LucideIcon> = {
  'add-tracks': Plus,
  rename: Pencil,
  reorder: GripVertical,
  cover: ImageIcon,
  download: Download,
  delete: Trash2,
};

export function PlaylistHeader({
  playlist,
  back,
  reordering,
  actions,
  visitor,
  eyebrow,
  attribution,
  play,
}: {
  playlist: PlaylistSummaryItem;
  /** Where the way back goes — omitted where the Playlist is embedded in
   *  another surface and there is nothing to go back from. */
  back?: { href: string; label: string };
  /** The reorder mode owns the header: its own bar is the only way out, so
   *  neither the menu, the way back nor Play can strand a buffered order. */
  reordering: boolean;
  /** The page's primary control, under the menu. */
  play?: ReactNode;
  /** Every row that can be reached needs a handler, so a shipped row with no
   *  wiring is a type error rather than a dead tap. Omitted on a surface
   *  that cannot curate: the menu then holds only Available offline and the
   *  visitor rows, and is absent, not empty, when it would hold nothing. */
  actions?: Record<PlaylistMenuRowId, () => void>;
  visitor?: VisitorMenu;
  /** Replaces the standing "Playlist" eyebrow (the visitor view names the room). */
  eyebrow?: string;
  /** Who this playlist belongs to, under the meta line — the visitor view's
   *  owner line; an owned surface renders none. */
  attribution?: ReactNode;
}) {
  const isFavorites = playlist.kind === 'favorites';
  return (
    <header>
      {back && !reordering ? (
        <Link
          href={back.href}
          className="-ml-2 mb-3 inline-flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-[13.5px] text-muted [-webkit-tap-highlight-color:transparent] hover:bg-[var(--control-bg-hover)] hover:text-paper"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> {back.label}
        </Link>
      ) : null}
      <div className="flex items-start gap-4">
        <PlaylistCover
          coverImageId={playlist.coverImageId}
          mosaicCoverImageIds={playlist.mosaicCoverImageIds}
          className="h-[88px] w-[88px] flex-none self-center rounded-[6px] desk:h-[128px] desk:w-[128px]"
        />
        <div className="min-w-0 flex-1">
          <p className={eyebrowClass}>
            {eyebrow ?? (isFavorites ? 'Playlist · Favorites' : 'Playlist')}
          </p>
          <div className="mt-2 flex items-center gap-2">
            {isFavorites ? (
              <Star className="h-6 w-6 flex-none fill-current text-lamp" aria-hidden />
            ) : null}
            <h1
              data-testid="playlist-title"
              className="min-w-0 break-words font-display text-[clamp(24px,6vw,32px)] font-extrabold leading-[1.1] tracking-[-0.02em]"
            >
              {playlist.name}
            </h1>
          </div>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
            <OfflineMark kind="playlist" id={playlist.id} />
            {formatPlaylistCardMeta(playlist)}
          </p>
          {attribution}
        </div>
        {/* Both slots stay so entering the mode does not reflow the title beside
            them. Stacked they match the phone cover's height, so Play ends level
            with the artwork. */}
        <div className="-mt-1.5 flex flex-none flex-col items-center justify-between self-stretch">
          <div className="h-[42px] w-[42px]">
            {reordering ? null : (
              <PlaylistMenu playlist={playlist} actions={actions} visitor={visitor} />
            )}
          </div>
          <div className="h-[52px] w-[52px]">{reordering ? null : play}</div>
        </div>
      </div>
    </header>
  );
}

function PlaylistMenu({
  playlist,
  actions,
  visitor,
}: {
  playlist: PlaylistSummaryItem;
  actions: Record<PlaylistMenuRowId, () => void> | undefined;
  visitor: VisitorMenu | undefined;
}) {
  const [open, setOpen] = useState(false);
  const offlineSupported = useOfflineSupported();
  if (!actions && !visitor && !offlineSupported) return null;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        aria-label="Playlist options"
        data-testid="playlist-menu"
        className={iconButtonClass}
      >
        <MoreHorizontal className="h-[22px] w-[22px]" aria-hidden />
      </SheetTrigger>
      <PlaylistOptionsSheetContent playlist={playlist}>
        {visitor ? (
          <LoungeVisitorRows
            playlistId={playlist.id}
            pinned={visitor.pinned}
            actions={visitor.actions}
            close={() => setOpen(false)}
          />
        ) : null}
        {actions
          ? playlistMenuRows(playlist).map((row) => {
              const Icon = MENU_ICONS[row.id];
              return (
                <MenuRow
                  key={row.id}
                  onlineOnly
                  icon={<Icon />}
                  label={row.label}
                  description={row.description}
                  note={row.note}
                  tone={row.tone}
                  disabled={row.disabled}
                  data-testid={`playlist-menu-${row.id}`}
                  onClick={() => {
                    setOpen(false);
                    actions[row.id]();
                  }}
                />
              );
            })
          : null}
      </PlaylistOptionsSheetContent>
    </Sheet>
  );
}
