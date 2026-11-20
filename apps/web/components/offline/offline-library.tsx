'use client';

// The Offline Library: the page Liedmotif opens to when there is no connection
// (the service worker falls back to it). It lists this device's offline
// Playlists and Sessions and plays them in the normal Player from the device's
// offline store. It is static and client-only — no sign-in, no server data —
// and has no online action at all. Its one request is the online state's
// probe, and only while the browser reports a network: is the server back?

import { useEffect, useState } from 'react';
import { Disc3, ListMusic, Play } from 'lucide-react';
import { CoverArt } from '@/components/player/cover-art';
import { PlayerProvider, usePlayerContext } from '@/components/player/player-provider';
import { TrackMediaProvider, type TrackMedia } from '@/components/player/track-media';
import { OfflineBadge } from '@/components/offline-badge';
import {
  cardShellClass,
  displayHeadingClass,
  eyebrowClass,
  LiedmotifRoundMark,
  sectionHeadingClass,
} from '@/components/ui/design-system';
import { cn } from '@/lib/cn';
import { openIndexedDbBacking } from '@/lib/offline/indexeddb-backing';
import { offlineSupported } from '@/lib/offline/offline-support';
import {
  createOfflineStore,
  type OfflineMark,
  type OfflineTrackCopy,
} from '@/lib/offline/offline-store';
import { reportServerUnreachable, useOnline } from '@/lib/online-state';
import {
  offlineCollectionNoun,
  offlineCollections,
  offlineCopyExpired,
  offlinePlayableTracks,
  offlineTrackMedia,
  type OfflineCollection,
} from './offline-library-model';
import { OfflineNowPlaying } from './offline-now-playing';

type Library =
  | { phase: 'loading' }
  /** No offline store in this browser (plain HTTP, or no IndexedDB). */
  | { phase: 'unavailable' }
  | {
      phase: 'ready';
      marks: OfflineMark[];
      copies: OfflineTrackCopy[];
      lastSyncedAt: number | null;
      media: TrackMedia;
      audioUrls: ReadonlyMap<string, string>;
    };

type ReadyLibrary = Extract<Library, { phase: 'ready' }>;

/** Before the store is read the Player still shows nothing from the server. */
const NO_MEDIA = offlineTrackMedia([], new Map());

/**
 * Reads the store once per page. Every Track's audio and cover get an object
 * URL up front, so a tap engages playback synchronously, inside its gesture.
 * The URLs live as long as the page: the decks and the lock screen may hold
 * any of them at any time.
 */
async function readLibrary(): Promise<Library> {
  if (!offlineSupported()) return { phase: 'unavailable' };
  const store = createOfflineStore(await openIndexedDbBacking());
  const [marks, copies, lastSyncedAt] = await Promise.all([
    store.marks(),
    store.list(),
    store.lastSyncedAt(),
  ]);
  const audioUrls = new Map<string, string>();
  const coverUrls = new Map<string, string>();
  await Promise.all(
    copies.map(async ({ trackId, track, coverBytes }) => {
      const audio = await store.getObjectUrl(trackId, 'audio');
      if (audio) audioUrls.set(trackId, audio);
      const coverId = track.coverImageId;
      if (!coverId || coverBytes === 0 || coverUrls.has(coverId)) return;
      const cover = await store.getObjectUrl(trackId, 'cover');
      if (cover && !coverUrls.has(coverId)) coverUrls.set(coverId, cover);
    }),
  );
  return {
    phase: 'ready',
    marks,
    copies,
    lastSyncedAt,
    media: offlineTrackMedia(copies, coverUrls),
    audioUrls,
  };
}

let reading: Promise<Library> | null = null;

