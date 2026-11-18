// Session-level text-LLM prompt policy. Provider adapters own transport, retries,
// and parsing; this module owns the prompts shared by expansion and naming.

import type { CoverStylePreset, ListenerContext } from '@liedmotif/shared';
import { MAX_LYRIC_CONTEXT_LENGTH, type SessionStyleSnapshot } from './snapshot';
import type { StylePicks } from './template';

const LYRIC_CONTEXT_PURPOSE =
  'organize a coherent group of request-relevant personal details into lyrical direction';
const LYRIC_CONTEXT_FORMAT = `compact labeled creative notes that ${LYRIC_CONTEXT_PURPOSE}`;

/** How an adjustment treats the running lyrical direction — the same
 * keep-unless-asked framing bpm/key already use, so lyrics are one more anchored
 * facet rather than a special-case pipeline. */
const LYRIC_EDIT_RULE =
  "The current lyricContext is the session's running lyrical direction: EDIT it — apply " +
  'only what the change request asks for and keep its people, places, relationships, story ' +
  'moments, imagery, and emotional arc otherwise; return it unchanged when the request does ' +
  'not touch lyrical content, build it from the request when it is empty and the result is ' +
  'vocal, and leave it empty only when the result is instrumental. It steers the sung lyrics ' +
  'alone — never stylePrompt, title, trackTitles, or coverConcept.';

/** When lyricContext may be filled: profile-backed by default; a skip-profile
 * session sources it from the request alone (the request is declared complete). */
function lyricContextRule(skipProfile: boolean): string {
  return skipProfile
    ? 'ONLY when vocals are wanted, built solely from details the request itself provides ' +
        'and the People it names'
    : 'ONLY when vocals are wanted AND a listener profile is given';
}

/** Only a new Session's own request may carry a duration target; an adjustment never extracts one. */
function durationRule(adjust: boolean): string {
  const policy = adjust
    ? 'This is an existing Session: return requestedDurationMinutes null; never extract a target from a change request or prompt history.'
    : 'Extract only an explicitly requested total Session duration, in any request language, converted to minutes. Return null when absent: never infer an activity length or mistake BPM, years, counts, or a per-track length for a Session target. Preserve the exact numeric value, even outside 1–600 whole minutes; validation belongs to the app, so never round, clamp, or discard an unsupported request.';
  return (
    `Duration policy: ${policy} ` +
    'Session duration is metadata only: never put it in stylePrompt or instruct the music model to trim or size individual Tracks.'
  );
}

/** One short line per cover preset, so the model can pick the one that fits the
 * Session (ADR 0007, 2026-11-17 Auto amendment). */
const COVER_STYLE_PRESET_LINES: Record<CoverStylePreset, string> = {
  record_sleeve:
    'an album cover made the way covers were in one decade from the 1960s to the 2000s',
  poster_art: 'bold graphic artwork built on one arresting visual metaphor',
  photographic: 'a believable real photograph of one honest moment',
  manga: 'a black-and-white manga ink illustration with expressive characters',
  drawing: 'a hand-made pencil or ink drawing on paper',
  minimal: 'one motif in generous empty space with two or three flat colors',
};

/** What the `coverStyle` answer is: the Auto cover pick, one more answer in a
 * call that already runs. */
const COVER_STYLE_ANSWER =
  'the cover style that best fits this session and the coverConcept, exactly one of: ' +
  (Object.entries(COVER_STYLE_PRESET_LINES) as [CoverStylePreset, string][])
    .map(([preset, line]) => `"${preset}": ${line}`)
    .join('; ');

/** Some models style every title in lowercase for a mellow vibe; titles follow
 * their language's capitalization instead. */
const TITLE_CASE_RULE =
  'capitalized the way titles are written in their language, never all lowercase';

