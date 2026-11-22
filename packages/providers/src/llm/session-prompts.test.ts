import { describe, expect, it } from 'vitest';
import { sessionStyleSnapshotSchema } from './snapshot';
import {
  allowsLyricContext,
  expansionPrompt,
  jsonExpansionPrompt,
  jsonRepairPrompt,
  namingPrompt,
  trackLyricBriefPrompt,
  trackTitlesPrompt,
  structuredRepairPrompt,
} from './session-prompts';

describe('expansionPrompt language pick', () => {
  it('states an explicit language pick as authoritative over the request language', () => {
    const prompt = expansionPrompt('driving through the night', null, { language: 'German' });
    expect(prompt).toContain('German');
    expect(prompt).toMatch(/regardless of the request/i);
  });

  it('keeps the request-language rule when no language is picked', () => {
    const prompt = expansionPrompt('driving through the night', null, {});
    expect(prompt).toContain('SAME language as the request');
    expect(prompt).not.toMatch(/regardless of the request/i);
  });

  it('never lets the listener profile set the request language', () => {
    const listener = { name: 'John', city: 'Berlin', country: 'Germany', people: [] };
    const prompt = expansionPrompt('cool down after a hard workout', listener, { vocal: 'vocal' });
    expect(prompt).toMatch(/never infer it from the listener profile/i);
  });
});

describe('expansionPrompt own-voice pick', () => {
  it('forbids singer descriptions in stylePrompt when the session uses the own voice', () => {
    const prompt = expansionPrompt('late-night coding', null, { vocal: 'vocal', ownVoice: true });
    expect(prompt).toContain('own cloned voice');
    expect(prompt).toMatch(/do not describe the singer/i);
  });

  it('drops a gender pick when the own voice defines the singer', () => {
    const prompt = expansionPrompt('late-night coding', null, {
      vocal: 'vocal',
      voice: 'male',
      ownVoice: true,
    });
    expect(prompt).not.toContain('male singing voice');
  });

  it('keeps the gender pick and adds no own-voice rule when the pick is off', () => {
    const prompt = expansionPrompt('late-night coding', null, { vocal: 'vocal', voice: 'male' });
    expect(prompt).toContain('male singing voice');
    expect(prompt).not.toContain('own cloned voice');
  });
});

describe('expansionPrompt Avoid guardrail', () => {
  it('constrains the expansion away from the avoided traits', () => {
    // Without this the model can write an avoided trait straight into the style
    // prose, where it reaches the music model despite the negative tags.
    const prompt = expansionPrompt('rainy night drive', null, { avoid: 'saxophone, brass' });
    expect(prompt).toMatch(/never include these traits/i);
    expect(prompt).toContain('saxophone, brass');
  });

  it('says nothing about avoided traits when the listener set none', () => {
    expect(expansionPrompt('rainy night drive', null, {})).not.toMatch(
      /never include these traits/i,
    );
  });
});

describe('expansionPrompt named references', () => {
  const current = sessionStyleSnapshotSchema.parse({ stylePrompt: 'mellow lofi hip hop' });

  it('turns a named artist or song into a described sound, for a new session and a change', () => {
    for (const prompt of [
      expansionPrompt('lofi like Nujabes'),
      expansionPrompt('more like Adele', null, undefined, { adjustFrom: current }),
    ]) {
      expect(prompt).toMatch(/describe that sound in your own words/i);
      expect(prompt).toMatch(
        /never put the name in stylePrompt, title, trackTitles, or lyricContext/i,
      );
    }
  });

  it('keeps the name out of every later prompt that rereads the request', () => {
    const userPrompt = 'a song for Mia like Adele';
    for (const prompt of [
      namingPrompt({ snapshot: current, userPrompt }),
      trackTitlesPrompt({
        takenTitles: [],
        count: 4,
        stylePrompt: 'lofi',
        mood: '',
        language: '',
        userPrompt,
      }),
      trackLyricBriefPrompt({
        lyricContext: 'For Mia',
        language: 'English',
        stylePrompt: 'soulful piano ballad',
        mood: '',
        previousBriefs: [],
        userPrompt,
      }),
    ]) {
      expect(prompt).toMatch(/never write the name of an artist, band, song, or album/i);
    }
  });
});

