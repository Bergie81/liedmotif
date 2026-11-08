import {
  getCachedLearnedTaste,
  getCoverArtSettings,
  getGenerationSettings,
  getUsageLimits,
  rankForYouGenres,
} from '@liedmotif/db';
import { GENRE_IDS, GENRE_SHORTLIST_SIZE } from '@/components/create/genre-vocabulary';
import { INTENT_PARAM, intentFromParam } from '@/components/create/intent-prefill';
import { hourInTimezone, pickGreeting } from '@/components/home/home-greeting';
import { HomeView } from '@/components/home/home-view';
import { RECENT_SESSIONS_LIMIT } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { getLlmProvider } from '@/lib/providers';
import { requireAppAccess } from '@/lib/session';
import { loadSessionList } from '@/lib/sessions';
import { loadPendingSurprise } from '@/lib/surprise-me';
import { resolveOwnVoiceOffer, type OwnVoiceOffer } from '@/lib/voice';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The search empty state hands its query over as ?intent= — seeded into the
  // Describe field for review, never auto-submitted.
  const initialPrompt = intentFromParam((await searchParams)[INTENT_PARAM]);
  // The create card preselects the saved defaults (cover style from Settings →
  // Cover Arts, language from Settings → Generation) and offers the User's
  // For you genres first. All are best-effort cosmetics: a read failure
  // degrades to the `auto` preselects and the default genre shortlist, never a
  // 500.
  const viewer = requireAppAccess().catch(() => null);
  const [
    coverArtDefaults,
    defaultLanguage,
    llmProvider,
    forYouGenres,
    ownVoiceOffer,
    recentSessions,
    localHour,
    pendingSurprise,
  ] = await Promise.all([
    getCoverArtSettings(getDb())
      .then((settings) => ({
        defaultCoverStyle: settings.defaultStyle,
        defaultUseStandardCover: settings.useStandardCoverArt,
      }))
      .catch(() => undefined),
    viewer
      .then((value) => (value ? getGenerationSettings(getDb(), value.session.user.id) : null))
      .then((settings) => settings?.defaultLanguage)
      .catch(() => undefined),
    getLlmProvider().catch(() => null),
    viewer
      .then((value) =>
        value
          ? getUsageLimits(getDb())
              .then(({ resetTimezone }) =>
                getCachedLearnedTaste(getDb(), {
                  ownerUserId: value.session.user.id,
                  now: new Date(),
                  timezone: resetTimezone,
                }),
              )
              .then((taste) =>
                rankForYouGenres(taste, { vocabulary: GENRE_IDS, limit: GENRE_SHORTLIST_SIZE }),
              )
          : [],
      )
      .catch(() => [] as string[]),
    viewer
      .then((value) =>
        value
          ? resolveOwnVoiceOffer(getDb(), { userId: value.session.user.id, role: value.role })
          : 'hidden',
      )
      .catch((): OwnVoiceOffer => 'hidden'),
    viewer
      .then((value) =>
        value
          ? loadSessionList(getDb(), value.session.user.id, {
              limit: RECENT_SESSIONS_LIMIT,
              includeActive: false,
              includePinned: false,
            })
          : null,
      )
      .catch(() => null),
    // The instance reset timezone is the app's one declared local clock (the
    // container's own is typically UTC), so it decides which daypart the
    // headline may greet.
    getUsageLimits(getDb())
      .then(({ resetTimezone }) => hourInTimezone(new Date(), resetTimezone))
      .catch(() => null),
    viewer
      .then((value) => (value ? loadPendingSurprise(getDb(), value.session.user.id) : null))
      .catch(() => null),
  ]);

  return (
    <HomeView
      greeting={pickGreeting(localHour, Math.random)}
      llmConfigured={llmProvider !== null}
      forYouGenres={forYouGenres}
      ownVoiceOffer={ownVoiceOffer}
      pendingSurprise={pendingSurprise}
      {...(initialPrompt ? { initialPrompt } : {})}
      {...(coverArtDefaults ?? {})}
      {...(defaultLanguage ? { defaultLanguage } : {})}
      {...(recentSessions ? { initialSessions: recentSessions } : {})}
    />
  );
}
