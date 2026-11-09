// Checks whether the configured text LLM is good enough for the Assistant
// (`npm run assistant:eval`). It asks the fixed eval set once — every question a
// real Assistant turn, one after the other, none asked again — and writes a
// scored Markdown report to `eval-reports/`, which git ignores.
//
// The model is the one the app itself would use: `LLM_*` in `.env` or the
// environment first, then what is saved under Settings › AI Providers. So it
// needs the app's database, and a run spends real requests on that provider.
// `LLM_PROVIDER=mock npm run assistant:eval` tries the tooling without a model.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVAL_SET } from '@/lib/assistant/eval/eval-set';
import { renderEvalReport } from '@/lib/assistant/eval/report';
import { runEval } from '@/lib/assistant/eval/run';
import { closeWebPool } from '@/lib/db';
import { getLlmProvider } from '@/lib/providers';

const reportsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval-reports');

async function main(): Promise<void> {
  const llm = await getLlmProvider();
  if (!llm) {
    throw new Error(
      'No text LLM is configured: set LLM_PROVIDER and its LLM_* values, or connect a Writing AI in the app.',
    );
  }
  const { providerKey } = llm;
  const { model } = llm.getCapabilities();
  console.log(`Asking ${EVAL_SET.length} questions once: ${providerKey}, model ${model}`);

  const startedAt = new Date();
  let asked = 0;
  const results = await runEval(llm, EVAL_SET, {
    onResult: ({ entry, turn, ms }) => {
      asked += 1;
      const outcome =
        turn.error ?? `${(ms / 1000).toFixed(1)} s, ${turn.toolCalls.length} tool calls`;
      console.log(`[${asked}/${EVAL_SET.length}] ${entry.id}: ${outcome}`);
    },
  });

  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${providerKey}-${model}`.replace(/[^a-z0-9.]+/gi, '-').replace(/^-|-$/g, '');
  const file = join(reportsDir, `assistant-${name}-${stamp}.md`);
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(file, `${renderEvalReport({ providerKey, model, startedAt, results })}\n`);
  console.log(`Report: ${file}`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closeWebPool();
}
