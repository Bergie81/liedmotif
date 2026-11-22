import {
  getCachedLearnedTaste,
  getHomeGreetingFacts,
  getCoverArtSettings,
  getGenerationSettings,
  getUsageLimits,
  rankForYouGenres,
} from '@liedmotif/db';
import { GENRE_IDS, GENRE_SHORTLIST_SIZE, genreLabel } from '@/components/create/genre-vocabulary';
import { INTENT_PARAM, intentFromParam } from '@/components/create/intent-prefill';
import {
  anniversaryYears,
  localClock,
  NO_GREETING_FACTS,
  pickGreeting,
  type GreetingFacts,
} from '@/components/home/home-greeting';
import { HomeView } from '@/components/home/home-view';
import { RECENT_SESSIONS_LIMIT } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { getLlmProvider } from '@/lib/providers/providers';
import { requireAppAccess } from '@/lib/auth/session';
import { loadSessionList } from '@/lib/sessions/sessions';
import { loadPendingSurprise } from '@/lib/sessions/surprise-me';
import { resolveOwnVoiceOffer, type OwnVoiceOffer } from '@/lib/voice/voice';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The search empty state hands its query over as ?intent= — seeded into the
  // Describe field for review, never auto-submitted.
  const initialPrompt = intentFromParam((await searchParams)[INTENT_PARAM]);
  // The create card preselects the viewer's saved defaults (cover style from
  // Settings → Cover art, language and the duration Auto stands for from
  // Settings → Generation) and offers the User's For you genres first. All are
  // best-effort cosmetics: a read failure degrades to the `auto` preselects,
  // the shipped duration and the default genre shortlist, never a 500.
  const viewer = requireAppAccess().catch(() => null);
  const [
    coverArtDefaults,
    generationDefaults,
    llmProvider,
    forYouGenres,
    ownVoiceOffer,
    recentSessions,
    timezone,
    greetingFacts,
    pendingSurprise,
  ] = await Promise.all([
    viewer
      .then((value) => (value ? getCoverArtSettings(getDb(), value.session.user.id) : null))
      .then((settings) =>
        settings
          ? {
              defaultCoverStyle: settings.defaultStyle,
              defaultUseStandardCover: settings.useStandardCoverArt,
            }
          : undefined,
      )
      .catch(() => undefined),
    viewer
      .then((value) => (value ? getGenerationSettings(getDb(), value.session.user.id) : null))
      .then((settings) =>
        settings
          ? {
              defaultLanguage: settings.defaultLanguage,
              defaultSessionDurationMinutes: settings.defaultSessionDurationMinutes,
            }
          : undefined,
      )
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
    // container's own is typically UTC), so it decides the day and hour the
    // headline may greet.
    getUsageLimits(getDb())
      .then(({ resetTimezone }) => resetTimezone)
      .catch(() => null),
    viewer
      .then((value) =>
        value
          ? getHomeGreetingFacts(getDb(), { ownerUserId: value.session.user.id, now: new Date() })
          : null,
      )
      .catch(() => null),
    viewer
      .then((value) => (value ? loadPendingSurprise(getDb(), value.session.user.id) : null))
      .catch(() => null),
  ]);

  const now = new Date();
  const clock = timezone ? localClock(now, timezone) : null;
  const joinedAt = await viewer.then((value) => value?.session.user.createdAt ?? null);
  // Every fact is a best-effort cosmetic: a failed read only drops its lines.
  const facts: GreetingFacts = {
    ...NO_GREETING_FACTS,
    lastSessionTitle: recentSessions?.items[0]?.title ?? null,
    topGenre: forYouGenres[0] ? genreLabel(forYouGenres[0]) : null,
    ...(greetingFacts
      ? {
          totalTracks: greetingFacts.totalTracks,
          tracksThisWeek: greetingFacts.tracksThisWeek,
          daysSinceListening: greetingFacts.lastListenedAt
            ? Math.floor((now.getTime() - greetingFacts.lastListenedAt.getTime()) / 86_400_000)
            : null,
        }
      : {}),
    anniversaryYears:
      timezone && joinedAt
        ? anniversaryYears(localClock(new Date(joinedAt), timezone), clock)
        : null,
  };

  return (
    <HomeView
      greeting={pickGreeting(clock, facts, Math.random)}
      llmConfigured={llmProvider !== null}
      forYouGenres={forYouGenres}
      ownVoiceOffer={ownVoiceOffer}
      pendingSurprise={pendingSurprise}
      {...(initialPrompt ? { initialPrompt } : {})}
      {...(coverArtDefaults ?? {})}
      {...(generationDefaults ?? {})}
      {...(recentSessions ? { initialSessions: recentSessions } : {})}
    />
  );
}
