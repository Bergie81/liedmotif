'use client';

// The player's options sheet, whole: the trigger, the plate that states what
// the next tap will touch, the row of one-tap tiles, the scoped list
// `player-options-model` describes, and the two modals its rows hand off to.
// Both Playback sources are THIS component with different wiring, so their
// shared skeleton is structural rather than a convention two files have to keep.
//
// A row that opens a modal pins its action at tap time. Playback may advance
// while the modal is up, and the write must land on the Track the owner
// actually chose, so the tapped action's closures are what the modal runs.

import { useState, type ReactNode } from 'react';
import { ImagePlus, ListPlus, MicVocal, MoreHorizontal } from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RenameDialog } from '@/components/rename-dialog';
import { iconButtonClass, menuTileClass } from '@/components/ui/design-system';
import { OnlineOnly } from '@/components/ui/online-only';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTrigger } from '@/components/ui/sheet';
import { BlendToggleTile } from './blend-toggle';
import { CoverThumb } from './cover-art';
import type { OptionsRowId, OptionsScopeSpec } from './player-options-model';
import { OptionsScope, type OptionsRowAction, type OptionsRowModal } from './player-options-rows';
import type { SourceNoun } from './player-presentation';
import { SleepTimerDialog } from './sleep-timer-dialog';

interface TileTargets {
  /** A Session's Lyrics; a Playlist keeps them as a row in its list. */
  lyrics?: { disabled: boolean; onSelect: () => void };
  blend: { enabled: boolean; onToggle: () => void };
  /** The source's own artwork — a Session Cover or a Playlist Cover. Disabled
   *  where managing it is not the listener's to do (a visitor's foreign
   *  playlist): the slot keeps its place, dark. */
  sourceCover: {
    label: string;
    hint: string;
    testId: string;
    disabled?: boolean;
    onSelect: () => void;
  };
  addToPlaylist: { disabled: boolean; onSelect: () => void };
}

