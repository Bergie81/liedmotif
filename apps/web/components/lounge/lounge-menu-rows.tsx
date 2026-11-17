'use client';

// The menu rows of a shared playlist, used by its Lounge tile and by the
// visitor view's header alike, so a shared playlist offers the same moves
// wherever it is opened. Each row's tap closes the sheet that holds it first.

import { Armchair, Lock, Pin, Play } from 'lucide-react';
import { cn } from '@/lib/cn';
import { LeaveLoungeGlyph, MenuMoreLikeThisGlyph } from '@/components/ui/glyphs';
import { MenuRow } from '@/components/ui/menu-row';

/** What a visitor can do with someone else's shared playlist. */
export interface LoungeVisitorActions {
  play: () => void;
  togglePin: () => void;
  /** A new Session in this style, on the VIEWER's budget. */
  moreLikeThis: () => void;
  /** Set only for the Admin — the moderation row is member-invisible. */
  returnToPrivate?: () => void;
}

/** What the owner can do with their own share from the Lounge. Curation
 *  (tracks, cover, name, delete) lives on the playlist's own page. */
export interface LoungeOwnerActions {
  play: () => void;
  togglePin: () => void;
  editSharing: () => void;
  /** Return it to Private; the caller confirms first. */
  removeFromLounge: () => void;
}

function LoungePlayRow({ playlistId, onClick }: { playlistId: string; onClick: () => void }) {
  return (
    <MenuRow
      icon={<Play className="fill-current" />}
      label="Play"
      description="Play its tracks in order"
      data-testid={`lounge-menu-play-${playlistId}`}
      onClick={onClick}
    />
  );
}

function LoungePinRow({
  playlistId,
  pinned,
  onClick,
}: {
  playlistId: string;
  pinned: boolean;
  onClick: () => void;
}) {
  return (
    <MenuRow
      onlineOnly
      icon={<Pin className={cn(pinned && 'fill-current')} />}
      label={pinned ? 'Unpin Playlist' : 'Pin in the Lounge'}
      description={pinned ? 'Stop listing it first' : 'List it first in your lounge'}
      data-testid={`lounge-menu-pin-${playlistId}`}
      onClick={onClick}
    />
  );
}

/** The owner's one-tap way out of the Lounge, next to Edit Sharing: the caller
 *  confirms before it unshares, since visitors' Pins and Shared references go
 *  with it. */
export function RemoveFromLoungeRow({ testId, onClick }: { testId: string; onClick: () => void }) {
  return (
    <MenuRow
      onlineOnly
      icon={<LeaveLoungeGlyph />}
      label="Remove from Lounge"
      description="Make it private, so nobody else can listen to it"
      tone="danger"
      data-testid={testId}
      onClick={onClick}
    />
  );
}

/** Play, the Pin toggle, Edit Sharing and Remove from Lounge. */
export function LoungeOwnerRows({
  playlistId,
  pinned,
  actions,
  close,
}: {
  playlistId: string;
  pinned: boolean;
  actions: LoungeOwnerActions;
  close: () => void;
}) {
  function pick(action: () => void) {
    close();
    action();
  }
  return (
    <>
      <LoungePlayRow playlistId={playlistId} onClick={() => pick(actions.play)} />
      <LoungePinRow
        playlistId={playlistId}
        pinned={pinned}
        onClick={() => pick(actions.togglePin)}
      />
      <MenuRow
        onlineOnly
        icon={<Armchair />}
        label="Edit Sharing"
        description="Choose who can listen to it in the lounge"
        data-testid={`lounge-menu-share-${playlistId}`}
        onClick={() => pick(actions.editSharing)}
      />
      <RemoveFromLoungeRow
        testId={`lounge-menu-remove-from-lounge-${playlistId}`}
        onClick={() => pick(actions.removeFromLounge)}
      />
    </>
  );
}

/** Play, the Pin toggle, More Like This and, for the Admin, the Return to
 *  Private moderation (the one cross-owner write). */
export function LoungeVisitorRows({
  playlistId,
  pinned,
  actions,
  close,
}: {
  playlistId: string;
  pinned: boolean;
  actions: LoungeVisitorActions;
  close: () => void;
}) {
  function pick(action: () => void) {
    close();
    action();
  }
  const { returnToPrivate } = actions;
  return (
    <>
      <LoungePlayRow playlistId={playlistId} onClick={() => pick(actions.play)} />
      <LoungePinRow
        playlistId={playlistId}
        pinned={pinned}
        onClick={() => pick(actions.togglePin)}
      />
      <MenuRow
        onlineOnly
        icon={<MenuMoreLikeThisGlyph />}
        label="More Like This"
        description="Start a new session in this style, on your own budget"
        data-testid={`lounge-menu-more-like-this-${playlistId}`}
        onClick={() => pick(actions.moreLikeThis)}
      />
      {returnToPrivate ? (
        <MenuRow
          onlineOnly
          icon={<Lock />}
          label="Return to Private"
          description="Admin: make it private and remove it from everyone else's library"
          tone="danger"
          data-testid={`lounge-menu-return-to-private-${playlistId}`}
          onClick={() => pick(returnToPrivate)}
        />
      ) : null}
    </>
  );
}
