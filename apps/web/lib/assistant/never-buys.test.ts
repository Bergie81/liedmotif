// The Assistant has no code that can buy music. A new Session is created in
// one place, the start route, and the only way there from the chat is the
// user's click on a card: a request the browser sends. This reads the
// Assistant's own source, so a later tool that reached for the creation
// function, or for the route, fails here.

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

/** The function that creates a Session, by the name the start route calls it. */
const CREATES_A_SESSION = /\bcreateSession\b/;

describe('the Assistant’s own code', () => {
  it('is read where it lives', () => {
    expect(SERVER).toContain(join('lib/assistant', 'propose-session-tool.ts'));
    expect(SERVER).toContain(join('app/api/assistant', 'route.ts'));
    expect(PANEL).toContain(join('components/assistant', 'confirm-card.ts'));
    // What the pin looks for is what the start route really calls.
    expect(read('app/api/sessions/route.ts')).toMatch(CREATES_A_SESSION);
  });

  it('never references the function that creates a Session', () => {
    expect(mentioning([...SERVER, ...PANEL], CREATES_A_SESSION)).toEqual([]);
  });

  it('has no server code that calls the app’s own routes', () => {
    expect(mentioning(SERVER, /\/api\/sessions|@\/lib\/api-client/)).toEqual([]);
  });

  it('sends the start request from one place in the browser: the flows a confirmed card runs', () => {
    // The client function that posts to the start route, as a panel file imports it.
    const importsTheStart = /import\s*\{[^}]*\bstartSession\b[^}]*\}\s*from\s*'@\/lib\/api-client'/;

    expect(mentioning(PANEL, importsTheStart)).toEqual([
      join('components/assistant', 'use-card-host.ts'),
    ]);
  });
});
