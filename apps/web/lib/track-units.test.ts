import { describe, expect, it } from 'vitest';
import { providerTasksToTracks, tracksToProviderTasks } from './track-units';

describe('Track and provider-task units', () => {
  it('round-trips whole provider batches', () => {
    expect(providerTasksToTracks(4, 2)).toBe(8);
    expect(tracksToProviderTasks(8, 2)).toBe(4);
    expect(tracksToProviderTasks(7, 2)).toBeNull();
  });

  it('normalizes an invalid provider yield to one Track per task', () => {
    expect(providerTasksToTracks(4, 0)).toBe(4);
    expect(providerTasksToTracks(4, Number.NaN)).toBe(4);
  });
});