function schemaFields(skipProfile: boolean): string {
  return (
    'stylePrompt (required, the music-generation style string), negativeTerms (string[]), ' +
    'mood, activity, genreTags (string[]), vocalMode ("instrumental" | "vocal", default instrumental), ' +
    'energy ("low" | "medium" | "high"), bpm (one tempo in BPM for the whole session), ' +
    'key (one musical key, e.g. "A minor"), titleScheme, ' +
    'title (a short evocative session name, max 60 chars), ' +
    `coverConcept (one concrete visual sentence for cover art; ${NAMED_VISUAL_REFERENCE_RULE}), ` +
    `coverStyle (${COVER_STYLE_ANSWER}), ` +
    'requestedDurationMinutes (number or null, explicitly requested total Session duration in minutes), ' +
    `trackTitles (string[], 8-12 short distinct creative track titles fitting the vibe; ${TITLE_CASE_RULE}), ` +
    `lyricContext (string, normally "": ${lyricContextRule(skipProfile)}, ` +
    `compact labeled creative notes — max ${MAX_LYRIC_CONTEXT_LENGTH} chars — that ` +
    `${LYRIC_CONTEXT_PURPOSE}), ` +
    'includesListener (boolean: true ONLY when the request places the listener themself in ' +
    'its scene or story as a participant, in any language — "me and Jonas on the moon", ' +
    '"my friends and I", or implied as in "with Jonas on the road to Lisbon"; false when the ' +
    'listener only asks for the music ("I want", "play me", "give us") or the scene belongs ' +
    'to other people), ' +
    `language (string, REQUIRED whenever vocals are wanted: the language the request's own ` +
    `words are written in, as an English name, e.g. "French", so the lyrics are sung in it; ` +
    `may be "" for instrumental), ` +
    'safetyWarnings (string[])'
  );
}

/** The request-language rule for every creative text the user will see or hear.
 * The profile clause exists because a model otherwise reads the listener's
 * country as the language (an English request from Germany sung in German). */
const CREATIVE_LANGUAGE_RULE =
  'Write title, trackTitles, and lyricContext in the SAME language as the request ' +
  '(a French request gets French titles and lyrics). The request language is the ' +
  "language of the request's own words — never infer it from the listener profile's " +
  'name, city, or country.';

/** Liedmotif never asks the music model to imitate someone, and there is no
 * keyword filter for it (it can't tell "like Adele" from "like Christmas
 * morning"). The model that reads the request does it: a named reference becomes
 * the sound it stands for, which is also what the music model can work with. */
const NAMED_REFERENCE_RULE =
  'If the request names an artist, band, song, or album as a reference, describe that ' +
  'sound in your own words (genre, era, instruments, production, vocal character, mood), ' +
  'and never put the name in stylePrompt, title, trackTitles, or lyricContext.';

/** The same rule for cover text: the cover-direction rewrite and the cover
 * concept. The worker runs its creator and brand word lists only when no text
 * LLM is configured, so this rule is what keeps names out of cover text, and an
 * ordinary word ("by the sea", "one red apple") must not be mistaken for one. */
export const NAMED_VISUAL_REFERENCE_RULE =
  'If the request names an artist, studio, franchise, or brand as a reference, describe ' +
  'its visual qualities in your own words (medium, palette, era, composition, texture, mood), ' +
  'and never write the name. This holds in any language. Ordinary words keep ' +
  'their ordinary meaning: "by the sea" is a place and "one red apple" is a fruit.';

/** The same rule for the later calls that reread the request (names, title
 * refills, per-track lyric briefs), so a name the expansion described away
 * doesn't come back in a title or a lyric. */
const NAMED_REFERENCE_NAME_RULE =
  'Never write the name of an artist, band, song, or album the request mentions.';

/** The naming call's language directive: a pinned snapshot language (an explicit
 * pick or the detected request language) is authoritative; the request-language
 * rule is the fallback, and a request-less call gets no directive. */
function namingLanguageRule(language: string, request: string | undefined): string {
  if (language) return ` Write title and trackTitles in ${language}.`;
  return request ? ` ${CREATIVE_LANGUAGE_RULE}` : '';
}

const LISTENER_FIELDS = ['name', 'city', 'country'] as const;

/** The theme-fidelity rule, shared verbatim by the expansion/naming guidance and
 * the per-track brief prompt: the request's attitude is the narrator's voice, and
 * no step may editorialize it away. Without it a text LLM reliably moralizes an
 * edgy request into a redemption arc, and every downstream lyric inherits the
 * inversion. */
const THEME_FIDELITY_RULE =
  "Keep the request's actual theme AND attitude — boastful, ruthless, dark, " +
  "competitive, or playful stays the narrator's voice; never soften, moralize, " +
  'or invert it into a lesson, redemption arc, or its opposite.';

/** The name-mention rule, shared verbatim by the guidance and the brief prompt:
 * an occasional verse-line touch, never a hook and never a constant. */
const NAME_MENTION_RULE =
  "The listener's name or city may appear in a verse line in SOME tracks as a " +
  'light personal touch — never the hook, chorus refrain, or opening, and not ' +
  'in every track.';

/** How lyric notes are selected and written. With the listener's own About in
 * hand, the About block sets the one fact it always contributes; beyond that,
 * personalization is never forced. */
