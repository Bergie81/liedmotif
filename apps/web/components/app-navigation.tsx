'use client';

import type { ComponentType, MouseEvent, ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  Armchair,
  AudioWaveform,
  Library as LibraryIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Radio,
  Search,
  SkipBack,
  SkipForward,
  Zap,
} from 'lucide-react';
import type { SessionSummary } from '@liedmotif/shared';
import { Meter, LiedmotifMark, LiedmotifWordmark } from '@/components/ui/design-system';
import { SessionGlyph } from '@/components/ui/glyphs';
import { cn } from '@/lib/cn';
import type { OfflineMarkKind } from '@/lib/offline/offline-store';
import { useOnline } from '@/lib/online-state';
import { AccountMenu, type Listener } from './account-menu';
import {
  deriveGenerationHeadroom,
  getPrimaryNavDestination,
  HEADROOM_PERIOD,
  headroomLine,
  PRIMARY_NAV_ITEMS,
  trackNoun,
  type PrimaryNavItem,
} from './app-shell-model';
import { OfflineBadge } from './offline-badge';
import { OfflineMark } from './offline/offline-mark';
import { CoverArt } from './player/cover-art';
import { PlaybackModeControl } from './player/playback-mode-control';
import {
  presentMiniPlayer,
  presentMiniVibeChange,
  resolveCoverImageId,
} from './player/player-presentation';
import {
  useTrackPreviewAnnouncement,
  type TrackPreviewAnnouncement,
} from './player/preview-announcer';
import { ScrambleText } from './player/scramble-text';
import { sectionLoopLive } from './player/playback-controller-api';
import { usePlayerContext, type LivePlayback } from './player/player-provider';
import { usePlaybackProgress } from './player/use-playback-progress';

const NAV_ICONS: Record<PrimaryNavItem['icon'], ComponentType<{ className?: string }>> = {
  home: Radio,
  search: Search,
  sessions: SessionGlyph,
  library: LibraryIcon,
  lounge: Armchair,
};

type GenerationHeadroom = NonNullable<ReturnType<typeof deriveGenerationHeadroom>>;

export function PrimaryNavigation({
  pathname,
  listener,
  headroom,
  headroomHref,
  activeSession,
  showMiniPlayer,
  railExpanded,
  onToggleRail,
  themeMode,
  onToggleThemeMode,
}: {
  pathname: string;
  listener: Listener;
  headroom: GenerationHeadroom | null;
  headroomHref: string;
  activeSession: SessionSummary | null;
  /** Owned by the shell (hidden on /player); a live Playlist keeps it up even
   *  with no active Session. */
  showMiniPlayer: boolean;
  railExpanded: boolean;
  onToggleRail: () => void;
  themeMode: 'night' | 'light';
  onToggleThemeMode: () => void;
}) {
  return (
    <nav
      id="primary-navigation"
      aria-label="Primary"
      className={cn(
        'fixed bottom-0 left-0 right-0 z-40 flex h-[calc(var(--tab-h)+env(safe-area-inset-bottom,0px))] border-t border-line bg-[var(--nav-bg)] pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-[18px]',
        // Every block of the rail keeps its size; a window too short for all of
        // them scrolls the rail as a whole. The scrollbar stays hidden: a
        // classic one would take ~12px of the 96px collapsed rail, pushing
        // its content off-center and squeezing the mini player's controls.
        'hide-scrollbar desk:top-0 desk:right-auto desk:h-auto desk:w-(--rail) desk:flex-col desk:overflow-x-hidden desk:overflow-y-auto desk:border-r desk:border-t-0 desk:pb-4 desk:pt-5',
        'rail-anim:transition-[width] rail-anim:duration-150 rail-anim:ease-[ease]',
      )}
    >
      <RailBrand expanded={railExpanded} onToggle={onToggleRail} />
      <div className="flex flex-1 desk:my-auto desk:flex-none desk:flex-col desk:gap-1 desk:px-[10px] desk:rail-exp:px-3">
        {PRIMARY_NAV_ITEMS.map((item) => (
          <PrimaryNavLink key={item.label} item={item} pathname={pathname} />
        ))}
      </div>
      {showMiniPlayer ? <MiniPlayer session={activeSession} /> : null}
      <div className="hidden border-t border-line px-[10px] pt-3 desk:block desk:shrink-0 desk:rail-exp:px-3">
        <OfflineBadge variant="rail" />
        <HeadroomLink headroom={headroom} href={headroomHref} />
        <div className="mt-1">
          <AccountMenu
            listener={listener}
            mode={themeMode}
            onToggleMode={onToggleThemeMode}
            expandedRail
          />
        </div>
      </div>
    </nav>
  );
}

