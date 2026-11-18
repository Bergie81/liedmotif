import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Request } from '@playwright/test';

// The offline store on real browser storage: a Track one page load stores, the
// next load lists and plays from an object URL under the app's CSP, and a wipe
// leaves nothing behind. The store's logic is unit-tested over a fake backing;
// this proves the IndexedDB backing under it keeps audio Blobs across loads.
//
// Online, the Player plays a Track the device stores from the device: no
// request reaches the audio route for it.
//
// Then the Offline Library end to end: with the network cut, opening the app
// lands on it through the service worker, and an offline Playlist plays in the
// Player from the device without a single request. An offline Session is
// listed apart and plays its Tracks in its own order. A Lounge Track whose
// week since the last sync runs out mid-play never starts from its stored
// audio, and the player says why.

const FIXTURE_DIR = fileURLToPath(new URL('../../../worker/src/audio/fixtures', import.meta.url));
const FIXTURE_URL = '/harness-fixtures/offline-track.mp3';

async function harnessReady(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/dev/offline-store-harness');
  await expect(page.getByTestId('harness-ready')).toHaveText('ready');
}

test('the offline store keeps a Track across page loads, plays it back, and wipes it', async ({
  page,
}) => {
  const mp3 = readFileSync(join(FIXTURE_DIR, 'decode-parity-marker.mp3'));
  await page.route(`**${FIXTURE_URL}`, (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: mp3 }),
  );

  await harnessReady(page);
  await page.evaluate(async (fixtureUrl) => {
    const store = await window.__liedmotifOfflineStoreHarness!.openStore();
    await store.wipe();
    await store.claim('user-a');
    await store.put({
      trackId: 't1',
      version: 'v1',
      track: {
        trackId: 't1',
        byteSize: null,
        version: 'v1',
        title: 'Harness Track',
        artist: null,
        originSessionTitle: null,
        durationSeconds: null,
        coverImageId: null,
        genreTags: [],
        vocalMode: 'instrumental',
        hasLyrics: false,
        fromLounge: false,
      },
      details: { title: 'Harness Track' } as never,
      lyrics: null,
      audio: await (await fetch(fixtureUrl)).blob(),
      cover: null,
    });
    await store.putMark({
      key: 'playlist:p1',
      kind: 'playlist',
      id: 'p1',
      markedAt: 1,
      syncedAt: 2,
      manifest: {
        name: 'Harness Playlist',
        tracks: (await store.list()).map((copy) => copy.track),
        leftOutTrackCount: 0,
      },
    });
  }, FIXTURE_URL);

  await harnessReady(page);
  const afterReload = await page.evaluate(async () => {
    const store = await window.__liedmotifOfflineStoreHarness!.openStore();
    const url = await store.getObjectUrl('t1', 'audio');
    const durationSeconds = await new Promise<number | string>((resolve) => {
      const audio = new Audio();
      audio.onloadedmetadata = () => resolve(audio.duration);
      audio.onerror = () => resolve(`media error ${audio.error?.code ?? '?'}`);
      audio.src = url ?? '';
    });
    if (url) URL.revokeObjectURL(url);
    return {
      titles: (await store.list()).map((copy) => copy.track.title),
      marks: (await store.marks()).map((mark) => mark.manifest.name),
      usage: await store.usage(),
      durationSeconds,
    };
  });
  expect(afterReload.titles).toEqual(['Harness Track']);
  expect(afterReload.marks).toEqual(['Harness Playlist']);
  expect(afterReload.usage).toBe(mp3.byteLength);
  expect(afterReload.durationSeconds).toEqual(expect.any(Number));
  expect(afterReload.durationSeconds as number).toBeGreaterThan(0);

  const afterWipe = await page.evaluate(async () => {
    const store = await window.__liedmotifOfflineStoreHarness!.openStore();
    await store.wipe();
    return {
      tracks: (await store.list()).length,
      marks: (await store.marks()).length,
      usage: await store.usage(),
      audio: await store.getObjectUrl('t1', 'audio'),
    };
  });
  expect(afterWipe).toEqual({ tracks: 0, marks: 0, usage: 0, audio: null });
});

