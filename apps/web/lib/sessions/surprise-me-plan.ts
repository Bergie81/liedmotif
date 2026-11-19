// What a Surprise Me proposal asks for, decided before any model runs: the
// fine-tune picks, the request without a text LLM, and the brief a text LLM
// writes a fresh request from. Deterministic given its random source, so both
// paths honor Familiar / More adventurous identically.
//
// Without a text LLM the request reads like one of the Describe field's example
// prompts: a situation first, then the music. The situation sets energy and
// length; learned taste picks the genres. The owner's own city may localize the
// situation — it is the only profile detail the text carries, and never People
// or About content, so the text is safe to show and to hand to the creation
// form.

import {
  isSungTheme,
  SESSION_LANGUAGES,
  type SessionLanguage,
  type SurpriseTheme,
  type SurpriseVocal,
} from '@liedmotif/shared';
import type { LearnedTaste, SurpriseProposalPicks } from '@liedmotif/db';
import type { SurpriseRequest } from '@liedmotif/providers';
import { GENRE_FAMILIES, genreLabel } from '@/components/create/genre-vocabulary';
import { PROMPT_EXAMPLES } from '@/components/create/prompt-examples';
import { SURPRISE_THEME_CONTENT, type SurpriseScene } from './surprise-me-scenes';

/** What the text LLM writes a fresh request from. */
export interface SurpriseBrief {
  /** The theme's subject, or the picked topic for `any`. */
  subject: string;
  /** The music the request names: genres, instrumental or vocals. */
  music: string;
  /** Example prompts for tone and shape only. */
  examples: readonly string[];
}

export interface SurprisePlan {
  /** The request without a text LLM, in the shape the text LLM returns one. */
  request: SurpriseRequest;
  /** The picked scene or topic, unlocalized: what the next Try another skips. */
  situation: string;
  brief: SurpriseBrief;
  /** The fine-tune picks; energy comes from whichever request is used. */
  picks: Omit<SurpriseProposalPicks, 'energy'>;
}

/** How far down the ranking Familiar may reach for its lead genre. */
const FAMILIAR_POOL = 4;
/** How many example prompts the text LLM sees: enough for tone, too few to copy one. */
const BRIEF_EXAMPLES = 4;
/** How many of the listener's sung languages Auto draws from. */
const TASTE_LANGUAGE_POOL = 3;

const FAMILY_OF = new Map(
  GENRE_FAMILIES.flatMap((family) => family.genres.map((genre) => [genre.id, family] as const)),
);

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
}

function labels(genres: readonly string[]): string {
  return genres.map(genreLabel).join(' and ');
}

/** `count` distinct items in random order. */
function sample<T>(items: readonly T[], count: number, random: () => number): T[] {
  const rest = [...items];
  const out: T[] = [];
  while (out.length < count && rest.length > 0)
    out.push(rest.splice(Math.floor(random() * rest.length), 1)[0]!);
  return out;
}

/**
 * Auto's Session language, from the languages the listener's vocal Tracks are
 * sung in: their main one half the time, otherwise one of the next most sung, so
 * frequent surprises are not all in one language.
 */
function tasteLanguage(taste: LearnedTaste, random: () => number): SessionLanguage | undefined {
  const [main, ...others] = taste.languages
    .slice(0, TASTE_LANGUAGE_POOL)
    .flatMap((facet) => SESSION_LANGUAGES.filter((name) => name.toLowerCase() === facet.value));
  return random() < 0.5 || others.length === 0 ? main : pick(others, random);
}

function sceneText(scene: SurpriseScene, city: string | undefined): string {
  return city && scene.local ? scene.local.replace('{city}', city) : scene.text;
}

/** The genres and how the request names them: taste-led, or the situation's own without taste. */
function pickMusic(
  known: readonly string[],
  scene: SurpriseScene,
  adventurous: boolean,
  random: () => number,
): { genres: string[]; music: string } {
  if (known.length === 0) {
    const genres = [...scene.genres];
    const music = labels(genres);
    return { genres, music: adventurous ? `${music}, taken somewhere unexpected` : music };
  }
  const anchors = known.slice(0, 2);
  if (adventurous) {
    const played = new Set(known);
    const related = anchors
      .flatMap((id) => FAMILY_OF.get(id)!.genres.map((genre) => genre.id))
      .filter((id, index, all) => !played.has(id) && all.indexOf(id) === index);
    // A listener who already plays a whole family explores from its far end.
    const lead = related.length > 0 ? pick(related, random) : known[known.length - 1]!;
    return {
      genres: [lead],
      music: `something fresh in ${genreLabel(lead)}, beyond my usual ${labels(anchors)}`,
    };
  }
  const lead = pick(known.slice(0, FAMILIAR_POOL), random);
  const genres = [lead, ...anchors.filter((id) => id !== lead).slice(0, 1)];
  return { genres, music: labels(genres) };
}

export function planSurprise(
  taste: LearnedTaste,
  options: {
    adventurous: boolean;
    random: () => number;
    theme?: SurpriseTheme;
    vocal?: SurpriseVocal;
    /** The Session language (name, titles, lyrics); omitted = Auto, drawn from learned taste. */
    language?: SessionLanguage;
    /** The owner's own city; omitted under Start without profile. */
    city?: string;
    /** The situation of the proposal this one replaces; it is not picked again. */
    replacing?: string | null;
  },
): SurprisePlan {
  const { adventurous, random, theme = 'any', vocal: vocalChoice = 'taste' } = options;
  const city = options.city?.trim() || undefined;
  const usable = taste.enabled && taste.confident;
  const known = usable
    ? taste.genres.map((genre) => genre.value).filter((id) => FAMILY_OF.has(id))
    : [];
  const content = SURPRISE_THEME_CONTENT[theme];

  const fresh = content.scenes.filter((scene) => scene.text !== options.replacing);
  const scene = pick(fresh.length > 0 ? fresh : content.scenes, random);
  const sungByTaste = vocalChoice === 'taste' && usable && taste.vocalModes[0]?.value === 'vocal';
  const vocal =
    isSungTheme(theme) || vocalChoice === 'vocal' || sungByTaste ? 'vocal' : 'instrumental';
  // The Session language names every proposal and, when sung, sets the vocals too.
  const language = options.language ?? (usable ? tasteLanguage(taste, random) : undefined);
  const voicing =
    vocal === 'vocal' ? `with vocals${language ? ` in ${language}` : ''}` : 'instrumental';
  const { genres, music } = pickMusic(known, scene, adventurous, random);

  return {
    picks: { genres, vocal, ...(language ? { language } : {}) },
    situation: scene.text,
    request: {
      request: `${sceneText(scene, city)} — ${music}, ${scene.energy} energy, ${voicing}.`,
      energy: scene.energy,
      durationMinutes: scene.minutes,
    },
    brief: {
      subject: content.subject ?? scene.text,
      music: `${music}, ${voicing}`,
      examples: sample(PROMPT_EXAMPLES, BRIEF_EXAMPLES, random),
    },
  };
}
