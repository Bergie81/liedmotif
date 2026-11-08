// Learned taste: what a User's own engagement with their own Tracks
// says about the music they like. A deterministic calculation kept apart from
// the measured stats — it ranks fine-tune suggestions and feeds Surprise Me,
// and nothing here is read when an ordinary Session compiles or runs.
//
// Evidence is listening occurrences plus `taste_evidence` (current curation and
// rerolls). Both carry frozen musical facts and no content link, so removing
// music never unlearns it.

import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  listeningOccurrences,
  listeningPreferences,
  tasteEvidence,
  tracks,
  userSettings,
  USER_SETTINGS_KEYS,
  type TasteEvidenceKind,
} from '../schema';
import { readUserSetting, writeUserSetting } from '../settings/user-settings-repo';
import { withTransaction, type Transaction } from '../transactions';
import { ensurePreferences, normalizedGenreTags, trackLanguage } from './listening-repo';
import { invalidateProposalsInTx } from './surprise-proposal-repo';

/**
 * The whole model. A Track's score is its curation weight plus its decayed
 * listening, and every facet (genre, energy, …) sums the scores of the Tracks
 * carrying it; a Track's score is shared equally between its genres.
 *
 * - Curation is explicit and current, so it outweighs any single play and does
 *   not decay. A Track holds one curation weight: `favorite`, else `playlist`.
 * - A qualifying play the User started (`deliberatePlay`) counts double one the
 *   Queue or a loop started (`passivePlay`); only the first
 *   `passivePlaysPerTrackPerDay` passive plays of a Track count per reporting day.
 * - Listening halves every `halfLifeDays`.
 * - An early skip (moved off before the play threshold, after at least
 *   `heardMs`) subtracts from that Track's own listening, which never drops
 *   below zero: doubt about a Track is not a verdict on its genres. A reroll
 *   multiplies the Track's listening by `rerollFactor`.
 * - Taste is `confident` from `minTracks` contributing Tracks and `minScore`
 *   total; below that callers fall back to curated defaults.
 */
const TASTE_COEFFICIENTS = {
  favorite: 8,
  playlist: 5,
  deliberatePlay: 2,
  passivePlay: 1,
  earlySkip: 0.5,
  rerollFactor: 0.25,
  halfLifeDays: 90,
  passivePlaysPerTrackPerDay: 3,
  heardMs: 3_000,
  minTracks: 3,
  minScore: 6,
} as const;

/** Genres kept in a taste answer — comfortably more than the pickable vocabulary. */
const GENRE_FACET_LIMIT = 60;

export interface TasteFacet {
  value: string;
  score: number;
}

export interface LearnedTaste {
  /** Personalize suggestions is on. Off means nothing below may be used, and nothing is. */
  enabled: boolean;
  /** Enough evidence to prefer this over curated defaults. */
  confident: boolean;
  /** Normalized (`lower(btrim(..))`) genre tags, strongest first. */
  genres: TasteFacet[];
  energies: TasteFacet[];
  vocalModes: TasteFacet[];
  /** Lowercased sung languages of vocal Tracks. */
  languages: TasteFacet[];
  /** Score-weighted mean tempo; null when no contributing Track has one. */
  tempoBpm: number | null;
}

const NO_TASTE = {
  confident: false,
  genres: [],
  energies: [],
  vocalModes: [],
  languages: [],
  tempoBpm: null,
} satisfies Omit<LearnedTaste, 'enabled'>;

export interface LearnedTasteQuery {
  ownerUserId: string;
  now: Date;
  /** The Instance timezone; a day of listening is a calendar day in it. */
  timezone: string;
}

async function readPreferences(db: Database | Transaction, ownerUserId: string) {
  await ensurePreferences(db, ownerUserId);
  const [row] = await db
    .select()
    .from(listeningPreferences)
    .where(eq(listeningPreferences.ownerUserId, ownerUserId));
  return row ?? null;
}

export async function getPersonalization(
  db: Database,
  ownerUserId: string,
): Promise<{ enabled: boolean }> {
  return { enabled: (await readPreferences(db, ownerUserId))?.personalizeSuggestions ?? true };
}

/**
 * Take the owner's existing Favorites and Playlist members as starting
 * evidence, exactly once per account. Only curation is taken: no listening is
 * implied. Tracks are matched by owner, so a Shared reference filed in an owned
 * Playlist is not evidence.
 */
