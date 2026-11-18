// The Assistant has no code that can buy music or a cover. Six things can
// spend: a new Session, a Surprise Me start, a More Like This, a Change Vibe,
// New music on, and a new cover. Each is written by one function, called from
// the app's own route, and the only way there from the chat is the user's
// click on a card: a request the browser sends. This reads the Assistant's own
// source, so a later tool that reached for one of those functions, or for a
// route, fails here. The app has more that spends than those six (a resumed
// Session, a Dislike reroll), so the source is also held to a list:
// everything the server code calls that can reach the database or a provider,
// and every route the panel calls.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(import.meta.dirname, '..', '..');

/** Every source file under `dir` that is not a test. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(WEB_ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => join(dir, file));
}

const read = (file: string) => readFileSync(join(WEB_ROOT, file), 'utf8');

/** The files among `files` whose source matches `pattern`. */
const mentioning = (files: string[], pattern: RegExp) =>
  files.filter((file) => pattern.test(read(file)));

const SERVER = [...sourceFiles('lib/assistant'), ...sourceFiles('app/api/assistant')];
const PANEL = sourceFiles('components/assistant');

const NAMED_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g;
const ANY_IMPORT = /(?:\bfrom|\bimport\(|\brequire\()\s*'([^']+)'/g;

/**
 * The values `file` imports from the modules `watched` matches, by the names
 * those modules export them under. A watched module reached any other way than
 * a named import is listed as that, so nothing gets past the names.
 */
function valuesFrom(file: string, watched: RegExp): string[] {
  const source = read(file);
  const named = [...source.matchAll(NAMED_IMPORT)].filter(([, , , from]) => watched.test(from!));
  const all = [...source.matchAll(ANY_IMPORT)].filter(([, from]) => watched.test(from!));
  const names = named.flatMap(([, typeOnly, list]) =>
    typeOnly
      ? []
      : list!
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name && !name.startsWith('type '))
          .map((name) => name.split(/\s+as\s+/)[0]!),
  );
  return all.length === named.length ? names : [...names, `${file}: not a named import`];
}

/** The database, the providers, and the app's own server code outside the Assistant. */
const REACHES_DATA = /^@liedmotif\/(db|providers)\b|^@\/lib\/(?!assistant\/)/;

/**
 * Everything the Assistant's server code calls there. None of it creates a
 * Session or makes one generate.
 */
const SERVER_CALLS = [
  // Reads, as the asking user: their music, their budget, what a route would refuse.
  'cachedUserProfile',
  'closestNames',
  'DOCS_BASE_URL',
  'evaluateGenerationBudget',
  'evaluateSessionHeadroom',
  'getActiveSession',
  'getAdminCoverUsage',
  'getAssistantTone',
  'getLibraryTracks',
  'getLoungePlaylistDetail',
  'getOwnedTrackSummary',
  'getOwnerUsageTracks',
  'getPlayableTrackSession',
  'getPlaylistDetail',
  'getReadableTrackDetails',
  'getSessionById',
  'getTypicalTracksPerMusicRequest',
  'getUsageLimits',
  'headroomRefusalMessage',
  'listPlaylists',
  'listSessionTracks',
  'loadMyBudgetData',
  'loadPendingSurprise',
  'loadPlaylistSummaries',
  'loadSessionList',
  'requestNow',
  'resolveAssistantStanding',
  'searchPlaylists',
  'searchSessions',
  'searchTracks',
  'startingSessionMode',
  'toPlaylistMemberItem',
  // Library writes: they add, rename and pin. A Session or Track rename also
  // retags the downloaded files, as the app's own rename does.
  'addPlaylistTracks',
  'createPlaylist',
  'ensureFavoritesPlaylist',
  'giveSessionName',
  'giveTrackName',
  'renamePlaylist',
  'setPlaylistLibraryPinned',
  'setSessionPinned',
  'setTrackFavorited',
  // The asker's own settings: read, and written one choice at a time. Of the
  // Generation settings only the language is written, never what a Session
  // generates ahead.
  'getCoverArtSettings',
  'getCoverReferenceFrequency',
  'getGenerationSettings',
  'getPlaybackSettings',
  'listPeople',
  'listPersonReferencePhotos',
  'SESSION_LANGUAGE_CHOICES',
  'sessionLanguageLabel',
  'toPersonRoster',
  'updateCoverReferenceFrequency',
  'updateDefaultLanguage',
  'updatePlaybackSettings',
  // The one write to a Session: its mode, and only to Repeat.
  'switchSessionMode',
  // Surprise Me's suggestion, as Home asks for it: the same Text AI calls
  // the app's own Surprise Me button makes, and the user's one pending
  // suggestion. It buys no music.
  'proposeSurprise',
  // Whether the cover regenerate routes would refuse a new cover: read, never reserved.
  'coverAttemptGate',
  // The route itself: who asks, their allowance, and the text LLM.
  'apiError',
  'apiRateLimited',
  'assistantLimiter',
  'countAssistantMessage',
  'getDb',
  'getLlmProvider',
  'parseJsonBody',
  'ProviderError',
  'requireOwnerId',
];

