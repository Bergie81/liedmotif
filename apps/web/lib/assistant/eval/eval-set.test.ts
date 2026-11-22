// The eval set's expectations name docs sections and app pages. Both move: the
// docs snapshot is re-synced from the website, and the route map grows. An
// entry that points at something that is gone would score every model wrong, so
// each one is checked against the real snapshot and the real route map. The
// entries about the user's own music name tools and things in the fixture
// Library the same way, and are checked against a real turn's tools.

import { describe, expect, it } from 'vitest';
import { assistantRequestSchema, uuidSchema } from '@liedmotif/shared';
import { loadDocs, readDocsSection } from '../docs';
import { APP_ROUTES, appRoutesFor } from '../route-map';
import { createTurnActions } from '../turn-actions';
import { EVAL_SET, type DocsRef, type EvalEntry, type ExpectedCall } from './eval-set';
import { fixtureTools, PLAYLISTS, SESSIONS, TRACKS } from './fixture';
import { detectLanguage } from './score';

const sections = (entry: EvalEntry): readonly DocsRef[] =>
  Array.isArray(entry.docs) ? entry.docs : [];

const count = (matches: (entry: EvalEntry) => boolean) => EVAL_SET.filter(matches).length;

/** The entries about the user's own music: what a good turn calls is part of each. */
const ABOUT_MUSIC = EVAL_SET.filter(({ calls }) => calls !== undefined);
const EXPECTED_CALLS = ABOUT_MUSIC.flatMap(({ id, calls = [] }) =>
  calls.map((call) => [id, call] as const),
);
const forms = (tool: string) =>
  EXPECTED_CALLS.filter(([, call]) => call.tool === tool).flatMap(([, call]) => call.input ?? []);

/** What a real turn offers the model, by tool name. */
const TOOLS = new Map(
  fixtureTools(
    'member',
    createTurnActions(() => {}),
  ).map((tool) => [tool.name, tool]),
);
const FIXTURE_IDS = [SESSIONS, TRACKS, PLAYLISTS].flatMap((things) =>
  Object.values(things).map(({ id }) => id),
);

