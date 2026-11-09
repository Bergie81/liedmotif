// The eval run as a Markdown report: the automatic scores, and every question
// next to what was expected and what the model answered, for a person to judge
// against the docs.

import { APP_ROUTES } from '../route-map';
import type { EvalEntry } from './eval-set';
import type { EvalResult } from './run';
import { CHECKS, type DocsRead } from './score';

/** The estimate the Assistant's context budget is sized with. */
const CHARS_PER_TOKEN = 3.5;

const ROLE_NAME = { admin: 'Admin', member: 'Member' } as const;

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
      '- **Whether an answer agrees with the docs is not scored automatically.** Read each answer below against its expected section and tick its box.',
      '- Link: only a link the chat panel would follow counts. A link it shows as plain text is listed, not counted.',
      '- Language: a word-count heuristic over English, German and French. It can misjudge a very short or a mixed answer.',
      '- Screen names: the answer contains the name of the expected page exactly as the app shows it.',
      `- Tool calls: one per \`readDocs\` call; a model call that asks for two sections counts as two. Prompt: system prompt, conversation and docs read, at ${CHARS_PER_TOKEN} characters per token.`,
    ].join('\n'),
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
        `≈ ${tokens(promptChars)} tokens`,
        turn.error === undefined ? seconds(ms) : 'failed',
      ]),
    ),
    '## Answers',
    ...results.map(answerSection),
  ].join('\n\n');
}

function answerSection(result: EvalResult, index: number): string {
  const { entry, turn, score, promptChars, ms } = result;
  const total = promptChars.system + promptChars.conversation + promptChars.docsRead;
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
      `- **Expected section:** ${expectedSection(entry)}`,
      `- **Expected link:** ${expectedLink(entry)}`,
      `- **A good answer:** ${entry.goodAnswer}`,
    ].join('\n'),
    turn.error === undefined ? '**Answer:**' : `**Failed:** ${turn.error}`,
    quote(turn.answer || '(no answer)'),
    [
      `- **Read:** ${calls} tool ${calls === 1 ? 'call' : 'calls'}${score.reads.length ? `: ${score.reads.map(readLine).join('; ')}` : ''}`,
      `- **Links:** ${linksLine(score.links)}`,
      `- **Language detected:** ${score.detectedLanguage ?? 'unclear'}`,
      `- **Checks:** ${CHECKS.map(([check, , title]) => `${title.toLowerCase()} ${score[check]}`).join(' · ')}`,
      `- **Prompt:** ${count(total)} characters, about ${tokens(promptChars)} tokens (system ${count(promptChars.system)}, conversation ${count(promptChars.conversation)}, docs read ${count(promptChars.docsRead)})`,
      `- **Time:** ${seconds(ms)}`,
    ].join('\n'),
    '- [ ] The answer agrees with the docs',
  ].join('\n\n');
}

function expectedSection({ docs }: EvalEntry): string {
  if (docs === 'none') return 'none: nothing to look up';
  if (docs === 'lookup')
    return 'none: the docs do not answer this, and a good turn looks before it says so';
  return docs.map(({ page, section }) => `${page} › ${section}`).join(', or ');
}

function expectedLink({ link }: EvalEntry): string {
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

const count = (value: number): string => value.toLocaleString('en-US');

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function tokens({ system, conversation, docsRead }: EvalResult['promptChars']): string {
  const estimate = (system + conversation + docsRead) / CHARS_PER_TOKEN;
  return count(Math.round(estimate / 100) * 100);
}