describe('expansionPrompt skip-profile sessions', () => {
  it('directs request-derived lyricContext when the session skips the profile', () => {
    const prompt = expansionPrompt('a song for Mia dancing in the rain', null, undefined, {
      skipProfile: true,
    });
    expect(prompt).toContain('the request itself provides');
    expect(prompt).not.toContain('AND a listener profile is given');
  });

  it('keeps the listener-profile lyricContext rule without the skip', () => {
    const prompt = expansionPrompt('a song for Mia dancing in the rain', null);
    expect(prompt).toContain('AND a listener profile is given');
    expect(prompt).not.toContain('the request itself provides');
  });

  it("drops the listener's own details and keeps the People the request names", () => {
    const prompt = expansionPrompt(
      'a song for Mia',
      {
        name: 'Ana',
        city: 'Berlin',
        about: 'OWN_ABOUT',
        people: [{ name: 'Mia', about: 'loves rain' }],
      },
      undefined,
      { skipProfile: true },
    );
    expect(prompt).not.toContain('Listener profile');
    expect(prompt).not.toContain('Ana');
    expect(prompt).not.toContain('Berlin');
    expect(prompt).not.toContain('OWN_ABOUT');
    expect(prompt).toContain('Person 1: name: Mia; About: loves rain');
    expect(prompt).toContain(
      "A Person the request names counts as the request's own detail: develop the notes from " +
        'their private context below as well',
    );
  });

  it('says nothing about named People when a skip-profile request names none', () => {
    const prompt = expansionPrompt('a song about rain', null, undefined, { skipProfile: true });
    expect(prompt).not.toContain('Named People');
    expect(prompt).not.toContain('A Person the request names');
  });
});

describe('expansionPrompt lyric-selection guidance', () => {
  const LISTENER = { name: 'John', city: 'Riverton' };

  it('allows the name in a verse line in some tracks, never hook/chorus/opening', () => {
    const prompt = expansionPrompt('a song about weekend rides', LISTENER);
    expect(prompt).toContain('in a verse line in SOME tracks');
    expect(prompt).toContain('never the hook, chorus refrain, or opening, and not in every track');
    expect(prompt).not.toContain('no name at all');
    expect(prompt).not.toContain('at most one light personal touch');
    expect(prompt).not.toContain('Names are encouraged');
  });

  it('carries the theme-fidelity rule against softening or inverting the request', () => {
    const prompt = expansionPrompt('a song about weekend rides', LISTENER);
    expect(prompt).toContain(
      'never soften, moralize, or invert it into a lesson, redemption arc, or its opposite',
    );
    expect(prompt).toContain("stays the narrator's voice");
  });

  it('demands a few developed details and leads the notes with the theme', () => {
    const prompt = expansionPrompt('a song about weekend rides', LISTENER);
    expect(prompt).toMatch(/DEVELOP/);
    expect(prompt).toContain('Lead the notes with the central theme');
  });

  it('orders the example theme-first with people last', () => {
    const prompt = expansionPrompt('a song about weekend rides', LISTENER);
    const theme = prompt.indexOf('theme:');
    const people = prompt.indexOf('people: John + Tina');
    expect(theme).toBeGreaterThan(-1);
    expect(people).toBeGreaterThan(theme);
  });

  it('carries the verse-line name rule and the fidelity rule into the naming prompt', () => {
    const snapshot = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'warm folk',
      vocalMode: 'vocal',
    });
    const prompt = namingPrompt({ snapshot, listener: LISTENER });
    expect(prompt).toContain('in a verse line in SOME tracks');
    expect(prompt).toContain(
      'never soften, moralize, or invert it into a lesson, redemption arc, or its opposite',
    );
    expect(prompt).not.toContain('no name at all');
    expect(prompt).not.toContain('Names are encouraged');
  });
});

