// The fixed questions a text-LLM model is checked with before it is recommended
// for the Assistant. Each entry says what a good turn does: which docs section
// it reads and which page of the app its answer ends in. The docs sections are
// those of the committed docs snapshot, so the set changes with it.

import type { UserRole } from '@liedmotif/db';
import type { AssistantMessage } from '@liedmotif/shared';

export type EvalLanguage = 'en' | 'de' | 'fr';

/** One section of the user docs: a page slug and a section id or heading. */
export interface DocsRef {
  page: string;
  section: string;
}

export interface EvalEntry {
  id: string;
  /** Who asks. It decides the pages of the app the model is told about. */
  role: UserRole;
  /** The language of the question, and so of a good answer. */
  language: EvalLanguage;
  /** Earlier turns, for a question that only makes sense after them. */
  history?: readonly AssistantMessage[];
  question: string;
  /**
   * The sections that answer the question; reading any one of them counts.
   * `lookup`: the docs do not answer it, and a good turn still looks before it
   * says so. `none`: nothing to look up.
   */
  docs: readonly DocsRef[] | 'lookup' | 'none';
  /** The path of the app page a good answer ends in; `null` for no app link. */
  link: string | null;
  /** What a good answer says, for the person judging it against the docs. */
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
    question: 'Wie schalte ich die Writing AI wieder ab?',
    docs: [{ page: 'providers-and-keys', section: 'writing-ai' }],
    link: '/settings/providers',
    goodAnswer:
      'Press Disable Writing AI in Settings › AI Providers. If .env configures the writing AI, those lines have to go too, or it stays on; until then the button reads Delete stored fallback.',
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
      'In Settings › Cover art: Use Basic Cover Art, Default cover style, Custom style definition and Enhance prompts. Says that styled covers cost money with the image provider.',
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
      'Settings › Diagnostics & worker shows the health of the instance: the providers, storage, the worker and recent events.',
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
      'Settings › My budget shows the user’s own budget and the shared one. It is read-only: the Admin sets both.',
  },
  {
    id: 'people-in-lyrics',
    role: 'member',
    language: 'fr',
    question: "Comment ajouter ma mère pour qu'une chanson parle d'elle ?",
    docs: [{ page: 'features', section: 'make-it-personal' }],
    link: '/settings/people',
    goodAnswer:
      'Add her in Settings › People (Name, About them, Reference photos), then use her saved name in the request; the word has to match. About them reaches the lyrics only with a writing AI.',
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
    goodAnswer:
      'A short, friendly no in German, and an offer to help with Liedmotif instead. No poem.',
  },
];