async function seedFromCuration(db: Database, input: LearnedTasteQuery): Promise<void> {
  await withTransaction(db, async (tx) => {
    const claimed = await tx.execute(sql`
      update ${listeningPreferences} set taste_seeded_at = ${input.now.toISOString()}::timestamptz
      where owner_user_id = ${input.ownerUserId}
        and taste_seeded_at is null and personalize_suggestions
      returning owner_user_id
    `);
    if (claimed.rows.length === 0) return;
    await tx.execute(sql`
      insert into ${tasteEvidence}
        (owner_user_id, analytics_track_id, kind, genre_tags, energy, vocal_mode, bpm_estimate, language)
      select ${tracks.ownerUserId}, ${tracks.analyticsId},
        case when ${tracks.favoritedAt} is not null then 'favorite' else 'playlist' end,
        ${tracks.genreTags}, ${tracks.energy}, ${tracks.vocalMode}, ${tracks.bpmEstimate}, ${trackLanguage()}
      from ${tracks}
      where ${tracks.ownerUserId} = ${input.ownerUserId}
        and ${tracks.status} not in ('rejected', 'deleted')
        and (${tracks.favoritedAt} is not null or ${tracks.savedAt} is not null)
      on conflict do nothing
    `);
  });
}

export async function getLearnedTaste(
  db: Database,
  input: LearnedTasteQuery,
): Promise<LearnedTaste> {
  let preferences = await readPreferences(db, input.ownerUserId);
  if (!preferences?.personalizeSuggestions) return { enabled: false, ...NO_TASTE };
  if (!preferences.tasteSeededAt) {
    await seedFromCuration(db, input);
    preferences = (await readPreferences(db, input.ownerUserId)) ?? preferences;
  }

  const c = TASTE_COEFFICIENTS;
  const o = listeningOccurrences;
  const now = sql`${input.now.toISOString()}::timestamptz`;
  const { timezone } = input;
  const boundary = preferences.tasteResetAt?.toISOString() ?? null;
  const passive = sql`(${o.qualifiedAt} is not null and ${o.startOrigin} is distinct from 'user')`;
  const happenedAt = sql`coalesce(${o.qualifiedAt}, ${o.lastListenedAt})`;

  const result = await db.execute<{ facet: string; value: string | null; score: number }>(sql`
    with listens as (
      select ${o.analyticsTrackId} as analytics_track_id, ${o.genreTags} as genre_tags,
        ${o.energy} as energy, ${o.vocalMode} as vocal_mode, ${o.bpmEstimate} as bpm_estimate,
        ${o.language} as language,
        ${passive} as passive,
        (case when ${o.qualifiedAt} is null then ${-c.earlySkip}::float8
              when ${passive} then ${c.passivePlay}::float8
              else ${c.deliberatePlay}::float8 end)
          * power(0.5::float8, greatest(0, extract(epoch from (${now} - ${happenedAt})))
              / ${c.halfLifeDays * 86_400}::float8) as weight,
        row_number() over (
          partition by ${o.analyticsTrackId}, ${passive}, (${happenedAt} at time zone ${timezone})::date
          order by ${happenedAt}
        ) as day_rank
      from ${o}
      where ${o.ownerUserId} = ${input.ownerUserId}
        and ${o.tasteEligible}
        and (${boundary}::timestamptz is null or ${o.startedAt} > ${boundary}::timestamptz)
        and (${o.qualifiedAt} is not null
          or (${o.endReason} = 'navigated' and ${o.playedMs} >= ${c.heardMs}))
    ),
    listened as (
      select analytics_track_id,
        greatest(0, sum(weight) filter (
          where not passive or day_rank <= ${c.passivePlaysPerTrackPerDay}
        )) as score
      from listens group by analytics_track_id
    ),
    evidence as (
      select analytics_track_id, kind, genre_tags, energy, vocal_mode, bpm_estimate, language
      from ${tasteEvidence} where owner_user_id = ${input.ownerUserId}
    ),
    facts as (
      select distinct on (analytics_track_id)
        analytics_track_id, genre_tags, energy, vocal_mode, bpm_estimate, language
      from (
        select analytics_track_id, genre_tags, energy, vocal_mode, bpm_estimate, language from evidence
        union all
        select analytics_track_id, genre_tags, energy, vocal_mode, bpm_estimate, language from listens
      ) as known
      order by analytics_track_id
    ),
    scored as (
      select facts.*,
        coalesce(listened.score, 0)
          * (case when evidence.kind = 'reroll' then ${c.rerollFactor}::float8 else 1 end)
          + (case evidence.kind when 'favorite' then ${c.favorite}::float8
                                when 'playlist' then ${c.playlist}::float8 else 0 end) as score
      from facts
      left join listened using (analytics_track_id)
      left join evidence using (analytics_track_id)
    ),
    liked as (select * from scored where score > 0),
    genres as (
      select tag as value, sum(liked.score / cardinality(n.tags)) as score
      from liked
      cross join lateral (
        select ${normalizedGenreTags(sql`liked.genre_tags`)} as tags
      ) as n
      cross join lateral unnest(n.tags) as tag
      group by tag
      order by score desc, tag
      limit ${GENRE_FACET_LIMIT}
    )
    select 'genre' as facet, value, score::float8 as score from genres
    union all
    select 'energy', energy, sum(score)::float8 from liked where energy is not null group by energy
    union all
    select 'vocal', vocal_mode::text, sum(score)::float8 from liked
      where vocal_mode is not null group by vocal_mode
    union all
    select 'language', lower(language), sum(score)::float8 from liked
      where vocal_mode = 'vocal' and language is not null group by lower(language)
    union all
    select 'tempo', null, (sum(score * bpm_estimate) / sum(score))::float8 from liked
      where bpm_estimate is not null having sum(score) > 0
    union all
    select 'tracks', null, count(*)::float8 from liked
    union all
    select 'total', null, coalesce(sum(score), 0)::float8 from liked
  `);

  const facet = (name: string): TasteFacet[] =>
    result.rows
      .filter((row) => row.facet === name && row.value !== null)
      .map((row) => ({ value: row.value!, score: Number(row.score) }))
      .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
  const single = (name: string) => {
    const row = result.rows.find((r) => r.facet === name);
    return row ? Number(row.score) : null;
  };

  return {
    enabled: true,
    confident: (single('tracks') ?? 0) >= c.minTracks && (single('total') ?? 0) >= c.minScore,
    genres: facet('genre'),
    energies: facet('energy'),
    vocalModes: facet('vocal'),
    languages: facet('language'),
    tempoBpm: single('tempo'),
  };
}

