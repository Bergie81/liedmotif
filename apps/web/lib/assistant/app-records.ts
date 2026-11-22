// The app's records of what an answer did ([Done by the app: …] and the
// others) reach the model inside its earlier answers, and a model may copy one
// into the answer it writes. The user never reads one: an answer is shown and
// kept without them, whatever the model wrote. Server-only by use, plain text.

import { ANSWER_LANGUAGE_OPENER } from './answer-language';
import { CARD_RECORD_OPENER } from './card-note';
import { NOT_DONE_RECORD_OPENER } from './player-command-note';
import { DONE_RECORD_OPENER } from './receipt-note';

/**
 * How each of the app's lines opens: its records, and the line that names the
 * answer's language, which the model reads in the turn it answers.
 */
const RECORD_OPENERS = [
  DONE_RECORD_OPENER,
  NOT_DONE_RECORD_OPENER,
  CARD_RECORD_OPENER,
  ANSWER_LANGUAGE_OPENER,
];

const isSpace = (char: string) => /\s/.test(char);

/**
 * An answer's chunks without any of the app's records in them. A record runs
 * from its opener to its first `]` outside the quoted names in it, where a
 * user's own `]` can stand ("Song [Live] Edit"); a line break ends one left
 * open. Of the space around a record, the wider side stays, so the words or
 * paragraphs it stood between stay apart. Text streams on as it comes, except
 * what could still turn out to open a record, and space, which waits for the
 * text after it.
 */
export async function* withoutAppRecords(chunks: AsyncIterable<string>): AsyncIterable<string> {
  /** Space not shown yet: it is shown only once text follows it. */
  let gap = '';
  /** The start of what may be an opener: `[` and what follows it, while it still matches one. */
  let opening = '';
  /** Inside a record being dropped: whether in a quoted name, and right after its `\`. */
  let record: { inName: boolean; escaped: boolean } | null = null;
  /** The space after a record, until text follows it; null when no record came right before. */
  let afterRecord: string | null = null;
  let started = false;
  let out = '';

  function show(text: string): void {
    out += gap + text;
    gap = '';
    started = true;
  }

  /** Names in a record are JSON strings, so `"` and `\` inside one come escaped. */
  function feedRecord(char: string, inside: { inName: boolean; escaped: boolean }): void {
    if (inside.escaped) inside.escaped = false;
    else if (inside.inName && char === '\\') inside.escaped = true;
    else if (char === '"') inside.inName = !inside.inName;
    else if ((char === ']' && !inside.inName) || char === '\n') {
      record = null;
      afterRecord = '';
      if (char === '\n') feed(char);
    }
  }

  function feed(char: string): void {
    if (record !== null) {
      feedRecord(char, record);
      return;
    }
    if (opening) {
      const next = opening + char;
      if (RECORD_OPENERS.includes(next)) {
        opening = '';
        record = { inName: false, escaped: false };
      } else if (RECORD_OPENERS.some((opener) => opener.startsWith(next))) {
        opening = next;
      } else {
        const text = opening;
        opening = '';
        show(text);
        feed(char);
      }
      return;
    }
    if (isSpace(char)) {
      if (afterRecord === null) gap += char;
      else afterRecord += char;
      return;
    }
    if (afterRecord !== null && started && afterRecord.length > gap.length) gap = afterRecord;
    afterRecord = null;
    if (char === '[') opening = char;
    else show(char);
  }

  for await (const chunk of chunks) {
    for (const char of chunk) feed(char);
    if (out) yield out;
    out = '';
  }
  if (opening) show(opening);
  if (out) yield out;
}