const lyricContextGuidance = (ownAbout: boolean): string =>
  [
    'For vocal lyricContext: The listening request is the primary creative direction.',
    THEME_FIDELITY_RULE,
    'Pick only the FEW profile details (roughly 2-4) that genuinely serve the request and DEVELOP them into one scene or story; every other profile fact stays out.',
    'The selected details are raw material to extend creatively, never lines to quote; do not try to maximize profile coverage.',
    `${NAME_MENTION_RULE} Neither belongs at the start of the notes.`,
    'Lead the notes with the central theme or story moment, then imagery; people and setting come last and only when they serve the theme.',
    'Write lyricContext as compact, labeled creative notes instead of prose sentences.',
    'Use semicolons between categories and commas within categories.',
    'Include only useful categories from: central theme, story moments, imagery, emotional arc, people/relationships, setting.',
    'Omit categories that add no value.',
    'Do not produce a biography, resume, or unstructured inventory of profile facts.',
    ownAbout
      ? "Beyond the one fact from the listener's own About, force no personalization."
      : 'If nothing in the profile fits, build the notes from the listening request without forced personalization.',
    'Return only the labeled notes, with no selection rationale.',
  ].join(' ');

/** Liedmotif is the soundtrack of the listener's own life, so a request is
 * theirs even when it is about someone else: a birthday song for Clara is the
 * listener singing to Clara. Without this a model treats a request that names
 * other people as having nothing to do with the profile. */
const LISTENER_PERSPECTIVE_RULE =
  "Every session is part of the soundtrack of the listener's own life: for vocal " +
  'lyricContext, relate the request to the listener even when it names other people. The ' +
  'listener is the voice of the song (its "I"), singing to, about, or with the people it ' +
  'names, so the notes say what the listener shares with them or brings to the moment, ' +
  'built on a request-relevant profile or About detail whenever one fits.';

/** What the model's own `includesListener` answer changes in the lyric notes.
 * A listener the request puts in the scene is a character in it, so the
 * light-touch limit on their name (which keeps a profile from being sung into
 * every request) gives way. The lead sentence exists because a model otherwise
 * reads "no listener" as "no notes" and returns none for a request about nobody
 * in particular. */
const LISTENER_IN_SCENE_RULE =
  'includesListener decides only whether the listener is a named participant, never whether ' +
  'lyricContext is written or whether the profile may inform it. ' +
  'When includesListener is true, the listener is a participant in the scene like any named ' +
  'Person: for vocal lyricContext, list them among the people (by their profile name when ' +
  "one is given) with a part in the story, and the limit on the listener's name does not " +
  'apply. When includesListener is false: that limit holds.';

const LYRIC_CONTEXT_EXAMPLE =
  'Example lyricContext: "theme: strain turning to pride; scene: rainy mountain climb, ' +
  'jokes on steep turns; imagery: spinning wheels, distant bells, thin air; ' +
  'people: John + Tina, parent/child".';

/** The People a request names, with their About — lyric material only. */
function namedPeopleBlock(listener: ListenerContext | null | undefined): string {
  const people = (listener?.people ?? []).flatMap((person, index) => {
    const name = person.name.trim();
    const about = person.about.trim();
    return name && about ? [`Person ${index + 1}: name: ${name}; About: ${about}`] : [];
  });
  return people.length
    ? `\n\nNamed People private context (use only for lyricContext when vocals are selected): ${people.join(' | ')}\n` +
        `This Person context must not affect stylePrompt, title, trackTitles, coverConcept, or any image prompt. ` +
        `Select only request-relevant facts for lyricContext; never copy a complete About value unconditionally.`
    : '';
}

/** The skip-profile counterpart of `listenerBlock`: nothing of the listener's
 * own is sent, and vocal lyricContext is sourced from the request — never
 * invented. The People the request names belong to the request, so their About
 * still rides along. An adjustment counts the running session's own context as
 * request-provided; without that, this stricter sourcing rule would fight the
 * lyric-edit rule and collapse the notes to the change fragment. */
function requestLyricContextBlock(
  isAdjustment: boolean,
  listener: ListenerContext | null | undefined,
): string {
  const adjustmentSourcing = isAdjustment
    ? "On an adjustment the current lyricContext and the earlier requests count as the request's own details. "
    : '';
  const people = namedPeopleBlock(listener);
  const peopleSourcing = people
    ? "A Person the request names counts as the request's own detail: develop the notes from their private context below as well, selecting the facts that serve the request. "
    : '';
  return (
    '\n\nThis session deliberately uses no listener profile; the request is the complete ' +
    'creative direction. For vocal lyricContext: build the notes ONLY from people, places, ' +
    'story moments, imagery, theme, or emotion the request itself provides — never invent ' +
    `personal details the request does not contain. ${adjustmentSourcing}${peopleSourcing}` +
    'Write lyricContext as compact, labeled creative notes; use semicolons between categories ' +
    'and commas within categories. Lead the notes with the central theme or story moment; ' +
    'people and setting come last. Leave lyricContext "" when the request offers no such ' +
    'details.\n' +
    LYRIC_CONTEXT_EXAMPLE +
    people
  );
}

