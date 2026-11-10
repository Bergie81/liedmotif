// The eval run as a Markdown report: the automatic scores, and every question
// next to what was expected, what the model called and what it answered, for a
// person to judge.

import type { AssistantAction } from '@liedmotif/shared';
import { cardNote } from '../card-note';
import { playerCommandNote } from '../player-command-note';
import { receiptNote } from '../receipt-note';
import { APP_ROUTES } from '../route-map';
import type { EvalEntry, ExpectedCall } from './eval-set';
import { FIXTURE_SUMMARY } from './fixture';
import type { EvalResult, PromptChars } from './run';
import { CHECKS, type DocsRead, type ObservedToolCall } from './score';

/** The estimate the Assistant's context budget is sized with. */
const CHARS_PER_TOKEN = 3.5;

const ROLE_NAME = { admin: 'Admin', member: 'Member' } as const;

/** How much of a tool's result a call's line shows. */
const RESULT_PREVIEW_CHARS = 120;

/** A question about the user's own music or a request to act, as against one about the docs. */
const aboutMusic = ({ entry }: EvalResult) => entry.calls !== undefined;

export function renderEvalReport(run: {
  providerKey: string;
  model: string;
  startedAt: Date;
  results: readonly EvalResult[];
}): string {
  const { results } = run;
  const answered = results.filter(({ turn }) => turn.error === undefined).length;
  return [
    '# Assistant model evaluation',
    [
      `- Model: \`${run.model}\` (provider \`${run.providerKey}\`)`,
      `- Run: ${run.startedAt.toISOString()}, ${results.length} questions, each asked once and never again`,
      `- Answered: ${answered} of ${results.length}`,
      `- The user's music: ${FIXTURE_SUMMARY}. Nothing is read from the database or written to it: a tool that acts reports what the app would do and changes nothing.`,
    ].join('\n'),
    '## Scores',
    table(
      ['Check', 'Passed'],
      CHECKS.map(([check, name]) => {
        const applies = results.filter(({ score }) => score[check] !== 'n/a');
        const passed = applies.filter(({ score }) => score[check] === 'pass');
        return [name, `${passed.length} / ${applies.length}`];
      }),
    ),
    [
      '- Each check is counted over the questions it applies to. A question that failed fails all of them.',
      '- **Whether an answer is right is not scored automatically.** Read each answer below against what was expected and what the turn did, and tick its box.',
      '- Link: only a link the chat panel would follow counts. A link it shows as plain text is listed, not counted. Not judged for a request the turn carries out.',
      '- Language: a word-count heuristic over English, German and French. It can misjudge a mixed answer, and does not judge one too short to call.',
      '- Screen names: the answer contains the name of the expected page exactly as the app shows it.',
      '- Tool and values: every call the entry expects was made, and made for the expected Session, Playlist or Track with the expected settings. Calls the entry does not name are not held against the turn.',
      '- No action: the turn changed nothing, gave the player no command and showed no card. Counted for every question that asks for none of that.',
      '- Card: the turn showed the card the entry expects.',
      '- No claim: a phrase heuristic over the same three languages. It fails an answer that says something was done in a turn with no receipt and no player command; it can miss a claim or take a description for one, so read the answer.',
      `- Tool calls: one per call of a tool; a model call that asks for two things counts as two. Prompt: system prompt, conversation and tool results, at ${CHARS_PER_TOKEN} characters per token.`,
    ].join('\n'),
    '## Time to answer',
    table(
      ['Questions', 'Answered', 'Median', 'Slowest'],
      [
        timeRow(
          'About the docs',
          results.filter((result) => !aboutMusic(result)),
        ),
        timeRow("About the user's music", results.filter(aboutMusic)),
      ],
    ),
    '## Per question',
    table(
      [
        '#',
        'Question',
        'Asked by',
        ...CHECKS.map(([, , title]) => title),
        'Tool calls',
        'Prompt',
        'Time',
      ],
      results.map(({ entry, score, turn, promptChars, ms }, index) => [
        String(index + 1),
        entry.id,
        `${ROLE_NAME[entry.role]}, ${entry.language}`,
        ...CHECKS.map(([check]) => score[check]),
        String(turn.toolCalls.length),
        `≈ ${tokens(promptTotal(promptChars))} tokens`,
        turn.error === undefined ? seconds(ms) : 'failed',
      ]),
    ),
    '## Answers',
    ...results.map(answerSection),
  ].join('\n\n');
}

