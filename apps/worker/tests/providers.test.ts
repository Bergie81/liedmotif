import { describe, expect, it } from 'vitest';
import { buildWorkerProviders, describeProviders } from '../src/providers';

describe('worker provider resolution', () => {
  it('defaults to mock music and local-fs storage', () => {
    const providers = buildWorkerProviders({} as NodeJS.ProcessEnv);
    expect(providers.musicSelection).toBe('mock');
    expect(providers.storage.providerKey).toBe('local-fs');
  });

  it('summarizes providers without leaking secrets', () => {
    const summary = describeProviders(buildWorkerProviders({} as NodeJS.ProcessEnv));
    expect(summary).toMatchObject({ music: 'mock', storage: 'local-fs' });
    expect(JSON.stringify(summary)).not.toMatch(/key|secret|token/i);
  });
});