/** Per-session personalization policy for expansion prompts and their enforcement. */
export interface ExpansionOptions {
  /** The session deliberately runs WITHOUT the listener's own details: a
   * supplied profile and own About are ignored, the People the request names
   * still inform the lyrics, and vocal lyricContext may be built from details
   * the request itself provides (normally it requires a listener profile). */
  skipProfile?: boolean;
  /** A Change Vibe adjustment: the running session's current Style Snapshot.
   * The expansion becomes an ADJUSTMENT of it — only what the request (and
   * explicit picks) asks for changes; every other facet stays as close to the
   * current values as possible, and an omitted bpm/key keeps the current
   * frozen ones instead of re-freezing new anchors. */
  adjustFrom?: SessionStyleSnapshot;
  /** The session's prompt history — the accumulated request text the current
   * snapshot was distilled from. Rides an ADJUSTMENT as background context, so
   * an edit can recover names, places, and story details the bounded lyric notes
   * dropped. Already bounded where it is stored (the API edge's prompt limit). */
  promptHistory?: string;
  /** A Change Vibe adjustment: whether the running session's request includes
   * the listener. Held unless the change request itself adds the listener to
   * the scene or takes them out. */
  includesListener?: boolean;
  /** The caller gave up (a cancelled Surprise Me): the model call stops, so the
   * answer nobody waits for is not paid for. */
  signal?: AbortSignal;
}

/** Input to the creative naming call (`LlmProvider.createSessionMetadata`) and
 * to the prompt it builds. */
export interface SessionNamingInput {
  userPrompt?: string | null;
  snapshot: SessionStyleSnapshot;
  listener?: ListenerContext | null;
  /** Names already taken (a seeded session's source title + track titles):
   * the proposal must be related in spirit but clearly different. */
  avoidTitles?: string[];
}

/** The taken names as every adapter reads them: a blank entry claims nothing. */
export function takenTitles(avoidTitles: string[] | undefined): string[] {
  return (avoidTitles ?? []).map((title) => title.trim()).filter(Boolean);
}

/** Whether a listener profile carries anything worth sending. */
function hasListener(listener: ListenerContext | null | undefined): listener is ListenerContext {
  return (
    listener != null &&
    (LISTENER_FIELDS.some((key) => listener[key]?.trim()) ||
      Boolean(listener.about?.trim()) ||
      listener.people?.some((person) => person.name.trim() && person.about.trim()) === true)
  );
}

function hasGeneralListener(listener: ListenerContext | null | undefined): boolean {
  return listener != null && LISTENER_FIELDS.some((key) => listener[key]?.trim());
}

/** The listener's own About — lyric material only, and the one place its rule is stated. */
function ownAboutBlock(about: string): string {
  return about
    ? `\n\nThe listener's own private About (when the request speaks in the first person, that is the listener; this alone does not make includesListener true): ${about}\n` +
        `It is profile material for lyricContext only, when vocals are selected: every vocal ` +
        `session carries at least one fact from it, chosen to suit the request and woven into ` +
        `the scene (the listener's place, a habit, a relationship); never copy the complete About. ` +
        `It must not affect stylePrompt, title, trackTitles, coverConcept, or any image prompt.`
    : '';
}

/** Render volunteered listener data plus request-scoped Person lyric context.
 * `withAbout` is the expansion: only it writes lyric direction from the request,
 * so only it sees About text (the named People's and the listener's own). */
function listenerBlock(listener: ListenerContext | null | undefined, withAbout: boolean): string {
  if (!hasListener(listener)) return '';
  const parts = LISTENER_FIELDS.flatMap((key) => {
    const value = listener[key]?.trim();
    return value ? [`${key}: ${value}`] : [];
  });
  const general = parts.length
    ? `\n\nListener profile (volunteered by the listener): ${parts.join('; ')}\n` +
      'The general profile may lightly inspire title and trackTitles.'
    : '';
  const about = withAbout ? (listener.about?.trim() ?? '') : '';
  const facts = withAbout
    ? `${general}${namedPeopleBlock(listener)}${ownAboutBlock(about)}`
    : general;
  if (!facts) return '';
  const block = `${facts}\n${lyricContextGuidance(Boolean(about))}\n${LYRIC_CONTEXT_EXAMPLE}`;
  return withAbout ? `${block}\n\n${LISTENER_PERSPECTIVE_RULE} ${LISTENER_IN_SCENE_RULE}` : block;
}

