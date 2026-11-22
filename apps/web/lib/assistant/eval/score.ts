// Scores one Assistant turn against what its eval-set entry expects. Pure
// functions over the answer, the tool calls and what the turn did for the
// user. Whether the answer is right is left to a human reading the report.

import { compiler } from 'markdown-to-jsx/react';
import { readDocsInputSchema, type AssistantAction } from '@liedmotif/shared';
import { resolveAnswerLink, type AnswerLinkTargets } from '../answer-links';
import { readDocsSection, type DocsPage } from '../docs';
import {
  BUDGET_TOOL_NAME,
  FIND_MUSIC_TOOL_NAME,
  LIST_TRACKS_TOOL_NAME,
  NOW_PLAYING_TOOL_NAME,
  PROPOSE_CHANGE_VIBE_TOOL_NAME,
  PROPOSE_COVER_TOOL_NAME,
  PROPOSE_MORE_LIKE_THIS_TOOL_NAME,
  PROPOSE_NEW_MUSIC_ON_TOOL_NAME,
  PROPOSE_SESSION_TOOL_NAME,
  PROPOSE_SURPRISE_TOOL_NAME,
  READ_DOCS_TOOL_NAME,
  READ_TRACK_TOOL_NAME,
} from '../tool-names';
import { APP_ROUTES } from '../route-map';
import type { DocsRef, EvalEntry, EvalLanguage, ExpectedCall } from './eval-set';

/**
 * A tool call the model made during one turn, with what it got back. A call is
 * seen once its input has passed the tool's own schema, so every input here is
 * one the tool takes.
 */
export interface ObservedToolCall {
  name: string;
  input: unknown;
  result: string;
}

/** What one turn produced. A turn with an `error` has no usable answer. */
export interface ObservedTurn {
  answer: string;
  toolCalls: readonly ObservedToolCall[];
  /** What the turn did for the user: each receipt, player command and card it reported. */
  actions: readonly AssistantAction[];
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
  /** Called every tool the entry expects. */
  toolCalled: Verdict;
  /** Called each of them with the expected values: the right item, the right setting. */
  toolValues: Verdict;
  /** Changed nothing, commanded nothing and offered no card, where the entry expects none of it. */
  noAction: Verdict;
  /** Offered the card the entry expects. */
  card: Verdict;
  /** Says something was done only in a turn that has a receipt or a player command. */
  noFalseClaim: Verdict;
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
  ['toolCalled', 'Called the expected tool', 'Tool'],
  ['toolValues', 'Called it with the expected values', 'Values'],
  ['noAction', 'Did nothing where nothing is expected', 'No action'],
  ['card', 'Offered a card where one is expected', 'Card'],
  ['noFalseClaim', 'Claimed nothing done without a receipt', 'No claim'],
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
    ? entry.docs.map((ref) => canonical(ref, context.pages))
    : [];
  const links = answerLinks(turn.answer, context.targets);
  const detectedLanguage = detectLanguage(turn.answer);
  const screenName = APP_ROUTES.find(({ path }) => path === entry.link)?.label;
  const calls = entry.calls ?? [];
  const cards = calls.flatMap(({ tool }) => CARD_OF[tool] ?? []);
  const made = (call: ExpectedCall, withValues: boolean) =>
    turn.toolCalls.some(
      ({ name, input }) => name === call.tool && (!withValues || carries(input, call)),
    );

  return {
    validRead: verdict(
      entry.docs !== 'none',
      reads.some(({ read }) => read),
    ),
    expectedRead: verdict(
      expected.length > 0,
      reads.some(
        (seen) =>
          seen.read &&
          expected.some((ref) => ref.page === seen.page && ref.section === seen.section),
      ),
    ),
    link: verdict(
      entry.link !== undefined,
      entry.link == null ? links.app.length === 0 : links.app.includes(entry.link),
    ),
    // An answer too short to call is not judged: a command is answered in a
    // word or two, or by the action alone.
    language: verdict(!answered || detectedLanguage !== null, detectedLanguage === entry.language),
    screenNames: verdict(screenName !== undefined, turn.answer.includes(screenName ?? '')),
    toolCalled: verdict(
      calls.length > 0,
      calls.every((call) => made(call, false)),
    ),
    toolValues: verdict(
      calls.length > 0,
      calls.every((call) => made(call, true)),
    ),
    noAction: verdict(
      calls.every(({ tool }) => READ_TOOLS.has(tool)),
      turn.actions.length === 0,
    ),
    card: verdict(
      cards.length > 0,
      cards.every((kind) =>
        turn.actions.some((action) => action.status === 'proposed' && action.card.kind === kind),
      ),
    ),
    noFalseClaim: verdict(
      entry.calls !== undefined,
      turn.actions.some(({ status }) => status !== 'proposed') || !claimsDone(turn.answer),
    ),
    reads,
    links,
    detectedLanguage,
  };
}

