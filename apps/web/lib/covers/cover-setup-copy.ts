// Cover regeneration needs two instance settings only the Admin can change.
// A Member is told who can fix them, never pointed at an admin-only settings
// page. Client-safe: the cover sheet shares this copy.

export type CoverSetupGap = 'generation_disabled' | 'provider_unconfigured';

const COVER_SETUP_MESSAGES: Readonly<Record<CoverSetupGap, Record<'admin' | 'member', string>>> = {
  generation_disabled: {
    admin: 'Tailored Cover Art is turned off under Settings → Generation.',
    member: 'Tailored Cover Art is turned off on this server. Ask the admin to turn it on.',
  },
  provider_unconfigured: {
    admin: 'No image provider is configured under Settings → Providers.',
    member: 'No image provider is set up on this server. Ask the admin to add one.',
  },
};

export function coverSetupMessage(gap: CoverSetupGap, role: 'admin' | 'member'): string {
  return COVER_SETUP_MESSAGES[gap][role];
}
