import { describe, expect, it } from 'vitest';
import type { LearnedTaste } from '@liedmotif/db';
import { SURPRISE_THEMES } from '@liedmotif/shared';
import { PROMPT_EXAMPLES } from '@/components/create/prompt-examples';
import { planSurprise } from './surprise-me-plan';
import { SURPRISE_THEME_CONTENT } from './surprise-me-scenes';

const NONE: LearnedTaste = {
  enabled: true,
  confident: false,
  genres: [],
  energies: [],
  vocalModes: [],
  languages: [],
  tempoBpm: null,
};

const LOFI_LISTENER: LearnedTaste = {
  enabled: true,
  confident: true,
  genres: [
    { value: 'lofi', score: 20 },
    { value: 'chillhop', score: 12 },
    { value: 'my own odd tag', score: 9 },
  ],
  energies: [{ value: 'low', score: 30 }],
  vocalModes: [{ value: 'vocal', score: 25 }],
  languages: [{ value: 'german', score: 25 }],
  tempoBpm: 84,
};

const first = () => 0;

describe('planSurprise', () => {
  it('sets the request in a situation from the chosen theme, at that situation’s energy', () => {
    for (const taste of [NONE, LOFI_LISTENER])
      for (const r of [0, 0.5, 0.95]) {
        const plan = planSurprise(taste, { adventurous: false, theme: 'rest', random: () => r });
        const scene = SURPRISE_THEME_CONTENT.rest.scenes.find((s) => s.text === plan.situation);
        expect(scene, plan.request.request).toBeDefined();
        expect(plan.request.request.startsWith(scene!.text)).toBe(true);
        expect(plan.request.energy).toBe(scene!.energy);
      }
  });

  it('sets a localizable situation in the owner’s city, and never leaves a placeholder', () => {
    const local = planSurprise(NONE, {
      adventurous: false,
      theme: 'travel',
      city: 'Hamburg',
      random: first,
    });
    expect(local.request.request).toContain('Hamburg');
    for (const city of [undefined, 'Hamburg'])
      for (const theme of SURPRISE_THEMES)
        for (const r of [0, 0.3, 0.6, 0.95])
          expect(
            planSurprise(NONE, { adventurous: false, theme, city, random: () => r }).request
              .request,
          ).not.toMatch(/[{}]/);
  });

  it('Try another never repeats the situation it replaces', () => {
    for (const theme of SURPRISE_THEMES)
      for (const city of [undefined, 'Hamburg'])
        for (const r of [0, 0.3, 0.6, 0.95]) {
          const random = () => r;
          const before = planSurprise(LOFI_LISTENER, { adventurous: false, theme, city, random });
          const after = planSurprise(LOFI_LISTENER, {
            adventurous: false,
            theme,
            city,
            random,
            replacing: before.situation,
          });
          expect(after.situation, theme).not.toBe(before.situation);
        }
  });

  it('Anything draws from its own wide topic list, never a theme’s situations', () => {
    const themed = new Set(
      Object.entries(SURPRISE_THEME_CONTENT).flatMap(([theme, content]) =>
        theme === 'any' ? [] : content.scenes.map((scene) => scene.text),
      ),
    );
    const topics = SURPRISE_THEME_CONTENT.any.scenes.map((scene) => scene.text);
    expect(topics.length).toBeGreaterThanOrEqual(20);
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const plan = planSurprise(LOFI_LISTENER, { adventurous: false, random: () => r });
      expect(topics).toContain(plan.situation);
      expect(themed.has(plan.situation)).toBe(false);
    }
  });

  it('briefs the text LLM with a subject, the music, and a few example prompts for style', () => {
    const plan = planSurprise(LOFI_LISTENER, {
      adventurous: false,
      theme: 'morning',
      vocal: 'instrumental',
      random: first,
    });
    expect(plan.brief.subject).toMatch(/morning/i);
    expect(plan.brief.music).toContain('Lo-fi');
    expect(plan.brief.examples.length).toBeGreaterThanOrEqual(3);
    for (const example of plan.brief.examples) expect(PROMPT_EXAMPLES).toContain(example);
  });

  it('honors an explicit vocals choice over learned taste', () => {
    expect(
      planSurprise(LOFI_LISTENER, { adventurous: false, vocal: 'instrumental', random: first })
        .picks,
    ).toMatchObject({ vocal: 'instrumental' });
    const sung = planSurprise(NONE, { adventurous: false, vocal: 'vocal', random: first });
    expect(sung.picks.vocal).toBe('vocal');
    expect(sung.request.request).toContain('with vocals');
  });

  it('an explicit language wins, sung or instrumental', () => {
    const sung = planSurprise(LOFI_LISTENER, {
      adventurous: false,
      vocal: 'vocal',
      language: 'Spanish',
      random: first,
    });
    expect(sung.picks.language).toBe('Spanish');
    expect(sung.brief.music).toContain('Spanish');
    const named = planSurprise(LOFI_LISTENER, {
      adventurous: false,
      vocal: 'instrumental',
      language: 'Spanish',
      random: first,
    });
    expect(named.picks).toMatchObject({ vocal: 'instrumental', language: 'Spanish' });
    expect(named.brief.music).not.toContain('Spanish');
  });

  it('Auto picks the Session language for instrumental proposals too', () => {
    const plain = planSurprise(LOFI_LISTENER, {
      adventurous: false,
      vocal: 'instrumental',
      random: first,
    });
    expect(plain.picks).toMatchObject({ vocal: 'instrumental', language: 'German' });
    expect(plain.brief.music).not.toContain('German');
    expect(
      planSurprise(NONE, { adventurous: false, random: first }).picks.language,
    ).toBeUndefined();
  });

  it('Auto mixes the listener’s other sung languages in with their main one', () => {
    const multilingual: LearnedTaste = {
      ...LOFI_LISTENER,
      languages: [
        { value: 'german', score: 40 },
        { value: 'english', score: 10 },
        { value: 'french', score: 5 },
        { value: 'italian', score: 1 },
      ],
    };
    // A small seeded generator: each plan draws several independent numbers.
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const seen = new Set<string | undefined>();
    for (let i = 0; i < 200; i += 1)
      seen.add(planSurprise(multilingual, { adventurous: false, random }).picks.language);
    expect(seen).toEqual(new Set(['German', 'English', 'French']));
  });

  it('a song about me is always sung, in the listener’s usual language', () => {
    const plan = planSurprise(LOFI_LISTENER, {
      adventurous: false,
      theme: 'about-me',
      vocal: 'instrumental',
      random: first,
    });
    expect(plan.picks).toMatchObject({ vocal: 'vocal', language: 'German' });
    expect(plan.request.request).toMatch(/song about me/);
  });

  it('reads like a listener’s own request, not a genre-and-tempo spec', () => {
    const plan = planSurprise(LOFI_LISTENER, { adventurous: false, random: first });
    expect(plan.request.request).not.toMatch(/BPM|Surprise me with/);
    expect(plan.request.request).toMatch(/ — /);
  });

  it('stays inside the listener’s strongest pickable genres by default', () => {
    const plan = planSurprise(LOFI_LISTENER, { adventurous: false, random: first });
    expect(plan.picks.genres?.length).toBeGreaterThan(0);
    for (const genre of plan.picks.genres ?? []) expect(['lofi', 'chillhop']).toContain(genre);
    expect(plan.picks).toMatchObject({ vocal: 'vocal', language: 'German' });
  });

  it('More adventurous leads with a related style the listener has not been playing', () => {
    const plan = planSurprise(LOFI_LISTENER, { adventurous: true, random: first });
    const lead = plan.picks.genres?.[0];
    // Same browsing family as lofi/chillhop, but neither of them.
    expect(['trip-hop', 'downtempo', 'hip-hop', 'trap', 'phonk']).toContain(lead);
    expect(plan.request.request).toContain('Lo-fi');
  });

  it.each([
    ['sparse', NONE],
    ['switched off', { ...LOFI_LISTENER, enabled: false }],
  ])('falls back to the situation’s own instrumental genres when taste is %s', (_name, taste) => {
    for (const adventurous of [false, true]) {
      const plan = planSurprise(taste, { adventurous, random: first });
      expect(plan.picks.vocal).toBe('instrumental');
      expect(plan.picks.language).toBeUndefined();
      expect(
        Object.values(SURPRISE_THEME_CONTENT)
          .flatMap((content) => content.scenes)
          .map((s) => s.genres[0]),
      ).toContain(plan.picks.genres?.[0]);
    }
  });

  // The length rides the card; in the text, prompt passthrough would hand it to the music model as style.
  it('always asks for a 10–60 minute Session, outside the request text', () => {
    for (const taste of [NONE, LOFI_LISTENER])
      for (const adventurous of [false, true])
        for (const r of [0, 0.3, 0.6, 0.95]) {
          const plan = planSurprise(taste, { adventurous, random: () => r });
          expect(plan.request.durationMinutes).toBeGreaterThanOrEqual(10);
          expect(plan.request.durationMinutes).toBeLessThanOrEqual(60);
          expect(plan.request.durationMinutes % 5).toBe(0);
          expect(plan.request.request).not.toMatch(/minutes/);
        }
  });

  it('varies with the random source', () => {
    const intents = new Set(
      [0, 0.3, 0.6, 0.95].map(
        (r) => planSurprise(NONE, { adventurous: false, random: () => r }).request.request,
      ),
    );
    expect(intents.size).toBeGreaterThan(1);
  });
});
