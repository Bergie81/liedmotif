// A new Session is refused while the music model cannot be reached: no key
// anywhere, a stored one that cannot be read, or an unknown music provider.
// Only the Admin can fix that, so a Member is told who can, never pointed at an
// admin-only settings page. Fixed copy: no error text or secret ever joins it.

const MUSIC_SETUP_MESSAGES: Readonly<Record<'admin' | 'member', string>> = {
  admin: "The music key is missing or can't be read. Enter it under Settings › AI Providers.",
  member: "Music isn't set up on this server yet. Ask the Admin to set it up.",
};

export function musicSetupMessage(role: 'admin' | 'member'): string {
  return MUSIC_SETUP_MESSAGES[role];
}
