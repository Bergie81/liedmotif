import { describe, expect, it } from 'vitest';
import { createListeningSender } from './listening-sender';
import type { ListeningReport } from './listening-meter';

const reportFor = (trackId: string) => ({ trackId }) as ListeningReport;

describe('listening sender', () => {
  it("stops reporting a Track the server refused as not the listener's own", async () => {
    const posted: string[] = [];
    const send = createListeningSender(async (report) => {
      posted.push(report.trackId);
      return report.trackId === 'foreign'
        ? { ok: false, error: { code: 'not_found' } }
        : { ok: true };
    });

    send(reportFor('foreign'));
    send(reportFor('own'));
    await Promise.resolve();
    send(reportFor('foreign'));
    send(reportFor('own'));

    expect(posted).toEqual(['foreign', 'own', 'own']);
  });

  it('keeps reporting after a failure that says nothing about ownership', async () => {
    const posted: string[] = [];
    const send = createListeningSender(async (report) => {
      posted.push(report.trackId);
      return { ok: false, error: { code: 'internal_error' } };
    });
    send(reportFor('own'));
    await Promise.resolve();
    send(reportFor('own'));
    expect(posted).toEqual(['own', 'own']);
  });

  it('survives a transport that rejects', async () => {
    const send = createListeningSender(async () => {
      throw new Error('offline');
    });
    expect(() => send(reportFor('own'))).not.toThrow();
    await Promise.resolve();
  });
});
