// The single definition of what a typed search query "matches": the field
// inventory per object kind, the exactness tiers, and the field weights that
// order equally-exact hits. Both /search's ranked retrieval and the Library's
// boolean filters derive their SQL from here, so the same words typed into two
// boxes can never disagree about what they find.

import { sql, type SQL } from 'drizzle-orm';
import { escapeRegExp, type SearchMatchField } from '@liedmotif/shared';
import {
  activitySessionQueueItems,
  activitySessions,
  generationRequests,
  listenerProfiles,
  playlists,
  playlistTracks,
  tracks,
  user,
} from '../schema';
import { escapeLikeTerm } from '../search-pattern';
import {
  playableSessionTrackCondition,
  sessionTrackQueueEdge,
} from '../generation/session-track-playability';
import { playlistMemberVisibleTo } from '../playlists/lounge-audible';

/**
 * Exactness tiers, best first: whole-field equality → starts-with →
 * word-start → anywhere → genre tag with punctuation ignored. A field's score
 * folds both dimensions into one integer (`exactness * EXACTNESS_STRIDE +
 * weight`), so a single `least(...)` picks the winning field and one ORDER BY
 * column applies the whole rank. The punctuation tier comes last so a hit on
 * the literal text always keeps its rank and field.
 */
const EXACTNESS_STRIDE = 8;
const LOOSE_TAG_EXACTNESS = 4;

export interface MatchPatterns {
  /** The trimmed query, lowercased, for whole-field equality. */
  whole: string;
  /** Escaped ILIKE pattern `query%`. */
  prefix: string;
  /** Escaped ILIKE pattern `%query%` — the match-or-not floor. */
  anywhere: string;
  /** Case-insensitive regex matching the query where it starts a word. */
  wordStart: string;
  /** See `looseTagPattern`. */
  looseTag: string | null;
}

const WORD_START = '(^|[^[:alnum:]])';
const ANY_SEPARATORS = '[^[:alnum:]]*';

export function buildMatchPatterns(query: string): MatchPatterns {
  const trimmed = query.trim();
  const escaped = escapeLikeTerm(trimmed);
  return {
    whole: trimmed.toLowerCase(),
    prefix: `${escaped}%`,
    anywhere: `%${escaped}%`,
    wordStart: `${WORD_START}${escapeRegExp(trimmed)}`,
    looseTag: looseTagPattern(trimmed),
  };
}

/**
 * Regex for a genre tag as a person types what its card shows: the query's
 * letters and digits with any punctuation allowed between them, "&" read as
 * "and". Null under two letters or digits, because "--" would otherwise match
 * every tag and "c#" every tag with a word starting in c.
 *
 * It must begin at a word start of the tag. Comparing separator-stripped text
 * anywhere would let "man" hit `drum-and-bass` and "pro" hit `pop-rock`.
 */
function looseTagPattern(query: string): string | null {
  // Tested before "&" expands: "&&" has no letters of its own to compare.
  if (!/[\p{L}\p{N}]/u.test(query)) return null;
  const chars = query.replace(/&/g, 'and').match(/[\p{L}\p{N}]/gu) ?? [];
  if (chars.length < 2) return null;
  return `${WORD_START}${chars.join(ANY_SEPARATORS)}`;
}

/**
 * One matchable field of an object kind: where its text lives and how strongly
 * a hit there ranks (weight 0 is the kind's best tier).
 */
export interface MatchFieldDef {
  field: SearchMatchField;
  weight: number;
  source:
    | { kind: 'text'; expr: SQL }
    /** A JSON array of genre tags. */
    | { kind: 'jsonbArray'; expr: SQL }
    /** Titles of the playlist's member tracks (correlates to `playlists.id`),
     *  limited to the members visible to `viewer` when one is given. */
    | { kind: 'memberTitles'; viewer?: string }
    /** Genre tags of the playlist's member tracks, gated like `memberTitles`. */
    | { kind: 'memberGenreTags'; viewer?: string }
    /** Titles of the Tracks the Session lists (correlates to `activity_sessions.id`). */
    | { kind: 'sessionTrackTitles' }
    /** Genre tags of those Tracks: what the Session's card shows, which outlives a
     *  Change Vibe's new snapshot. */
    | { kind: 'sessionTrackGenreTags' };
}

