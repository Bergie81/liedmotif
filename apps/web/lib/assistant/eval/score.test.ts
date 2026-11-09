import { describe, expect, it } from 'vitest';
import type { AnswerLinkTargets } from '../answer-links';
import { parseDocsPage } from '../docs';
import { appRoutesFor } from '../route-map';
import type { EvalEntry } from './eval-set';
import { answerLinks, detectLanguage, scoreAnswer, type ObservedTurn } from './score';

const INVITE_SECTION = '## Invite someone\n\nCreate an invite link in **Settings › Members**.';
const PAGES = [
  parseDocsPage(
    'members',
    `---\ntitle: Members\ndescription: People.\n---\n\nBring people in.\n\n${INVITE_SECTION}\n\n## The lounge\n\nShare playlists.\n`,
  ),
];

const targetsFor = (role: 'admin' | 'member'): AnswerLinkTargets => ({
  appPaths: appRoutesFor(role).map(({ path }) => path),
  docsPages: PAGES.map(({ slug }) => slug),
});

const ADMIN = { pages: PAGES, targets: targetsFor('admin') };
const MEMBER = { pages: PAGES, targets: targetsFor('member') };

const INVITE: EvalEntry = {
  id: 'invite',
  role: 'admin',
  language: 'en',
  question: 'How do I invite my sister?',
  docs: [{ page: 'members', section: 'invite-someone' }],
  link: '/settings/members',
  goodAnswer: 'Create an invite link and send it.',
};

const readInvite = {
  name: 'readDocs',
  input: { page: 'members', section: 'Invite someone' },
  result: INVITE_SECTION,
};

const GOOD_ANSWER =
  'Open **Settings › Members** and create an invite link, then send it to her. ' +
  'Her music is paid from your keys. [Settings › Members](/settings/members)';

const turn = (overrides: Partial<ObservedTurn> = {}): ObservedTurn => ({
  answer: GOOD_ANSWER,
  toolCalls: [readInvite],
  ...overrides,
});

describe('scoring an answer', () => {
  it('passes a turn that read the expected section and ends in the expected page', () => {
    expect(scoreAnswer(INVITE, turn(), ADMIN)).toMatchObject({
      validRead: 'pass',
      expectedRead: 'pass',
      link: 'pass',
      language: 'pass',
      screenNames: 'pass',
    });
  });

  it('fails the reads of a turn that answered without the docs', () => {
    expect(scoreAnswer(INVITE, turn({ toolCalls: [] }), ADMIN)).toMatchObject({
      validRead: 'fail',
      expectedRead: 'fail',
    });
  });

  it('does not count a call for a section that does not exist', () => {
    const wrong = {
      name: 'readDocs',
      input: { page: 'members', section: 'Roles' },
      result: 'The page "members" has no section "Roles". Its sections are: intro; Invite someone.',
    };

    const score = scoreAnswer(INVITE, turn({ toolCalls: [wrong] }), ADMIN);

    expect(score).toMatchObject({ validRead: 'fail', expectedRead: 'fail' });
    expect(score.reads).toEqual([{ page: 'members', section: 'Roles', read: false }]);
  });

  it('tells a valid read of another section from the expected one', () => {
    const lounge = {
      name: 'readDocs',
      input: { page: 'members', section: 'the-lounge' },
      result: '## The lounge\n\nShare playlists.',
    };

    expect(scoreAnswer(INVITE, turn({ toolCalls: [lounge] }), ADMIN)).toMatchObject({
      validRead: 'pass',
      expectedRead: 'fail',
    });
  });

  it('does not count a section the tool refused for the read budget', () => {
    const refused = { ...readInvite, result: 'That section is more than you can still read.' };

    expect(scoreAnswer(INVITE, turn({ toolCalls: [refused] }), ADMIN)).toMatchObject({
      validRead: 'fail',
      expectedRead: 'fail',
    });
  });

  it('fails the link when the answer names the page without linking to it', () => {
    const answer = 'Open **Settings › Members** and create an invite link for her.';

    expect(scoreAnswer(INVITE, turn({ answer }), ADMIN)).toMatchObject({
      link: 'fail',
      screenNames: 'pass',
    });
  });

  it('fails the screen name when the answer translates it', () => {
    const entry: EvalEntry = { ...INVITE, language: 'de' };
    const answer =
      'Öffne die Einstellungen für Mitglieder und erstelle einen Einladungslink, den du ihr schickst. ' +
      '[Einstellungen › Mitglieder](/settings/members)';

    expect(scoreAnswer(entry, turn({ answer }), ADMIN)).toMatchObject({
      link: 'pass',
      language: 'pass',
      screenNames: 'fail',
    });
  });

  it('fails the language of an English answer to a German question', () => {
    expect(scoreAnswer({ ...INVITE, language: 'de' }, turn(), ADMIN)).toMatchObject({
      language: 'fail',
      detectedLanguage: 'en',
    });
  });

  describe('when no app link is expected', () => {
    const memberAsks: EvalEntry = { ...INVITE, role: 'member', link: null };

    it('passes an answer without one, and has no screen name to check', () => {
      const answer = 'The Admin does this for you, so ask your Admin for an invite link.';

      expect(scoreAnswer(memberAsks, turn({ answer }), MEMBER)).toMatchObject({
        link: 'pass',
        screenNames: 'n/a',
      });
    });

    it('fails an answer that links to a page of the app anyway', () => {
      const answer = 'Ask your Admin, and check what you have left. [Home](/)';

      expect(scoreAnswer(memberAsks, turn({ answer }), MEMBER).link).toBe('fail');
    });

    it('does not count a link to an admin page a Member cannot follow, but reports it', () => {
      const score = scoreAnswer(memberAsks, turn(), MEMBER);

      expect(score.link).toBe('pass');
      expect(score.links).toEqual({ app: [], docs: [], plainText: ['/settings/members'] });
    });
  });

  it('expects a lookup, but no particular section, where the docs have no answer', () => {
    const entry: EvalEntry = { ...INVITE, docs: 'lookup', link: null };

    expect(scoreAnswer(entry, turn(), ADMIN)).toMatchObject({
      validRead: 'pass',
      expectedRead: 'n/a',
    });
    expect(scoreAnswer(entry, turn({ toolCalls: [] }), ADMIN).validRead).toBe('fail');
  });

  it('expects no lookup for an off-topic request', () => {
    const entry: EvalEntry = { ...INVITE, docs: 'none', link: null };
    const answer = 'That is not something I can help with here, but ask me about Liedmotif.';

    expect(scoreAnswer(entry, turn({ answer, toolCalls: [] }), ADMIN)).toMatchObject({
      validRead: 'n/a',
      expectedRead: 'n/a',
      link: 'pass',
      language: 'pass',
    });
  });

  it('fails every check that applies when the turn itself failed', () => {
    const failed = turn({ answer: '', toolCalls: [], error: 'The Writing AI did not answer.' });

    expect(scoreAnswer({ ...INVITE, link: null }, failed, ADMIN)).toMatchObject({
      validRead: 'fail',
      expectedRead: 'fail',
      link: 'fail',
      language: 'fail',
      screenNames: 'n/a',
    });
  });
});

