// Scores one Assistant answer against what its eval-set entry expects. Pure
// functions over the answer and the docs sections the turn read. Whether the
// answer agrees with the docs is left to a human reading the report.

import { readDocsInputSchema } from '@liedmotif/shared';
import { resolveAnswerLink, type AnswerLinkTargets } from '../answer-links';
import { readDocsSection, type DocsPage } from '../docs';
import { READ_DOCS_TOOL_NAME } from '../read-docs-tool';
import { APP_ROUTES } from '../route-map';
import type { DocsRef, EvalEntry, EvalLanguage } from './eval-set';

/** A tool call the model made during one turn, with what it got back. */
export interface ObservedToolCall {
  name: string;
  input: unknown;
  result: string;
}

/** What one turn produced. A turn with an `error` has no usable answer. */
export interface ObservedTurn {
  answer: string;
  toolCalls: readonly ObservedToolCall[];
  error?: string;
}

/** `n/a`: the entry expects nothing this check could judge. */
export type Verdict = 'pass' | 'fail' | 'n/a';

export interface DocsRead extends DocsRef {
  /** The section exists and the turn got its text. */
  read: boolean;
}

export interface AnswerScore {
  /** Called `readDocs` with a page and section that exist. */
  validRead: Verdict;
  /** Read one of the sections the entry names. */
  expectedRead: Verdict;
  /** Ends in the expected app page, or in none where none is expected. */
  link: Verdict;
  /** Written in the language of the question. */
  language: Verdict;
  /** Names the expected app page exactly as the app shows it. */
  screenNames: Verdict;
  reads: DocsRead[];
  links: AnswerLinks;
  detectedLanguage: EvalLanguage | null;
}

/** The checks in report order: the score's key, what it checks, and a column title. */
export const CHECKS = [
  ['validRead', 'Called readDocs with a valid section', 'Valid read'],
  ['expectedRead', 'Read the expected section', 'Expected read'],
  ['link', 'Link correct', 'Link'],
  ['language', 'Answered in the asked language', 'Language'],
  ['screenNames', 'Screen names left as shown', 'Screen names'],
] as const satisfies ReadonlyArray<readonly [keyof AnswerScore, string, string]>;

export function scoreAnswer(
  entry: EvalEntry,
  turn: ObservedTurn,
  context: { pages: readonly DocsPage[]; targets: AnswerLinkTargets },
): AnswerScore {
  const answered = turn.error === undefined;
  const verdict = (applies: boolean, ok: boolean): Verdict =>
    !applies ? 'n/a' : answered && ok ? 'pass' : 'fail';

  const reads = docsReads(turn.toolCalls, context.pages);
  const expected = Array.isArray(entry.docs)
    ? entry.docs.map((ref) => canonical(ref, context))
    : [];
  const links = answerLinks(turn.answer, context.targets);
  const detectedLanguage = detectLanguage(turn.answer);
  const screenName = APP_ROUTES.find(({ path }) => path === entry.link)?.label;

  return {
    validRead: verdict(
      entry.docs !== 'none',
      reads.some(({ read }) => read),
    ),
    expectedRead: verdict(
      expected.length > 0,
      reads.some(
        (made) =>
          made.read &&
          expected.some((ref) => ref.page === made.page && ref.section === made.section),
      ),
    ),
    link: verdict(
      true,
      entry.link === null ? links.app.length === 0 : links.app.includes(entry.link),
    ),
    language: verdict(true, detectedLanguage === entry.language),
    screenNames: verdict(screenName !== undefined, turn.answer.includes(screenName ?? '')),
    reads,
    links,
    detectedLanguage,
  };
}

/** A section reference as `readDocsSection` names it, whether written by id or by heading. */
function canonical(ref: DocsRef, { pages }: { pages: readonly DocsPage[] }): DocsRef {
  const lookup = readDocsSection(pages, ref.page, ref.section);
  return lookup.found ? { page: lookup.page, section: lookup.section } : ref;
}