export function allowsLyricContext(
  snapshot: SessionStyleSnapshot,
  listener: ListenerContext | null | undefined,
  options?: ExpansionOptions,
): boolean {
  return snapshot.vocalMode === 'vocal' && (options?.skipProfile === true || hasListener(listener));
}

export function allowsNamingLyricContext(
  snapshot: SessionStyleSnapshot,
  listener: ListenerContext | null | undefined,
): boolean {
  return snapshot.vocalMode === 'vocal' && hasGeneralListener(listener);
}

/** The user's explicit fine-tune picks as hard creative constraints. Guidance
 *  only — the adapter still enforces every pick deterministically on the parsed
 *  snapshot (`applyStylePicks`); this just keeps the model's creative choices
 *  (style wording, titles, lyrics) coherent with what will be enforced. */
function picksBlock(picks: StylePicks | undefined): string {
  const genres = picks?.genres?.map((genre) => genre.trim()).filter(Boolean) ?? [];
  const constraints: string[] = [];
  if (genres.length) {
    constraints.push(
      `The listener explicitly picked these genres: ${genres.join(', ')}. They are ` +
        `authoritative over anything the request's words suggest; the first pick leads. ` +
        `Build the session in these genres and list them first in genreTags.`,
    );
  }
  if (picks?.energy) {
    constraints.push(
      `The listener explicitly set the energy to ${picks.energy}; set energy to ` +
        `"${picks.energy}" and shape tempo and intensity to it.`,
    );
  }
  if (picks?.vocal) {
    constraints.push(
      picks.vocal === 'vocal'
        ? 'The listener explicitly wants vocals: set vocalMode to "vocal".'
        : 'The listener explicitly wants an instrumental session: set vocalMode to "instrumental".',
    );
  }
  // The own-voice opt-in supersedes a gender pick (the user's own voice defines
  // the singer), mirroring the deterministic enforcement in `applyStylePicks`.
  // stylePrompt is the one surface only guidance can protect: a "male vocal"
  // style tag rides straight into the music model and fights the voice persona.
  if (picks?.ownVoice) {
    constraints.push(
      `The session will be sung with the listener's own cloned voice (a provider voice ` +
        `persona). Do not describe the singer in stylePrompt — no gender, age, timbre, or ` +
        `vocal-character words (like "male vocal" or "soft female voice"); describe only ` +
        `the music.`,
    );
  } else if (picks?.voice) {
    constraints.push(`The listener wants a ${picks.voice} singing voice.`);
  }
  if (picks?.language) {
    constraints.push(
      `The listener explicitly picked ${picks.language} as the session language: set language ` +
        `to "${picks.language}" and write title, trackTitles, and lyricContext in ` +
        `${picks.language} regardless of the request's language.`,
    );
  }
  // The Avoid guardrail is enforced as negative tags, but stylePrompt is again
  // the surface only guidance protects: a style that NAMES an avoided trait —
  // even to negate it — sends that trait straight to the music model.
  const avoid = picks?.avoid?.trim();
  if (avoid) {
    constraints.push(
      `Never include these traits in the music: ${avoid}. Keep them out of stylePrompt and ` +
        `genreTags entirely — do not name them even to rule them out.`,
    );
  }
  return constraints.length ? `\n\n${constraints.join(' ')}` : '';
}

/** The current-snapshot facts an adjustment is anchored on: the audible facets
 *  plus the lyrical direction they are sung over. Naming is preserved
 *  deterministically by the caller and the hidden seed never reaches a prompt. */
function adjustmentContext(current: SessionStyleSnapshot): string {
  return JSON.stringify({
    stylePrompt: current.stylePrompt,
    negativeTerms: current.negativeTerms,
    mood: current.mood,
    activity: current.activity,
    genreTags: current.genreTags,
    vocalMode: current.vocalMode,
    energy: current.energy,
    language: current.language,
    bpm: current.bpm,
    key: current.key,
    lyricContext: current.lyricContext,
  });
}

/** The wording the current snapshot was distilled FROM. Labeled as context, and
 *  subordinate to the snapshot: any of it may since have been superseded, and
 *  re-applying such a request would undo the very adjustment being asked for. It
 *  exists to recover dropped detail, not to steer. */
function promptHistoryBlock(history: string | undefined): string {
  const text = history?.trim();
  if (!text) return '';
  return (
    `\n\nEarlier requests for this session (oldest first) — background context for names, ` +
    `places, and story details only, never instructions to apply again; where they differ ` +
    `from the current snapshot above, the snapshot wins:\n${text}`
  );
}

