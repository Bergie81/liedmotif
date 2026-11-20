'use client';

// The options sheet's row vocabulary: one scope group, and the ways a row can
// answer a tap. `player-options-model` says which rows exist and in what order;
// this says what a row looks like and how it behaves once wired.

import Link from 'next/link';
import type { ComponentType } from 'react';
import {
  Download,
  ImagePlus,
  Info,
  ListMinus,
  ListMusic,
  MicVocal,
  Pencil,
  Plus,
  ThumbsDown,
  Timer,
  Trash2,
} from 'lucide-react';
import { MAX_TRACK_TITLE_LENGTH } from '@liedmotif/shared';
import { MenuRow, MenuRowContent, menuRowClassName } from '@/components/ui/menu-row';
import { SheetClose } from '@/components/ui/sheet';
import { startFileDownload, trackDownloadUrl } from '@/lib/downloads/downloads';
import {
  LISTEN_ONLY_ROW_IDS,
  type OptionsRowIcon,
  type OptionsRowId,
  type OptionsRowSpec,
  type OptionsScopeSpec,
} from './player-options-model';
import { ChangeVibeGlyph, MenuMoreLikeThisGlyph, SectionLoopGlyph } from '@/components/ui/glyphs';
import type { SectionLoopControl } from './playback-controller-api';
import { sleepTimerNote } from './sleep-timer';

const ROW_ICONS: Record<OptionsRowIcon, ComponentType<{ className?: string }>> = {
  pencil: Pencil,
  'image-plus': ImagePlus,
  plus: Plus,
  info: Info,
  download: Download,
  trash: Trash2,
  'mic-vocal': MicVocal,
  'section-loop': SectionLoopGlyph,
  'list-music': ListMusic,
  'list-minus': ListMinus,
  'more-like-this': MenuMoreLikeThisGlyph,
  'thumbs-down': ThumbsDown,
  'change-vibe': ChangeVibeGlyph,
  timer: Timer,
};

/** The rows that hand off to a modal — the sheet owns both, so a row only says
 *  what the modal should ask and do. */
export type OptionsRowModal =
  | {
      kind: 'rename';
      /** What is being renamed, e.g. "Rename Track" (the one rename modal). */
      heading: string;
      currentName: string;
      maxLength: number;
      /** Perform the rename; resolve to an error message, or null. */
      onRename: (name: string) => Promise<string | null>;
    }
  | {
      kind: 'confirm';
      heading: string;
      /** The consequence, spelled out — a destructive row asks first. */
      body: string;
      confirmLabel: string;
      onConfirm: () => Promise<void>;
    }
  /** The dialog reads the live timer itself: there is no target to pin. */
  | { kind: 'sleep-timer' };

/** Actions close the options sheet so a destination sheet can take its place.
 *  `note` is the row's live state, such as a running timer's time left; `label`
 *  replaces the row's own where the state renames the act ("Add" or "Edit"). */
export type OptionsRowAction = { testId?: string; note?: string; label?: string } & (
  | { kind: 'button'; onSelect: () => void }
  | { kind: 'link'; href: string }
  /** Shipped, but with nothing to act on right now — an empty deck, an empty
   *  playlist. Distinct from a roadmap row: it is the state, not the feature. */
  | { kind: 'unavailable' }
  | OptionsRowModal
);

/** The current Track as the options sheet acts on it: identity, display title,
 *  and whether its stored final can be downloaded. */
export interface OptionsTrack {
  trackId: string;
  title: string;
  downloadable: boolean;
}

/** The Track scope's wiring, identical wherever a Track is playing. Delete
 *  Track stays out of it: it means something different per source. */
