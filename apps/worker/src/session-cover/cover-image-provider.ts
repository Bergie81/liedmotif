// Which generated-image provider a Session Cover attempt runs against.
//
// There are two sources: the image provider (OpenRouter) paints a
// PROMPT-DRIVEN cover around the session's style and People, and the music
// provider's cover endpoint draws one from the music alone. The prompt-driven
// source is the owner's `tailoredCoverArtEnabled` opt-in and needs
// credentials; the music-provider source needs neither and takes over whenever
// the tailored one cannot run, so a session that expects a generated cover
// gets one either way. A session that chose STANDARD covers wants the
// music-provider source first, with the tailored one only as the stand-in when
// it is unbuildable. User regenerations are prompt-driven ONLY — the standard
// source yields one cover per music task, so re-hitting it cannot produce a new
// cover. The shared cover budget is enforced downstream at admission, so this
// selection can never bypass the spend caps.

import { getUsageLimits, type Database } from '@liedmotif/db';
import type { GeneratedImageProvider } from '@liedmotif/providers';

export interface SessionCoverProviders {
  /** Prompt-driven generated covers (OpenRouter); null when unconfigured. */
  getCoverArt: () => Promise<GeneratedImageProvider | null>;
  /** Music-task-driven standard covers (Suno); null when unbuildable. */
  getSunoCoverArt: () => Promise<GeneratedImageProvider | null>;
}

/**
 * Each source is resolved only when the choice reaches it, so a source that
 * cannot resolve (a credential that no longer decrypts) never blocks a cover
 * the other one paints.
 */
export async function resolveSessionCoverImageProvider(
  db: Database,
  providers: SessionCoverProviders,
  /** The session the cover belongs to; null for a user regeneration. */
  session: { useStandardCover: boolean } | null,
): Promise<GeneratedImageProvider | null> {
  // The provider is tested before the switch, so an instance without an image
  // provider never reads limits to decide a question its absence already answers.
  const tailored = async () => {
    const coverArt = await providers.getCoverArt();
    return coverArt && (await getUsageLimits(db)).tailoredCoverArtEnabled ? coverArt : null;
  };
  if (session === null) return tailored();
  return session.useStandardCover
    ? ((await providers.getSunoCoverArt()) ?? tailored())
    : ((await tailored()) ?? providers.getSunoCoverArt());
}