test('online, the Player plays a Track the device stores instead of streaming it', async ({
  page,
}) => {
  // The harness has no account or server data, so the Player's own API reads
  // (playback settings, listening) are answered here; one for the audio route
  // would be the stream.
  const audioRequests: string[] = [];
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (new URL(url).pathname.startsWith('/api/audio/')) audioRequests.push(url);
    return route.fulfill({ status: 404 });
  });

  await harnessReady(page);
  await page.evaluate(async () => {
    // Thirty seconds of silence: still playing while it is checked.
    const rate = 8000;
    const samples = rate * 30;
    const view = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (at: number, value: string) =>
      [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples * 2, true);
    const audio = new Blob([view.buffer], { type: 'audio/wav' });

    const harness = window.__liedmotifOfflineStoreHarness!;
    const store = await harness.openStore();
    await store.wipe();
    await store.claim('user-a');
    await store.put({
      trackId: 't1',
      version: 'v1',
      track: {
        trackId: 't1',
        byteSize: audio.size,
        version: 'v1',
        title: 'Harness Track',
        artist: null,
        originSessionTitle: null,
        durationSeconds: 30,
        coverImageId: null,
        genreTags: [],
        vocalMode: 'instrumental',
        hasLyrics: false,
        fromLounge: false,
      },
      details: { title: 'Harness Track' } as never,
      lyrics: null,
      audio,
      cover: null,
    });
    await harness.openDeviceStore();
  });
  await page.waitForFunction(
    () => window.__liedmotifOfflineStoreHarness?.storedTrackAudio('t1') != null,
  );

  await page.getByTestId('harness-play-online').click();
  await expect(page.getByTestId('deck-a')).toHaveAttribute('src', /^blob:/);
  await page.waitForFunction(() => {
    const deck = document.querySelector<HTMLAudioElement>('[data-testid="deck-a"]');
    return deck != null && !deck.paused && deck.currentTime > 0.5;
  });
  expect(audioRequests).toEqual([]);
});

const DETAILS = {
  title: 'Harness Track',
  sessionTitle: 'Harness Session',
  artistName: 'Harness Artist',
  createdAt: '2026-11-01T10:00:00.000Z',
  durationSeconds: 30,
  userPrompt: 'night drive',
  stylePrompt: 'synthwave, 100 bpm',
  expandedPrompt: null,
  genreTags: ['synthwave'],
  activity: null,
  mood: null,
  energy: null,
  vocalMode: 'vocal',
  language: 'English',
  bpm: 100,
  providerKey: 'suno',
  providerModel: null,
  licenseNote: null,
};