function RailBrand({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <div className="hidden items-center justify-center px-[10px] pb-6 desk:flex desk:shrink-0 rail-exp:justify-start rail-exp:px-3">
      <button
        type="button"
        onClick={onToggle}
        aria-controls="primary-navigation"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse the Sidebar' : 'Expand the Sidebar'}
        className="group grid h-10 w-10 flex-none place-items-center rounded-[11px] [-webkit-tap-highlight-color:transparent] hover:bg-[var(--control-bg-hover)]"
      >
        <LiedmotifMark className="h-[22px] w-[22px] group-hover:hidden group-focus-visible:hidden rail-exp:group-hover:block rail-exp:group-focus-visible:block" />
        <PanelLeftOpen className="hidden h-[19px] w-[19px] text-muted group-hover:block group-focus-visible:block rail-exp:group-hover:hidden rail-exp:group-focus-visible:hidden" />
      </button>
      <LiedmotifWordmark className="hidden text-[22px] rail-exp:inline" />
      <button
        type="button"
        onClick={onToggle}
        aria-controls="primary-navigation"
        aria-expanded={expanded}
        aria-label="Collapse the Sidebar"
        className="ml-auto hidden h-[34px] w-[34px] place-items-center rounded-[10px] text-dim hover:bg-[var(--control-bg-hover)] hover:text-paper rail-exp:grid"
      >
        <PanelLeftClose className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}

function PrimaryNavLink({ item, pathname }: { item: PrimaryNavItem; pathname: string }) {
  const Icon = NAV_ICONS[item.icon];
  const active = item.href === getPrimaryNavDestination(pathname);
  const className = cn(
    'relative flex flex-1 flex-col items-center justify-center gap-[3px] text-[10.5px] font-semibold tracking-[0.02em] [-webkit-tap-highlight-color:transparent]',
    'desk:flex-none desk:rounded-xl desk:py-4 desk:rail-exp:flex-row desk:rail-exp:justify-start desk:rail-exp:gap-3 desk:rail-exp:px-3 desk:rail-exp:py-3 desk:rail-exp:text-[14px] desk:rail-exp:tracking-normal',
    active
      ? 'text-lamp desk:bg-lamp/[0.07] light:desk:bg-lamp-fill/[0.13] desk:before:absolute desk:before:left-[-10px] desk:before:top-1/2 desk:before:h-5 desk:before:w-[3px] desk:before:-translate-y-1/2 desk:before:rounded-r-[3px] desk:before:bg-lamp desk:before:shadow-[0_0_10px_var(--lamp-glow)] desk:rail-exp:before:left-[-12px]'
      : 'text-dim hover:text-muted desk:hover:bg-[var(--control-bg)] light:desk:hover:bg-[var(--control-bg-hover)]',
  );
  const content = (
    <>
      <Icon
        className={cn(
          'h-[21px] w-[21px] desk:rail-exp:h-[19px] desk:rail-exp:w-[19px]',
          active && 'drop-shadow-[0_0_6px_var(--lamp-glow)]',
        )}
      />
      {item.label}
    </>
  );

  return (
    <Link href={item.href} aria-current={active ? 'page' : undefined} className={className}>
      {content}
    </Link>
  );
}

export function HeadroomLink({
  headroom,
  href,
  compact = false,
}: {
  headroom: GenerationHeadroom | null;
  /** Where the viewer's own limits live: cost controls or a Member's budget. */
  href: string;
  compact?: boolean;
}) {
  const online = useOnline();
  // The usage read streams in after the shell paints; until it resolves there
  // is no number to show, and an empty chip would just flash placeholder text.
  // Offline nothing can be generated, and the Offline badge takes this place.
  if (!headroom || !online) return null;
  const Icon = headroom.critical ? AlertCircle : Zap;
  // The figure is whichever window binds, so the readout names that window: a
  // month-bound number is not what is left today, and a One-time total is left
  // for good.
  const unitLine = `${trackNoun(headroom.remainingTracks)} left${HEADROOM_PERIOD[headroom.window]}`;
  const label = `Generation headroom: ${headroomLine(headroom)}`;

  if (compact) {
    return (
      <Link
        href={href}
        aria-label={label}
        title="Generation headroom — counted in tracks"
        className={cn(
          'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border bg-[var(--control-bg)] px-3 py-1 font-mono text-[11px] tracking-[0.05em] text-muted',
          headroom.critical ? 'border-warn/50' : 'border-line',
        )}
      >
        <Icon className={cn('h-[13px] w-[13px]', headroom.critical && 'text-warn')} />
        <b className={cn('font-bold', headroom.critical ? 'text-warn' : 'text-paper')}>
          {headroom.remainingTracks}
        </b>
        {unitLine}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      aria-label={label}
      title="Generation headroom — counted in tracks"
      className="block rounded-xl px-2 pb-3 pt-2 hover:bg-[var(--control-bg)] light:hover:bg-[var(--control-bg-hover)]"
    >
      <div
        className={cn(
          'flex items-center justify-center gap-2 whitespace-nowrap font-mono text-[10.5px] uppercase tracking-[0.08em] rail-exp:justify-start',
          headroom.critical ? 'text-warn' : 'text-muted',
        )}
      >
        <Icon className="h-[13px] w-[13px] flex-none" />
        <b className={cn('font-bold', headroom.critical ? 'text-warn' : 'text-paper')}>
          {headroom.remainingTracks}
        </b>
        <span className="hidden rail-exp:inline">{unitLine}</span>
      </div>
      <Meter
        label={label}
        value={headroom.remainingRatio * 100}
        className={cn(
          'mt-2 h-1',
          headroom.critical &&
            '[--gradient-meter:var(--gradient-warning-meter)] [--shadow-meter:var(--shadow-warning-meter)]',
        )}
      />
    </Link>
  );
}

/** How often the mini progress strip samples the truthful playback clock —
 * a 2px strip needs far less than the full player's 250 ms. */
const MINI_PROGRESS_POLL_MS = 1000;

/** The one mini-player shell (draft `.mini`): a floating bar above the tab
 * bar on mobile, docked into the sidebar rail at `desk`.
 *
 * The bar is centred on the shell's own content column (`--shell-col`), so on a
 * wide phone or a tablet it stays as wide as the page it belongs to; the 8px
 * insets are the floor below that width. At `desk` the rail (208px expanded at
 * most) owns the width and the cap never binds. */
const miniShellClass =
  'fixed bottom-[calc(var(--tab-h)+env(safe-area-inset-bottom,0px)+8px)] left-2 right-2 z-41 mx-auto grid h-(--mini-h) max-w-(--shell-col) grid-cols-[42px_1fr_auto] items-center gap-3 overflow-hidden rounded-[14px] border border-line-2 [background:var(--gradient-mini)] px-2 shadow-[var(--shadow-mini)] desk:mx-[10px] desk:mb-3 desk:h-auto desk:shrink-0 desk:grid-cols-[1fr] desk:gap-0 desk:rounded-none desk:border-0 desk:bg-none desk:p-0 desk:pt-3 desk:shadow-none desk:rail-exp:mx-3 desk:rail-exp:mb-0 desk:rail-exp:grid-rows-[auto_minmax(0,1fr)_30px] desk:rail-exp:gap-2 desk:rail-exp:pb-2 desk:rail-exp:rail-short:grid-cols-[42px_minmax(0,1fr)] desk:rail-exp:rail-short:grid-rows-[42px_30px] desk:rail-exp:rail-short:gap-x-3';

/** The trailing controls slot: under the cover in the expanded rail, and on a
 * row of its own below the thumbnail and title when the rail is too short. */
const miniTrailingClass = 'desk:justify-self-center desk:rail-exp:rail-short:col-span-2';

/** The shell override for a bar that carries transport controls: at `desk` it
 * sits in the rail's flow and reserves the 40px control row under the cover. */
const miniControlShellClass =
  'desk:relative desk:bottom-auto desk:left-auto desk:right-auto desk:grid-rows-[auto_40px]';

const miniMainClass =
  'min-w-0 desk:hidden desk:rail-exp:block desk:rail-exp:w-full desk:rail-exp:px-3 desk:rail-exp:text-center desk:rail-exp:rail-short:px-0 desk:rail-exp:rail-short:text-left';

const miniTitleClass =
  'block overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold';

const miniSubtitleClass =
  'mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.06em] text-dim';

function MiniPlayerCover({ coverImageId }: { coverImageId: string | null }) {
  return (
    // In the rail the cover gives up height first when the window is short:
    // down to 80% (the rest of the rail is ~608px collapsed, ~516px expanded),
    // then a thumbnail (see `rail-short`).
    <span className="relative grid h-[42px] w-[42px] place-items-center overflow-hidden rounded-[8px] bg-panel-2 text-lamp desk:h-auto desk:w-[clamp(80%,calc(100dvh-608px),100%)] desk:aspect-square desk:justify-self-center desk:rounded-none desk:rail-exp:w-[clamp(80%,calc(100dvh-516px),100%)] desk:rail-short:h-[42px] desk:rail-short:w-[42px] desk:rail-short:rounded-[8px]">
      <CoverArt
        coverImageId={coverImageId}
        className="h-full w-full object-cover"
        fallback={<AudioWaveform className="h-5 w-5 desk:h-7 desk:w-7" />}
      />
    </span>
  );
}

type MiniOfflineMark = { kind: OfflineMarkKind; id: string };

function liveOfflineMark({ source, session }: LivePlayback): MiniOfflineMark | null {
  if (source.kind === 'playlist') return { kind: 'playlist', id: source.playlist.id };
  return session ? { kind: 'session', id: session.id } : null;
}

/** The title, then on the phone the Available-offline icon, which stays in view
 * while a long title truncates. The rail has no room for it beside the title. */
function MiniTitleWithOfflineMark({
  mark,
  children,
}: {
  mark: MiniOfflineMark | null;
  children: ReactNode;
}) {
  return (
    <span className="flex items-center desk:block">
      <span className={cn(miniTitleClass, 'min-w-0')}>{children}</span>
      {mark ? <OfflineMark {...mark} className="ml-1.5 desk:hidden" /> : null}
    </span>
  );
}

function MiniPlayer({ session }: { session: SessionSummary | null }) {
  const preview = useTrackPreviewAnnouncement();
  const { playback } = usePlayerContext();
  // A running track preview is the most recent listening intent, so its
  // mirror outranks the engaged source until the preview ends or its page is
  // left — then the bar falls back to the transport.
  if (preview) return <PreviewMiniPlayer preview={preview} />;
  if (playback) return <LiveMiniPlayer playback={playback} />;
  return session ? <SessionLinkMiniPlayer session={session} /> : null;
}

/** The mini player while a page-local track preview plays (Library, search):
 * a mirror of the bare preview <audio>, never the transport — one pause/resume
 * control, no prev/skip, no Now Playing link (the preview lives on its page). */
function PreviewMiniPlayer({ preview }: { preview: TrackPreviewAnnouncement }) {
  const PlayIcon = preview.playing ? Pause : Play;
  const title = preview.title ?? 'Untitled Track';
  return (
    <div className={cn(miniShellClass, miniControlShellClass)}>
      <MiniPlayerCover coverImageId={preview.coverImageId} />
      <span className={miniMainClass}>
        <span className={miniTitleClass}>{title}</span>
        <span className={miniSubtitleClass}>
          {preview.artist ? `${preview.artist} · ` : ''}Track preview
        </span>
      </span>
      <span className={cn('flex items-center', miniTrailingClass)}>
        <MiniControl
          label={`${preview.playing ? 'Pause' : 'Resume'} Preview of ${title}`}
          onPress={preview.toggle}
        >
          <PlayIcon className="h-5 w-5 desk:h-[18px] desk:w-[18px]" />
        </MiniControl>
      </span>
    </div>
  );
}

/** The mini player while the cross-route controller is live: the audible
 * track, working transport controls, and the playback progress strip. The
 * whole bar links to Now Playing; the controls act without navigating. */
function LiveMiniPlayer({ playback }: { playback: LivePlayback }) {
  const { session, player, source } = playback;
  const { vibeChange } = usePlayerContext();
  const track = player.currentTrack;
  const { title, subtitle } = presentMiniPlayer({
    sourceTitle: source.kind === 'playlist' ? source.playlist.name : (session?.title ?? null),
    sourceNoun: source.kind === 'playlist' ? 'Playlist' : 'Session',
    track,
    pendingTrackTitle: player.pendingGeneration?.trackTitle ?? null,
    sectionLooping: sectionLoopLive(player.sectionLoopTool),
  });
  // The provider-scoped Change Vibe request narrates here too — the one player
  // surface that exists on every route, so leaving /player never hides an
  // in-flight change or swallows its failure.
  const vibeNote = presentMiniVibeChange(vibeChange, session?.id ?? null);
  const coverId = resolveCoverImageId(player, session);
  const isPlaying = player.status === 'playing';
  const hasTrack = track != null;
  const progress = usePlaybackProgress({
    getPlaybackSample: player.getPlaybackSample,
    queueItemId: track?.queueItemId ?? null,
    pollMs: MINI_PROGRESS_POLL_MS,
    knownDurationSeconds: track?.durationSeconds ?? null,
  });
  const PlayIcon = isPlaying ? Pause : Play;

  return (
    <Link
      href="/player"
      aria-label={`Open Now Playing for ${title}`}
      className={cn(miniShellClass, miniControlShellClass)}
    >
      <MiniPlayerCover coverImageId={coverId} />
      <span className={miniMainClass}>
        <MiniTitleWithOfflineMark mark={liveOfflineMark(playback)}>
          <ScrambleText text={title} />
        </MiniTitleWithOfflineMark>
        <span
          data-testid="mini-vibe-note"
          data-tone={vibeNote?.tone}
          className={cn(miniSubtitleClass, vibeNote?.tone === 'error' && 'text-warn')}
        >
          {vibeNote?.text ?? subtitle}
        </span>
      </span>
      <span className={cn('flex items-center', miniTrailingClass)}>
        <MiniControl label="Previous" disabled={!hasTrack} onPress={player.back}>
          <SkipBack className="h-[18px] w-[18px] desk:h-4 desk:w-4" />
        </MiniControl>
        <MiniControl label={isPlaying ? 'Pause' : 'Play'} onPress={player.toggle}>
          <PlayIcon className="h-5 w-5 desk:h-[18px] desk:w-[18px]" />
        </MiniControl>
        <MiniControl label="Skip" disabled={!hasTrack} onPress={player.skip}>
          <SkipForward className="h-[18px] w-[18px] desk:h-4 desk:w-4" />
        </MiniControl>
        <PlaybackModeControl
          mode={player.playbackMode}
          onCycle={player.cyclePlaybackMode}
          variant="mini"
        />
      </span>
      <span
        aria-hidden
        data-testid="mini-progress"
        className="absolute bottom-0 left-0 h-[2px] bg-lamp shadow-[0_0_8px_var(--lamp)]"
        style={{ width: `${progress}%` }}
      />
    </Link>
  );
}

function MiniControl({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent) => {
    // The bar itself is a link to /player; a control acts without navigating.
    event.preventDefault();
    event.stopPropagation();
    onPress();
  };
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-xl text-muted [-webkit-tap-highlight-color:transparent] hover:bg-[var(--control-bg-hover)] hover:text-paper disabled:opacity-35 desk:h-[26px] desk:w-6 desk:rail-exp:h-[30px] desk:rail-exp:w-[30px]"
    >
      {children}
    </button>
  );
}

/** The mini player for a server-known active Session with no live controller
 * in this tab (a fresh page load): the bar opens Now Playing, and its Play
 * starts the Session right here, after which the live bar takes over. */
function SessionLinkMiniPlayer({ session }: { session: SessionSummary }) {
  const { engage, beginOtherMusic } = usePlayerContext();
  const title = session.title || 'Untitled Session';
  return (
    <Link
      href="/player"
      aria-label={`Open Now Playing for ${title}`}
      className={cn(miniShellClass, miniControlShellClass)}
    >
      <MiniPlayerCover coverImageId={session.coverImageId} />
      <span className={miniMainClass}>
        <MiniTitleWithOfflineMark mark={{ kind: 'session', id: session.id }}>
          {title}
        </MiniTitleWithOfflineMark>
        <span className={miniSubtitleClass}>Session</span>
      </span>
      <span className={cn('flex items-center', miniTrailingClass)}>
        <MiniControl
          label={`Play ${title}`}
          onPress={() => {
            void beginOtherMusic().then((go) => {
              if (go) engage(session, { autoplay: true });
            });
          }}
        >
          <Play className="h-5 w-5 desk:h-[18px] desk:w-[18px]" />
        </MiniControl>
      </span>
    </Link>
  );
}
