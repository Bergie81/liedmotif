import type { CoverStyle } from '@liedmotif/shared';

export const BASELINE_FIXTURE_CATALOG_VERSION = 'session-cover-baseline-v5';
export const FROZEN_PRE_REPLACEMENT_RUN_ID = 'pre-replacement-complete-v1';
export const BASELINE_SESSION_VARIANTS = ['variation-a', 'variation-b', 'variation-c'] as const;
export const BASELINE_SPEND_CONFIRMATION = 'I_ACCEPT_PAID_COVER_BASELINE';

export type BaselineSessionVariant = (typeof BASELINE_SESSION_VARIANTS)[number];
export type BaselineRequestedStyle = CoverStyle;
export type BaselineCreationPath = 'structured_no_llm' | 'free_text';
export type BaselineReferenceMode = 'none' | 'synthetic_person';

interface ControlledCoverInput {
  sessionTitle: string;
  sessionIntent: string;
  stylePrompt: string;
  mood: string;
  activity: string;
  energy: string;
  genreTags: string[];
  vocalMode: string;
  coverStyle: CoverStyle;
  customStyleHint: string;
}

export interface BaselineFixture {
  id: string;
  requestedStyle: BaselineRequestedStyle;
  creationPath: BaselineCreationPath;
  referenceMode: BaselineReferenceMode;
  scenarios: string[];
  input: ControlledCoverInput;
}

export interface BaselineFixtureCatalog {
  schemaVersion: typeof BASELINE_FIXTURE_CATALOG_VERSION;
  dataClassification: 'controlled_synthetic_only';
  fixtures: BaselineFixture[];
}

export interface BaselineCase extends BaselineFixture {
  fixtureId: string;
  ownerUserId: 'cover-qualification-fixture-owner';
  activitySessionId: string;
  sessionVariant: BaselineSessionVariant;
}

export type BaselineAuthorizationFailureReason =
  | 'capture_not_enabled'
  | 'spend_not_confirmed'
  | 'api_key_missing'
  | 'two_models_required'
  | 'material_model_difference_unconfirmed'
  | 'partial_scope_not_allowed'
  | 'comparison_baseline_missing'
  | 'call_ceiling_missing'
  | 'call_ceiling_too_low'
  | 'call_ceiling_mismatch'
  | 'synthetic_reference_missing'
  | 'synthetic_reference_not_confirmed';

export type BaselineCaptureAuthorization =
  | { authorized: false; reason: BaselineAuthorizationFailureReason }
  | {
      authorized: true;
      fixtureIds: string[];
      models: string[];
      expectedCallCount: number;
      maxCalls: number;
      scope: 'complete' | 'partial';
    };

function input(args: {
  sessionTitle: string;
  sessionIntent: string;
  stylePrompt: string;
  mood: string;
  activity: string;
  energy: string;
  genreTags: string[];
  coverStyle: CoverStyle;
  customStyleHint?: string;
}): ControlledCoverInput {
  return {
    ...args,
    vocalMode: 'instrumental',
    customStyleHint: args.customStyleHint ?? '',
  };
}

