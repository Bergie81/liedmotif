import { describe, expect, it, vi } from 'vitest';
import { AudioResourceLifetime } from './audio-resource-lifetime';

describe('AudioResourceLifetime', () => {
  it('preserves a probe cleanup but disposes after the real unbind', async () => {
    const dispose = vi.fn();
    const lifetime = new AudioResourceLifetime(dispose);

    const cleanupProbe = lifetime.bind();
    cleanupProbe();
    const cleanupMounted = lifetime.bind();
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();

    cleanupMounted();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
