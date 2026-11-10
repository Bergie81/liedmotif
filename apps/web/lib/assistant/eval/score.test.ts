import { describe, expect, it } from 'vitest';
import type { AssistantAction } from '@liedmotif/shared';
import type { AnswerLinkTargets } from '../answer-links';
import { parseDocsPage } from '../docs';
import { appRoutesFor } from '../route-map';
import type { EvalEntry } from './eval-set';
import { answerLinks, claimsDone, detectLanguage, scoreAnswer, type ObservedTurn } from './score';

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
  actions: [],
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

const NEON_RAIN = { id: '00000000-0000-4000-8000-000000000201', name: 'Neon Rain' };
const RUNNING = { id: '00000000-0000-4000-8000-000000000302', name: 'Running' };

const receipt: AssistantAction = {
  status: 'done',
  receipt: {
    action: 'favoriteTrack',
    track: NEON_RAIN,
    playlist: { id: '00000000-0000-4000-8000-000000000301', name: 'Favorites' },
  },
};
const command: AssistantAction = { status: 'player', command: { name: 'next' } };
const card: AssistantAction = {
  status: 'proposed',
  card: { kind: 'session', prompt: 'calm piano', vocal: 'instrumental' },
};

/** A request about the user's own music, with the calls a good turn makes. */
const request = (calls: EvalEntry['calls'], overrides: Partial<EvalEntry> = {}): EvalEntry => ({
  id: 'request',
  role: 'member',
  language: 'en',
  question: 'Favorite this.',
  docs: 'none',
  calls,
  goodAnswer: 'Says it is in Favorites.',
  ...overrides,
});

const called = (name: string, input: unknown = {}, result = 'Done: it is done.') => ({
  name,
  input,
  result,
});

describe('scoring what a turn did', () => {
  const favoriteThis = request([
    { tool: 'favoriteTrack', input: [{ trackId: undefined }, { trackId: NEON_RAIN.id }] },
  ]);

  it('passes a turn that called the expected tool for the expected item', () => {
    const made = turn({
      answer: 'Added to your Favorites.',
      toolCalls: [called('favoriteTrack', { trackId: NEON_RAIN.id })],
      actions: [receipt],
    });

    expect(scoreAnswer(favoriteThis, made, MEMBER)).toMatchObject({
      toolCalled: 'pass',
      toolValues: 'pass',
      noAction: 'n/a',
      card: 'n/a',
      noFalseClaim: 'pass',
    });
  });

  it('takes a field the model left out, sent as null or sent empty for "left out"', () => {
    for (const input of [{}, { trackId: null }, { trackId: '' }]) {
      const made = turn({ toolCalls: [called('favoriteTrack', input)], actions: [receipt] });

      expect(scoreAnswer(favoriteThis, made, MEMBER).toolValues, JSON.stringify(input)).toBe(
        'pass',
      );
    }
  });

  it('fails the values of a call that points at another item', () => {
    const made = turn({ toolCalls: [called('favoriteTrack', { trackId: RUNNING.id })] });

    expect(scoreAnswer(favoriteThis, made, MEMBER)).toMatchObject({
      toolCalled: 'pass',
      toolValues: 'fail',
    });
  });

  it('fails both when the expected tool was never called', () => {
    const made = turn({ toolCalls: [called('nowPlaying')] });

    expect(scoreAnswer(favoriteThis, made, MEMBER)).toMatchObject({
      toolCalled: 'fail',
      toolValues: 'fail',
    });
  });

  it('wants every expected call of a two-step request, in any order', () => {
    const findThenAdd = request([
      { tool: 'findMusic' },
      { tool: 'addToPlaylist', input: [{ playlistId: RUNNING.id, trackIds: [NEON_RAIN.id] }] },
    ]);
    const add = called('addToPlaylist', { playlistId: RUNNING.id, trackIds: [NEON_RAIN.id] });
    const find = called('findMusic', { kind: 'playlist', query: 'running' });

    expect(scoreAnswer(findThenAdd, turn({ toolCalls: [add, find] }), MEMBER)).toMatchObject({
      toolCalled: 'pass',
      toolValues: 'pass',
    });
    expect(scoreAnswer(findThenAdd, turn({ toolCalls: [add] }), MEMBER)).toMatchObject({
      toolCalled: 'fail',
      toolValues: 'fail',
    });
  });

  it('compares a list of ids as a set, and other values exactly', () => {
    const two = request([{ tool: 'addToPlaylist', input: [{ trackIds: ['a', 'b'] }] }]);
    const scored = (trackIds: string[]) =>
      scoreAnswer(two, turn({ toolCalls: [called('addToPlaylist', { trackIds })] }), MEMBER)
        .toolValues;

    expect(scored(['b', 'a'])).toBe('pass');
    expect(scored(['a'])).toBe('fail');
    expect(scored(['a', 'b', 'c'])).toBe('fail');

    const timer = request([{ tool: 'sleepTimer', input: [{ minutes: 30, off: undefined }] }]);
    const set = (input: unknown) =>
      scoreAnswer(timer, turn({ toolCalls: [called('sleepTimer', input)] }), MEMBER).toolValues;
    expect(set({ minutes: 30, off: false })).toBe('pass');
    expect(set({ minutes: 45 })).toBe('fail');
    expect(set({ minutes: 30, off: true })).toBe('fail');
  });

  describe('where nothing should be done', () => {
    const remove = request([], { question: 'Remove Neon Rain from my Favorites.' });

    it('passes a turn that only looked things up', () => {
      const made = turn({
        answer: 'I cannot remove a Track. You do that in your Library.',
        toolCalls: [called('findMusic', { kind: 'track', query: 'Neon Rain' }, 'Tracks: …')],
      });

      expect(scoreAnswer(remove, made, MEMBER)).toMatchObject({
        toolCalled: 'n/a',
        toolValues: 'n/a',
        noAction: 'pass',
        noFalseClaim: 'pass',
      });
    });

    it('fails a turn that changed something, commanded the player or offered a card', () => {
      for (const action of [receipt, command, card]) {
        expect(
          scoreAnswer(remove, turn({ actions: [action] }), MEMBER).noAction,
          action.status,
        ).toBe('fail');
      }
    });

    it('also holds a question about the docs, and one about music, to it', () => {
      const whatIsThis = request([{ tool: 'nowPlaying' }], { question: 'What is this?' });

      expect(scoreAnswer(INVITE, turn(), ADMIN).noAction).toBe('pass');
      expect(scoreAnswer(INVITE, turn({ actions: [command] }), ADMIN).noAction).toBe('fail');
      expect(scoreAnswer(whatIsThis, turn({ actions: [command] }), MEMBER).noAction).toBe('fail');
    });
  });

  describe('where a card is expected', () => {
    const startSomething = request([{ tool: 'proposeSession' }], {
      question: 'Start something calm.',
    });

    it('passes a turn that offered that card and says it is prepared', () => {
      const made = turn({
        answer: 'I have prepared a card for a calm Session. Confirming it generates new Tracks.',
        toolCalls: [called('proposeSession', { prompt: 'something calm' }, 'Prepared: a card …')],
        actions: [card],
      });

      expect(scoreAnswer(startSomething, made, MEMBER)).toMatchObject({
        card: 'pass',
        noAction: 'n/a',
        noFalseClaim: 'pass',
      });
    });

    it('fails a turn that offered none, or a card for something else', () => {
      const other: AssistantAction = {
        status: 'proposed',
        card: { kind: 'moreLikeThis', tracks: [NEON_RAIN] },
      };

      expect(scoreAnswer(startSomething, turn(), MEMBER).card).toBe('fail');
      expect(scoreAnswer(startSomething, turn({ actions: [other] }), MEMBER).card).toBe('fail');
    });

    it('fails the claim of a turn that says the Session has started', () => {
      const made = turn({ answer: 'I started a calm Session for you.', actions: [card] });

      expect(scoreAnswer(startSomething, made, MEMBER)).toMatchObject({
        card: 'pass',
        noFalseClaim: 'fail',
      });
    });
  });

  it('does not judge a claim in an answer about the docs', () => {
    expect(scoreAnswer(INVITE, turn({ answer: 'I have added her.' }), ADMIN).noFalseClaim).toBe(
      'n/a',
    );
  });

  it('judges no link where the entry names none, and no language in an answer of two words', () => {
    const next = request([{ tool: 'playerControl', input: [{ command: 'next' }] }]);
    const made = turn({
      answer: 'Skipped. [Now Playing](/player)',
      toolCalls: [called('playerControl', { command: 'next' })],
      actions: [command],
    });

    expect(scoreAnswer(next, made, MEMBER)).toMatchObject({
      link: 'n/a',
      language: 'n/a',
      screenNames: 'n/a',
      noFalseClaim: 'pass',
    });
  });

  it('judges no language in a turn that acted and wrote nothing', () => {
    const next = request([{ tool: 'playerControl' }]);

    expect(scoreAnswer(next, turn({ answer: '', actions: [command] }), MEMBER).language).toBe(
      'n/a',
    );
  });
});

