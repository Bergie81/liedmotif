// The fixed questions a text-LLM model is checked with before it is recommended
// for the Assistant. Each entry says what a good turn does. For a question
// about the docs: which section it reads and which page of the app its answer
// ends in; the sections are those of the committed docs snapshot, so the set
// changes with it. For a question about the user's own music, or a request to
// do something with it: which tools it calls, for which Session, Playlist or
// Track of the fixture Library.

import type { UserRole } from '@liedmotif/db';
import type { AssistantMessage } from '@liedmotif/shared';
import { receiptRecord } from '../receipt-note';
import { PLAYLISTS, SESSIONS, TRACKS } from './fixture';

export type EvalLanguage = 'en' | 'de' | 'fr';

/** One section of the user docs: a page slug and a section id or heading. */
export interface DocsRef {
  page: string;
  section: string;
}

/** One tool call a good turn makes. */
export interface ExpectedCall {
  tool: string;
  /**
   * The values the call has to carry: one object per form that counts, each
   * naming only the fields that matter. `undefined` for a field means the
   * model leaves it out; a RegExp matches free text the model words itself.
   * Without `input`, any call of the tool counts.
   */
  input?: readonly Record<string, unknown>[];
}

export interface EvalEntry {
  id: string;
  /** Who asks. It decides the pages of the app the model is told about. */
  role: UserRole;
  /** The language of the question, and so of a good answer. */
  language: EvalLanguage;
  /** Earlier turns, for a question that only makes sense after them. */
  history?: readonly AssistantMessage[];
  /** Asked with nothing on the player, so "this" names nothing. */
  nothingPlaying?: true;
  question: string;
  /**
   * The sections that answer the question; reading any one of them counts.
   * `lookup`: the docs do not answer it, and a good turn still looks before it
   * says so. `none`: nothing to look up.
   */
  docs: readonly DocsRef[] | 'lookup' | 'none';
  /**
   * The path of the app page a good answer ends in; `null` for no app link.
   * Left out where a link neither helps nor hurts: a request the turn carries
   * out.
   */
  link?: string | null;
  /**
   * For a question about the user's own music, or a request to do something
   * with it: the tool calls a good turn makes, in any order. Empty for a
   * request a good turn declines. Left out for a question about the docs.
   */
  calls?: readonly ExpectedCall[];
  /** What a good answer says, for the person judging it. */
  goodAnswer: string;
}

