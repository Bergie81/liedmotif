import { createHash } from 'node:crypto';
import { COVER_STYLE_PRESETS, type CoverStyle, type CoverStylePreset } from '@liedmotif/shared';
import type { StyleSnapshot } from '@liedmotif/db';

export interface StyleGrammar {
  required: string;
  forbidden: string[];
  modes: string[];
  subjects: string[];
  compositions: string[];
  palettes: string[];
  materials: string[];
  lighting: string[];
  referenceTreatments: string[];
  energy: Record<'low' | 'medium' | 'high', string>;
}

export type PresetStyle = CoverStylePreset;

export const DIVERSITY_RELAXATION_ORDER = [
  'palette',
  'lighting',
  'material',
  'composition',
  'subject',
  'conceptMode',
] as const;

export type DiversityAxis = (typeof DIVERSITY_RELAXATION_ORDER)[number];

export interface ControlledCoverFingerprint extends Record<string, string> {
  preset: string;
  customStyle: string;
  conceptMode: string;
  subject: string;
  scene: string;
  composition: string;
  palette: string;
  material: string;
  lighting: string;
  referenceTreatment: string;
}

export interface ArtDirectionCandidate {
  fingerprint: ControlledCoverFingerprint;
  semanticRank: number;
  stableKey: string;
}

export interface PlannedCandidate extends ArtDirectionCandidate {
  resolvedStyle: PresetStyle | 'custom';
  conceptMode: string;
  subject: string;
  composition: string;
  palette: string;
  material: string;
  lighting: string;
  styleMode: string;
  referenceTreatment: string | null;
}

export interface SelectedArtDirection<T extends ArtDirectionCandidate> {
  candidate: T;
  relaxedAxes: DiversityAxis[];
}