describe('the links of an answer', () => {
  it('sorts them the way the chat panel treats them', () => {
    const answer =
      'See [Settings › Members](/settings/members), the [docs](/docs/members#invite-someone), ' +
      '[the web](https://example.com/a) and [nowhere](/settings/nope).';

    expect(answerLinks(answer, targetsFor('admin'))).toEqual({
      app: ['/settings/members'],
      docs: ['https://liedmotif.com/docs/members/#invite-someone'],
      plainText: ['https://example.com/a', '/settings/nope'],
    });
  });

  it('leaves out images and links inside code', () => {
    const answer = '![Home](/) and `[Home](/)` are not links.';

    expect(answerLinks(answer, targetsFor('admin'))).toEqual({ app: [], docs: [], plainText: [] });
  });
});

describe('detecting the language of an answer', () => {
  it('tells English, German and French apart', () => {
    expect(
      detectLanguage('Open the page and create an invite link, then send it to her yourself.'),
    ).toBe('en');
    expect(
      detectLanguage(
        'Öffne die Seite und erstelle einen Einladungslink, den du ihr dann schickst.',
      ),
    ).toBe('de');
    expect(
      detectLanguage("Ouvre la page et crée un lien d'invitation, que tu lui envoies ensuite."),
    ).toBe('fr');
  });

  it('is not misled by the English screen names a translated answer keeps', () => {
    const answer =
      'Öffne **Settings › Playback**, stelle **Crossfade length** ein und drücke **Save playback**. ' +
      'Danach lädst du die Seite neu. [Settings › Playback](/settings/playback)';

    expect(detectLanguage(answer)).toBe('de');
  });

  it('recognizes a one-sentence refusal', () => {
    expect(detectLanguage('Dabei kann ich dir nicht helfen, ich bin nur für Liedmotif da.')).toBe(
      'de',
    );
  });

  it('does not guess when there is too little to go on', () => {
    expect(detectLanguage('**Settings › Playback**')).toBeNull();
    expect(detectLanguage('OK.')).toBeNull();
  });
});
