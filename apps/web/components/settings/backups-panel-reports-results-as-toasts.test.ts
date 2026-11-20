// @vitest-environment jsdom

// Saving the backup schedule and pressing Back up now report what happened as
// toasts; the Status card keeps describing the backup service as it is.

import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_BACKUP_SCHEDULE, type BackupsOverview } from '@liedmotif/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { shownToasts, toast } from '@/lib/toast';
import { BackupsPanel } from './backups-panel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toast.dismiss();
});

function overview(service: BackupsOverview['service']): BackupsOverview {
  return {
    schedule: DEFAULT_BACKUP_SCHEDULE,
    timezone: 'UTC',
    service,
    requestedAt: null,
    status: null,
    downloadAvailable: false,
    backups: [],
  };
}

/** The backups routes: the schedule and run requests answer from `answers`, a read with `current`. */
function serve(current: BackupsOverview, answers: Response[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET'
        ? Response.json({ ok: true, data: current })
        : answers.shift()!,
    ),
  );
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

it('reports a failed schedule save, and clears it once saving again succeeds', async () => {
  serve(overview('healthy'), [
    Response.json(
      { ok: false, error: { message: 'Could not save the schedule.' } },
      { status: 500 },
    ),
    Response.json({ ok: true, data: { schedule: DEFAULT_BACKUP_SCHEDULE } }),
  ]);
  render(h(BackupsPanel, { initial: overview('healthy') }));

  fireEvent.click(button('Save Schedule'));
  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'Could not save the schedule.' }),
    ]),
  );
  await waitFor(() => expect(button('Save Schedule').disabled).toBe(false));
  fireEvent.click(button('Save Schedule'));

  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'success', message: 'Backup schedule saved.' }),
    ]),
  );
});

it('says a requested backup waits for the backup service when it is not running', async () => {
  serve(overview('not-running'), [Response.json({ ok: true, data: {} })]);
  render(h(BackupsPanel, { initial: overview('not-running') }));

  fireEvent.click(button('Back Up Now'));

  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({
        tone: 'info',
        message: 'Backup requested. It runs once the backup service is back.',
      }),
    ]),
  );
});

it('reports a backup that could not be requested', async () => {
  serve(overview('healthy'), [
    Response.json(
      { ok: false, error: { message: 'A backup is already running.' } },
      { status: 409 },
    ),
  ]);
  render(h(BackupsPanel, { initial: overview('healthy') }));

  fireEvent.click(button('Back Up Now'));

  await waitFor(() =>
    expect(shownToasts()).toEqual([
      expect.objectContaining({ tone: 'error', message: 'A backup is already running.' }),
    ]),
  );
});