/** The function that creates a Session, by the name the start and More Like This routes call it. */
const CREATES_A_SESSION = /\bcreateSession\b/;
/** The function that starts a Surprise Me suggestion, by the name its route and the api client call it. */
const STARTS_A_SURPRISE = /\bstartSurprise\b/;
/** The function that gives a Session a new vibe, by the name the Change Vibe route calls it. */
const CHANGES_THE_VIBE = /\brestyleSession\b/;
/** The function behind New music on, by the name the duration route and the api client call it. */
const SETS_THE_DURATION = /\bsetSessionDuration\b/;
/**
 * What reserves and starts a paid cover attempt, by the names both regenerate
 * routes call them: the owner's cover lock, the reservation, and the job.
 */
const RESERVES_A_COVER =
  /\b(withOwnerCoverAdmissionLock|reserve(Session|Playlist)CoverRegeneration|enqueueRegenerate(Session|Playlist)Cover)\b/;
/** The client functions that post to the two regenerate routes. */
const REGENERATES_A_COVER = /\bregenerate(Session|Playlist)Cover\b/;
/** The function that writes a Session's mode; towards Keep Going it switches generation on. */
const SWITCHES_THE_MODE = /\b(switchSessionMode|setSessionMode)\b/;

/** A panel file's import of one of `names` from the api client. */
const importsFromApiClient = (names: string) =>
  new RegExp(`import\\s*\\{[^}]*\\b(${names})\\b[^}]*\\}\\s*from\\s*'@/lib/api-client'`);

const CARD_HOST = join('components/assistant', 'use-card-host.ts');