describe('allowsLyricContext for skip-profile sessions', () => {
  const vocal = sessionStyleSnapshotSchema.parse({ stylePrompt: 'folk', vocalMode: 'vocal' });
  const instrumental = sessionStyleSnapshotSchema.parse({ stylePrompt: 'calm piano' });

  it('allows vocal lyricContext with no listener when the session skips the profile', () => {
    expect(allowsLyricContext(vocal, null)).toBe(false);
    expect(allowsLyricContext(vocal, null, { skipProfile: true })).toBe(true);
  });

  it('never allows lyricContext on an instrumental session', () => {
    expect(allowsLyricContext(instrumental, null, { skipProfile: true })).toBe(false);
  });
});

describe('cover concept named references', () => {
  const current = sessionStyleSnapshotSchema.parse({ stylePrompt: 'mellow lofi hip hop' });

  it('tells the expansion and naming calls to describe a named visual reference in the cover concept', () => {
    for (const prompt of [
      expansionPrompt('rainy harbor in Ghibli style'),
      namingPrompt({ snapshot: current, userPrompt: 'rainy harbor in Ghibli style' }),
    ]) {
      const coverConcept = prompt.slice(prompt.indexOf('coverConcept'));
      expect(coverConcept).toMatch(
        /names an artist, studio, franchise, or brand as a reference, describe its visual qualities in your own words/i,
      );
      expect(coverConcept).toMatch(/ordinary words keep their ordinary meaning/i);
    }
  });
});

describe('namingPrompt language', () => {
  it('writes titles in the snapshot language when one is set', () => {
    const snapshot = sessionStyleSnapshotSchema.parse({
      stylePrompt: 'mellow lofi beats',
      language: 'German',
    });
    const prompt = namingPrompt({ snapshot, userPrompt: 'lofi zum lernen' });
    expect(prompt).toMatch(/title.*German|German.*title/i);
  });

  it('falls back to the request-language rule when the snapshot has no language', () => {
    const snapshot = sessionStyleSnapshotSchema.parse({ stylePrompt: 'mellow lofi beats' });
    const prompt = namingPrompt({ snapshot, userPrompt: 'lofi for studying' });
    expect(prompt).toContain('SAME language as the request');
  });
});

describe('expansionPrompt adjustment (Change Vibe)', () => {
  const current = sessionStyleSnapshotSchema.parse({
    stylePrompt: 'warm german indie pop, female vocals',
    genreTags: ['indie-pop'],
    vocalMode: 'vocal',
    language: 'German',
    bpm: 96,
    key: 'A minor',
  });

  it('frames the intent as a change against the current snapshot', () => {
    const prompt = expansionPrompt('a bit faster', null, undefined, { adjustFrom: current });
    expect(prompt).toContain('Adjust');
    expect(prompt).toContain('warm german indie pop');
    expect(prompt).toContain('German');
    expect(prompt).toContain('Change request: a bit faster');
    expect(prompt).not.toContain('Turn this listening request');
  });

  it('still carries explicit picks as constraints in adjustment mode', () => {
    const prompt = expansionPrompt(
      'more organic',
      null,
      { energy: 'high' },
      { adjustFrom: current },
    );
    expect(prompt).toContain('energy to high');
  });

  it('keeps the cold-start framing without adjustFrom', () => {
    const prompt = expansionPrompt('a bit faster');
    expect(prompt).toContain('Turn this listening request');
    expect(prompt).not.toContain('Change request:');
  });
});

