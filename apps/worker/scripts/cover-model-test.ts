import { fileURLToPath } from 'node:url';
import { openRouterImageProvider } from '@liedmotif/providers';
import { runCoverQualificationCli } from '../../../packages/providers/scripts/cover-qualification/cli';
import { replacementQualificationCompiler } from './cover-qualification-composition';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function main(): Promise<void> {
  const result = await runCoverQualificationCli(process.env, {
    repositoryRoot,
    now: () => new Date(),
    logger: {
      info: (message) => console.log(message),
      error: (message) => console.error(message),
    },
    replacementCompiler: replacementQualificationCompiler,
    createProvider: (input) => {
      const provider = openRouterImageProvider({
        apiKey: input.apiKey,
        model: input.model,
        resolution: input.resolution,
        aspectRatio: input.aspectRatio,
        ...(input.supportedParams.length
          ? { capabilityAssertion: { supportedParameters: input.supportedParams } }
          : {}),
      });
      return {
        model: provider.model,
        getCapabilities: () => provider.getCapabilities(),
        async generateCover({ prompt, exclusions, seed, count, idempotencyKey, references }) {
          const generated = await provider.generate({
            purpose: 'session-cover',
            positivePrompt: prompt,
            exclusions,
            target: { shape: 'square', quality: 'high' },
            references: references.map((reference) => ({
              ...reference,
              role: 'subject' as const,
            })),
            idempotencyKey,
            seed,
            count,
          });
          return {
            bytes: generated.bytes,
            mediaType: generated.mediaType,
            appliedControls: generated.appliedControls,
            downgradeCodes: generated.downgradeCodes,
            ...(generated.reportedCostUsd === undefined
              ? {}
              : { costUsd: generated.reportedCostUsd }),
          };
        },
      };
    },
  });

  if (result.status === 'gated' && result.reason !== 'capture_not_enabled') {
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error('Cover replacement qualification failed during preflight or artifact creation.');
  process.exitCode = 1;
});