describe('the eval set', () => {
  it('is about 20 questions on the docs, each entry with its own id', () => {
    const aboutDocs = EVAL_SET.length - ABOUT_MUSIC.length;

    expect(aboutDocs).toBeGreaterThanOrEqual(18);
    expect(aboutDocs).toBeLessThanOrEqual(24);
    expect(new Set(EVAL_SET.map(({ id }) => id)).size).toBe(EVAL_SET.length);
  });

  it.each(EVAL_SET.flatMap((entry) => sections(entry).map((ref) => [entry.id, ref] as const)))(
    '%s expects a section the docs snapshot has: %o',
    (_id, ref) => {
      expect(readDocsSection(loadDocs(), ref.page, ref.section)).toMatchObject({ found: true });
    },
  );

  it.each(
    EVAL_SET.filter(({ link }) => typeof link === 'string').map(({ id, role, link }) => [
      id,
      role,
      link,
    ]),
  )('%s expects a page the route map lists for the %s: %s', (_id, role, link) => {
    expect(appRoutesFor(role as EvalEntry['role']).map(({ path }) => path)).toContain(link);
  });

  it.each(EVAL_SET.map((entry) => [entry.id, entry] as const))(
    '%s is a conversation the chat panel could send',
    (_id, { history = [], question }) => {
      const messages = [...history, { role: 'user', content: question }];

      expect(assistantRequestSchema.safeParse({ messages }).success).toBe(true);
    },
  );

  // A command as spoken ("next") is too short to tell its language from.
  it.each(EVAL_SET.map((entry) => [entry.id, entry] as const))(
    '%s is asked in no other language than it expects the answer in',
    (_id, { question, language }) => {
      expect(detectLanguage(question) ?? language).toBe(language);
    },
  );

  it('asks as the Admin and as a Member', () => {
    expect(count(({ role }) => role === 'admin')).toBeGreaterThanOrEqual(5);
    expect(count(({ role }) => role === 'member')).toBeGreaterThanOrEqual(5);
  });

  it('asks at least 5 questions in German and 2 in French', () => {
    expect(count(({ language }) => language === 'de')).toBeGreaterThanOrEqual(5);
    expect(count(({ language }) => language === 'fr')).toBeGreaterThanOrEqual(2);
  });

  it('has a Member ask about something only the Admin has a page for', () => {
    const adminPages = APP_ROUTES.filter(({ adminOnly }) => adminOnly).map(({ label }) => label);
    const sendsToAnAdminPage = (ref: DocsRef) => {
      const lookup = readDocsSection(loadDocs(), ref.page, ref.section);
      return lookup.found && adminPages.some((label) => lookup.markdown.includes(label));
    };

    expect(
      count(
        (entry) =>
          entry.role === 'member' &&
          entry.link === null &&
          sections(entry).some(sendsToAnAdminPage),
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it('has a question the docs do not answer, an off-topic request and a follow-up', () => {
    expect(count(({ docs }) => docs === 'lookup')).toBeGreaterThanOrEqual(1);
    expect(count(({ docs }) => docs === 'none')).toBeGreaterThanOrEqual(1);
    expect(count(({ history }) => (history?.length ?? 0) > 0)).toBeGreaterThanOrEqual(1);
  });

  describe("the entries about the user's own music", () => {
    it('are about 40, at least 3 in German and 1 in French', () => {
      expect(ABOUT_MUSIC.length).toBeGreaterThanOrEqual(30);
      expect(ABOUT_MUSIC.length).toBeLessThanOrEqual(45);
      expect(ABOUT_MUSIC.filter(({ language }) => language === 'de').length).toBeGreaterThanOrEqual(
        3,
      );
      expect(ABOUT_MUSIC.filter(({ language }) => language === 'fr').length).toBeGreaterThanOrEqual(
        1,
      );
    });

    it.each(EXPECTED_CALLS)(
      '%s expects a call a real turn can make: %o',
      (_id, { tool, input = [] }: ExpectedCall) => {
        const fields = Object.keys(
          (TOOLS.get(tool)?.inputSchema as { shape?: object } | undefined)?.shape ?? {},
        );

        expect([...TOOLS.keys()]).toContain(tool);
        for (const form of input) {
          expect(fields).toEqual(expect.arrayContaining(Object.keys(form)));
          const ids = Object.values(form)
            .flat()
            .filter((value) => uuidSchema.safeParse(value).success);
          expect(FIXTURE_IDS).toEqual(expect.arrayContaining(ids));
        }
      },
    );

    it('call for every tool that reads the user’s music or acts for them', () => {
      const expected = new Set(EXPECTED_CALLS.map(([, { tool }]) => tool));

      expect([...TOOLS.keys()].filter((tool) => !expected.has(tool))).toEqual(['readDocs']);
    });

    it('search lyrics, play each kind of thing, and give "next" and "pause" as spoken', () => {
      expect(forms('findMusic')).toContainEqual(expect.objectContaining({ lyrics: true }));
      expect(new Set(forms('play').map(({ kind }) => kind))).toEqual(
        new Set(['session', 'playlist', 'track']),
      );
      expect(ABOUT_MUSIC.map(({ question }) => question)).toEqual(
        expect.arrayContaining(['next', 'pause']),
      );
    });

    it('have a request in two steps: find something, then add or play it', () => {
      const actsOnWhatItFound = ({ calls = [] }: EvalEntry) =>
        calls.some(({ tool }) => tool === 'findMusic') &&
        calls.some(({ tool }) => tool === 'addToPlaylist' || tool === 'play');

      expect(ABOUT_MUSIC.filter(actsOnWhatItFound).length).toBeGreaterThanOrEqual(1);
    });

    it('have a request that says "this" about the Track that is playing', () => {
      // Left out, the Track is the one on the deck.
      expect(forms('favoriteTrack')).toContainEqual({ trackId: undefined });
    });

    it('rename and pin the Session that is on and rename the Track on the deck for "this"', () => {
      expect(forms('renameSession')).toContainEqual(
        expect.objectContaining({ sessionId: undefined }),
      );
      expect(forms('pinSession')).toContainEqual({ sessionId: undefined });
      expect(forms('renameTrack')).toContainEqual(expect.objectContaining({ trackId: undefined }));
    });

    it('prepare a new cover for a Session and for a Playlist, and Surprise Me as asked', () => {
      expect(new Set(forms('proposeCover').map((form) => form.in))).toEqual(
        new Set(['session', 'playlist']),
      );
      expect(forms('proposeSurprise')).toContainEqual(
        expect.objectContaining({ adventurous: true, theme: 'morning' }),
      );
    });

    it('have a request about "this" with nothing playing, which ends in no call', () => {
      expect(
        ABOUT_MUSIC.filter(({ nothingPlaying, calls }) => nothingPlaying && calls?.length === 0)
          .length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('have a request to remove something, which ends in a link and no call', () => {
      expect(
        ABOUT_MUSIC.filter(({ calls, link }) => calls?.length === 0 && typeof link === 'string')
          .length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('have a Member ask for a change only the Admin makes', () => {
      expect(
        ABOUT_MUSIC.filter(
          ({ calls, role, link }) => calls?.length === 0 && role === 'member' && !link,
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });

    it('have a request that builds on the receipt of the turn before', () => {
      const afterAReceipt = ({ history = [] }: EvalEntry) =>
        history.some(
          ({ role, content }) => role === 'assistant' && content.includes('[Done by the app: '),
        );

      expect(ABOUT_MUSIC.filter(afterAReceipt).length).toBeGreaterThanOrEqual(1);
    });
  });
});