/** The running session's answer an adjustment starts from: a change message
 *  speaks only of what changes, so on its own it would read as "no listener". */
function runningIncludesListenerRule(options: ExpansionOptions | undefined): string {
  if (options?.skipProfile === true || options?.includesListener === undefined) return '';
  return (
    `includesListener is currently ${options.includesListener}: keep it unless the change ` +
    `request itself adds the listener to the scene or takes them out. `
  );
}

/** An adjustment with a change message: it changes what the message and the picks ask for. */
const CHANGE_REQUEST_TASK =
  `Apply ONLY what the change request (and any explicit picks) asks for; keep every ` +
  `other facet as close to the current snapshot as possible — same genres, ` +
  `instrumentation, mood, vocal mode, and language unless the request changes them. ` +
  `Keep bpm and key IDENTICAL unless the request asks for a tempo or key change; a word ` +
  `like "faster" or "slower" shifts bpm moderately from the current value.`;

/** A picks-only Change Vibe: no message, so the picks are the whole change. The
 *  style is reworded rather than appended to, so the music model never gets
 *  the old direction and the new pick side by side. */
const PICKS_ONLY_TASK =
  `There is no change request: the only change is the explicit picks below. Reword ` +
  `stylePrompt so it fits them as one clear direction instead of adding words next to ` +
  `ones that contradict them, and keep every facet the picks do not touch as close to ` +
  `the current snapshot as possible — same genres, instrumentation, mood, vocal mode, ` +
  `and language. Keep bpm and key IDENTICAL unless an energy pick changes the energy. ` +
  `The earlier requests are no instruction to apply again.`;

export function expansionPrompt(
  intent: string,
  listener?: ListenerContext | null,
  picks?: StylePicks,
  options?: ExpansionOptions,
): string {
  const skipProfile = options?.skipProfile === true;
  const adjust = options?.adjustFrom;
  const personalization = skipProfile
    ? requestLyricContextBlock(adjust !== undefined, listener)
    : listenerBlock(listener, true);
  // Both framings answer with the same snapshot under the same rules — only the
  // task sentence and the request block differ.
  const rules =
    `${CREATIVE_LANGUAGE_RULE} Keep stylePrompt itself in English ` +
    `(it configures the music model). ${NAMED_REFERENCE_RULE} ` +
    `Fields: ${schemaFields(skipProfile)}. ` +
    `${durationRule(adjust !== undefined)} ` +
    `${picksBlock(picks)}${personalization}`;
  if (adjust) {
    const request = intent.trim();
    return (
      `Adjust the Style Snapshot of a RUNNING music session. ` +
      (request ? CHANGE_REQUEST_TASK : PICKS_ONLY_TASK) +
      ` ${LYRIC_EDIT_RULE} ` +
      `${runningIncludesListenerRule(options)}${rules}` +
      `\n\nCurrent Style Snapshot:\n${adjustmentContext(adjust)}` +
      promptHistoryBlock(options?.promptHistory) +
      (request ? `\n\nChange request: ${intent}` : '')
    );
  }
  return (
    `Turn this listening request into a music Style Snapshot. Default to instrumental ` +
    `unless vocals are clearly wanted. Pick ONE bpm and key for the whole session so its ` +
    `tracks beat-match. ${runningIncludesListenerRule(options)}${rules}\n\nRequest: ${intent}`
  );
}

export function jsonExpansionPrompt(
  intent: string,
  listener?: ListenerContext | null,
  picks?: StylePicks,
  options?: ExpansionOptions,
): string {
  return `${expansionPrompt(intent, listener, picks, options)}\n\nRespond with ONLY a JSON object — no prose, no markdown.`;
}

export function jsonRepairPrompt(
  intent: string,
  previous: string,
  listener?: ListenerContext | null,
  picks?: StylePicks,
  options?: ExpansionOptions,
): string {
  return (
    `${jsonExpansionPrompt(intent, listener, picks, options)}\n\nYour previous reply could not be parsed as that JSON object. ` +
    `Reply again with ONLY valid JSON.\nPrevious reply:\n${previous}`
  );
}

export function structuredRepairPrompt(
  intent: string,
  listener?: ListenerContext | null,
  picks?: StylePicks,
  options?: ExpansionOptions,
): string {
  return `${expansionPrompt(intent, listener, picks, options)}\n\nEnsure stylePrompt is present and every field is valid.`;
}