/**
 * The `readDocs` calls of a turn. A call counts as read when the section exists
 * and the tool handed its text over; a section refused for the turn's read
 * budget was asked for correctly but not read.
 */
function docsReads(toolCalls: readonly ObservedToolCall[], pages: readonly DocsPage[]): DocsRead[] {
  return toolCalls
    .filter(({ name }) => name === READ_DOCS_TOOL_NAME)
    .map(({ input, result }) => {
      const parsed = readDocsInputSchema.safeParse(input);
      if (!parsed.success) return { page: '?', section: '?', read: false };
      const lookup = readDocsSection(pages, parsed.data.page, parsed.data.section);
      return lookup.found
        ? { page: lookup.page, section: lookup.section, read: result === lookup.markdown }
        : { ...parsed.data, read: false };
    });
}

export interface AnswerLinks {
  /** App pages the chat panel would turn into a button, by path. */
  app: string[];
  /** Docs pages the panel would open on the website, by URL. */
  docs: string[];
  /** Targets the panel shows as plain text: nothing the user can follow. */
  plainText: string[];
}

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
// `[text](target)` with an optional title. An image is not a link: the panel
// shows only its description.
const INLINE_LINK = /(!?)\[[^\]]*\]\(\s*<?([^\s)>]+)>?[^)]*\)/g;

/**
 * The Markdown links of an answer, sorted the way the chat panel treats them.
 * Only links written as `[text](target)` are seen; a bare web address is not.
 */
export function answerLinks(answer: string, targets: AnswerLinkTargets): AnswerLinks {
  const links: AnswerLinks = { app: [], docs: [], plainText: [] };
  for (const [, image, href] of answer.replace(CODE, '').matchAll(INLINE_LINK)) {
    if (image || !href) continue;
    const link = resolveAnswerLink(href, targets);
    if (link?.kind === 'app') links.app.push(link.path);
    else if (link?.kind === 'docs') links.docs.push(link.url);
    else links.plainText.push(href);
  }
  return links;
}

// Function words that are frequent in one of the three languages and not a word
// of the other two.
const FUNCTION_WORDS: Record<EvalLanguage, ReadonlySet<string>> = {
  en: new Set(
    'the and is are you your to of that this it with for can not from have then there when which what how if but be do does at by they them their has only each any about into its yourself'.split(
      ' ',
    ),
  ),
  de: new Set(
    'der das und ist nicht mit für auf ein eine einen einem einer dein deine deinen deinem dich dir den dem zu von wird werden kann kannst wenn oder aber auch nur sich sie wie dort dann noch bei nach über unter dass sind im zum zur ich wir mehr kein keine dafür damit dabei'.split(
      ' ',
    ),
  ),
  fr: new Set(
    'le la les et est pas pour dans une un tu ta tes toi vous votre que qui avec sur ce cette ces ne se au aux ou mais peut peux sont il elle nous par si à où être aussi comme de lui'.split(
      ' ',
    ),
  ),
};

/** Fewer function words than this and the answer is too short to call. */
const MIN_FUNCTION_WORDS = 2;

/**
 * The language an answer is written in, or `null` when it cannot be told.
 *
 * A heuristic that needs no model and no network: it counts each language's
 * function words and takes the clear winner. Code, links and bold text are left
 * out first, because an answer in any language keeps the app's English names
 * there. It knows only the eval set's languages, calls a mixed answer by its
 * majority, and gives up on an answer of a few words.
 */
export function detectLanguage(answer: string): EvalLanguage | null {
  const prose = answer
    .replace(CODE, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\*\*[^*]*\*\*/g, ' ')
    .toLowerCase();
  const words = prose.match(/\p{L}+/gu) ?? [];
  const counts = (Object.keys(FUNCTION_WORDS) as EvalLanguage[])
    .map((language) => ({
      language,
      count: words.filter((word) => FUNCTION_WORDS[language].has(word)).length,
    }))
    .sort((a, b) => b.count - a.count);
  const [first, second] = counts;
  if (!first || first.count < MIN_FUNCTION_WORDS || first.count === second?.count) return null;
  return first.language;
}