/**
 * The For you genres: the learned ranking within `vocabulary`, or nothing —
 * the caller's curated defaults — while taste is off or too thin to trust.
 * Ranked inside the vocabulary so free-text tags never crowd pickable genres out.
 */
export function rankForYouGenres(
  taste: LearnedTaste,
  options: { vocabulary: readonly string[]; limit: number },
): string[] {
  if (!taste.enabled || !taste.confident) return [];
  const pickable = new Set(options.vocabulary);
  return taste.genres
    .filter((genre) => pickable.has(genre.value))
    .slice(0, options.limit)
    .map((genre) => genre.value);
}

/** How long an answer is served. Taste ranks months of evidence, so minutes of lag are invisible. */
const LEARNED_TASTE_CACHE_TTL_MS = 15 * 60_000;

interface CachedLearnedTaste {
  /**
   * The state the answer was computed under: the switch and both boundaries.
   * A reset, a clearing or a toggle changes it, so an answer measured before
   * one is never served after it, whenever its write lands.
   */
  query: string;
  measuredAt: string;
  taste: LearnedTaste;
}

/**
 * `getLearnedTaste` behind a per-owner cache — the seam user-facing reads use;
 * Home asks on every load. Concurrent misses both measure and write the same answer.
 */
export async function getCachedLearnedTaste(
  db: Database,
  input: LearnedTasteQuery,
): Promise<LearnedTaste> {
  const stateKey = async () => {
    const preferences = await readPreferences(db, input.ownerUserId);
    return [
      preferences?.personalizeSuggestions ?? true,
      preferences?.tasteResetAt?.toISOString() ?? '-',
      preferences?.tasteSeededAt?.toISOString() ?? '-',
      input.timezone,
    ].join('|');
  };
  const cached = await readUserSetting<CachedLearnedTaste>(
    db,
    input.ownerUserId,
    USER_SETTINGS_KEYS.learnedTaste,
  );
  const age = cached ? input.now.getTime() - Date.parse(cached.measuredAt) : NaN;
  const before = await stateKey();
  if (cached?.query === before && age >= 0 && age < LEARNED_TASTE_CACHE_TTL_MS) {
    return cached.taste;
  }
  const taste = await getLearnedTaste(db, input);
  // Cached only when the state held still while measuring: a toggle, reset or
  // clearing landing mid-measurement would otherwise file the old answer under
  // the new state. The first measurement stamps the seeding, so it is simply
  // measured again on the next read.
  const after = await stateKey();
  if (after !== before) return taste;
  const measured: CachedLearnedTaste = {
    query: after,
    measuredAt: input.now.toISOString(),
    taste,
  };
  await writeUserSetting(db, input.ownerUserId, USER_SETTINGS_KEYS.learnedTaste, measured);
  return taste;
}

/**
 * Start learned taste afresh inside the caller's transaction: forget the
 * curation evidence, move the boundary past all listening so far, and mark
 * seeding done so current memberships cannot refill it. Updating the
 * preferences row first is the lock every evidence writer shares, so a write in
 * flight either lands before the delete or counts as engagement after it.
 */