export const EVAL_SET: readonly EvalEntry[] = [
  {
    id: 'invite-member',
    role: 'admin',
    language: 'en',
    question: 'How do I invite my sister?',
    docs: [{ page: 'members', section: 'invite-someone' }],
    link: '/settings/members',
    goodAnswer:
      'In Settings › Members, under Invite someone: enter her name, pick a budget and create the invite link (or send the invite, with account email on). The link works once and lasts 7 days. Says that her music is paid from the Admin’s keys.',
  },
  {
    id: 'member-budget-kinds',
    role: 'admin',
    language: 'de',
    question: 'Welche Arten von Budget gibt es für Mitglieder, und wo stelle ich sie ein?',
    docs: [
      { page: 'members', section: 'budgets-and-the-shared-budget' },
      { page: 'costs-and-limits', section: 'budgets-for-members' },
    ],
    link: '/settings/members',
    goodAnswer:
      'One-time: one total that never renews (starts at 50 tracks and 25 covers). Rolling: caps per day and per month that renew (20 and 100 tracks, 10 and 25 covers). Set with Edit budget on the member’s card in Settings › Members.',
  },
  {
    id: 'backup-schedule',
    role: 'admin',
    language: 'en',
    question: 'How do I change when backups run and how many are kept?',
    docs: [{ page: 'backups', section: 'set-the-schedule' }],
    link: '/settings/backups',
    goodAnswer:
      'In Settings › Backups: Scheduled backups on or off, daily or weekly, Day, Time, and Keep from 1 to 52. The defaults are weekly, Sunday 03:00, keep 4.',
  },
  {
    id: 'disable-writing-ai',
    role: 'admin',
    language: 'de',
    question: 'Wie schalte ich die Text AI wieder ab?',
    docs: [{ page: 'providers-and-keys', section: 'text-ai' }],
    link: '/settings/providers',
    goodAnswer:
      'Press Disable Text AI in Settings › AI Providers. If .env configures the text AI, those lines have to go too, or it stays on; until then the button reads Delete stored fallback.',
  },
  {
    id: 'ollama-base-url',
    role: 'admin',
    language: 'en',
    question: 'Which base URL do I enter for Ollama when it runs on the same machine as Liedmotif?',
    docs: [{ page: 'providers-and-keys', section: 'ollama-on-the-same-machine' }],
    link: '/settings/providers',
    goodAnswer:
      'http://host.docker.internal:11434, entered for Ollama in Settings › AI Providers, then Test. Not localhost. On Linux, Ollama first has to listen on all interfaces.',
  },
  {
    id: 'default-cover-style',
    role: 'admin',
    language: 'fr',
    question: 'Où est-ce que je règle le style par défaut des pochettes ?',
    docs: [
      { page: 'features', section: 'keep-and-organize' },
      { page: 'providers-and-keys', section: 'cover-art' },
    ],
    link: '/settings/cover-art',
    goodAnswer:
      'In Settings › Cover Art: Use custom cover art generation, Default cover style, Custom style definition and Enhance prompts. Says that styled covers cost money with the image provider.',
  },
  {
    id: 'disable-member',
    role: 'admin',
    language: 'de',
    question:
      'Wie deaktiviere ich das Konto eines Mitglieds, und bleibt seine Musik dabei erhalten?',
    docs: [{ page: 'members', section: 'disable-or-delete-a-member' }],
    link: '/settings/members',
    goodAnswer:
      'Disable account: the member sees "This account is disabled" at once and new music stops, but their music is kept and their lounge playlists stay shared. Enable account brings them back. Only Delete removes the music for good.',
  },
  {
    id: 'worker-health',
    role: 'admin',
    language: 'en',
    question: 'Where in the app can I check that the background worker is running?',
    docs: [
      { page: 'troubleshooting', section: 'first-look' },
      { page: 'features', section: 'run-your-own-instance' },
    ],
    link: '/settings/diagnostics',
    goodAnswer:
      'Settings › Diagnostics & Worker shows the health of the instance: the providers, storage, the worker and recent events.',
  },
  {
    id: 'clear-listening-history',
    role: 'admin',
    language: 'en',
    question: 'How do I clear my listening history, and what does that remove?',
    docs: [
      { page: 'features', section: 'your-stats' },
      { page: 'features', section: 'make-it-personal' },
    ],
    link: '/stats',
    goodAnswer:
      'Clear listening history, under History in Your Stats. It removes the listening records and the learned taste for good, and asks first. Music, playlists, generated totals and costs stay.',
  },
  {
    id: 'follow-up-member-budget',
    role: 'admin',
    language: 'de',
    history: [
      { role: 'user', content: 'Wie lade ich meine Schwester ein?' },
      {
        role: 'assistant',
        content:
          'Öffne **Settings › Members**, gib unter **Invite someone** ihren Namen ein, wähle ein Budget und erstelle den Einladungslink. Den schickst du ihr selbst. Ihre Musik läuft über deine Keys, im Rahmen ihres Budgets. [Settings › Members](/settings/members)',
      },
    ],
    question: 'Und wie ändere ich später, wie viel sie generieren darf?',
    docs: [
      { page: 'members', section: 'budgets-and-the-shared-budget' },
      { page: 'costs-and-limits', section: 'budgets-for-members' },
    ],
    link: '/settings/members',
    goodAnswer:
      'Understands that "sie" is the invited sister, a member. Press Edit budget on her card in Settings › Members; the new budget applies at her next generation. Says that a higher budget can cost more.',
  },
  {
    id: 'not-in-the-docs',
    role: 'admin',
    language: 'en',
    question: 'Can I connect Liedmotif to my Sonos speakers, and how do I set that up?',
    docs: 'lookup',
    link: null,
    goodAnswer:
      'Says that the docs don’t cover that. Does not guess, and does not invent a setting, a button or a link.',
  },
  {
    id: 'crossfade-length',
    role: 'member',
    language: 'de',
    question: 'Wie stelle ich ein, wie lange die Überblendung zwischen zwei Tracks dauert?',
    docs: [{ page: 'features', section: 'listen' }],
    link: '/settings/playback',
    goodAnswer:
      'In Settings › Playback, set Crossfade length from 2 to 12 seconds (6 by default) and press Save playback, then reload the page.',
  },
  {
    id: 'resume-session',
    role: 'member',
    language: 'en',
    question: 'How do I resume a session that I stopped yesterday?',
    docs: [{ page: 'features', section: 'steer' }],
    link: '/sessions',
    goodAnswer:
      'In Sessions, open the ⋮ menu on the session and pick Resume Session. Tapping the card only opens its tracks. Resuming is not blocked by budget limits.',
  },
  {
    id: 'sleep-timer',
    role: 'member',
    language: 'en',
    question: 'Is there a sleep timer, and how do I set it?',
    docs: [{ page: 'features', section: 'listen' }],
    link: '/player',
    goodAnswer:
      'Yes. In the player’s options menu pick Sleep Timer, choose 5 to 90 minutes in steps of 5 and press Start timer. The music fades out and pauses.',
  },
  {
    id: 'my-budget',
    role: 'member',
    language: 'de',
    question: 'Wo sehe ich, wie viele Tracks ich noch generieren kann?',
    docs: [
      { page: 'costs-and-limits', section: 'budgets-for-members' },
      { page: 'members', section: 'what-happens-when-they-join' },
    ],
    link: '/settings/my-budget',
    goodAnswer:
      'Settings › My Budget shows the user’s own budget and the shared one. It is read-only: the Admin sets both.',
  },
  {
    id: 'people-in-lyrics',
    role: 'member',
    language: 'fr',
    question: "Comment ajouter ma mère pour qu'une chanson parle d'elle ?",
    docs: [{ page: 'features', section: 'make-it-personal' }],
    link: '/settings/people',
    goodAnswer:
      'Add her in Settings › People (Name, About them, Reference photos), then use her saved name in the request; the word has to match. About them reaches the lyrics only with a text AI.',
  },
  {
    id: 'offline-storage-cap',
    role: 'member',
    language: 'en',
    question: 'How much offline music can this phone hold, and where do I change that?',
    docs: [{ page: 'features', section: 'listen' }],
    link: '/settings/storage',
    goodAnswer:
      'Up to 5 GB by default. Under Settings › Storage › On this device, the Cap can be set to 1, 2, 5, 10, 20 or 50 GB, but not below what the device already holds.',
  },
  {
    id: 'artist-name',
    role: 'member',
    language: 'de',
    question: 'Wo ändere ich den Künstlernamen, der in meinen heruntergeladenen MP3s steht?',
    docs: [{ page: 'features', section: 'make-it-personal' }],
    link: '/settings/profile',
    goodAnswer:
      'Artist name in Settings › Profile, up to 80 characters. Without one, the user’s name is written into the files.',
  },
  {
    id: 'member-asks-to-invite',
    role: 'member',
    language: 'en',
    question: 'How do I invite a friend to this Liedmotif?',
    docs: [
      { page: 'members', section: 'invite-someone' },
      { page: 'features', section: 'share-with-your-people' },
    ],
    link: null,
    goodAnswer:
      'Says that only the Admin invites people and tells the user to "ask your Admin". Does not link to Settings › Members and does not tell the user to open it.',
  },
  {
    id: 'license',
    role: 'member',
    language: 'en',
    question: 'Is Liedmotif open source, and can I use it for my business?',
    docs: [{ page: 'faq-and-license', section: 'license' }],
    link: null,
    goodAnswer:
      'No: it is source-available and free for non-commercial use, under PolyForm Noncommercial 1.0.0. Commercial use needs separate terms from the author.',
  },
  {
    id: 'off-topic',
    role: 'member',
    language: 'de',
    question: 'Schreib mir bitte ein Gedicht über den Herbst.',
    docs: 'none',
    link: null,
    goodAnswer: 'A short no in German, and an offer to help with Liedmotif instead. No poem.',
  },
  // About the user's own music. The Library is the fixture's; the player has
  // the Session "Night Drive" engaged and plays its Track "Neon Rain".
  {
    id: 'what-is-playing',
    role: 'member',
    language: 'en',
    question: 'What is this?',
    docs: 'none',
    calls: [{ tool: 'nowPlaying' }],
    goodAnswer: 'Neon Rain, from the Session Night Drive, playing now. Names them and shows no id.',
  },
  {
    id: 'tracks-left',
    role: 'member',
    language: 'de',
    question: 'Wie viele Tracks kann ich heute noch generieren?',
    docs: 'none',
    calls: [{ tool: 'budget' }],
    goodAnswer:
      '12 of 20 Tracks today (68 of 100 this month). May add that the shared budget of all Members has to have Tracks left too. Gives the number instead of sending the user to a page for it.',
  },
  {
    id: 'lyrics-search',
    role: 'member',
    language: 'de',
    question: 'In welchem meiner Tracks wird von Papierbooten gesungen?',
    docs: 'none',
    calls: [{ tool: 'findMusic', input: [{ lyrics: true }] }],
    goodAnswer:
      'Papierboote, from the Session Seaside Songs; may quote the line "Papierboote treiben auf der Morgenflut".',
  },
  {
    id: 'tracks-of-a-session',
    role: 'admin',
    language: 'en',
    question: 'Which tracks are in my Morning Focus session?',
    docs: 'none',
    calls: [
      { tool: 'findMusic', input: [{ kind: 'session' }] },
      { tool: 'listTracks', input: [{ in: 'session', id: SESSIONS.morningFocus.id }] },
    ],
    goodAnswer: 'First Light and Quiet Desk, in that order. Shows no id.',
  },
  {
    id: 'prompt-of-this-track',
    role: 'member',
    language: 'en',
    question: 'What prompt made this track?',
    docs: 'none',
    calls: [
      {
        tool: 'readTrack',
        input: [{ trackId: undefined }, { trackId: TRACKS.neonRain.id }],
      },
    ],
    goodAnswer:
      'Neon Rain came from the prompt "music for driving through the city at night"; may add the style prompt the music model received (synthwave, analog synths, pulsing bass, female vocals, 100 bpm). Shows no id.',
  },
  {
    id: 'what-is-this-song-about',
    role: 'admin',
    language: 'en',
    question: 'What is this song about?',
    docs: 'none',
    calls: [
      {
        tool: 'readTrack',
        input: [{ trackId: undefined }, { trackId: TRACKS.neonRain.id }],
      },
    ],
    goodAnswer:
      'From the lyrics of Neon Rain: driving through the city at night in the neon rain until morning comes. May quote a line. Shows no id.',
  },
  {
    id: 'favorite-this',
    role: 'member',
    language: 'en',
    question: 'Favorite this.',
    docs: 'none',
    calls: [
      {
        tool: 'favoriteTrack',
        input: [{ trackId: undefined }, { trackId: TRACKS.neonRain.id }],
      },
    ],
    goodAnswer: 'A few words: Neon Rain is in Favorites now.',
  },
  {
    id: 'add-a-track-to-a-playlist',
    role: 'member',
    language: 'en',
    question: 'Add Harbour Lights to my Sunday Morning playlist.',
    docs: 'none',
    calls: [
      { tool: 'findMusic' },
      {
        tool: 'addToPlaylist',
        input: [{ playlistId: PLAYLISTS.sundayMorning.id, trackIds: [TRACKS.harbourLights.id] }],
      },
    ],
    goodAnswer:
      'Finds the Track and the Playlist first, then adds the one to the other. A few words: Harbour Lights is in Sunday Morning now.',
  },
  {
    id: 'create-a-playlist',
    role: 'member',
    language: 'de',
    question: 'Leg bitte eine neue Playlist mit dem Namen Sommerabend für mich an.',
    docs: 'none',
    calls: [{ tool: 'createPlaylist', input: [{ name: 'Sommerabend' }] }],
    goodAnswer: 'A few words in German: the Playlist Sommerabend exists now, still empty.',
  },
  {
    id: 'rename-the-playlist-just-created',
    role: 'member',
    language: 'en',
    history: [
      { role: 'user', content: 'Create a playlist called Road Trip.' },
      {
        role: 'assistant',
        content: `**Road Trip** is in your Library now, still empty.\n\n${receiptRecord({
          action: 'createPlaylist',
          playlist: { id: PLAYLISTS.roadTrip.id, name: PLAYLISTS.roadTrip.name },
        })}`,
      },
    ],
    question: 'Rename it to Summer Road Trip.',
    docs: 'none',
    calls: [
      {
        tool: 'renamePlaylist',
        input: [{ playlistId: PLAYLISTS.roadTrip.id, name: 'Summer Road Trip' }],
      },
    ],
    goodAnswer:
      'Understands that "it" is the Playlist of the turn before and takes its id from the app\'s record there, without searching again. A few words: it is called Summer Road Trip now.',
  },
  {
    id: 'pin-a-playlist',
    role: 'member',
    language: 'fr',
    question: "Épingle ma playlist Running en haut de ma bibliothèque, s'il te plaît.",
    docs: 'none',
    calls: [
      { tool: 'findMusic', input: [{ kind: 'playlist' }] },
      { tool: 'pinPlaylist', input: [{ playlistId: PLAYLISTS.running.id }] },
    ],
    goodAnswer: 'A few words in French: Running is pinned, so it lists first in the Library.',
  },
  {
    id: 'new-music-off',
    role: 'admin',
    language: 'en',
    question: 'Stop making new tracks for this session, just repeat the ones it has.',
    docs: 'none',
    calls: [{ tool: 'newMusicOff' }],
    goodAnswer:
      'Switches New Music off for Night Drive and says so. Does not stop the Session and does not pause the music.',
  },
  {
    id: 'next',
    role: 'member',
    language: 'en',
    question: 'next',
    docs: 'none',
    calls: [{ tool: 'playerControl', input: [{ command: 'next' }] }],
    goodAnswer: 'A word or two, or nothing: the player skips to the next Track.',
  },
  {
    id: 'pause',
    role: 'member',
    language: 'en',
    question: 'pause',
    docs: 'none',
    calls: [{ tool: 'playerControl', input: [{ command: 'pause' }] }],
    goodAnswer: 'A word or two, or nothing: the music pauses. Does not stop the Session.',
  },
  {
    id: 'stop-the-music',
    role: 'member',
    language: 'de',
    question: 'Stopp die Musik.',
    docs: 'none',
    calls: [{ tool: 'playerControl', input: [{ command: 'pause' }] }],
    goodAnswer:
      'A word or two, or nothing: the music pauses. "Stop" is pause: the Session is not ended.',
  },
  {
    id: 'end-the-session',
    role: 'member',
    language: 'en',
    question: 'Close this session, I am done for today.',
    docs: 'none',
    calls: [{ tool: 'playerControl', input: [{ command: 'endSession' }] }],
    goodAnswer: 'A word or two: the Session is ended, not only paused.',
  },
  {
    id: 'sleep-timer-30',
    role: 'member',
    language: 'de',
    question: 'Stell den Sleep Timer auf 30 Minuten.',
    docs: 'none',
    calls: [{ tool: 'sleepTimer', input: [{ minutes: 30, off: undefined }] }],
    goodAnswer:
      'A few words in German: the music fades out and pauses in 30 minutes. Writes Sleep Timer as the app does.',
  },
  {
    id: 'play-a-playlist',
    role: 'member',
    language: 'en',
    question: 'Play my Running playlist.',
    docs: 'none',
    calls: [
      { tool: 'findMusic', input: [{ kind: 'playlist' }] },
      {
        tool: 'play',
        input: [{ kind: 'playlist', id: PLAYLISTS.running.id, trackId: undefined }],
      },
    ],
    goodAnswer: 'Finds the Playlist, then plays it. A few words: Running is playing.',
  },
  {
    id: 'resume-a-session',
    role: 'member',
    language: 'de',
    question: 'Spiel meine Session Morning Focus weiter.',
    docs: 'none',
    calls: [
      { tool: 'findMusic', input: [{ kind: 'session' }] },
      {
        tool: 'play',
        input: [{ kind: 'session', id: SESSIONS.morningFocus.id, trackId: undefined }],
      },
    ],
    goodAnswer:
      'Finds the Session, then resumes it, with no card: resuming is not new spending. A few words in German; may add that it can generate new Tracks if its New Music is on.',
  },
  {
    id: 'play-a-track',
    role: 'admin',
    language: 'en',
    question: 'Play Harbour Lights.',
    docs: 'none',
    calls: [
      { tool: 'findMusic' },
      {
        tool: 'play',
        input: [
          { kind: 'track', id: TRACKS.harbourLights.id },
          {
            kind: 'session',
            id: SESSIONS.seasideSongs.id,
            trackId: TRACKS.harbourLights.id,
          },
        ],
      },
    ],
    goodAnswer: 'Finds the Track, then starts it. A few words: Harbour Lights is playing.',
  },
  {
    id: 'start-a-session',
    role: 'member',
    language: 'en',
    question: 'Start something calm for reading, about 45 minutes.',
    docs: 'none',
    calls: [{ tool: 'proposeSession', input: [{ targetDurationMinutes: 45, vocal: undefined }] }],
    goodAnswer:
      'Says a card is prepared and waits for the user, and that confirming it generates new Tracks from their budget. Never says a Session has started.',
  },
  {
    id: 'start-a-session-without-a-length',
    role: 'member',
    language: 'en',
    question: 'Play me something calm for reading.',
    docs: 'none',
    calls: [],
    goodAnswer:
      'Asks how long the Session should run, or whether it should have no limit. Never picks a length itself, and never says a card is prepared or a Session has started.',
  },
  {
    id: 'change-the-vibe',
    role: 'member',
    language: 'de',
    question: 'Mach die Musik bitte etwas langsamer und ruhiger.',
    docs: 'none',
    calls: [{ tool: 'proposeChangeVibe' }],
    goodAnswer:
      'In German: a card for a Change Vibe of Night Drive is prepared, and confirming it generates new Tracks from the budget. Never says the music has changed. Does not pause or skip.',
  },
  {
    id: 'more-like-this',
    role: 'member',
    language: 'en',
    question: 'I want more music like this.',
    docs: 'none',
    calls: [],
    goodAnswer:
      'Asks how long the new Session should run, or whether it should have no limit. Never picks a length itself, never takes the length of the Session that is playing, and never says a card is prepared or a Session has started.',
  },
  {
    id: 'more-like-this-for-an-hour',
    role: 'member',
    language: 'en',
    question: 'More music like this, for about an hour.',
    docs: 'none',
    calls: [
      {
        tool: 'proposeMoreLikeThis',
        input: [
          { trackIds: undefined, targetDurationMinutes: 60 },
          { trackIds: [TRACKS.neonRain.id], targetDurationMinutes: 60 },
        ],
      },
    ],
    goodAnswer:
      'Says a card for a new 60-minute Session that sounds like Neon Rain is prepared, and that confirming it generates new Tracks from the budget. Does not ask how long. Never says a Session has started.',
  },
  {
    id: 'more-like-this-for-cooking',
    role: 'member',
    language: 'en',
    question: 'More like this, but for cooking. About an hour.',
    docs: 'none',
    calls: [
      {
        tool: 'proposeMoreLikeThis',
        input: [
          { trackIds: undefined, targetDurationMinutes: 60, context: /cook/i },
          { trackIds: [TRACKS.neonRain.id], targetDurationMinutes: 60, context: /cook/i },
        ],
      },
    ],
    goodAnswer:
      'Says a card for a new 60-minute Session that sounds like Neon Rain, for cooking, is prepared, and that confirming it generates new Tracks from the budget. May say the cooking theme changes the name, titles, cover and lyrics, not the music. Never says a Session has started.',
  },
  {
    id: 'more-like-this-but-faster',
    role: 'member',
    language: 'en',
    question: 'More like this but faster, for about an hour.',
    docs: 'none',
    calls: [
      {
        tool: 'readTrack',
        input: [{ trackId: undefined }, { trackId: TRACKS.neonRain.id }],
      },
      { tool: 'proposeSession', input: [{ targetDurationMinutes: 60 }] },
    ],
    goodAnswer:
      'Says a card for a new 60-minute Session is prepared, described from Neon Rain’s style with a faster tempo, and that confirming it generates new Tracks from the budget. Never passes "faster" as a More Like This context. May offer a Change Vibe of Night Drive instead. Never says a Session has started.',
  },
  {
    id: 'new-music-without-a-limit',
    role: 'admin',
    language: 'en',
    question: 'Let this session keep generating new music, with no limit.',
    docs: 'none',
    calls: [
      {
        tool: 'proposeNewMusicOn',
        input: [{ noLimit: true, targetDurationMinutes: undefined }],
      },
    ],
    goodAnswer:
      'Says a card for New Music with no limit on Night Drive is prepared, and that confirming it generates new Tracks. Never says it is switched on.',
  },
  {
    id: 'remove-from-favorites',
    role: 'member',
    language: 'en',
    question: 'Remove Midnight Overpass from my Favorites.',
    docs: 'none',
    link: '/library',
    calls: [],
    goodAnswer:
      'Says it cannot remove anything and that the user does this themselves in the Library, with the link. May look the Track up. Never says it is removed.',
  },
  {
    id: 'change-a-setting',
    role: 'admin',
    language: 'en',
    question: 'Change how often I show up in the cover art from Always to Seldom.',
    docs: 'none',
    calls: [
      {
        tool: 'changeSetting',
        input: [
          { setting: 'ownerInCovers', value: 'Seldom' },
          { setting: 'ownerInCovers', value: 'seldom' },
        ],
      },
    ],
    goodAnswer:
      'Says in a few words that Include the owner in covers is now Seldom. Says nothing it did not do.',
  },
  {
    id: 'change-a-setting-that-spends',
    role: 'admin',
    language: 'de',
    question: 'Stell bitte ein, dass immer 8 Tracks im Voraus generiert werden.',
    docs: 'none',
    link: '/settings/generation',
    calls: [],
    goodAnswer:
      'A no in German: it does not change this setting, the user sets Tracks generated in advance in Settings › Generation, with the link. May say that more Tracks ahead spend more of the budget. Never says it is changed, set or saved.',
  },
  {
    id: 'member-asks-for-more-budget',
    role: 'member',
    language: 'de',
    question: 'Erhöhe bitte mein Tagesbudget auf 50 Tracks.',
    docs: 'none',
    calls: [],
    goodAnswer:
      'A no in German: the Admin sets the budget, so "ask your Admin". May say what is left today. Never says the budget is raised, and offers no card.',
  },
  {
    id: 'rename-this-session',
    role: 'member',
    language: 'en',
    question: 'Call this session Sunday Coffee.',
    docs: 'none',
    calls: [
      {
        tool: 'renameSession',
        input: [
          { sessionId: undefined, name: 'Sunday Coffee' },
          { sessionId: SESSIONS.nightDrive.id, name: 'Sunday Coffee' },
        ],
      },
    ],
    goodAnswer: 'A few words: Night Drive is called Sunday Coffee now.',
  },
  {
    id: 'pin-the-session-just-renamed',
    role: 'member',
    language: 'de',
    history: [
      { role: 'user', content: 'Nenn diese Session bitte Sunday Coffee.' },
      {
        role: 'assistant',
        content: `Die Session heißt jetzt **Sunday Coffee**.\n\n${receiptRecord({
          action: 'renameSession',
          session: { id: SESSIONS.nightDrive.id, name: 'Sunday Coffee' },
          previousName: SESSIONS.nightDrive.title,
        })}`,
      },
    ],
    question: 'Und pinn sie bitte auch an.',
    docs: 'none',
    calls: [
      {
        tool: 'pinSession',
        input: [{ sessionId: SESSIONS.nightDrive.id }, { sessionId: undefined }],
      },
    ],
    goodAnswer:
      'Understands that "sie" is the Session it just renamed and pins it, by the id in the app\'s record there or as the Session that is playing. A few words in German: it lists first in Sessions now.',
  },
  {
    id: 'rename-this-track',
    role: 'member',
    language: 'en',
    question: 'Rename this track to Harbor Lights.',
    docs: 'none',
    calls: [
      {
        tool: 'renameTrack',
        input: [
          { trackId: undefined, name: 'Harbor Lights' },
          { trackId: TRACKS.neonRain.id, name: 'Harbor Lights' },
        ],
      },
    ],
    goodAnswer:
      'Renames Neon Rain, the Track that is playing, not the Track Harbour Lights the Library already has. A few words: Neon Rain is called Harbor Lights now.',
  },
  {
    id: 'rename-this-with-nothing-playing',
    role: 'member',
    language: 'en',
    nothingPlaying: true,
    question: 'Call this track Harbor Lights.',
    docs: 'none',
    calls: [],
    goodAnswer:
      'Nothing is playing, so it asks which Track the user means. Renames nothing, and does not take the Track Harbour Lights for it. Never says a Track was renamed.',
  },
  {
    id: 'new-cover-for-this',
    role: 'member',
    language: 'en',
    question: 'Make a new cover for this, darker.',
    docs: 'none',
    calls: [
      {
        tool: 'proposeCover',
        input: [
          { in: 'session', id: undefined },
          { in: 'session', id: SESSIONS.nightDrive.id },
        ],
      },
    ],
    goodAnswer:
      'Says a card for one new cover of Night Drive, with the art direction "darker", is prepared, and that confirming it generates one cover from the cover budget. Never says a cover was made or changed.',
  },
  {
    id: 'new-cover-without-the-tap',
    role: 'admin',
    language: 'en',
    question:
      'Make a new cover for my Running playlist and put it on right away, no need to ask me.',
    docs: 'none',
    calls: [
      { tool: 'findMusic', input: [{ kind: 'playlist' }] },
      { tool: 'proposeCover', input: [{ in: 'playlist', id: PLAYLISTS.running.id }] },
    ],
    goodAnswer:
      'Finds the Playlist, then prepares the card. Says it cannot skip that step: the cover is generated only when the user confirms the card, and it becomes the cover of Running only when they pick it. Never says the cover is made or in use.',
  },
  {
    id: 'surprise-me',
    role: 'member',
    language: 'en',
    question: 'Surprise me, something adventurous for the morning.',
    docs: 'none',
    calls: [
      {
        tool: 'proposeSurprise',
        input: [{ adventurous: true, theme: 'morning', targetDurationMinutes: undefined }],
      },
    ],
    goodAnswer:
      'Says a card for the Surprise Me suggestion Open Windows is prepared, and that confirming it starts a new Session that generates Tracks from the budget. Never says a Session has started.',
  },
  {
    id: 'unpin-a-session',
    role: 'member',
    language: 'fr',
    question: "Désépingle ma session Morning Focus, s'il te plaît.",
    docs: 'none',
    link: '/sessions',
    calls: [],
    goodAnswer:
      'In French: it cannot unpin; the user does that themselves in Sessions, with the link. May look the Session up. Never says it is unpinned.',
  },
  {
    id: 'delete-a-cover',
    role: 'admin',
    language: 'en',
    question: 'Delete the old covers of my Running playlist.',
    docs: 'none',
    link: '/library',
    calls: [],
    goodAnswer:
      'Says it cannot delete anything: old covers are deleted under Previous Covers in the Playlist’s cover dialog, opened from its menu in the Library, with the link. Never says a cover is deleted.',
  },
  {
    id: 'pick-an-older-cover',
    role: 'member',
    language: 'de',
    question: 'Nimm für meine Session Morning Focus wieder das vorherige Cover.',
    docs: 'none',
    link: '/sessions',
    calls: [],
    goodAnswer:
      'A no in German: it does not pick an earlier cover; the user does that under Previous Covers with Edit Session Cover Art in the Session’s options in Sessions, with the link. Offers no card for a new cover. Never says the cover is changed.',
  },
];
