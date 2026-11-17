import { describe, expect, it } from 'vitest';
import { SessionCoverRetryableError } from '../session-cover/session-cover-generator';
import { createGenerateSessionCoverTask } from './generate-session-cover';

describe('generate-session-cover Graphile adapter', () => {
  it.each([
    null,
    {},
    { activitySessionId: 'not-a-uuid', ownerUserId: crypto.randomUUID() },
    { activitySessionId: crypto.randomUUID(), ownerUserId: '' },
    { activitySessionId: crypto.randomUUID(), ownerUserId: 'x'.repeat(256) },
    {
      activitySessionId: crypto.randomUUID(),
      ownerUserId: crypto.randomUUID(),
      coverGenerationId: 'not-a-uuid',
    },
  ])('rejects an invalid payload before touching runtime dependencies', async (payload) => {
    const task = createGenerateSessionCoverTask({
      db: {} as never,
      getCoverArt: async () => null,
      getSunoCoverArt: async () => null,
      getLlm: async () => null,
      storage: {} as never,
    });

    await expect(task(payload, {} as never)).rejects.toThrow(
      'Invalid generate-session-cover job payload.',
    );
  });

  it('accepts Better Auth text owner identifiers before entering the deep seam', async () => {
    const task = createGenerateSessionCoverTask({
      db: {} as never,
      getCoverArt: async () => null,
      getSunoCoverArt: async () => null,
      getLlm: async () => null,
      storage: {} as never,
    });
    const helpers = {
      job: { attempts: 1, max_attempts: 3 },
      addJob: async () => undefined,
      logger: { info: () => undefined, warn: () => undefined },
    } as never;

    await expect(
      task(
        { activitySessionId: crypto.randomUUID(), ownerUserId: 'better-auth-owner-id' },
        helpers,
      ),
    ).rejects.toBeInstanceOf(SessionCoverRetryableError);
  });
});