// A Change Vibe adjusts the lyrical direction the same way it adjusts every other
// facet: the running notes ride the anchor and are EDITED, never rederived from
// the change fragment alone.
describe('expansionPrompt adjustment lyric continuity', () => {
  const NOTES =
    'people: John + Tina, partners; story moments: anniversary bike trip London to Paris';
  const HISTORY = 'a song for John and Tina about their anniversary bike trip from London to Paris';
  const CHANGE = 'use berlin instead of london';
  const current = sessionStyleSnapshotSchema.parse({
    stylePrompt: 'warm indie folk, close vocals',
    vocalMode: 'vocal',
    language: 'English',
    lyricContext: NOTES,
  });
  function adjusted(options?: { promptHistory?: string; skipProfile?: boolean }): string {
    return expansionPrompt(CHANGE, null, undefined, { adjustFrom: current, ...options });
  }

  it('anchors the adjustment on the running lyric notes', () => {
    expect(adjusted()).toContain(NOTES);
  });

  it('tells the model to edit those notes instead of rebuilding them', () => {
    const prompt = adjusted();
    expect(prompt).toMatch(/EDIT it/);
    expect(prompt).toMatch(/return it unchanged/i);
    expect(prompt).toMatch(/empty only when the result is instrumental/i);
  });

  it('still asks for notes when the running session carries none', () => {
    expect(adjusted()).toMatch(/build it .* when it is empty/i);
  });

  it('keeps the edited notes off the style, naming, and cover surfaces', () => {
    expect(adjusted()).toMatch(/never stylePrompt, title, trackTitles, or coverConcept/);
  });

  it('states no lyric-edit rule on a cold-start expansion', () => {
    expect(expansionPrompt('a song for John and Tina')).not.toMatch(/EDIT it/);
  });

  it('renders the prompt history as labeled background context, never instructions', () => {
    const prompt = adjusted({ promptHistory: HISTORY });
    expect(prompt).toContain(HISTORY);
    expect(prompt).toMatch(/background context/i);
    expect(prompt).toMatch(/never instructions/i);
  });

  it('omits the history block when the session carries none', () => {
    expect(adjusted()).not.toMatch(/background context/i);
    expect(adjusted({ promptHistory: '   ' })).not.toMatch(/background context/i);
  });

  it('renders the history in full even when a change message repeats it word for word', () => {
    // The listener may mean the same words again: they are a message like any other.
    const prompt = expansionPrompt(HISTORY, null, undefined, {
      adjustFrom: current,
      promptHistory: HISTORY,
    });
    expect(prompt).toMatch(/background context/i);
    expect(prompt).toContain(`Change request: ${HISTORY}`);
  });

  it('lets a skip-profile adjustment source notes from the anchor and the history', () => {
    const prompt = adjusted({ skipProfile: true, promptHistory: HISTORY });
    expect(prompt).toMatch(/current lyricContext and the earlier requests count as/i);
    expect(prompt).toContain('the request itself provides');
  });

  it('keeps the strict skip-profile sourcing rule on a cold start', () => {
    const prompt = expansionPrompt('a song for John', null, undefined, { skipProfile: true });
    expect(prompt).not.toMatch(/count as/i);
  });

  it('inherits the adjustment rules in the JSON and repair variants', () => {
    const options = { adjustFrom: current, promptHistory: HISTORY };
    for (const prompt of [
      jsonExpansionPrompt(CHANGE, null, undefined, options),
      jsonRepairPrompt(CHANGE, '{oops', null, undefined, options),
      structuredRepairPrompt(CHANGE, null, undefined, options),
    ]) {
      expect(prompt).toContain(NOTES);
      expect(prompt).toContain(HISTORY);
      expect(prompt).toMatch(/EDIT it/);
    }
  });
});

// A picks-only Change Vibe has no message: the picks are the only change, and
// the history stays background.
describe('expansionPrompt picks-only adjustment', () => {
  const HISTORY = 'calm piano for reading\n\nmake it rockier\n\nactually, drop the guitars';
  const current = sessionStyleSnapshotSchema.parse({
    stylePrompt: 'calm, gentle solo piano',
    energy: 'low',
  });
  const prompt = expansionPrompt(
    '',
    null,
    { energy: 'high' },
    {
      adjustFrom: current,
      promptHistory: HISTORY,
    },
  );

  it('has no change-request line', () => {
    expect(prompt).not.toContain('Change request:');
  });

  it('states that the picks are the only change and asks to reword the style to fit them', () => {
    expect(prompt).toMatch(/no change request/i);
    expect(prompt).toMatch(/only change is the explicit picks/i);
    expect(prompt).toMatch(/reword stylePrompt/i);
  });

  it('keeps the anchor, the picks and the history as labeled background', () => {
    expect(prompt).toContain('calm, gentle solo piano');
    expect(prompt).toContain('energy to high');
    expect(prompt).toContain(HISTORY);
    expect(prompt).toMatch(/background context/i);
  });
});