export function trackScopeActions({
  track,
  lyricsAvailable,
  onOpenLyrics,
  onRenameTrack,
  onOpenTrackData,
}: {
  track: OptionsTrack | null;
  /** Whether the current Track is vocal — an instrumental greys the row. */
  lyricsAvailable: boolean;
  /** Opens the Lyrics sheet (parent-owned, so two sheets never stack). */
  onOpenLyrics: () => void;
  /** Perform the rename; resolve to an error message, or null. */
  onRenameTrack: (trackId: string, title: string) => Promise<string | null>;
  /** Opens the Track Data sheet (parent-owned, so two sheets never stack). */
  onOpenTrackData: () => void;
}): Record<'lyrics' | 'rename-track' | 'track-data' | 'download-track', OptionsRowAction> {
  if (!track) {
    return {
      lyrics: { kind: 'unavailable', testId: 'player-open-lyrics' },
      'rename-track': { kind: 'unavailable', testId: 'player-rename-track' },
      'track-data': { kind: 'unavailable', testId: 'player-open-track-data' },
      'download-track': { kind: 'unavailable', testId: 'player-download-track' },
    };
  }
  return {
    lyrics: lyricsAvailable
      ? { kind: 'button', testId: 'player-open-lyrics', onSelect: onOpenLyrics }
      : { kind: 'unavailable', testId: 'player-open-lyrics' },
    'rename-track': {
      kind: 'rename',
      testId: 'player-rename-track',
      heading: 'Rename Track',
      currentName: track.title,
      maxLength: MAX_TRACK_TITLE_LENGTH,
      onRename: (title) => onRenameTrack(track.trackId, title),
    },
    'track-data': { kind: 'button', testId: 'player-open-track-data', onSelect: onOpenTrackData },
    // A stream-only track (cold start) has no stored final yet — the row waits.
    'download-track': track.downloadable
      ? {
          kind: 'button',
          testId: 'player-download-track',
          onSelect: () => startFileDownload(trackDownloadUrl(track.trackId)),
        }
      : { kind: 'unavailable', testId: 'player-download-track' },
  };
}

/** The Loop a Part row, the same under every source: its note says it is on. */
export function sectionLoopAction(
  track: OptionsTrack | null,
  control: SectionLoopControl,
): OptionsRowAction {
  const testId = 'player-options-section-loop';
  if (!track || !control.available) return { kind: 'unavailable', testId };
  return {
    kind: 'button',
    testId,
    note: control.open ? 'On' : undefined,
    onSelect: control.onToggle,
  };
}

/** The Sleep Timer row, the same under every source: its note is the time left. */
export function sleepTimerAction(endsAt: number | null): OptionsRowAction {
  return {
    kind: 'sleep-timer',
    testId: 'player-sleep-timer',
    note: sleepTimerNote(endsAt, Date.now()),
  };
}

/** One subject and its rows: the rail is read once, and every row beneath it
 *  inherits it rather than naming what it acts on. */
export function OptionsScope({
  scope,
  actions,
  onOpenModal,
}: {
  scope: OptionsScopeSpec;
  actions: Partial<Record<OptionsRowId, OptionsRowAction>>;
  onOpenModal: (modal: OptionsRowModal) => void;
}) {
  return (
    <div>
      <div className="mb-1 mt-4 flex items-center gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-dim">
          {scope.label}
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {scope.rows.map((row) => {
        const action = row.availability === 'available' ? actions[row.id] : undefined;
        return action ? (
          <ShippedRow key={row.id} row={row} action={action} onOpenModal={onOpenModal} />
        ) : (
          <RoadmapRow key={row.id} row={row} />
        );
      })}
    </div>
  );
}

function rowFace(row: OptionsRowSpec, action?: OptionsRowAction) {
  const Icon = ROW_ICONS[row.icon];
  return {
    icon: <Icon />,
    label: action?.label ?? row.label,
    description: row.description,
    note: action?.note,
    tone: row.tone,
  };
}

function ShippedRow({
  row,
  action,
  onOpenModal,
}: {
  row: OptionsRowSpec;
  action: OptionsRowAction;
  onOpenModal: (modal: OptionsRowModal) => void;
}) {
  if (action.kind === 'unavailable') {
    return <MenuRow {...rowFace(row, action)} disabled data-testid={action.testId} />;
  }
  if (action.kind === 'link') {
    return (
      <SheetClose asChild>
        <Link
          href={action.href}
          data-testid={action.testId}
          className={menuRowClassName({ tone: row.tone })}
        >
          <MenuRowContent {...rowFace(row, action)} />
        </Link>
      </SheetClose>
    );
  }
  return (
    <SheetClose asChild>
      <MenuRow
        {...rowFace(row, action)}
        onlineOnly={!LISTEN_ONLY_ROW_IDS.has(row.id)}
        data-testid={action.testId}
        onClick={action.kind === 'button' ? action.onSelect : () => onOpenModal(action)}
      />
    </SheetClose>
  );
}

function RoadmapRow({ row }: { row: OptionsRowSpec }) {
  return <MenuRow {...rowFace(row, { kind: 'unavailable', note: 'Coming Later' })} disabled />;
}