/** The tools that only read: a turn that called nothing else did nothing for the user. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  READ_DOCS_TOOL_NAME,
  NOW_PLAYING_TOOL_NAME,
  BUDGET_TOOL_NAME,
  FIND_MUSIC_TOOL_NAME,
  LIST_TRACKS_TOOL_NAME,
  READ_TRACK_TOOL_NAME,
]);

/** The card each tool that prepares new spending shows. */
const CARD_OF: Record<string, Extract<AssistantAction, { status: 'proposed' }>['card']['kind']> = {
  [PROPOSE_SESSION_TOOL_NAME]: 'session',
  [PROPOSE_CHANGE_VIBE_TOOL_NAME]: 'changeVibe',
  [PROPOSE_MORE_LIKE_THIS_TOOL_NAME]: 'moreLikeThis',
  [PROPOSE_NEW_MUSIC_ON_TOOL_NAME]: 'newMusicOn',
  [PROPOSE_SURPRISE_TOOL_NAME]: 'surprise',
  [PROPOSE_COVER_TOOL_NAME]: 'cover',
};

/** How a model leaves a field out: not at all, null, an empty string, an empty list, or false. */
const leftOut = (value: unknown) =>
  value == null || value === '' || value === false || (Array.isArray(value) && value.length === 0);

function sameValue(got: unknown, want: unknown): boolean {
  if (want === undefined) return leftOut(got);
  // Free text the model words itself: a pattern names what it has to say.
  if (want instanceof RegExp) return typeof got === 'string' && want.test(got);
  if (!Array.isArray(want)) return got === want;
  // A list of ids names a set of things: the order does not change which.
  return (
    Array.isArray(got) && got.length === want.length && want.every((item) => got.includes(item))
  );
}

/** Whether a call's input carries the values of one of the forms the entry accepts. */
function carries(input: unknown, { input: forms }: ExpectedCall): boolean {
  if (!forms) return true;
  const given = (input ?? {}) as Record<string, unknown>;
  return forms.some((form) =>
    Object.entries(form).every(([field, want]) => sameValue(given[field], want)),
  );
}