/**
 * Track surface: Name → Tags (genre tags, mood, activity) → Prompt → origin
 * Session title. Callers must join `activity_sessions` (via
 * `generation_requests`) for the session arm to resolve.
 */
export function trackMatchFields(): MatchFieldDef[] {
  return [
    { field: 'name', weight: 0, source: { kind: 'text', expr: sql`${tracks.title}` } },
    { field: 'tags', weight: 1, source: { kind: 'jsonbArray', expr: sql`${tracks.genreTags}` } },
    { field: 'tags', weight: 1, source: { kind: 'text', expr: sql`${tracks.mood}` } },
    { field: 'tags', weight: 1, source: { kind: 'text', expr: sql`${tracks.activity}` } },
    { field: 'prompt', weight: 2, source: { kind: 'text', expr: sql`${tracks.prompt}` } },
    {
      field: 'session',
      weight: 3,
      // A pending-delete Session reads as already deleted, as in `libraryColumns`.
      source: {
        kind: 'text',
        expr: sql`case when ${activitySessions.deleteRequestedAt} is null then ${activitySessions.title} end`,
      },
    },
  ];
}

/** Lyrics mode: sung lyric text is the only field. */
export function lyricsMatchFields(): MatchFieldDef[] {
  return [{ field: 'lyrics', weight: 0, source: { kind: 'text', expr: sql`${tracks.lyrics}` } }];
}

/**
 * Session surface: Name → Tags (style-snapshot genre tags, mood, activity, and
 * its listed Tracks' genre tags) → its listed Track titles → Prompt (the user's
 * own words, then the expanded style prompt).
 */
export function sessionMatchFields(): MatchFieldDef[] {
  return [
    { field: 'name', weight: 0, source: { kind: 'text', expr: sql`${activitySessions.title}` } },
    { field: 'tags', weight: 1, source: { kind: 'jsonbArray', expr: snapshotJson('genreTags') } },
    { field: 'tags', weight: 1, source: { kind: 'text', expr: snapshotText('mood') } },
    { field: 'tags', weight: 1, source: { kind: 'text', expr: snapshotText('activity') } },
    { field: 'tags', weight: 1, source: { kind: 'sessionTrackGenreTags' } },
    { field: 'tracks', weight: 2, source: { kind: 'sessionTrackTitles' } },
    {
      field: 'prompt',
      weight: 3,
      source: { kind: 'text', expr: sql`${activitySessions.userPrompt}` },
    },
    { field: 'prompt', weight: 3, source: { kind: 'text', expr: snapshotText('stylePrompt') } },
  ];
}

/**
 * Playlist surface: Name → member Track titles → member genre tags. Pass the
 * `viewer` whenever the row may be another owner's playlist, so a member
 * hidden from them can never be what matched (`playlistMemberVisibleTo`).
 */
export function playlistMatchFields(viewer?: string): MatchFieldDef[] {
  return [
    { field: 'name', weight: 0, source: { kind: 'text', expr: sql`${playlists.name}` } },
    { field: 'tracks', weight: 1, source: { kind: 'memberTitles', viewer } },
    { field: 'tags', weight: 2, source: { kind: 'memberGenreTags', viewer } },
  ];
}

/**
 * The Lounge box: the playlist vocabulary plus member genre tags
 * and the sharing owner's name — artist name and User name both answer to
 * "owner". Callers must join `user` and `listener_profiles` on the playlist's
 * owner for the owner arms to resolve. Sung lyrics are deliberately absent:
 * the Lounge search exposes nothing that browsing a shared playlist doesn't.
 */
export function loungeMatchFields(viewer: string): MatchFieldDef[] {
  return [
    ...playlistMatchFields(viewer),
    {
      field: 'owner',
      weight: 3,
      source: { kind: 'text', expr: sql`${listenerProfiles.artistName}` },
    },
    { field: 'owner', weight: 3, source: { kind: 'text', expr: sql`${user.name}` } },
  ];
}