describe('namingPrompt taken names', () => {
  const snapshot = sessionStyleSnapshotSchema.parse({ stylePrompt: 'mellow lofi beats' });

  it('marks avoid titles as taken so a seeded session cannot clone its source', () => {
    const prompt = namingPrompt({ snapshot, avoidTitles: ['Focus Flow', ' Quiet Desk '] });
    expect(prompt).toContain('TAKEN');
    expect(prompt).toContain('Focus Flow');
    expect(prompt).toContain('Quiet Desk');
  });

  it('emits no taken-names directive without avoid titles', () => {
    expect(namingPrompt({ snapshot })).not.toContain('TAKEN');
    expect(namingPrompt({ snapshot, avoidTitles: ['  '] })).not.toContain('TAKEN');
  });
});

describe('trackLyricBriefPrompt', () => {
  const input = {
    lyricContext: 'theme: night rides; people: Mia',
    language: 'German',
    stylePrompt: 'mellow indie pop',
    mood: 'wistful',
    previousBriefs: ['scene: harbor at dawn, gulls', 'scene: rooftop rain, neon'],
  };

  it('renders the previous briefs with the variety rule against reusing their angle', () => {
    const prompt = trackLyricBriefPrompt(input);
    expect(prompt).toContain('scene: harbor at dawn, gulls');
    expect(prompt).toContain('scene: rooftop rain, neon');
    expect(prompt).toMatch(/DIFFERENT scene, moment, or emotional angle/);
    expect(prompt).toMatch(/never reuse their opening image, hook, or scene/i);
  });

  it('allows the name as a some-tracks verse touch and grounds the brief in the session notes', () => {
    const prompt = trackLyricBriefPrompt(input);
    expect(prompt).toContain('in a verse line in SOME tracks');
    expect(prompt).toContain('never the hook, chorus refrain, or opening, and not in every track');
    expect(prompt).not.toContain('at most one light personal touch');
    expect(prompt).toContain('theme: night rides; people: Mia');
    expect(prompt).toMatch(/extend them/i);
  });

  it('makes the listening request authoritative for theme/attitude and forbids softening it', () => {
    const prompt = trackLyricBriefPrompt({
      ...input,
      userPrompt: 'outperforming everyone at work, crushing them',
    });
    expect(prompt).toContain('The listening request is the source of truth for theme and attitude');
    expect(prompt).toContain('notes supply people, setting, and continuity');
    expect(prompt).toContain(
      'never soften, moralize, or invert it into a lesson, redemption arc, or its opposite',
    );
    expect(prompt).toContain("stays the narrator's voice");
    // Without a request the notes stay the whole direction, but the fidelity
    // rule still rides along.
    const requestless = trackLyricBriefPrompt(input);
    expect(requestless).toContain("stays the narrator's voice");
  });

  it('directs the session language and the labeled-notes reply shape', () => {
    const prompt = trackLyricBriefPrompt(input);
    expect(prompt).toContain('Write the brief in German.');
    expect(prompt).toContain('compact labeled creative notes');
    expect(prompt).toContain('160');
    expect(prompt).toMatch(/ONLY the notes/);
  });

  it('falls back to the session-notes language when none is pinned', () => {
    const prompt = trackLyricBriefPrompt({ ...input, language: '' });
    expect(prompt).not.toContain('Write the brief in German.');
    expect(prompt).toMatch(/same language as the session notes/i);
  });

  it('builds a valid first-track prompt when no previous briefs exist', () => {
    const prompt = trackLyricBriefPrompt({ ...input, previousBriefs: [] });
    expect(prompt).not.toMatch(/previous briefs/i);
    expect(prompt).toMatch(/first/i);
    expect(prompt).toContain('theme: night rides; people: Mia');
  });

  it('grounds the brief in the listening request when one is supplied', () => {
    const prompt = trackLyricBriefPrompt({ ...input, userPrompt: 'a song about our night rides' });
    expect(prompt).toContain('a song about our night rides');
    expect(trackLyricBriefPrompt(input)).not.toMatch(/listening request/i);
  });
});

