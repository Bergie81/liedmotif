// The connect-time guard on the ADAPTERS' own API calls. Real
// sockets on loopback, no DNS and no internet — `pinned.invalid` is unresolvable
// by construction, so a request that arrives proves the vetted address was
// dialed rather than the hostname resolved again.

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderConfigError, ProviderUnbilledError } from '../errors';
import { pinnedProviderFetch } from './provider-fetch';
import { BLOCKED_BASE_URL_MESSAGE } from './ssrf';

let server: Server;
let port: number;
let seen: { url: string; method: string; auth?: string }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({
      url: request.url ?? '',
      method: request.method ?? '',
      ...(request.headers.authorization ? { auth: request.headers.authorization } : {}),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

/** A resolver that answers `addresses` for any name, standing in for DNS. */
function resolvesTo(...addresses: string[]) {
  return async () => addresses;
}

describe('pinnedProviderFetch', () => {
  it('dials the vetted address and forwards the request unchanged', async () => {
    // Ollama's documented loopback exemption is what makes a local test server a
    // legitimate target at all; every other preset is refused one below.
    const fetchImpl = pinnedProviderFetch({
      providerKey: 'ollama',
      resolve: resolvesTo('127.0.0.1'),
    });

    const response = await fetchImpl(`http://pinned.invalid:${port}/v1/models`, {
      method: 'POST',
      headers: { authorization: 'Bearer k' },
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ url: '/v1/models', method: 'POST', auth: 'Bearer k' }]);
  });

  it('refuses a hostname that resolves to a metadata address', async () => {
    // The rebinding window the literal base-URL check cannot see: the name was
    // public when the admin saved it and answers 169.254.169.254 at call time.
    const fetchImpl = pinnedProviderFetch({
      providerKey: 'openai-compatible',
      resolve: resolvesTo('169.254.169.254'),
    });

    await expect(fetchImpl(`http://pinned.invalid:${port}/v1/models`)).rejects.toBeInstanceOf(
      ProviderConfigError,
    );
    expect(seen).toEqual([]);
  });

  it('refuses a loopback answer for a preset that is not Ollama', async () => {
    // A hosted preset reaching localhost is the port-probe the guard exists to
    // refuse, whether the address was typed or answered by DNS.
    const fetchImpl = pinnedProviderFetch({
      providerKey: 'openrouter',
      resolve: resolvesTo('127.0.0.1'),
    });

    await expect(fetchImpl(`http://pinned.invalid:${port}/api/tags`)).rejects.toBeInstanceOf(
      ProviderConfigError,
    );
    expect(seen).toEqual([]);
  });

  it.each([
    ['a private IP literal', 'http://10.0.0.5/v1/models', resolvesTo('203.0.113.9')],
    ['a well-known private name, caught before DNS', 'http://localhost/v1/models', resolvesTo()],
    [
      'a name where one of several answers is private',
      'http://pinned.invalid/v1/models',
      resolvesTo('8.8.8.8', '192.168.1.10'),
    ],
  ])('refuses %s as a private host', async (_case, url, resolve) => {
    const fetchImpl = pinnedProviderFetch({ providerKey: 'openai-compatible', resolve });

    await expect(fetchImpl(url)).rejects.toThrow(
      expect.objectContaining({
        name: 'ProviderConfigError',
        message: BLOCKED_BASE_URL_MESSAGE,
      }),
    );
  });

  it.each([
    [
      'a lookup that fails',
      async () => {
        throw new Error('getaddrinfo EAI_AGAIN pinned.invalid');
      },
    ],
    ['a lookup that answers no address', resolvesTo()],
  ])('reports %s as unreachable and unpaid, never as a private host', async (_case, resolve) => {
    const fetchImpl = pinnedProviderFetch({ providerKey: 'openai-compatible', resolve });

    const error = await fetchImpl(`http://pinned.invalid:${port}/v1/models`).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderUnbilledError);
    expect(error).not.toBeInstanceOf(ProviderConfigError);
    expect((error as ProviderUnbilledError).refusal).toBe('provider_unavailable');
    expect((error as Error).message).toBe(
      'The provider could not be reached. Try again in a moment.',
    );
    expect(seen).toEqual([]);
  });
});