export async function resetLearnedTasteInTx(
  tx: Transaction,
  input: { ownerUserId: string; now: Date },
): Promise<void> {
  await ensurePreferences(tx, input.ownerUserId);
  const at = sql`${input.now.toISOString()}::timestamptz`;
  await tx.execute(sql`
    update ${listeningPreferences}
    set taste_reset_at = ${at}, taste_seeded_at = coalesce(taste_seeded_at, ${at})
    where owner_user_id = ${input.ownerUserId}
  `);
  await tx.delete(tasteEvidence).where(eq(tasteEvidence.ownerUserId, input.ownerUserId));
  await dropCachedTaste(tx, input.ownerUserId);
  await invalidateProposalsInTx(tx, input.ownerUserId);
}

async function dropCachedTaste(tx: Transaction, ownerUserId: string) {
  await tx
    .delete(userSettings)
    .where(
      and(
        eq(userSettings.ownerUserId, ownerUserId),
        eq(userSettings.key, USER_SETTINGS_KEYS.learnedTaste),
      ),
    );
}

/** Reset learned taste: listening history and its stats are untouched. */
export async function resetLearnedTaste(
  db: Database,
  input: { ownerUserId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await withTransaction(db, (tx) => resetLearnedTasteInTx(tx, { ...input, now }));
}

/**
 * Turn Personalize suggestions on or off. Off stops both learning and use;
 * what was learned before stays for a later return. Either way seeding is
 * marked done, so curation made while off is never swept in afterwards.
 */
export async function setPersonalizeSuggestions(
  db: Database,
  input: { ownerUserId: string; enabled: boolean; now?: Date },
): Promise<void> {
  const at = sql`${(input.now ?? new Date()).toISOString()}::timestamptz`;
  await withTransaction(db, async (tx) => {
    await ensurePreferences(tx, input.ownerUserId);
    const changed = await tx.execute(sql`
      update ${listeningPreferences}
      set personalize_suggestions = ${input.enabled},
          taste_seeded_at = case when ${input.enabled} then taste_seeded_at
                                 else coalesce(taste_seeded_at, ${at}) end
      where owner_user_id = ${input.ownerUserId}
        and personalize_suggestions <> ${input.enabled}
    `);
    // A repeated request changes no permission, so the pending proposal stands.
    if (changed.rowCount === 0) return;
    await dropCachedTaste(tx, input.ownerUserId);
    await invalidateProposalsInTx(tx, input.ownerUserId);
  });
}

/**
 * Whether the owner is learning right now, read under the shared lock a reset
 * takes exclusively — held to the end of the caller's transaction.
 */
async function isLearningInTx(tx: Transaction, ownerUserId: string): Promise<boolean> {
  await ensurePreferences(tx, ownerUserId);
  const [row] = await tx
    .select({ enabled: listeningPreferences.personalizeSuggestions })
    .from(listeningPreferences)
    .where(eq(listeningPreferences.ownerUserId, ownerUserId))
    .for('share');
  return row?.enabled ?? false;
}

/**
 * Bring a Track's evidence row in line with a change the owner just made to it.
 * `gained` is a new act of curation or a reroll and may create the row; losing
 * a flag only ever downgrades or removes an existing one, so un-favoriting an
 * old Track after a reset teaches nothing. Owner-matched: a Shared reference
 * never becomes evidence. Skipped entirely while personalization is off.
 */
export async function recordTasteEvidenceInTx(
  tx: Transaction,
  input: { ownerUserId: string; trackId: string; kind: TasteEvidenceKind | null; gained: boolean },
): Promise<void> {
  if (!(await isLearningInTx(tx, input.ownerUserId))) return;
  const track = sql`${tracks.id} = ${input.trackId} and ${tracks.ownerUserId} = ${input.ownerUserId}`;
  const analyticsId = sql`(select ${tracks.analyticsId} from ${tracks} where ${track})`;
  if (input.kind === null) {
    await tx.execute(sql`
      delete from ${tasteEvidence}
      where owner_user_id = ${input.ownerUserId} and analytics_track_id = ${analyticsId}
    `);
  } else if (input.gained) {
    await tx.execute(sql`
      insert into ${tasteEvidence}
        (owner_user_id, analytics_track_id, kind, genre_tags, energy, vocal_mode, bpm_estimate, language)
      select ${tracks.ownerUserId}, ${tracks.analyticsId}, ${input.kind},
        ${tracks.genreTags}, ${tracks.energy}, ${tracks.vocalMode}, ${tracks.bpmEstimate}, ${trackLanguage()}
      from ${tracks} where ${track}
      on conflict (owner_user_id, analytics_track_id) do update set kind = excluded.kind
    `);
  } else {
    await tx.execute(sql`
      update ${tasteEvidence} set kind = ${input.kind}
      where owner_user_id = ${input.ownerUserId} and analytics_track_id = ${analyticsId}
    `);
  }
}