/** Input to the per-generation brief call (`LlmProvider.createTrackLyricBrief`)
 * and to the prompt it builds. Callers gate on a non-empty `lyricContext` — the
 * brief EXTENDS the session's lyric direction, it never invents one. */
export interface TrackLyricBriefInput {
  /** The Session's base lyric notes — the brief's source for people, setting,
   * and continuity; theme and attitude answer to the listening request. */
  lyricContext: string;
  /** The Session language (an English name); '' means unspecified. */
  language: string;
  /** Light tonal grounding, never the subject of the brief. */
  stylePrompt: string;
  mood: string;
  /** The session's most recent briefs, newest first — the variety memory the
   * new brief must differ from in scene, imagery, and opening. */
  previousBriefs: string[];
  /** The session's prompt-history head, for request grounding. */
  userPrompt?: string;
}

/** Soft length target for a brief. Kept under the hard clamp
 * (`MAX_TRACK_LYRIC_BRIEF_LENGTH`) so the own-voice path's
 * "Write the lyrics in <language>. " prefix + brief fits Suno's 200-char
 * lyrics-brief cap for every selectable language. The longest detected name
 * ("Brazilian Portuguese") overruns it by two characters, and a model that
 * overshoots the target loses its brief's tail there. */
const TRACK_LYRIC_BRIEF_TARGET_CHARS = 160;

export function trackLyricBriefPrompt(input: TrackLyricBriefInput): string {
  const previous = input.previousBriefs.map((brief) => brief.trim()).filter(Boolean);
  const languageRule = input.language
    ? `Write the brief in ${input.language}.`
    : 'Write the brief in the same language as the session notes.';
  const variety = previous.length
    ? `It must explore a DIFFERENT scene, moment, or emotional angle than the previous ` +
      `briefs below — never reuse their opening image, hook, or scene.\n` +
      `Previous briefs (newest first):\n${previous.map((brief) => `- ${brief}`).join('\n')}`
    : `This is the session's first brief: open the lyric direction with one concrete ` +
      `scene or moment.`;
  const request = input.userPrompt?.trim();
  // With a request in hand, it outranks the session notes on theme/attitude —
  // otherwise a base note the expansion already softened locks every brief to
  // the softened version. Without one, the notes are the whole direction.
  const direction = request
    ? `The listening request is the source of truth for theme and attitude; the session ` +
      `notes supply people, setting, and continuity — extend them, and where the notes ` +
      `soften or drift from the request's theme or attitude, follow the request.`
    : `Stay inside the session's lyric direction — its people, setting, theme, and ` +
      `continuity; extend them, never contradict them.`;
  return (
    `Write ONE fresh compact lyric brief for the NEXT track of a running music session: ` +
    `compact labeled creative notes in the same format as the session notes, under ` +
    `${TRACK_LYRIC_BRIEF_TARGET_CHARS} characters. ${languageRule}\n` +
    `${direction} ${THEME_FIDELITY_RULE} ${NAME_MENTION_RULE} ${NAMED_REFERENCE_NAME_RULE}\n` +
    `${variety}\n` +
    `Respond with ONLY the notes.\n\n` +
    `Session lyric notes: ${input.lyricContext}\n` +
    (request ? `Listening request: ${request}\n` : '') +
    `Style: ${input.stylePrompt}` +
    (input.mood ? `\nMood: ${input.mood}` : '')
  );
}

export function namingPrompt(input: SessionNamingInput): string {
  const wantsLyricContext = allowsNamingLyricContext(input.snapshot, input.listener);
  const request = input.userPrompt?.trim();
  const avoid = takenTitles(input.avoidTitles);
  return (
    `Name a generated-music listening session and its tracks. Respond with ONLY JSON: ` +
    `{"title": string (a short evocative session name, max 60 chars), ` +
    `"coverConcept": string (one concrete visual sentence; ${NAMED_VISUAL_REFERENCE_RULE}), ` +
    `"coverStyle": string (${COVER_STYLE_ANSWER}), ` +
    `"trackTitles": string[] (8-12 short distinct creative track titles fitting the vibe; ${TITLE_CASE_RULE})` +
    (wantsLyricContext
      ? `, "lyricContext": string (max ${MAX_LYRIC_CONTEXT_LENGTH} chars: ${LYRIC_CONTEXT_FORMAT})`
      : '') +
    `}. No prose, no markdown. ${NAMED_REFERENCE_NAME_RULE}` +
    namingLanguageRule(input.snapshot.language, request) +
    (avoid.length
      ? ` These names are TAKEN by the session this one is seeded from — stay in the same ` +
        `spirit but make title and every track title clearly different from all of them: ` +
        `${avoid.join('; ')}.`
      : '') +
    `${listenerBlock(input.listener, false)}\n\n` +
    (request ? `Listening request: ${request}\n` : '') +
    `Style: ${input.snapshot.stylePrompt}`
  );
}

