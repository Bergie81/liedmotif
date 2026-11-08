// The connect-time half of the egress guard: the transport
// dials the addresses the guard already vetted instead of resolving the
// hostname a second time. Real sockets on loopback, no DNS and no internet —
// `pinned.invalid` is unresolvable by construction, so every request that
// arrives proves the pin was used.

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchPinnedAddresses } from './pinned-fetch';

let server: Server;
let port: number;
const seenHosts: string[] = [];
const seenRanges: (string | undefined)[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seenHosts.push(request.headers.host ?? '');
    seenRanges.push(request.headers.range);
    response.writeHead(200, { 'content-type': 'audio/mpeg' });
    response.end('bytes');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchPinnedAddresses', () => {
  it('connects to the vetted address instead of resolving the hostname again', async () => {
    // A rebinding provider answers a public address to the guard's lookup and an
    // internal one to the transport's. Here DNS would fail outright, so a 200
    // can only mean the vetted address was dialed.
    const response = await fetchPinnedAddresses(`http://pinned.invalid:${port}/a.mp3`, {}, [
      '127.0.0.1',
    ]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('bytes');
  });

  it('sends the original Host so a vhosted or signature-checking CDN still answers', async () => {
    seenHosts.length = 0;
    await (
      await fetchPinnedAddresses(`http://pinned.invalid:${port}/a.mp3`, {}, ['127.0.0.1'])
    ).text();
    expect(seenHosts).toEqual([`pinned.invalid:${port}`]);
  });

  it('forwards the request init, so a proxied Range reaches the upstream', async () => {
    seenRanges.length = 0;
    const response = await fetchPinnedAddresses(
      `http://pinned.invalid:${port}/a.mp3`,
      { headers: { Range: 'bytes=0-4' } },
      ['127.0.0.1'],
    );
    await response.text();
    expect(seenRanges).toEqual(['bytes=0-4']);
  });

  it('fails the connection when no vetted address is left to dial', async () => {
    await expect(
      fetchPinnedAddresses(`http://pinned.invalid:${port}/a.mp3`, {}, []),
    ).rejects.toThrow();
  });
});