test('without a connection the app opens the Offline Library and plays an offline Playlist from the device', async ({
  context,
  page,
}) => {
  await harnessReady(page);
  await page.evaluate(async (details) => {
    // Long enough that the first Track is still playing while it is checked.
    const tone = (seconds: number) => {
      const rate = 8000;
      const samples = rate * seconds;
      const view = new DataView(new ArrayBuffer(44 + samples * 2));
      const text = (at: number, value: string) =>
        [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
      text(0, 'RIFF');
      view.setUint32(4, 36 + samples * 2, true);
      text(8, 'WAVEfmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, 'data');
      view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i / 8) * 3000, true);
      return new Blob([view.buffer], { type: 'audio/wav' });
    };
    const harness = window.__liedmotifOfflineStoreHarness!;
    const store = await harness.openStore();
    await store.wipe();
    await store.claim('user-a');
    const audio = tone(30);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const cover = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
    const entry = (trackId: string, title: string, vocal: boolean, fromLounge: boolean) => ({
      trackId,
      byteSize: audio.size,
      version: 'v1',
      title,
      artist: null,
      originSessionTitle: 'Harness Session',
      durationSeconds: 30,
      coverImageId: `cover-${trackId}`,
      genreTags: ['synthwave'],
      vocalMode: vocal ? ('vocal' as const) : ('instrumental' as const),
      hasLyrics: vocal,
      fromLounge,
    });
    const first = entry('t1', 'Harness Track', true, false);
    // A Shared reference: another owner's Track, playable while a recent sync
    // confirmed it is still Lounge-audible.
    const second = entry('t2', 'Second Track', false, true);
    await store.put({
      trackId: 't1',
      version: 'v1',
      track: first,
      details: details as never,
      lyrics: {
        state: 'ready',
        lines: [{ kind: 'line', text: 'Headlights on the empty road', timeSeconds: 0 }],
        synced: true,
        settled: true,
      },
      audio,
      cover,
    });
    await store.put({
      trackId: 't2',
      version: 'v1',
      track: second,
      details: { ...details, title: 'Second Track', vocalMode: 'instrumental' } as never,
      lyrics: null,
      audio,
      cover,
    });
    await store.putMark({
      key: 'playlist:p1',
      kind: 'playlist',
      id: 'p1',
      markedAt: 1,
      syncedAt: 2,
      manifest: { name: 'Harness Playlist', tracks: [first, second], leftOutTrackCount: 0 },
    });
    await store.putLastSyncedAt(Date.now());
    const sessionTrack = entry('t3', 'Session Track', false, false);
    await store.put({
      trackId: 't3',
      version: 'v1',
      track: sessionTrack,
      details: { ...details, title: 'Session Track', vocalMode: 'instrumental' } as never,
      lyrics: null,
      audio,
      cover,
    });
    await store.putMark({
      key: 'session:s1',
      kind: 'session',
      id: 's1',
      markedAt: 3,
      syncedAt: 4,
      manifest: { name: 'Harness Session', tracks: [sessionTrack, first], leftOutTrackCount: 0 },
    });
    await harness.readyOfflineLibrary();
    await navigator.serviceWorker.ready;
  }, DETAILS);

  await context.setOffline(true);
  // An app page while offline: the navigation fails and the service worker
  // answers with the cached Offline Library.
  await page.goto('/library');
  const row = page
    .getByRole('list', { name: 'Offline Playlists' })
    .getByTestId('offline-collection');
  await expect(row).toContainText('Harness Playlist');
  await expect(row).toContainText('2 Tracks');

  // Everything playback asks for must be answered on the device: object URLs,
  // or the service worker's cached copy — never a request that leaves it.
  const requests: Request[] = [];
  context.on('request', (request) => {
    if (!request.url().startsWith('blob:')) requests.push(request);
  });
  const leftTheDevice = async () => {
    const left: string[] = [];
    for (const request of requests) {
      const response = await request.response();
      if (request.serviceWorker() || !response?.fromServiceWorker()) left.push(request.url());
    }
    return left;
  };

  await row.click();
  const nowPlaying = page.getByTestId('now-playing');
  await expect(nowPlaying).toHaveAttribute('data-player-status', 'playing');
  await expect(page.getByTestId('track-title')).toContainText('Harness Track');
  // The stored cover, as an object URL.
  await expect(nowPlaying.locator('img').first()).toHaveAttribute('src', /^blob:/);
  const lockScreen = await page.evaluate(() => ({
    title: navigator.mediaSession.metadata?.title,
    artwork: navigator.mediaSession.metadata?.artwork.map((image) => image.src),
    state: navigator.mediaSession.playbackState,
  }));
  expect(lockScreen).toEqual({
    title: 'Harness Track',
    artwork: [expect.stringMatching(/^blob:/)],
    state: 'playing',
  });

  // Lyrics and Track Data come from the device.
  const options = page.getByRole('button', { name: 'Playlist and Track options' }).last();
  await options.click();
  await page.getByTestId('player-open-track-data').click();
  await expect(page.getByText('night drive')).toBeVisible();
  await page.keyboard.press('Escape');
  await options.click();
  await page.getByTestId('player-open-lyrics').click();
  await expect(page.getByText('Headlights on the empty road').last()).toBeVisible();
  await page.keyboard.press('Escape');

  // Seek, then skip on to the next Track.
  const seek = page.getByRole('slider', { name: 'Seek' });
  await seek.press('ArrowRight');
  await seek.press('ArrowRight');
  await expect(page.getByTestId('progress-elapsed')).toHaveText(/^0:1\d$/);
  await page.getByTestId('player-skip').click();
  await expect(page.getByTestId('track-title')).toContainText('Second Track');
  await expect(nowPlaying).toHaveAttribute('data-player-status', 'playing');
  expect(await leftTheDevice()).toEqual([]);

  // A cold start without a connection lands there too.
  const cold = await context.newPage();
  await cold.goto('/');
  await expect(cold.getByRole('list', { name: 'Offline Playlists' })).toContainText(
    'Harness Playlist',
  );
  const sessionRow = cold
    .getByRole('list', { name: 'Offline Sessions' })
    .getByTestId('offline-collection');
  await expect(sessionRow).toContainText('Harness Session');
  await sessionRow.click();
  await expect(cold.getByTestId('track-title')).toContainText('Session Track');
  await expect(
    cold.getByRole('button', { name: 'Session and Track options' }).last(),
  ).toBeVisible();
  await cold.close();

  // Online again, the app's pages load from the server.
  await context.setOffline(false);
  await harnessReady(page);
});