function useLibrary(): Library {
  const [library, setLibrary] = useState<Library>({ phase: 'loading' });
  useEffect(() => {
    let cancelled = false;
    reading ??= readLibrary().catch((): Library => ({ phase: 'unavailable' }));
    void reading.then((read) => {
      if (!cancelled) setLibrary(read);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return library;
}

export function OfflineLibrary() {
  const library = useLibrary();
  // The service worker shows this page when a navigation failed, which a
  // device with a network but no reachable server does too: the server counts
  // as unreachable until the online state's probe hears it answer.
  useEffect(() => reportServerUnreachable(), []);
  return (
    <TrackMediaProvider media={library.phase === 'ready' ? library.media : NO_MEDIA}>
      <PlayerProvider>
        <main className="mx-auto max-w-(--shell-col) px-4 pb-12 pt-4 desk:max-w-[1120px] desk:px-10 desk:pt-6">
          <OfflineLibraryView library={library} />
        </main>
      </PlayerProvider>
    </TrackMediaProvider>
  );
}

function OfflineLibraryView({ library }: { library: Library }) {
  const { playback, engageOffline } = usePlayerContext();
  const [showPlayer, setShowPlayer] = useState(false);
  // The page can stay open past a Lounge copy's expiry (a Home Screen app
  // resumed days later), so expiry is judged again whenever it returns to the
  // foreground and on every tap. A Track already playing may finish.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const onForeground = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onForeground);
    return () => document.removeEventListener('visibilitychange', onForeground);
  }, []);
  const playing = playback?.source.kind === 'offline' ? playback.source : null;
  const collections =
    library.phase === 'ready'
      ? offlineCollections(library.marks, library.copies, library.lastSyncedAt, now)
      : [];

  if (showPlayer && playback && playing) {
    const collection = collections.find((entry) => entry.key === playing.key);
    return (
      <div className="@container">
        <OfflineNowPlaying
          playback={playback}
          name={playing.name}
          noun={collection ? offlineCollectionNoun(collection) : 'Playlist'}
          onBack={() => setShowPlayer(false)}
        />
      </div>
    );
  }

  /** A tap on what is already playing only brings its player back. */
  function open(collection: OfflineCollection, { copies, lastSyncedAt, audioUrls }: ReadyLibrary) {
    const at = Date.now();
    setNow(at);
    if (collection.key !== playing?.key) {
      const expired = offlineCopyExpired(copies, lastSyncedAt, Date.now);
      const tracks = collection.tracks.filter((copy) => !expired(copy.trackId));
      if (tracks.length === 0) return;
      engageOffline({
        key: collection.key,
        name: collection.name,
        tracks: offlinePlayableTracks(tracks, (id) => audioUrls.get(id) ?? null),
        startTrackId: null,
        expired,
      });
    }
    setShowPlayer(true);
  }

  if (library.phase === 'loading') return <LibraryHeader />;
  if (library.phase === 'unavailable' || collections.length === 0) {
    return (
      <>
        <LibraryHeader />
        <div className="mt-6 rounded-card border border-dashed border-line-2 px-4 py-10 text-center">
          <p className="font-display text-[17px] font-bold">Nothing on This Device Yet</p>
          <p className="mt-2 text-[13.5px] text-muted">
            {library.phase === 'unavailable'
              ? 'This browser can’t keep music on this device.'
              : 'While you’re online, turn on Available Offline for a playlist or session. It plays here without a connection.'}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <LibraryHeader />
      {(['Playlist', 'Session'] as const).map((noun) => {
        const ofNoun = collections.filter((entry) => offlineCollectionNoun(entry) === noun);
        if (ofNoun.length === 0) return null;
        return (
          <section key={noun} className="mt-6">
            <h2 className={sectionHeadingClass}>{noun}s</h2>
            <ul className="mt-3 space-y-2" aria-label={`Offline ${noun}s`}>
              {ofNoun.map((collection) => (
                <li key={collection.key}>
                  <CollectionRow
                    collection={collection}
                    playing={collection.key === playing?.key}
                    onOpen={() => open(collection, library)}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function LibraryHeader() {
  const online = useOnline();
  return (
    <>
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <LiedmotifRoundMark />
          <span className="truncate font-display text-[17.5px] font-bold tracking-[-0.015em]">
            Liedmotif
          </span>
        </div>
        <OfflineBadge />
      </header>
      <div className="mt-8">
        <p className={eyebrowClass}>On This Device</p>
        <h1 className={cn(displayHeadingClass, 'mt-2')}>Offline Library</h1>
        <p className="mt-2 text-[13.5px] text-muted">
          {online ? (
            <>
              You’re back online. {/* A full page load: the app pages render on the server. */}
              <a href="/" className="font-semibold text-lamp underline-offset-2 hover:underline">
                Open Liedmotif
              </a>
            </>
          ) : (
            'No connection. Your offline playlists and sessions play from this device.'
          )}
        </p>
      </div>
    </>
  );
}

function countLine({ tracks, expiredCount }: OfflineCollection): string {
  const parts = [
    ...(tracks.length > 0 ? [`${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`] : []),
    ...(expiredCount > 0 ? [`${expiredCount} expired`] : []),
  ];
  return parts.length > 0 ? parts.join(' · ') : 'Not on this device yet';
}

function CollectionRow({
  collection,
  playing,
  onOpen,
}: {
  collection: OfflineCollection;
  playing: boolean;
  onOpen: () => void;
}) {
  const count = collection.tracks.length;
  return (
    <button
      type="button"
      data-testid="offline-collection"
      disabled={count === 0}
      onClick={onOpen}
      className={cn(
        cardShellClass,
        'grid w-full grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 p-3 text-left hover:bg-[var(--control-bg-hover)] active:scale-[0.995] disabled:opacity-50',
      )}
    >
      <span className="grid h-14 w-14 place-items-center overflow-hidden rounded-[10px] bg-panel-2">
        <CoverArt
          coverImageId={collection.tracks[0]?.track.coverImageId ?? null}
          thumb
          className="h-full w-full object-cover"
          fallback={
            offlineCollectionNoun(collection) === 'Session' ? (
              <Disc3 className="h-6 w-6 text-dim" aria-hidden />
            ) : (
              <ListMusic className="h-6 w-6 text-dim" aria-hidden />
            )
          }
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-semibold">{collection.name}</span>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-dim">
          {countLine(collection)}
        </span>
        {collection.expiredCount > 0 ? (
          <span
            data-testid="offline-collection-expired"
            className="block text-[11.5px] leading-[1.35] text-muted"
          >
            Go online to refresh
          </span>
        ) : null}
      </span>
      {playing ? (
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-lamp">
          Playing
        </span>
      ) : (
        <Play className="h-5 w-5 fill-current text-muted" aria-hidden />
      )}
    </button>
  );
}