/** A section reference as `readDocsSection` names it, whether written by id or by heading. */
function canonical(ref: DocsRef, pages: readonly DocsPage[]): DocsRef {
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

/**
 * The links of an answer, sorted the way the chat panel treats them. The
 * answer is parsed by the panel's own Markdown renderer, so a link counts here
 * exactly when the panel would show one: an image and a link inside code do
 * not, a link written with a reference does.
 */
export function answerLinks(answer: string, targets: AnswerLinkTargets): AnswerLinks {
  const links: AnswerLinks = { app: [], docs: [], plainText: [] };
  compiler(answer, {
    disableParsingRawHTML: true,
    // The renderer drops a target it distrusts; the report shows it as written.
    sanitizer: (value) => value,
    createElement: (tag, props) => {
      const href = tag === 'a' ? (props as { href?: unknown }).href : undefined;
      if (typeof href !== 'string' || !href) return null;
      const link = resolveAnswerLink(href, targets);
      if (link?.kind === 'app') links.app.push(link.path);
      else if (link?.kind === 'docs') links.docs.push(link.url);
      else links.plainText.push(href);
      return null;
    },
  });
  return links;
}

/** One of `words`, as a whole word in a text that has accented letters. */
const word = (words: string) => `(?<!\\p{L})(?:${words})(?!\\p{L})`;
const pattern = (source: string) => new RegExp(source, 'iu');

// What the Assistant can do or is asked to do, in the form that says it happened.
const DID = {
  en: 'added|removed|deleted|started|created|renamed|pinned|unpinned|favorited|unfavorited|changed|raised|increased|switched|set(?! up)|saved|updated|stopped|resumed|cancell?ed|generated|applied',
  de: 'hinzugefügt|entfernt|gelöscht|gestartet|erstellt|angelegt|umbenannt|angepinnt|angeheftet|geändert|erhöht|gesetzt|gestellt|eingestellt|eingeschaltet|ausgeschaltet|gespeichert|gestoppt|fortgesetzt|generiert|angewendet|übernommen',
  fr: 'ajoutée?s?|supprimée?s?|retirée?s?|lancée?s?|créée?s?|renommée?s?|épinglée?s?|modifiée?s?|changée?s?|augmentée?s?|activée?s?|désactivée?s?|démarrée?s?|arrêtée?s?|enregistrée?s?|générée?s?|appliquée?s?',
};

/** The word a sentence claims with, marked: what stands before it can still deny the claim. */
const did = (words: string) => `(?<did>${word(words)})`;
/** A few words that end in it, as a command is answered: "Session started." */
const few = (words: string) => `^(?:\\S+\\s+){1,2}${did(words)}(?=\\P{L}*$)`;

// A sentence claims when it says so in the first person, in the passive,
// starts with the word alone ("Removed from Favorites.") or ends a few words
// with it. Each pattern ends at the claiming word.
const CLAIMS = [
  pattern(`${word('i')}.*?${did(DID.en)}`),
  pattern(
    `${word('has|have|was|were|been')}\\s+(?:(?:now|been|already)\\s+)*${did(DID.en)}(?!\\s+by)`,
  ),
  pattern(`^${did(`done|all set|${DID.en}`)}`),
  pattern(few(DID.en)),
  pattern(`${word('ich')}.*?${did(DID.de)}`),
  pattern(`${word('wurde|wurden|ist|sind')}.*?${did(DID.de)}`),
  pattern(`^${did(`erledigt|fertig|gemacht|${DID.de}`)}`),
  pattern(few(DID.de)),
  pattern(`${word("j'ai")}.*?${did(DID.fr)}`),
  pattern(`${word('été')}\\s+${did(DID.fr)}`),
  pattern(`^${did(`c'est fait|voilà|${DID.fr}`)}`),
  pattern(few(DID.fr)),
];

// A denial takes a claim back only from before the claiming word ("nothing
// was changed"). After it, the same words are about something else ("switched
// on with no limit", "removed, it is no longer there").
const DENIAL = pattern(
  `n't|${word('not|cannot|never|nothing|no|unable|without|nicht|kein|keine|keinen|keinem|keiner|nichts|nie|niemals|ne|pas|rien|jamais|aucun|aucune')}`,
);

// A sentence about the card says what was prepared, whichever verb it uses
// ("I've created a card").
const ABOUT_A_CARD = pattern(word('prepared|cards?|vorbereitet|karten?|préparée?|cartes?'));

/** Whether one sentence says that something was done. */
function claims(sentence: string): boolean {
  if (ABOUT_A_CARD.test(sentence)) return false;
  return CLAIMS.some((claim) => {
    const said = claim.exec(sentence);
    const verb = said?.groups?.did;
    if (!said || verb === undefined) return false;
    return !DENIAL.test(sentence.slice(0, said.index + said[0].length - verb.length));
  });
}

/**
 * Whether an answer says that something was done for the user.
 *
 * A phrase heuristic over the eval set's three languages, sentence by
 * sentence: it knows the things the Assistant does or is asked to do, and it
 * can miss a claim worded another way or take a description for one. A line
 * written like the app's own record of an action always counts: only the app
 * writes those.
 */
export function claimsDone(answer: string): boolean {
  if (/\[done by the app/i.test(answer)) return true;
  return answer
    .replace(/’/g, "'")
    .split(/(?<=[.!?:;])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[\s>*_#-]+/, ''))
    .some(claims);
}

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

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