test('offline, a Lounge Track whose week runs out during playback does not start, and the player says why', async ({
  context,
  page,
}) => {
  const syncedAt = Date.UTC(2026, 10, 1);
  await harnessReady(page);
  await page.evaluate(async (lastSyncedAt) => {
    const tone = (seconds: number) => {
      const rate = 8000;
      const samples = rate * seconds;
      const view = new DataView(new ArrayBuffer(44 + samples * 2));
      const text = (at: number, value: string) =>
        [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
      text(0, 'RIFF');
      view.setUint32(4, 36 + samples * 2, true);
      text(8, 'WAVEfmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, 'data');
      view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i / 8) * 3000, true);
      return new Blob([view.buffer], { type: 'audio/wav' });
    };
    const harness = window.__liedmotifOfflineStoreHarness!;
    const store = await harness.openStore();
    await store.wipe();
    await store.claim('user-a');
    const entry = (trackId: string, title: string, audio: Blob, fromLounge: boolean) => ({
      trackId,
      byteSize: audio.size,
      version: 'v1',
      title,
      artist: null,
      originSessionTitle: 'Harness Session',
      durationSeconds: null,
      coverImageId: null,
      genreTags: [],
      vocalMode: 'instrumental' as const,
      hasLyrics: false,
      fromLounge,
    });
    // The listener's own Track is short, so it ends after the week ran out.
    const own = tone(4);
    const lounge = tone(30);
    const tracks = [
      entry('own', 'Own Track', own, false),
      entry('lounge', 'Lounge Track', lounge, true),
    ];
    for (const [track, audio] of [
      [tracks[0]!, own],
      [tracks[1]!, lounge],
    ] as const) {
      await store.put({
        trackId: track.trackId,
        version: 'v1',
        track,
        details: { title: track.title } as never,
        lyrics: null,
        audio,
        cover: null,
      });
    }
    await store.putMark({
      key: 'playlist:p1',
      kind: 'playlist',
      id: 'p1',
      markedAt: 1,
      syncedAt: 2,
      manifest: { name: 'Harness Playlist', tracks, leftOutTrackCount: 0 },
    });
    await store.putLastSyncedAt(lastSyncedAt);
    await harness.readyOfflineLibrary();
    await navigator.serviceWorker.ready;
  }, syncedAt);

  await page.clock.setFixedTime(syncedAt + 60_000);
  await context.setOffline(true);
  await page.goto('/library');
  const row = page
    .getByRole('list', { name: 'Offline Playlists' })
    .getByTestId('offline-collection');
  await expect(row).toContainText('2 Tracks');
  const titles: string[] = [];
  await page.exposeFunction('reportTitle', (title: string) => titles.push(title));

  await row.click();
  const nowPlaying = page.getByTestId('now-playing');
  await expect(nowPlaying).toHaveAttribute('data-player-status', 'playing');
  await expect(page.getByTestId('track-title')).toContainText('Own Track');
  await page.evaluate(() => {
    const title = document.querySelector('[data-testid="track-title"]')!;
    new MutationObserver(() =>
      (window as unknown as { reportTitle: (t: string) => void }).reportTitle(
        title.textContent ?? '',
      ),
    ).observe(title, { subtree: true, childList: true, characterData: true });
  });

  // The week runs out while the own Track plays.
  await page.clock.setFixedTime(syncedAt + 8 * 24 * 60 * 60 * 1000);

  await expect(nowPlaying.getByRole('alert')).toHaveText(
    'The rest of this Playlist expired on this device. Connect to refresh it.',
    { timeout: 15_000 },
  );
  await expect(page.getByTestId('track-title')).toContainText('Own Track');
  expect(titles.some((title) => title.includes('Lounge Track'))).toBe(false);

  await page.getByRole('button', { name: 'Tracks in this Playlist' }).click();
  const list = page.getByTestId('playlist-queue');
  await expect(list.locator('li', { hasText: 'Lounge Track' })).toContainText('Expired');
  await expect(list.getByRole('button', { name: 'Play Lounge Track' })).toHaveCount(0);

  await context.setOffline(false);
});