function snapshotText(key: string): SQL {
  return sql`${activitySessions.sessionStyleSnapshot} ->> ${key}`;
}

function snapshotJson(key: string): SQL {
  return sql`${activitySessions.sessionStyleSnapshot} -> ${key}`;
}

/** Inline integer for CASE arms, where a bind parameter's type is ambiguous. */
function int(value: number): SQL {
  return sql.raw(String(value));
}

/** The exactness tier a winning score encodes — the stride's other half. */
export function exactnessFromScore(score: SQL): SQL {
  return sql`${score} / ${int(EXACTNESS_STRIDE)}`;
}

/**
 * The score of one text expression: `exactness * stride + weight`, or null
 * when the text does not contain the query at all.
 */
function textScore(expr: SQL, weight: number, p: MatchPatterns, looseTag?: SQL | null): SQL {
  return sql`case
    when lower(${expr}) = ${p.whole} then ${int(weight)}
    when ${expr} ilike ${p.prefix} then ${int(EXACTNESS_STRIDE + weight)}
    when ${expr} ~* ${p.wordStart} then ${int(2 * EXACTNESS_STRIDE + weight)}
    when ${expr} ilike ${p.anywhere} then ${int(3 * EXACTNESS_STRIDE + weight)}
    ${looseTag ? sql`when ${looseTag} then ${int(LOOSE_TAG_EXACTNESS * EXACTNESS_STRIDE + weight)}` : sql``}
  end`;
}

/** The array's elements as text rows; a missing or non-array value yields none. */
function arrayElements(expr: SQL): SQL {
  return sql`jsonb_array_elements_text(case when jsonb_typeof(${expr}) = 'array' then ${expr} end)`;
}

// NOTE: correlated references inside these subqueries are spelled
// `${playlists}."id"` — a bare `${playlists.id}` renders UNQUALIFIED ("id")
// inside query-builder subqueries and binds to the subquery's own tables.
const memberTitles = sql`${playlistTracks} pt join ${tracks} t on t.id = pt.track_id`;

function memberOfPlaylist(viewer: string | undefined): SQL {
  const ofPlaylist = sql`pt.playlist_id = ${playlists}."id"`;
  return viewer === undefined
    ? ofPlaylist
    : sql`${ofPlaylist} and ${playlistMemberVisibleTo(viewer, sql`t`)}`;
}

function sessionTracks(): SQL {
  return sql`${generationRequests}
    inner join ${tracks} on ${tracks.generationRequestId} = ${generationRequests.id}
    left join ${activitySessionQueueItems} on ${sessionTrackQueueEdge}`;
}

function listedInSession(): SQL {
  return sql`${generationRequests.activitySessionId} = ${activitySessions}."id"
    and ${playableSessionTrackCondition(sql`${activitySessions}."owner_user_id"`)}`;
}

/**
 * A many-valued field's candidate texts as a subquery source: one text column
 * over a FROM and the condition that correlates it to the outer row. Scoring
 * takes the best of them, the snippet takes the winner, and the boolean filter
 * asks whether any of them match.
 */
interface ValueRows {
  text: SQL;
  from: SQL;
  correlation: SQL;
  /** The values are genre tags, which also match with punctuation ignored. */
  genreTag?: true;
}

function valueRows(source: Exclude<MatchFieldDef['source'], { kind: 'text' }>): ValueRows {
  switch (source.kind) {
    case 'jsonbArray':
      return {
        text: sql`item.value`,
        from: sql`${arrayElements(source.expr)} item`,
        correlation: sql`true`,
        genreTag: true,
      };
    case 'memberTitles':
      return {
        text: sql`t.title`,
        from: memberTitles,
        correlation: memberOfPlaylist(source.viewer),
      };
    case 'memberGenreTags':
      // The set-returning function references t, so it must follow the join —
      // Postgres treats it as an implicit LATERAL.
      return {
        text: sql`tag.value`,
        from: sql`${memberTitles}, ${arrayElements(sql.raw('t.genre_tags'))} tag`,
        correlation: memberOfPlaylist(source.viewer),
        genreTag: true,
      };
    case 'sessionTrackTitles':
      return {
        text: sql`${tracks.title}`,
        from: sessionTracks(),
        correlation: listedInSession(),
      };
    case 'sessionTrackGenreTags':
      return {
        text: sql`tag.value`,
        from: sql`${sessionTracks()}, ${arrayElements(sql`${tracks}."genre_tags"`)} tag`,
        correlation: listedInSession(),
        genreTag: true,
      };
  }
}