function exactFingerprint(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

function sameTriple(a: Record<string, string>, b: Record<string, string>): boolean {
  return (
    a.conceptMode === b.conceptMode && a.subject === b.subject && a.composition === b.composition
  );
}

function repetitionPenalty(
  fingerprint: ControlledCoverFingerprint,
  history: readonly Record<string, string>[],
  penalizePreset: boolean,
): number {
  return history.reduce((penalty, recent, index) => {
    const recency = history.length - index;
    const axisMatches = [
      'conceptMode',
      'subject',
      'scene',
      'composition',
      'palette',
      'material',
      'lighting',
      'referenceTreatment',
    ].filter((axis) => fingerprint[axis] === recent[axis]).length;
    return (
      penalty +
      axisMatches * recency +
      (penalizePreset && fingerprint.preset === recent.preset ? recency * 2 : 0)
    );
  }, 0);
}

function candidatesWithoutAvoidableExact<T extends ArtDirectionCandidate>(
  candidates: readonly T[],
  history: readonly Record<string, string>[],
): readonly T[] {
  const alternatives = candidates.filter(
    (candidate) => !history.some((recent) => exactFingerprint(candidate.fingerprint, recent)),
  );
  return alternatives.length > 0 ? alternatives : candidates;
}

function candidatesWithoutAvoidableTriple<T extends ArtDirectionCandidate>(
  candidates: readonly T[],
  history: readonly Record<string, string>[],
  explicitPreset: string | null,
): readonly T[] {
  if (!explicitPreset) return candidates;
  const latestSix = history.filter((row) => row.preset === explicitPreset).slice(0, 6);
  const alternatives = candidates.filter(
    (candidate) => !latestSix.some((recent) => sameTriple(candidate.fingerprint, recent)),
  );
  return alternatives.length > 0 ? alternatives : candidates;
}

function candidatesAtRelaxation<T extends ArtDirectionCandidate>(
  candidates: readonly T[],
  history: readonly Record<string, string>[],
  relaxedCount: number,
): readonly T[] {
  const constrainedAxes = DIVERSITY_RELAXATION_ORDER.slice(relaxedCount);
  return candidates.filter((candidate) =>
    constrainedAxes.every(
      (axis) =>
        !history.some(
          (recent) =>
            recent.preset === candidate.fingerprint.preset &&
            recent[axis] === candidate.fingerprint[axis],
        ),
    ),
  );
}

/** Hard cap on enumerated art-direction candidates per plan, explicit or Auto. */
const CANDIDATE_BUDGET = 64;

const CONCEPT_MODES = [
  'title symbol',
  'title narrative',
  'material transformation',
  'environmental metaphor',
  'impossible scale',
  'rhythmic abstraction',
] as const;

export function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pick<T>(values: readonly T[], salt: string): T {
  return values[Number.parseInt(stableDigest(salt).slice(0, 8), 16) % values.length]!;
}

/** `alternatives` as a regex source that matches whole words only, so `rain`
 *  never matches inside "Brain" and `train` never inside "Training". */
function wholeWords(alternatives: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * The no-LLM ranking (ADR 0004, 2026-11-17 amendment): fixed English words decide
 * which presets fit Auto only when no text LLM is configured.
 */
const AUTO_KEYWORD_RULES: readonly { pattern: RegExp; styles: readonly PresetStyle[] }[] = [
  {
    pattern: wholeWords('retro|vinyl|jazz|(?:19)?[6-9]0s|2000s'),
    styles: ['record_sleeve', 'drawing', 'photographic'],
  },
  { pattern: wholeWords('manga|anime|j-?rock|j-?pop'), styles: ['manga'] },
  { pattern: wholeWords('dream|moon|surreal|ambient'), styles: ['minimal', 'poster_art'] },
  { pattern: wholeWords('focus|minimal|quiet|calm'), styles: ['minimal', 'photographic'] },
  {
    pattern: wholeWords('cinema|storm|rain|train|dramatic'),
    styles: ['photographic', 'poster_art'],
  },
];

function autoSemanticRank(style: PresetStyle, text: string): number {
  return AUTO_KEYWORD_RULES.some(
    ({ pattern, styles }) => styles.includes(style) && pattern.test(text),
  )
    ? 4
    : 2;
}

function candidateFingerprint(args: {
  style: PresetStyle | 'custom';
  custom: string;
  mode: string;
  subject: string;
  cueIds: string[];
  composition: string;
  palette: string;
  material: string;
  lighting: string;
  referenceTreatment: string | null;
}): ControlledCoverFingerprint {
  return {
    preset: args.style,
    customStyle: args.custom ? `custom:${stableDigest(args.custom).slice(0, 16)}` : 'none',
    conceptMode: args.mode,
    subject: args.subject,
    scene: args.cueIds.join('+'),
    composition: args.composition,
    palette: args.palette,
    material: args.material,
    lighting: args.lighting,
    referenceTreatment: args.referenceTreatment ?? 'none',
  };
}

/**
 * The axis vocabulary a Custom plan draws from: the Custom definition is the
 * sole aesthetic direction, so every single-entry axis defers to it (a `pick`
 * over one entry is salt-independent, keeping Custom plans deterministic).
 */
const CUSTOM_GRAMMAR: Pick<
  StyleGrammar,
  | 'modes'
  | 'subjects'
  | 'compositions'
  | 'palettes'
  | 'materials'
  | 'lighting'
  | 'referenceTreatments'
> = {
  modes: ['Custom-defined concept treatment'],
  subjects: ['one concrete motif derived only from the Custom direction and Session Name'],
  compositions: [
    'one clear focal hierarchy derived from the Custom direction',
    'asymmetric field with deliberate negative space',
    'layered foreground and background with one focal subject',
  ],
  palettes: ['the palette explicitly described by the Custom direction'],
  materials: ['the medium and material explicitly described by the Custom direction'],
  lighting: ['lighting consistent with the Custom direction'],
  referenceTreatments: [
    'identity only, integrated as a secondary subject in the Custom medium; the Custom direction controls composition, palette, material, and light',
  ],
};

function enumerateStyleCandidates(args: {
  style: PresetStyle | 'custom';
  custom: string;
  cueIds: string[];
  referenceEnabled: boolean;
  semanticRank: number;
  salt: string;
  grammars: Record<PresetStyle, StyleGrammar>;
}): PlannedCandidate[] {
  const grammar = args.style === 'custom' ? CUSTOM_GRAMMAR : args.grammars[args.style];
  const referenceTreatments = args.referenceEnabled ? grammar.referenceTreatments : [null];
  const base = CONCEPT_MODES.flatMap((mode) =>
    grammar.subjects.flatMap((subject) =>
      grammar.compositions.map((composition) => ({ mode, subject, composition })),
    ),
  );

  return base.map((candidate) => {
    const axisSalt = `${args.salt}:${args.style}:${JSON.stringify(candidate)}`;
    const palette = pick(grammar.palettes, `${axisSalt}:palette`);
    const material = pick(grammar.materials, `${axisSalt}:material`);
    const lighting = pick(grammar.lighting, `${axisSalt}:lighting`);
    const referenceTreatment = pick(referenceTreatments, `${axisSalt}:reference`);
    const fingerprint = candidateFingerprint({
      style: args.style,
      custom: args.custom,
      mode: candidate.mode,
      subject: candidate.subject,
      cueIds: args.cueIds,
      composition: candidate.composition,
      palette,
      material,
      lighting,
      referenceTreatment,
    });
    return {
      resolvedStyle: args.style,
      conceptMode: candidate.mode,
      subject: candidate.subject,
      composition: candidate.composition,
      palette,
      material,
      lighting,
      styleMode: pick(grammar.modes, `${axisSalt}:style-mode`),
      referenceTreatment,
      fingerprint,
      semanticRank: args.semanticRank,
      stableKey: stableDigest(`${args.salt}:${JSON.stringify(fingerprint)}`),
    };
  });
}

/** The one style a cover plans, or null when it draws from the whole Auto pool:
 *  Auto without a pick, and Custom without a usable definition. */
function plannedStyle(
  requestedStyle: CoverStyle,
  autoPick: PresetStyle | null,
  custom: string,
): PresetStyle | 'custom' | null {
  if (requestedStyle === 'auto') return autoPick;
  if (requestedStyle === 'custom' && !custom) return null;
  return requestedStyle;
}

/**
 * The art-direction candidates for a requested style. Auto with the text LLM's
 * stored pick plans exactly that preset, as if it were chosen by name, so
 * recent-cover diversity varies the art direction inside it and never swaps the
 * preset. Auto without a pick offers every preset: ranked by keyword only when
 * no text LLM is configured (ADR 0004), otherwise left to recent-cover
 * diversity and the hash.
 */
export function enumerateArtDirectionCandidates(args: {
  requestedStyle: CoverStyle;
  /** The text LLM's preset pick for Auto; ignored by every other style. */
  autoPick?: PresetStyle | null;
  /** A configured text LLM judges meaning, so keyword ranking never runs. */
  textLlmConfigured?: boolean;
  custom: string;
  name: string;
  snapshot: StyleSnapshot;
  cueIds: string[];
  referenceEnabled: boolean;
  salt: string;
  grammars: Record<PresetStyle, StyleGrammar>;
}): { candidates: PlannedCandidate[]; explicitPreset: string | null } {
  const style = plannedStyle(args.requestedStyle, args.autoPick ?? null, args.custom);
  if (style) {
    return {
      candidates: enumerateStyleCandidates({
        style,
        custom: args.custom,
        cueIds: args.cueIds,
        referenceEnabled: args.referenceEnabled,
        semanticRank: 4,
        salt: args.salt,
        grammars: args.grammars,
      })
        // Sorting by stable key before the cut keeps every concept mode
        // reachable for a style with more candidates than the budget.
        .sort((a, b) => a.stableKey.localeCompare(b.stableKey))
        .slice(0, CANDIDATE_BUDGET),
      explicitPreset: style,
    };
  }

  const semanticText = `${args.name} ${args.snapshot.mood ?? ''} ${args.snapshot.activity ?? ''} ${(args.snapshot.genreTags ?? []).join(' ')}`;
  // Every preset contributes an equal deterministic sample so the candidate
  // budget stays balanced across the Auto pool.
  const perPresetBudget = Math.floor(CANDIDATE_BUDGET / COVER_STYLE_PRESETS.length);
  const candidates = COVER_STYLE_PRESETS.flatMap((style) =>
    enumerateStyleCandidates({
      style,
      custom: '',
      cueIds: args.cueIds,
      referenceEnabled: args.referenceEnabled,
      semanticRank: args.textLlmConfigured ? 2 : autoSemanticRank(style, semanticText),
      salt: args.salt,
      grammars: args.grammars,
    })
      .sort((a, b) => a.stableKey.localeCompare(b.stableKey))
      .slice(0, perPresetBudget),
  );
  return { candidates: candidates.slice(0, CANDIDATE_BUDGET), explicitPreset: null };
}

export function selectArtDirection<T extends ArtDirectionCandidate>(args: {
  candidates: readonly T[];
  recentFingerprints: readonly Record<string, string>[];
  explicitPreset: string | null;
}): SelectedArtDirection<T> {
  const history = args.recentFingerprints.slice(0, 24);
  let eligible = candidatesWithoutAvoidableExact(args.candidates, history);
  eligible = candidatesWithoutAvoidableTriple(eligible, history, args.explicitPreset);

  let relaxedCount = 0;
  for (; relaxedCount < DIVERSITY_RELAXATION_ORDER.length; relaxedCount += 1) {
    const constrained = candidatesAtRelaxation(eligible, history, relaxedCount);
    if (constrained.length > 0) {
      eligible = constrained;
      break;
    }
  }
  if (relaxedCount === DIVERSITY_RELAXATION_ORDER.length) {
    const fullyRelaxed = candidatesAtRelaxation(eligible, history, relaxedCount);
    if (fullyRelaxed.length > 0) eligible = fullyRelaxed;
  }

  const ranked = [...eligible].sort((a, b) => {
    return (
      b.semanticRank - a.semanticRank ||
      repetitionPenalty(a.fingerprint, history, args.explicitPreset === null) -
        repetitionPenalty(b.fingerprint, history, args.explicitPreset === null) ||
      a.stableKey.localeCompare(b.stableKey)
    );
  });
  return {
    candidate: ranked[0]!,
    relaxedAxes: DIVERSITY_RELAXATION_ORDER.slice(0, relaxedCount),
  };
}