const FIXTURES: BaselineFixture[] = [
  {
    id: 'auto-structured-rain-desk',
    requestedStyle: 'auto',
    creationPath: 'structured_no_llm',
    referenceMode: 'none',
    scenarios: ['structured_no_llm', 'literal_name', 'similar_sessions'],
    input: input({
      sessionTitle: 'Rain Desk',
      sessionIntent: 'quiet concentration while writing at a desk during rain',
      stylePrompt: 'minimal ambient, soft piano, no vocals',
      mood: 'focused',
      activity: 'writing',
      energy: 'low',
      genreTags: ['ambient', 'minimal'],
      coverStyle: 'auto',
    }),
  },
  {
    id: 'photographic-glasshouse-morning',
    requestedStyle: 'photographic',
    creationPath: 'free_text',
    referenceMode: 'none',
    scenarios: ['literal_name'],
    input: input({
      sessionTitle: 'Glasshouse Morning',
      sessionIntent: 'bright acoustic focus for an early greenhouse work session',
      stylePrompt: 'organic acoustic ambient with gentle percussion',
      mood: 'clear',
      activity: 'focus',
      energy: 'low',
      genreTags: ['acoustic', 'ambient'],
      coverStyle: 'photographic',
    }),
  },
  {
    id: 'photographic-last-train',
    requestedStyle: 'photographic',
    creationPath: 'free_text',
    referenceMode: 'none',
    scenarios: ['literal_name'],
    input: input({
      sessionTitle: 'Last Train Through the Storm',
      sessionIntent: 'dramatic orchestral electronic music for a night journey',
      stylePrompt: 'cinematic electronica with tense strings and deep pulse',
      mood: 'determined',
      activity: 'travel',
      energy: 'medium',
      genreTags: ['cinematic', 'electronica'],
      coverStyle: 'photographic',
    }),
  },
  {
    id: 'minimal-one-quiet-orbit',
    requestedStyle: 'minimal',
    creationPath: 'free_text',
    referenceMode: 'none',
    scenarios: ['abstract_name'],
    input: input({
      sessionTitle: 'One Quiet Orbit',
      sessionIntent: 'spacious concentration music with a slow repeating pulse',
      stylePrompt: 'minimal techno and ambient, restrained motion',
      mood: 'calm',
      activity: 'focus',
      energy: 'low',
      genreTags: ['minimal techno', 'ambient'],
      coverStyle: 'minimal',
    }),
  },
  {
    id: 'drawing-notes-in-margin',
    requestedStyle: 'drawing',
    creationPath: 'free_text',
    referenceMode: 'none',
    scenarios: ['literal_name'],
    input: input({
      sessionTitle: 'Notes in the Margin',
      sessionIntent: 'warm instrumental study music with human imperfections',
      stylePrompt: 'lofi jazz, brushed drums, soft keys',
      mood: 'curious',
      activity: 'study',
      energy: 'low',
      genreTags: ['lofi', 'jazz'],
      coverStyle: 'drawing',
    }),
  },
  {
    id: 'drawing-long-moon-reflection',
    requestedStyle: 'drawing',
    creationPath: 'free_text',
    referenceMode: 'none',
    scenarios: ['abstract_name', 'long_name'],
    input: input({
      sessionTitle: 'The Moon Forgot Its Reflection in the Last Lake Before Morning',
      sessionIntent: 'dreamlike quiet music for the edge of sleep',
      stylePrompt: 'dream pop ambience with distant guitar and soft synths',
      mood: 'dreamlike',
      activity: 'sleep',
      energy: 'low',
      genreTags: ['dream pop', 'ambient'],
      coverStyle: 'drawing',
    }),
  },
  {
    id: 'minimal-multilingual-sao-paulo',
    requestedStyle: 'minimal',
    creationPath: 'free_text',
    referenceMode: 'none',
    scenarios: ['multilingual_unicode_name', 'abstract_name'],
    input: input({
      sessionTitle: 'Lluvia sobre São Paulo — 夜の静けさ',
      sessionIntent: 'quiet nocturnal music for a rain-lit city',
      stylePrompt: 'organic electronic music with intricate quiet rhythms',
      mood: 'observant',
      activity: 'night walk',
      energy: 'medium',
      genreTags: ['electronica', 'ambient'],
      coverStyle: 'minimal',
    }),
  },
  {
    id: 'poster-art-neon-basement',
    requestedStyle: 'poster_art',
    creationPath: 'free_text',
    referenceMode: 'none',
    scenarios: ['poster_text', 'literal_name'],
    input: input({
      sessionTitle: 'Neon Basement',
      sessionIntent: 'energetic underground dance music for a house party',
      stylePrompt: 'deep house and disco with a strong club pulse',
      mood: 'euphoric',
      activity: 'party',
      energy: 'high',
      genreTags: ['house', 'disco'],
      coverStyle: 'poster_art',
    }),
  },
  {
    id: 'custom-conflict-paper-constellation',
    requestedStyle: 'custom',
    creationPath: 'free_text',
    referenceMode: 'synthetic_person',
    scenarios: ['conflicting_custom_definition', 'person_reference', 'abstract_name'],
    input: input({
      sessionTitle: 'Paper Constellation',
      sessionIntent: 'uplifting rhythmic music for an outdoor morning run',
      stylePrompt: 'melodic house with bright percussion',
      mood: 'uplifted',
      activity: 'running',
      energy: 'high',
      genreTags: ['melodic house'],
      coverStyle: 'auto',
      customStyleHint:
        'hand-cut monochrome paper collage, visible torn fibers, flat frontal layout, no photography',
    }),
  },
];

