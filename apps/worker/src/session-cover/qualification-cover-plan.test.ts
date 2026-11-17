import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { GeneratedImageCapabilities } from '@liedmotif/providers';
import {
  compileQualificationCoverPlan,
  finishQualificationCoverArtifact,
} from './qualification-cover-plan';

const capabilities: GeneratedImageCapabilities = {
  provider: {
    providerType: 'image',
    providerKey: 'openrouter',
    model: 'provider/model-a',
  },
  exclusions: 'native',
  nativeSeed: true,
  idempotency: 'absent',
  references: {
    roles: ['subject'],
    maxCount: 1,
    multiSubjectIdentity: false,
    mediaTypes: ['image/webp'],
  },
  squareOutput: 'native',
  maxCandidates: 1,
  costReporting: true,
};

function controlledInput(style: 'minimal' | 'poster_art') {
  return {
    sessionId: `controlled-${style}`,
    sessionName: style === 'poster_art' ? 'Neon Basement' : 'One Quiet Orbit',
    coverConcept: null,
    coverStyle: style,
    customDefinition: null,
    sessionIntent: 'controlled synthetic qualification intent',
    snapshot: {
      stylePrompt: 'minimal ambient pulse',
      mood: 'calm',
      activity: 'focus',
      energy: 'low',
      genreTags: ['ambient'],
      vocalMode: 'instrumental' as const,
    },
    capabilities,
    referencesApplied: false,
  };
}

describe('replacement Session Cover qualification composition', () => {
  it('compiles the persisted replacement planner contract for a controlled fixture', () => {
    const compiled = compileQualificationCoverPlan(controlledInput('minimal'));

    expect(compiled).toMatchObject({
      promptVersion: 'session-cover-prompt-v14',
      planVersion: 'session-cover-plan-v7',
      resolvedStyle: 'minimal',
      poster: null,
      count: 1,
    });
    expect(compiled.positivePrompt).toContain('Session Name: "One Quiet Orbit"');
    expect(compiled.exclusions).toContain('readable text or lettering');
    expect(compiled.controlledFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps Poster Art image-only through production finalization', async () => {
    const compiled = compileQualificationCoverPlan(controlledInput('poster_art'));
    const generated = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: { r: 35, g: 22, b: 68 },
      },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="1024" height="1024"><circle cx="760" cy="510" r="260" fill="#e36d38"/></svg>',
          ),
        },
      ])
      .webp()
      .toBuffer();

    const originalCwd = process.cwd();
    let finished: Awaited<ReturnType<typeof finishQualificationCoverArtifact>>;
    try {
      process.chdir(fileURLToPath(new URL('../../', import.meta.url)));
      finished = await finishQualificationCoverArtifact({
        compiled,
        bytes: new Uint8Array(generated),
        mediaType: 'image/webp',
      });
    } finally {
      process.chdir(originalCwd);
    }

    expect(finished).toMatchObject({ mediaType: 'image/webp', localPosterLettering: false });
    expect(await sharp(finished.bytes).metadata()).toMatchObject({
      format: 'webp',
      width: 1024,
      height: 1024,
    });
    const sourceTitleArea = await sharp(generated)
      .extract({ left: 64, top: 64, width: 896, height: 128 })
      .stats();
    const finishedTitleArea = await sharp(finished.bytes)
      .extract({ left: 64, top: 64, width: 896, height: 128 })
      .stats();
    // The title area must stay untouched by local lettering. Finalization
    // re-encodes lossily (normalize + brand), so channel means drift by a small
    // fraction of a level; rendered lettering would shift them by whole levels.
    for (let channel = 0; channel < 3; channel += 1) {
      expect(
        Math.abs(
          finishedTitleArea.channels[channel]!.mean - sourceTitleArea.channels[channel]!.mean,
        ),
      ).toBeLessThan(2);
    }
  });
});
import { fileURLToPath } from 'node:url';