// The text AI, not a word list, decides whether "me"/"we" puts the listener
// in the scene — in any language. The listener's own About rides along so the
// same call can use it once it has decided.
describe('expansionPrompt for a request that may include the listener', () => {
  const ABOUT = 'Runs along the Elbe in the rain, cooks for friends on Fridays.';
  const LISTENER = { name: 'Emma', city: 'Hamburg', about: ABOUT };
  const current = sessionStyleSnapshotSchema.parse({
    stylePrompt: 'bright german synth-pop',
    vocalMode: 'vocal',
  });

  it('asks whether the request places the listener in its scene, not merely asks for music', () => {
    const prompt = expansionPrompt('Me, Jonas and Clara on a trip to the moon', LISTENER);
    expect(prompt).toContain('includesListener (boolean');
    expect(prompt).toContain('in any language');
    expect(prompt).toMatch(/false when the listener only asks for the music/);
  });

  it("sends the listener's own About as lyric material for any vocal request, never for naming or the cover", () => {
    const prompt = expansionPrompt('A birthday song for Clara', LISTENER);
    expect(prompt).toContain(ABOUT);
    expect(prompt).toMatch(/own private About[^\n]*\n[^\n]*profile material for lyricContext only/);
    expect(prompt).toContain('every vocal session carries at least one fact from it');
    expect(prompt).toMatch(/must not affect stylePrompt, title, trackTitles, coverConcept/);
    expect(prompt).not.toMatch(/ONLY when includesListener is true/);
  });

  it('never lets "nothing fits" excuse leaving the About out, and keeps that excuse for a bare profile', () => {
    const withAbout = expansionPrompt('A birthday song for Clara', LISTENER);
    expect(withAbout).not.toContain('If nothing in the profile fits');
    expect(withAbout).toContain(
      "Beyond the one fact from the listener's own About, force no personalization.",
    );

    const bare = expansionPrompt('A birthday song for Clara', { name: 'Emma', city: 'Hamburg' });
    expect(bare).toContain(
      'If nothing in the profile fits, build the notes from the listening request without forced personalization.',
    );
  });

  it('relates every request to the listener, also one that names other people', () => {
    const prompt = expansionPrompt('A birthday song for Clara', LISTENER);
    expect(prompt).toContain("part of the soundtrack of the listener's own life");
    expect(prompt).toContain('even when it names other people');
    expect(prompt).toContain('what the listener shares with them or brings to the moment');
  });

  it('makes an included listener a named participant, lifting the verse-line name limit', () => {
    const prompt = expansionPrompt('Me, Jonas and Clara on a trip to the moon', LISTENER);
    expect(prompt).toMatch(
      /When includesListener is true, the listener is a participant in the scene like any named Person/,
    );
    expect(prompt).toContain('When includesListener is false: ');
  });

  it('still asks for lyric notes, with the profile, when the listener is not a named participant', () => {
    const prompt = expansionPrompt('Running through the waves at the beach', LISTENER);
    expect(prompt).toContain(
      'includesListener decides only whether the listener is a named participant, never ' +
        'whether lyricContext is written or whether the profile may inform it',
    );
  });

  it('still makes an included listener a participant when they have written no About', () => {
    const prompt = expansionPrompt('Me and Jonas on the moon', { name: 'Emma' });
    expect(prompt).toContain('When includesListener is true, the listener is a participant');
    expect(prompt).not.toContain('own private About');
  });

  it('sends the About alone when the profile holds nothing else', () => {
    const prompt = expansionPrompt('Me and Jonas on the moon', { about: ABOUT });
    expect(prompt).toContain(ABOUT);
    expect(prompt).toContain('For vocal lyricContext: The listening request');
  });

  it('states the lyric guidance and example once, whatever the profile holds', () => {
    const prompt = expansionPrompt('A birthday song for Clara', {
      ...LISTENER,
      people: [{ name: 'Clara', about: 'plays the cello' }],
    });
    const count = (text: string) => prompt.split(text).length - 1;
    expect(count('For vocal lyricContext: The listening request')).toBe(1);
    expect(count('Example lyricContext:')).toBe(1);
    expect(count('at least one fact')).toBe(1);
  });

  it('withholds the About from a session started without the profile', () => {
    const prompt = expansionPrompt('Me and Jonas on the moon', LISTENER, undefined, {
      skipProfile: true,
    });
    expect(prompt).not.toContain(ABOUT);
  });

  it('keeps the About out of the naming prompt', () => {
    const prompt = namingPrompt({ userPrompt: null, snapshot: current, listener: LISTENER });
    expect(prompt).not.toContain(ABOUT);
    expect(prompt).not.toContain('includesListener');
  });

  it('states the running answer on an adjustment, to be held unless the change says otherwise', () => {
    const prompt = expansionPrompt('a bit faster', LISTENER, undefined, {
      adjustFrom: current,
      includesListener: true,
    });
    expect(prompt).toMatch(
      /includesListener is currently true: keep it unless the change request itself/,
    );
  });

  it('states the running answer on a Change Vibe whose anchor fell back to a fresh expansion', () => {
    const prompt = expansionPrompt('a bit faster', LISTENER, undefined, {
      includesListener: true,
    });
    expect(prompt).toMatch(/includesListener is currently true/);
  });

  it('states no running answer on a new session', () => {
    expect(expansionPrompt('Me and Jonas on the moon', LISTENER)).not.toContain(
      'includesListener is currently',
    );
  });
});