/** The punctuation-ignoring test for one genre tag value; null when it does not apply. */
function looseTagMatch(rows: ValueRows, p: MatchPatterns): SQL | null {
  if (!rows.genreTag || !p.looseTag) return null;
  return sql`replace(${rows.text}, '&', ' and ') ~* ${p.looseTag}`;
}

/** A field's score: the best (lowest) score among its values, null when none match. */
export function fieldScore(def: MatchFieldDef, p: MatchPatterns): SQL {
  if (def.source.kind === 'text') return textScore(def.source.expr, def.weight, p);
  const rows = valueRows(def.source);
  return sql`(select min(${textScore(rows.text, def.weight, p, looseTagMatch(rows, p))})
    from ${rows.from} where ${rows.correlation})`;
}

/** The field's winning text — what the match-context snippet is cut from. */
export function fieldText(def: MatchFieldDef, p: MatchPatterns): SQL {
  if (def.source.kind === 'text') return def.source.expr;
  const rows = valueRows(def.source);
  const score = textScore(rows.text, 0, p, looseTagMatch(rows, p));
  return sql`(select ${rows.text} from ${rows.from}
    where ${rows.correlation} and ${score} is not null
    order by ${score}, ${rows.text} limit 1)`;
}

/** Boolean "does this field match" — any tier at all, the Library's filter. */
function fieldMatches(def: MatchFieldDef, p: MatchPatterns): SQL {
  if (def.source.kind === 'text') return sql`${def.source.expr} ilike ${p.anywhere}`;
  const rows = valueRows(def.source);
  const literal = sql`${rows.text} ilike ${p.anywhere}`;
  const loose = looseTagMatch(rows, p);
  return sql`exists (select 1 from ${rows.from}
    where ${rows.correlation} and ${loose ? sql`(${literal} or ${loose})` : literal})`;
}

/** How many member track titles match — the playlist row's "N matches" meta. */
export function memberTitleMatchCount(pattern: string, viewer?: string): SQL {
  return sql`(select count(*)::int from ${memberTitles}
    where ${memberOfPlaylist(viewer)} and t.title ilike ${pattern})`;
}

/**
 * The winning field among per-def scores read back into JS: lowest score wins,
 * definition order breaks ties — the same choice the ranked query's
 * `least(...)` + CASE arms make in SQL, for callers that keep their own row
 * order (the Lounge narrows, never re-ranks) and only need the field named.
 * Returns -1 when nothing matched.
 */
export function winningMatchIndex(scores: ReadonlyArray<number | null>): number {
  let winner = -1;
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (score === null || score === undefined) continue;
    if (winner === -1 || score < scores[winner]!) winner = i;
  }
  return winner;
}

/**
 * One boolean condition over a kind's whole field surface: the Library's
 * search boxes filter on it, and the ranked query uses it as its eligibility
 * prefilter — it tests the same floor every score implies (`anywhere`, plus the
 * punctuation-ignoring test on genre tags), so the condition and a non-null
 * score select exactly the same rows.
 */
export function matchCondition(defs: MatchFieldDef[], p: MatchPatterns): SQL {
  return sql`(${sql.join(
    defs.map((def) => fieldMatches(def, p)),
    sql` or `,
  )})`;
}

/**
 * A Library search box as a condition. Undefined for a blank term, which every
 * caller reads as "no search filter at all" rather than "match nothing".
 */
export function searchBoxCondition(
  defs: MatchFieldDef[],
  term: string | null | undefined,
): SQL | undefined {
  return term?.trim() ? matchCondition(defs, buildMatchPatterns(term)) : undefined;
}