function answerSection(result: EvalResult, index: number): string {
  const { entry, turn, score, promptChars, ms } = result;
  const total = promptTotal(promptChars);
  const calls = turn.toolCalls.length;
  return [
    `### ${index + 1}. ${entry.id}`,
    ...(entry.history?.length
      ? [
          '**Earlier turns:**',
          entry.history
            .map(({ role, content }) =>
              quote(`**${role === 'user' ? 'User' : 'Assistant'}:** ${content}`),
            )
            .join('\n>\n'),
        ]
      : []),
    [
      `- **Question** (${ROLE_NAME[entry.role]}, ${entry.language}): ${entry.question}`,
      entry.calls === undefined
        ? `- **Expected section:** ${expectedSection(entry)}`
        : `- **Expected calls:** ${expectedCalls(entry.calls)}`,
      `- **Expected link:** ${expectedLink(entry)}`,
      `- **A good answer:** ${entry.goodAnswer}`,
    ].join('\n'),
    turn.error === undefined ? '**Answer:**' : `**Failed:** ${turn.error}`,
    quote(turn.answer || '(no answer)'),
    [
      `- **Tool calls:** ${calls}${score.reads.length ? ` (${score.reads.map(readLine).join('; ')})` : ''}`,
      ...turn.toolCalls.map(callLine),
      `- **Did:** ${turn.actions.length ? turn.actions.map(actionLine).join('; ') : 'nothing'}`,
      `- **Links:** ${linksLine(score.links)}`,
      `- **Language detected:** ${score.detectedLanguage ?? 'unclear'}`,
      `- **Checks:** ${CHECKS.map(([check, , title]) => `${title.toLowerCase()} ${score[check]}`).join(' · ')}`,
      `- **Prompt:** ${count(total)} characters, about ${tokens(total)} tokens (system ${count(promptChars.system)}, conversation ${count(promptChars.conversation)}, tool results ${count(promptChars.toolResults)})`,
      `- **Time:** ${seconds(ms)}`,
    ].join('\n'),
    entry.calls === undefined
      ? '- [ ] The answer agrees with the docs'
      : '- [ ] The answer says what happened, and nothing else',
  ].join('\n\n');
}

/** One call under the answer: the tool, what the model gave it, and the start of what it returned. */
function callLine({ name, input, result }: ObservedToolCall): string {
  const [firstLine = ''] = result.split('\n');
  const preview =
    firstLine.length > RESULT_PREVIEW_CHARS || firstLine.length < result.length
      ? `${firstLine.slice(0, RESULT_PREVIEW_CHARS)} …`
      : firstLine;
  return `  - \`${name}\` \`${JSON.stringify(input)}\` → ${preview}`;
}

/** What the turn did, worded as the app words it for the model. */
function actionLine(action: AssistantAction): string {
  switch (action.status) {
    case 'done':
      return `receipt: ${receiptNote(action.receipt)}`;
    case 'player':
      return `player command: ${playerCommandNote(action.command)}`;
    case 'proposed':
      return `card: ${cardNote(action.card)}`;
  }
}

function expectedCalls(calls: readonly ExpectedCall[]): string {
  if (calls.length === 0) return 'none that does anything';
  const leftOut = (_field: string, value: unknown) => (value === undefined ? '<left out>' : value);
  return calls
    .map(({ tool, input }) =>
      input
        ? `\`${tool}\` with ${input.map((form) => `\`${JSON.stringify(form, leftOut)}\``).join(' or ')}`
        : `\`${tool}\``,
    )
    .join(' and ');
}

/** Median and slowest answer of one group; a failed question has no time to answer. */
function timeRow(name: string, results: readonly EvalResult[]): string[] {
  const times = results
    .filter(({ turn }) => turn.error === undefined)
    .map(({ ms }) => ms)
    .sort((a, b) => a - b);
  if (times.length === 0) return [name, '0', 'n/a', 'n/a'];
  const middle = Math.floor(times.length / 2);
  const median = times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
  return [name, String(times.length), seconds(median), seconds(times.at(-1)!)];
}

function expectedSection({ docs }: EvalEntry): string {
  if (docs === 'none') return 'none: nothing to look up';
  if (docs === 'lookup')
    return 'none: the docs do not answer this, and a good turn looks before it says so';
  return docs.map(({ page, section }) => `${page} › ${section}`).join(', or ');
}

function expectedLink({ link }: EvalEntry): string {
  if (link === undefined) return 'not judged';
  if (link === null) return 'no link to a page of the app';
  const label = APP_ROUTES.find(({ path }) => path === link)?.label;
  return `\`${link}\` (${label})`;
}

function readLine({ page, section, read }: DocsRead): string {
  return read ? `read ${page} › ${section}` : `asked for ${page} › ${section} (not read)`;
}

function linksLine(links: EvalResult['score']['links']): string {
  const code = (targets: readonly string[]) => targets.map((target) => `\`${target}\``).join(', ');
  const parts = [
    ...(links.app.length ? [`app pages: ${code(links.app)}`] : []),
    ...(links.docs.length ? [`docs pages: ${code(links.docs)}`] : []),
    ...(links.plainText.length ? [`shown as plain text: ${code(links.plainText)}`] : []),
  ];
  return parts.length ? parts.join('; ') : 'none';
}

function table(head: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

function quote(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function promptTotal({ system, conversation, toolResults }: PromptChars): number {
  return system + conversation + toolResults;
}

/** A character count as tokens, rounded to the hundred. */
function tokens(chars: number): string {
  return count(Math.round(chars / CHARS_PER_TOKEN / 100) * 100);
}