describe('namingPrompt for a More Like This context', () => {
  const vocalSeed = sessionStyleSnapshotSchema.parse({
    stylePrompt: 'warm synthwave, night drive',
    vocalMode: 'vocal',
    activity: 'running',
    lyricContext: 'theme: night drive; people: Mira, my sister',
  });
  const instrumentalSeed = sessionStyleSnapshotSchema.parse({
    stylePrompt: 'calm piano',
    activity: 'reading',
  });
  const taken = ['Night Drive', 'Neon Exit'];

  it('without a context is the seeded naming prompt as it always was', () => {
    expect(namingPrompt({ snapshot: vocalSeed, listener: { name: 'John' }, avoidTitles: taken }))
      .toMatchInlineSnapshot(`
      "Name a generated-music listening session and its tracks. Respond with ONLY JSON: {"title": string (a short evocative session name, max 60 chars), "coverConcept": string (one concrete visual sentence; If the request names an artist, studio, franchise, or brand as a reference, describe its visual qualities in your own words (medium, palette, era, composition, texture, mood), and never write the name. This holds in any language. Ordinary words keep their ordinary meaning: "by the sea" is a place and "one red apple" is a fruit.), "coverStyle": string (the cover style that best fits this session and the coverConcept, exactly one of: "record_sleeve": an album cover made the way covers were in one decade from the 1960s to the 2000s; "poster_art": bold graphic artwork built on one arresting visual metaphor; "photographic": a believable real photograph of one honest moment; "manga": a black-and-white manga ink illustration with expressive characters; "drawing": a hand-made pencil or ink drawing on paper; "minimal": one motif in generous empty space with two or three flat colors), "trackTitles": string[] (8-12 short distinct creative track titles fitting the vibe; capitalized the way titles are written in their language, never all lowercase), "lyricContext": string (max 500 chars: compact labeled creative notes that organize a coherent group of request-relevant personal details into lyrical direction)}. No prose, no markdown. Never write the name of an artist, band, song, or album the request mentions. These names are TAKEN by the session this one is seeded from — stay in the same spirit but make title and every track title clearly different from all of them: Night Drive; Neon Exit.

      Listener profile (volunteered by the listener): name: John
      The general profile may lightly inspire title and trackTitles.
      For vocal lyricContext: The listening request is the primary creative direction. Keep the request's actual theme AND attitude — boastful, ruthless, dark, competitive, or playful stays the narrator's voice; never soften, moralize, or invert it into a lesson, redemption arc, or its opposite. Pick only the FEW profile details (roughly 2-4) that genuinely serve the request and DEVELOP them into one scene or story; every other profile fact stays out. The selected details are raw material to extend creatively, never lines to quote; do not try to maximize profile coverage. The listener's name or city may appear in a verse line in SOME tracks as a light personal touch — never the hook, chorus refrain, or opening, and not in every track. Neither belongs at the start of the notes. Lead the notes with the central theme or story moment, then imagery; people and setting come last and only when they serve the theme. Write lyricContext as compact, labeled creative notes instead of prose sentences. Use semicolons between categories and commas within categories. Include only useful categories from: central theme, story moments, imagery, emotional arc, people/relationships, setting. Omit categories that add no value. Do not produce a biography, resume, or unstructured inventory of profile facts. If nothing in the profile fits, build the notes from the listening request without forced personalization. Return only the labeled notes, with no selection rationale.
      Example lyricContext: "theme: strain turning to pride; scene: rainy mountain climb, jokes on steep turns; imagery: spinning wheels, distant bells, thin air; people: John + Tina, parent/child".

      Style: warm synthwave, night drive"
    `);
  });

  it('hands the context to the call as its listening request, the style fixed', () => {
    const prompt = namingPrompt({
      snapshot: vocalSeed,
      context: 'for cooking',
      avoidTitles: taken,
    });
    expect(prompt).toContain('Listening request: for cooking');
    expect(prompt).toMatch(/never changes? the music/i);
    expect(prompt).toContain('Style: warm synthwave, night drive');
  });

  it('asks a vocal seed for lyric notes even without a listener profile, editing the seed notes', () => {
    const prompt = namingPrompt({ snapshot: vocalSeed, context: 'for cooking' });
    expect(prompt).toContain('"lyricContext"');
    expect(prompt).toContain('theme: night drive; people: Mira, my sister');
    expect(prompt).toMatch(/keep its people and relationships unless the request replaces them/i);
  });

  it('never asks an instrumental seed for lyric notes', () => {
    const prompt = namingPrompt({ snapshot: instrumentalSeed, context: 'for cooking' });
    expect(prompt).not.toContain('"lyricContext"');
  });

  it('asks for the activity the context is for', () => {
    const prompt = namingPrompt({ snapshot: instrumentalSeed, context: 'for cooking' });
    expect(prompt).toContain('"activity"');
    expect(namingPrompt({ snapshot: instrumentalSeed })).not.toContain('"activity"');
  });
});

