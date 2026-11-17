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

  it('omits the history block when the change request already carries it', () => {
    // What a picks-only fine-tune sends: the stored history re-expanded as the
    // change request — rendering it twice would contradict itself.
    const prompt = expansionPrompt(
      HISTORY,
      null,
      { energy: 'high' },
      { adjustFrom: current, promptHistory: HISTORY },
    );
    expect(prompt).not.toMatch(/background context/i);
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

// The writing AI, not a word list, decides whether "me"/"we" puts the listener
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