/** Input for one track-title pool refill: the Session ran (or is about to run)
 * past its pool, so the model proposes fresh titles in the same vibe. */
export interface TrackTitlesInput {
  /** Every title the Session's pool already holds — the new ones must differ. */
  takenTitles: string[];
  /** How many fresh titles to propose. */
  count: number;
  stylePrompt: string;
  mood: string;
  /** The Session language (an English name); '' means unspecified. */
  language: string;
  /** The Session's prompt-history head, for theme grounding. */
  userPrompt?: string;
}

function trackTitlesLanguageRule(language: string, request: string | undefined): string {
  if (language) return ` Write them in ${language}.`;
  return request ? ' Write them in the same language as the listening request.' : '';
}

export function trackTitlesPrompt(input: TrackTitlesInput): string {
  const taken = takenTitles(input.takenTitles);
  const request = input.userPrompt?.trim();
  return (
    `Propose ${input.count} more short, distinct, creative track titles for a running ` +
    `generated-music session. Respond with ONLY JSON: {"trackTitles": string[]}. ` +
    `No prose, no markdown. Stay in the spirit of the session's existing titles, but every ` +
    `new title must be clearly different from all of them — never a variation of one with ` +
    `a number added. Titles are ${TITLE_CASE_RULE}. ${NAMED_REFERENCE_NAME_RULE}` +
    `${trackTitlesLanguageRule(input.language, request)}\n\n` +
    (taken.length ? `Existing titles: ${taken.join('; ')}\n` : '') +
    (request ? `Listening request: ${request}\n` : '') +
    `Style: ${input.stylePrompt}` +
    (input.mood ? `\nMood: ${input.mood}` : '')
  );
}

/** Surprise Me's request writer input: a subject and the music, never People or About. */
export interface SurpriseRequestInput {
  /** What to write about: a theme's subject or a picked topic. */
  subject: string;
  /** The music the request must name: genres, instrumental or vocals. */
  music: string;
  /** Example prompts for tone and shape only. */
  examples: readonly string[];
  /** The owner's own city and country ("Hamburg, Germany"), when their profile has them. */
  place?: string;
  /** The request this one replaces: the new one must differ clearly. */
  avoid?: string;
  /**
   * The Session language. The request is written in it, so the expansion's
   * request-language rule and its language pick agree on the name, titles and
   * lyrics; omitted = English.
   */
  language?: string;
  /** The caller's request: once it aborts, the call stops. */
  signal?: AbortSignal;
}

/** The longest request the writer may return, well inside the Describe field's limit. */
export const MAX_SURPRISE_REQUEST_LENGTH = 500;
/** The Session length a written request may ask for, in minutes; `fallback` replaces an unusable one. */
export const SURPRISE_MINUTES = { min: 10, max: 60, fallback: 30 } as const;

export function surpriseRequestPrompt(input: SurpriseRequestInput): string {
  return (
    `Write ONE listening request for a generated-music app's "Surprise Me" button, in the ` +
    `voice of the listener typing it. Respond with ONLY JSON: ` +
    `{"request": string, "energy": "low" | "medium" | "high", "durationMinutes": integer ${SURPRISE_MINUTES.min}-${SURPRISE_MINUTES.max}}. ` +
    `No prose, no markdown.\n\n` +
    `Subject: ${input.subject}\n` +
    `Music it must ask for: ${input.music}\n` +
    (input.place
      ? `The listener lives in ${input.place}. Set the request there only if it makes it better.\n`
      : '') +
    (input.avoid
      ? `The previous surprise was: "${input.avoid}". Write something clearly different: ` +
        `another situation, image and angle.\n`
      : '') +
    `\nExamples of how listeners write requests (tone and shape only; never copy, ` +
    `paraphrase or reuse their situations):\n` +
    input.examples.map((example) => `- ${example.replace(/\s+/g, ' ').trim()}`).join('\n') +
    `\n\nRules:\n` +
    `- Invent your own specific, unexpected angle on the subject, not the most obvious one.\n` +
    `- Lead with the situation, scene or story in concrete sensory detail, then the music in ` +
    `your own words using the genres given. One to three sentences, at most ` +
    `${MAX_SURPRISE_REQUEST_LENGTH} characters, in ${input.language?.trim() || 'English'}.\n` +
    `- No artist or song names, no BPM, no track length.\n` +
    `- energy fits the situation; durationMinutes is how long that situation would last.`
  );
}