describe('the Assistant’s own code', () => {
  it('is read where it lives', () => {
    expect(SERVER).toContain(join('lib/assistant', 'propose-session-tool.ts'));
    expect(SERVER).toContain(join('app/api/assistant', 'route.ts'));
    expect(PANEL).toContain(join('components/assistant', 'confirm-card.ts'));
    // What the pins look for is what the routes really call.
    expect(read('app/api/sessions/route.ts')).toMatch(CREATES_A_SESSION);
    expect(read('app/api/surprise-me/start/route.ts')).toMatch(STARTS_A_SURPRISE);
    expect(read('lib/api-client.ts')).toMatch(STARTS_A_SURPRISE);
    expect(read('app/api/sessions/more-like-this/route.ts')).toMatch(CREATES_A_SESSION);
    expect(read('app/api/sessions/change-vibe/route.ts')).toMatch(CHANGES_THE_VIBE);
    expect(read('app/api/sessions/duration/route.ts')).toMatch(SETS_THE_DURATION);
    expect(read('lib/api-client.ts')).toMatch(SETS_THE_DURATION);
    for (const kind of ['Session', 'Playlist']) {
      const regenerate = read(`app/api/${kind.toLowerCase()}s/cover/regenerate/route.ts`);
      for (const name of [
        'withOwnerCoverAdmissionLock',
        `reserve${kind}CoverRegeneration`,
        `enqueueRegenerate${kind}Cover`,
      ]) {
        expect(name).toMatch(RESERVES_A_COVER);
        expect(regenerate).toContain(name);
      }
      expect(read('lib/api-client.ts')).toContain(`export function regenerate${kind}Cover(`);
    }
  });

  it('reaches the database and the providers through a fixed list of functions', () => {
    const called = new Set(SERVER.flatMap((file) => valuesFrom(file, REACHES_DATA)));

    expect([...called].sort()).toEqual([...SERVER_CALLS].sort());
  });

  it('never references the function that creates a Session', () => {
    expect(mentioning([...SERVER, ...PANEL], CREATES_A_SESSION)).toEqual([]);
  });

  it('never references the function that starts a Surprise Me suggestion from server code', () => {
    // The panel's one way there is the card host's client call, listed below.
    expect(mentioning(SERVER, STARTS_A_SURPRISE)).toEqual([]);
  });

  it('never references what reserves a cover, and asks for one from the card host only', () => {
    expect(mentioning([...SERVER, ...PANEL], RESERVES_A_COVER)).toEqual([]);
    expect(mentioning(SERVER, REGENERATES_A_COVER)).toEqual([]);
    expect(mentioning(PANEL, REGENERATES_A_COVER)).toEqual([CARD_HOST]);
  });

  it('never references the function that changes a vibe, or the one that sets New music on', () => {
    expect(mentioning([...SERVER, ...PANEL], CHANGES_THE_VIBE)).toEqual([]);
    expect(mentioning([...SERVER, ...PANEL], SETS_THE_DURATION)).toEqual([]);
  });

  it('writes a Session’s mode in one place, and only to switch New music off', () => {
    const writers = mentioning([...SERVER, ...PANEL], SWITCHES_THE_MODE);

    expect(writers).toEqual([join('lib/assistant', 'new-music-off-tool.ts')]);
    expect(read(writers[0]!)).toMatch(/mode: 'repeat'/);
    expect(read(writers[0]!)).not.toMatch(/keep_going/);
  });

  it('has no server code that calls the app’s own routes', () => {
    expect(mentioning(SERVER, /\/api\/(?!assistant\b)|@\/lib\/api-client/)).toEqual([]);
  });

  it('calls the app’s routes from the browser through a fixed list of client functions', () => {
    const calls = PANEL.map((file) => [file, valuesFrom(file, /^@\/lib\/api-client$/)] as const);

    expect(Object.fromEntries(calls.filter(([, names]) => names.length > 0))).toEqual({
      // The start and cover requests, sent from one place: the flows a confirmed
      // card runs, the cover status a cover card reads its budget and its
      // attempt from, as the cover dialog reads it, and the free select
      // request that makes a ready cover the cover.
      [CARD_HOST]: [
        'getSessionCoverStatus',
        'playlistCoverStatus',
        'regeneratePlaylistCover',
        'regenerateSessionCover',
        'selectPlaylistCover',
        'selectSessionCover',
        'startSession',
        'startSurprise',
      ],
      // Stop Session, and reading a Playlist to play it. Neither buys.
      [join('components/assistant', 'use-player-commands.ts')]: ['stopSession'],
      [join('components/assistant', 'use-play-command.ts')]: [
        'getAllPlaylistMembers',
        'getLoungePlaylist',
      ],
    });
    // The chat's own route is the one path a panel file names.
    expect(mentioning(PANEL, /\/api\/(?!assistant\b)/)).toEqual([]);
  });

  it('leaves the other three spends to the app’s own flows, which one panel file runs', () => {
    // The client functions that post to the Change Vibe, More Like This and duration routes.
    const importsASpend = importsFromApiClient('changeVibe|moreLikeThis|setSessionDuration');
    // The flows the app's own controls run, which hold those calls.
    const runsASpendFlow = /\b(submitChangeVibe|useSeedMoreLikeThis|switchNewMusicOn)\b/;

    expect(read('components/player/use-vibe-change-request.ts')).toMatch(importsASpend);
    expect(read('components/sessions/use-seed-more-like-this.ts')).toMatch(importsASpend);
    expect(read('components/player/switch-new-music-on.ts')).toMatch(importsASpend);
    expect(mentioning(PANEL, runsASpendFlow)).toEqual([CARD_HOST]);
    expect(mentioning(SERVER, runsASpendFlow)).toEqual([]);
    for (const flow of ['submitChangeVibe', 'useSeedMoreLikeThis', 'switchNewMusicOn']) {
      expect(read(CARD_HOST)).toContain(flow);
    }
  });
});