describe('namingPrompt for a More Like This context with personal ingredients', () => {
  const vocalSeed = sessionStyleSnapshotSchema.parse({
    stylePrompt: 'warm synthwave, night drive',
    vocalMode: 'vocal',
  });
  const instrumentalSeed = sessionStyleSnapshotSchema.parse({ stylePrompt: 'calm piano' });
  const listener = {
    name: 'John',
    about: 'grew up by the sea',
    people: [{ name: 'Anna', about: 'bakes sourdough' }],
  };

  it('gives a vocal seed’s lyric notes the named People’s and the listener’s own About', () => {
    const prompt = namingPrompt({ snapshot: vocalSeed, listener, context: 'for Anna’s birthday' });
    expect(prompt).toContain('name: Anna; About: bakes sourdough');
    expect(prompt).toContain("The listener's own private About");
    expect(prompt).toContain('grew up by the sea');
  });

  it('sends an instrumental seed no About', () => {
    const prompt = namingPrompt({
      snapshot: instrumentalSeed,
      listener,
      context: 'for Anna’s birthday',
    });
    expect(prompt).not.toContain('bakes sourdough');
    expect(prompt).not.toContain('grew up by the sea');
  });

  it('asks whether the listener is in the scene, on any seed', () => {
    for (const snapshot of [vocalSeed, instrumentalSeed]) {
      expect(namingPrompt({ snapshot, context: 'me cooking with Anna' })).toContain(
        '"includesListener": boolean (true ONLY when the request places the listener themself',
      );
    }
    expect(namingPrompt({ snapshot: vocalSeed, listener })).not.toContain('includesListener');
  });
});
