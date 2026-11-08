import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './registry';

interface FakeProvider {
  readonly providerKey: string;
}

describe('ProviderRegistry', () => {
  it('registers and resolves providers by key', () => {
    const registry = new ProviderRegistry<FakeProvider>();
    const suno = { providerKey: 'suno' };
    registry.register(suno);

    expect(registry.has('suno')).toBe(true);
    expect(registry.get('suno')).toBe(suno);
    expect(registry.tryGet('suno')).toBe(suno);
    expect(registry.list()).toEqual([suno]);
  });

  it('throws on duplicate registration', () => {
    const registry = new ProviderRegistry<FakeProvider>();
    registry.register({ providerKey: 'suno' });
    expect(() => registry.register({ providerKey: 'suno' })).toThrow(/already registered/);
  });

  it('throws when resolving an unknown key', () => {
    const registry = new ProviderRegistry<FakeProvider>();
    expect(() => registry.get('missing')).toThrow(/No provider registered/);
    expect(registry.tryGet('missing')).toBeUndefined();
    expect(registry.has('missing')).toBe(false);
  });
});
