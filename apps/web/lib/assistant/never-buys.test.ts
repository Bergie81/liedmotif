// The Assistant has no code that can buy music. Four things can spend: a new
// Session, a More Like This, a Change Vibe, and New music on. Each is written
// by one function, called from the app's own route, and the only way there
// from the chat is the user's click on a card: a request the browser sends.
// This reads the Assistant's own source, so a later tool that reached for one
// of those functions, or for a route, fails here.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = join(import.meta.dirname, '..', '..');

/** Every source file under `dir` that is not a test. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(WEB_ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => join(dir, file));
}

const read = (file: string) => readFileSync(join(WEB_ROOT, file), 'utf8');

/** The files among `files` whose source matches `pattern`. */
const mentioning = (files: string[], pattern: RegExp) =>
  files.filter((file) => pattern.test(read(file)));

const SERVER = [...sourceFiles('lib/assistant'), ...sourceFiles('app/api/assistant')];
const PANEL = sourceFiles('components/assistant');

/** The function that creates a Session, by the name the start and More Like This routes call it. */
const CREATES_A_SESSION = /\bcreateSession\b/;
/** The function that gives a Session a new vibe, by the name the Change Vibe route calls it. */
const CHANGES_THE_VIBE = /\brestyleSession\b/;
/** The function behind New music on, by the name the duration route and the api client call it. */
const SETS_THE_DURATION = /\bsetSessionDuration\b/;
/** The function that writes a Session's mode; towards Keep Going it switches generation on. */
const SWITCHES_THE_MODE = /\b(switchSessionMode|setSessionMode)\b/;

/** A panel file's import of one of `names` from the api client. */
const importsFromApiClient = (names: string) =>
  new RegExp(`import\\s*\\{[^}]*\\b(${names})\\b[^}]*\\}\\s*from\\s*'@/lib/api-client'`);

const CARD_HOST = join('components/assistant', 'use-card-host.ts');

describe('the Assistant’s own code', () => {
  it('is read where it lives', () => {
    expect(SERVER).toContain(join('lib/assistant', 'propose-session-tool.ts'));
    expect(SERVER).toContain(join('app/api/assistant', 'route.ts'));
    expect(PANEL).toContain(join('components/assistant', 'confirm-card.ts'));
    // What the pins look for is what the routes really call.
    expect(read('app/api/sessions/route.ts')).toMatch(CREATES_A_SESSION);
    expect(read('app/api/sessions/more-like-this/route.ts')).toMatch(CREATES_A_SESSION);
    expect(read('app/api/sessions/change-vibe/route.ts')).toMatch(CHANGES_THE_VIBE);
    expect(read('app/api/sessions/duration/route.ts')).toMatch(SETS_THE_DURATION);
    expect(read('lib/api-client.ts')).toMatch(SETS_THE_DURATION);
  });

  it('never references the function that creates a Session', () => {
    expect(mentioning([...SERVER, ...PANEL], CREATES_A_SESSION)).toEqual([]);
  });

  it('never references the function that changes a vibe, or the one that sets New music on', () => {
    expect(mentioning([...SERVER, ...PANEL], CHANGES_THE_VIBE)).toEqual([]);
    expect(mentioning([...SERVER, ...PANEL], SETS_THE_DURATION)).toEqual([]);
  });

  it('writes a Session’s mode in one place, and only to switch New music off', () => {
    const writers = mentioning([...SERVER, ...PANEL], SWITCHES_THE_MODE);

    expect(writers).toEqual([join('lib/assistant', 'new-music-off-tool.ts')]);
    expect(read(writers[0]!)).toMatch(/mode: 'repeat'/);
    expect(read(writers[0]!)).not.toMatch(/keep_going/);
  });

  it('has no server code that calls the app’s own routes', () => {
    expect(mentioning(SERVER, /\/api\/sessions|@\/lib\/api-client/)).toEqual([]);
  });

  it('sends the start request from one place in the browser: the flows a confirmed card runs', () => {
    // The client function that posts to the start route, as a panel file imports it.
    expect(mentioning(PANEL, importsFromApiClient('startSession'))).toEqual([CARD_HOST]);
  });

  it('imports none of the other client calls that spend: a card runs the app’s own flows for them', () => {
    // The client functions that post to the Change Vibe, More Like This and duration routes.
    const importsASpend = importsFromApiClient('changeVibe|moreLikeThis|setSessionDuration');
    // The flows the app's own controls run, which hold those calls.
    const runsASpendFlow = /\b(submitChangeVibe|useSeedMoreLikeThis|switchNewMusicOn)\b/;

    expect(read('components/player/use-vibe-change-request.ts')).toMatch(importsASpend);
    expect(read('components/sessions/use-seed-more-like-this.ts')).toMatch(importsASpend);
    expect(read('components/player/switch-new-music-on.ts')).toMatch(importsASpend);
    expect(mentioning(PANEL, importsASpend)).toEqual([]);
    expect(mentioning(PANEL, runsASpendFlow)).toEqual([CARD_HOST]);
    expect(mentioning(SERVER, runsASpendFlow)).toEqual([]);
    for (const flow of ['submitChangeVibe', 'useSeedMoreLikeThis', 'switchNewMusicOn']) {
      expect(read(CARD_HOST)).toContain(flow);
    }
  });
});