export function getBaselineFixtureCatalog(): BaselineFixtureCatalog {
  return {
    schemaVersion: BASELINE_FIXTURE_CATALOG_VERSION,
    dataClassification: 'controlled_synthetic_only',
    fixtures: FIXTURES,
  };
}

export function buildBaselineCases(fixtureIds?: readonly string[]): BaselineCase[] {
  const selected = fixtureIds?.length
    ? FIXTURES.filter((fixture) => fixtureIds.includes(fixture.id))
    : FIXTURES;

  return selected.flatMap((fixture) =>
    BASELINE_SESSION_VARIANTS.map((sessionVariant) => ({
      ...fixture,
      fixtureId: fixture.id,
      ownerUserId: 'cover-qualification-fixture-owner' as const,
      activitySessionId: `cover-baseline-${fixture.id}-${sessionVariant}`,
      sessionVariant,
    })),
  );
}

/** A qualification run always compares exactly two materially different models. */
export const QUALIFICATION_MODEL_COUNT = 2;

/** The complete paid matrix: every baseline case captured once per model. */
export function completeQualificationCallCount(): number {
  return buildBaselineCases().length * QUALIFICATION_MODEL_COUNT;
}

function commaSeparated(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function readBaselineCaptureAuthorization(
  environment: Readonly<Record<string, string | undefined>>,
): BaselineCaptureAuthorization {
  if (environment.COVER_MODEL_TEST !== '1') {
    return { authorized: false, reason: 'capture_not_enabled' };
  }
  if (environment.COVER_MODEL_TEST_AUTHORIZE_SPEND !== BASELINE_SPEND_CONFIRMATION) {
    return { authorized: false, reason: 'spend_not_confirmed' };
  }
  if (!environment.IMAGE_API_KEY?.trim()) {
    return { authorized: false, reason: 'api_key_missing' };
  }
  if (!environment.COVER_MODEL_TEST_BASELINE_RUN?.trim()) {
    return { authorized: false, reason: 'comparison_baseline_missing' };
  }

  const models = commaSeparated(environment.COVER_MODEL_TEST_MODELS);
  if (models.length !== QUALIFICATION_MODEL_COUNT) {
    return { authorized: false, reason: 'two_models_required' };
  }
  if (environment.COVER_MODEL_TEST_MODELS_ARE_MATERIALLY_DIFFERENT !== '1') {
    return { authorized: false, reason: 'material_model_difference_unconfirmed' };
  }

  const allFixtureIds = FIXTURES.map((fixture) => fixture.id);
  const requestedFixtureIds = commaSeparated(environment.COVER_MODEL_TEST_FIXTURES);
  if (requestedFixtureIds.length > 0) {
    return { authorized: false, reason: 'partial_scope_not_allowed' };
  }
  const fixtureIds = allFixtureIds;

  const expectedCallCount = buildBaselineCases(fixtureIds).length * models.length;
  const maxCallsInput = environment.COVER_MODEL_TEST_MAX_CALLS ?? '';
  if (!/^[1-9]\d*$/.test(maxCallsInput)) {
    return { authorized: false, reason: 'call_ceiling_missing' };
  }
  const maxCalls = Number(maxCallsInput);
  if (!Number.isSafeInteger(maxCalls)) {
    return { authorized: false, reason: 'call_ceiling_missing' };
  }
  if (maxCalls < expectedCallCount) {
    return { authorized: false, reason: 'call_ceiling_too_low' };
  }
  if (maxCalls !== expectedCallCount) {
    return { authorized: false, reason: 'call_ceiling_mismatch' };
  }

  const needsReference = FIXTURES.some(
    (fixture) => fixtureIds.includes(fixture.id) && fixture.referenceMode === 'synthetic_person',
  );
  if (needsReference && !environment.COVER_MODEL_TEST_REFERENCE?.trim()) {
    return { authorized: false, reason: 'synthetic_reference_missing' };
  }
  if (needsReference && environment.COVER_MODEL_TEST_REFERENCE_IS_SYNTHETIC !== '1') {
    return { authorized: false, reason: 'synthetic_reference_not_confirmed' };
  }

  return {
    authorized: true,
    fixtureIds,
    models,
    expectedCallCount,
    maxCalls,
    scope: 'complete',
  };
}