export function PlayerOptionsSheet({
  sourceKind,
  sourceName,
  coverImageId,
  trackTitle,
  tiles,
  scopes,
  actions,
  leadRows,
  footer,
}: {
  sourceKind: SourceNoun;
  sourceName: string;
  /** The current Track's art — the plate's thumb. */
  coverImageId: string | null;
  /** Null while no Track is loaded — the sheet is then about the source alone. */
  trackTitle: string | null;
  /** Absent in the Offline Library, where every tile would need the server. */
  tiles?: TileTargets;
  scopes: readonly OptionsScopeSpec[];
  /** Wiring for every id `scopes` marks available; anything missing renders as
   *  the roadmap row it is. Call sites type this as a full Record over their
   *  own available ids, so shipping a row without a handler is a type error. */
  actions: Partial<Record<OptionsRowId, OptionsRowAction>>;
  /** About the source as a whole, so they lead the list above the scoped groups. */
  leadRows?: ReactNode;
  /** The source's closing action, below the list (a Session can be stopped). */
  footer?: ReactNode;
}) {
  const [modal, setModal] = useState<OptionsRowModal | null>(null);
  const close = () => setModal(null);

  return (
    <>
      {modal?.kind === 'rename' ? (
        <RenameDialog
          heading={modal.heading}
          currentName={modal.currentName}
          maxLength={modal.maxLength}
          onRename={modal.onRename}
          onClose={close}
        />
      ) : null}
      {modal?.kind === 'sleep-timer' ? <SleepTimerDialog onClose={close} /> : null}
      {modal?.kind === 'confirm' ? (
        <ConfirmDialog
          heading={modal.heading}
          body={modal.body}
          confirmLabel={modal.confirmLabel}
          onConfirm={async () => {
            await modal.onConfirm();
            close();
          }}
          onClose={close}
        />
      ) : null}

      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label={`${sourceKind} and Track options`}
            className={iconButtonClass}
          >
            <MoreHorizontal className="h-[22px] w-[22px]" aria-hidden />
          </button>
        </SheetTrigger>
        {/* Taller than the default bottom-sheet cap (important wins the
            conflict): this is the longest list in the app. */}
        <SheetContent side="bottom" className="max-h-[94vh]! overflow-y-auto">
          <OptionsPlate
            coverImageId={coverImageId}
            trackTitle={trackTitle}
            sourceKind={sourceKind}
            sourceName={sourceName}
          />
          {tiles ? <OptionsTiles {...tiles} /> : null}
          {/* In their own wrapper the last of them is a last child, so it draws
              no rule above the first scope's own heading rule. */}
          {leadRows ? <div>{leadRows}</div> : null}
          {scopes.map((scope) => (
            <OptionsScope
              key={scope.label}
              scope={scope}
              actions={actions}
              onOpenModal={setModal}
            />
          ))}
          {footer}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The heading: the Track being played, and the source it is playing inside. The
 * source name is the only part of the second line that varies, so it takes the
 * lamp — "in Session" is a label, not content. With no Track loaded there is
 * only one subject left, and the plate says so.
 */
function OptionsPlate({
  coverImageId,
  trackTitle,
  sourceKind,
  sourceName,
}: {
  coverImageId: string | null;
  trackTitle: string | null;
  sourceKind: SourceNoun;
  sourceName: string;
}) {
  return (
    <SheetHeader
      leading={<CoverThumb coverImageId={coverImageId} />}
      title={trackTitle ?? sourceName}
      description={
        trackTitle ? (
          // One line like the title above it: a long source name truncates
          // rather than wrapping the plate taller.
          <span className="block truncate">
            in {sourceKind} <span className="text-lamp">{sourceName}</span>
          </span>
        ) : (
          `${sourceKind} options`
        )
      }
      closeLabel={`Close ${sourceKind} and Track options`}
      offlineMark
    />
  );
}

/**
 * The reachable targets: one tap, no reading. Every sheet fills the same slots
 * in the same order, so a slot is hit rather than parsed, and a tile with
 * nothing to show greys out in place: a slot that keeps its position costs less
 * than every other slot moving.
 */
function OptionsTiles({ lyrics, blend, sourceCover, addToPlaylist }: TileTargets) {
  return (
    <div className="mb-2 mt-4 grid auto-cols-[minmax(0,1fr)] grid-flow-col gap-2">
      {/* Lyrics read what the player already holds, so they work offline. */}
      {lyrics ? (
        <OptionsTile
          testId="player-open-lyrics"
          icon={MicVocal}
          label="Lyrics"
          disabled={lyrics.disabled}
          onSelect={lyrics.onSelect}
        />
      ) : null}
      {/* Every other tile writes to the server, the blend setting included. */}
      <OnlineOnly>
        <OptionsTile
          testId={sourceCover.testId}
          icon={ImagePlus}
          label={sourceCover.label}
          hint={sourceCover.hint}
          disabled={sourceCover.disabled}
          onSelect={sourceCover.onSelect}
        />
        <BlendToggleTile enabled={blend.enabled} onToggle={blend.onToggle} />
        <OptionsTile
          testId="player-add-track-to-playlist"
          icon={ListPlus}
          label="Playlist"
          hint="Add Track to Playlist"
          disabled={addToPlaylist.disabled}
          onSelect={addToPlaylist.onSelect}
        />
      </OnlineOnly>
    </div>
  );
}

function OptionsTile({
  icon: Icon,
  label,
  hint,
  testId,
  disabled,
  onSelect,
}: {
  icon: typeof ImagePlus;
  label: string;
  /** What the tile's compressed label leaves out — its accessible name, and a
   *  hover title where there is a pointer to hover with. */
  hint?: string;
  testId: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <SheetClose asChild>
      <button
        type="button"
        data-testid={testId}
        aria-label={hint}
        title={hint}
        disabled={disabled}
        onClick={onSelect}
        className={menuTileClass}
      >
        <Icon className="h-5 w-5 text-lamp" aria-hidden />
        {label}
      </button>
    </SheetClose>
  );
}
