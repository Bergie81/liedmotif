import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@liedmotif/db';

const mocks = vi.hoisted(() => ({
  getCoverArtSettings: vi.fn(),
  loadPendingSurprise: vi.fn(),
  proposeSurprise: vi.fn(),
  newSessionTargetMinutes: vi.fn(),
}));
vi.mock('@liedmotif/db', () => ({ getCoverArtSettings: mocks.getCoverArtSettings }));
vi.mock('@/lib/sessions/sessions', () => ({
  newSessionTargetMinutes: mocks.newSessionTargetMinutes,
}));
vi.mock('@/lib/sessions/surprise-me', () => ({
  loadPendingSurprise: mocks.loadPendingSurprise,
  proposeSurprise: mocks.proposeSurprise,
}));

const { createProposeSurpriseTool } = await import('./propose-surprise-tool');
const { createTurnActions } = await import('./turn-actions');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadPendingSurprise.mockResolvedValue({ id: 'pending-a' });
  mocks.proposeSurprise.mockResolvedValue({
    ok: true,
    proposal: { id: 'pending-b', edit: { durationMinutes: 45 } },
  });
});

describe('proposeSurprise tool', () => {
  it('leaves the pending suggestion in place when the cover settings cannot be read', async () => {
    mocks.getCoverArtSettings.mockRejectedValue(new Error('connection lost'));
    const tool = createProposeSurpriseTool(
      { db: {} as Database, userId: 'u1', role: 'admin', player: null },
      createTurnActions(() => {}),
    );

    await expect(tool.execute({})).rejects.toThrow('connection lost');

    expect(mocks.proposeSurprise).not.toHaveBeenCalled();
  });

  it('leaves the pending suggestion in place when the default Session duration cannot be read', async () => {
    mocks.getCoverArtSettings.mockResolvedValue({ defaultStyle: 'auto' });
    mocks.newSessionTargetMinutes.mockRejectedValue(new Error('connection lost'));
    const tool = createProposeSurpriseTool(
      { db: {} as Database, userId: 'u1', role: 'admin', player: null },
      createTurnActions(() => {}),
    );

    await expect(tool.execute({})).rejects.toThrow('connection lost');

    expect(mocks.proposeSurprise).not.toHaveBeenCalled();
  });
});