describe('a claim that something was done', () => {
  it.each([
    'Done.',
    'I have added it to your Favorites.',
    "I've removed the Track from the Playlist.",
    'Your budget has been raised to 50 Tracks.',
    'Removed from Favorites.',
    'Ich habe den Track aus deinen Favoriten entfernt.',
    'Erledigt!',
    'Dein Tagesbudget wurde auf 50 Tracks erhöht.',
    "J'ai supprimé le morceau de tes favoris.",
    "C'est fait.",
    '[Done by the app: created the Playlist "Gym"]',
    // What follows the claim does not take it back.
    'I’ve switched New music on with no limit.',
    'I started a calm instrumental Session without vocals.',
    "I've removed Midnight Overpass, it's no longer in your Favorites.",
    'Ich habe den Track entfernt, er ist nicht mehr in deinen Favoriten.',
    // A few words that end in it, as a command is answered.
    'Session started.',
    'Okay, removed.',
    'Session gestartet.',
    "The vibe's been changed.",
  ])('is seen in: %s', (answer) => {
    expect(claimsDone(answer)).toBe(true);
  });

  it.each([
    '',
    'I cannot remove a Track. You do that in your [Library](/library).',
    'Nothing was changed: I could not find that Playlist.',
    'I have prepared a card for a calm Session. It starts when you confirm it.',
    'This is **Neon Rain** from your Session **Night Drive**.',
    'You have 12 of 20 Tracks left today.',
    'Das kann ich nicht für dich ändern. Frag deinen Admin.',
    'Ich habe eine Karte vorbereitet. Die Session startet erst, wenn du sie bestätigst.',
    'Je ne peux pas supprimer un morceau.',
    'No Session has started yet.',
    'Die Session wurde noch nicht gestartet.',
    // A card is the one thing a turn that only prepares has made.
    "I've created a card for a calm Session.",
    'Ich habe eine Karte für eine ruhige Session erstellt.',
    'Prepared: the card to keep this Session generating new music with no limit is waiting for you.',
  ])('is not seen in: %s', (answer) => {
    expect(claimsDone(answer)).toBe(false);
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

  it('sees a link written with a reference, which the panel also turns into a button', () => {
    const answer = 'Your music is in the [Library][lib].\n\n[lib]: /library';

    expect(answerLinks(answer, targetsFor('member'))).toEqual({
      app: ['/library'],
      docs: [],
      plainText: [],
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
