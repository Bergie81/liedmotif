// The pages of the app the Assistant may send a user to. One list feeds both
// ends: the system prompt tells the model which pages exist, and the chat panel
// follows a link only when its target is on it. Plain data, safe to import from
// the browser.
//
// A page is listed only when it is there for everyone of its role who can ask:
// pages with an id in the path and pages behind an instance opt-in (My voice)
// are left out, so a listed link always works. The Assistant's own settings
// page is there for exactly the users who have the Assistant.

import type { UserRole } from '@liedmotif/db';
import { ASSISTANT_NAME } from './persona';

export interface AppRoute {
  /** The page's URL path, exactly as its `page.tsx` serves it. */
  path: string;
  /** The page's name as the app shows it. */
  label: string;
  /** What you do there, for the model to match a question to a page. */
  description: string;
  /** Instance configuration: only the Admin can open it. */
  adminOnly: boolean;
  /** A page only a Member has; the Admin's equivalent is another page. */
  memberOnly?: true;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: '/',
    label: 'Home',
    description:
      'Start a Session: describe the music, set the fine-tune picks, or jump back into a recent Session.',
    adminOnly: false,
  },
  {
    path: '/search',
    label: 'Search',
    description: 'Find any Session, Track or Playlist.',
    adminOnly: false,
  },
  {
    path: '/sessions',
    label: 'Sessions',
    description:
      'Your Sessions: the active one, the pinned ones and the history. Resume, pin or stop a Session, or open its Tracks.',
    adminOnly: false,
  },
  {
    path: '/library',
    label: 'Library',
    description: 'Your Tracks, under Playlists (Favorites leads them), Saved and History.',
    adminOnly: false,
  },
  {
    path: '/lounge',
    label: 'Lounge',
    description: 'The Playlists people on this instance share with each other.',
    adminOnly: false,
  },
  {
    path: '/player',
    label: 'Now Playing',
    description:
      'The full player for the music that is playing: transport, lyrics, sleep timer and the options menu.',
    adminOnly: false,
  },
  {
    path: '/stats',
    label: 'Your Stats',
    description: 'How much you listen and what you play most; clear your listening history.',
    adminOnly: false,
  },
  {
    path: '/settings',
    label: 'Settings',
    description: 'The overview of every settings page.',
    adminOnly: false,
  },
  {
    path: '/settings/profile',
    label: 'Settings › Profile',
    description: 'Your name, artist name, photo, city and country, and your password.',
    adminOnly: false,
  },
  {
    path: '/settings/people',
    label: 'Settings › People',
    description: 'Add People who can appear on covers and in personalized lyrics.',
    adminOnly: false,
  },
  {
    path: '/settings/storage',
    label: 'Settings › Storage',
    description:
      'The offline music kept on this device. The Admin also sees where audio and covers are stored and what cleanup deletes.',
    adminOnly: false,
  },
  {
    path: '/settings/generation',
    label: 'Settings › Generation',
    description:
      'The language Sessions use, whether new Sessions keep generating, and how many Tracks are generated ahead.',
    adminOnly: false,
  },
  {
    path: '/settings/playback',
    label: 'Settings › Playback',
    description: 'How one Track blends into the next, and personalization from learned taste.',
    adminOnly: false,
  },
  {
    path: '/settings/assistant',
    label: `Settings › ${ASSISTANT_NAME}`,
    description: `The tone ${ASSISTANT_NAME} answers you in: your own words, or a ready-made tone.`,
    adminOnly: false,
  },
  {
    path: '/settings/my-budget',
    label: 'Settings › My budget',
    description:
      'How many Tracks and covers you can still generate, from your own budget and the shared one. Read-only.',
    adminOnly: false,
    memberOnly: true,
  },
  {
    path: '/settings/limits',
    label: 'Settings › Cost limits',
    description:
      'Set the daily and monthly limits on Tracks and covers that keep spending in check.',
    adminOnly: true,
  },
  {
    path: '/settings/members',
    label: 'Settings › Members',
    description:
      "Invite people, set each Member's budget and the shared budget, choose who may use the Assistant and how many messages a day, and disable or remove a Member.",
    adminOnly: true,
  },
  {
    path: '/settings/providers',
    label: 'Settings › AI Providers',
    description:
      'Connect the music provider, the Text AI and the cover image provider: keys, models and unit costs.',
    adminOnly: true,
  },
  {
    path: '/settings/cover-art',
    label: 'Settings › Cover art',
    description:
      'Your default cover style, Tailored Cover Art, your own Custom style and whether the Text AI polishes cover text.',
    adminOnly: false,
  },
  {
    path: '/settings/backups',
    label: 'Settings › Backups',
    description: 'Set when backups run and how many copies are kept, and run a backup now.',
    adminOnly: true,
  },
  {
    path: '/settings/diagnostics',
    label: 'Settings › Diagnostics & worker',
    description: 'Check that providers, storage and the background worker are running properly.',
    adminOnly: true,
  },
];

/** The pages a user of this role can open, in the list's order. */
export function appRoutesFor(role: UserRole): readonly AppRoute[] {
  return APP_ROUTES.filter((route) => (role === 'admin' ? !route.memberOnly : !route.adminOnly));
}
