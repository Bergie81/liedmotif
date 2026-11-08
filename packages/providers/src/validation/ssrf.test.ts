import { describe, expect, it } from 'vitest';
import {
  isBlockedResolvedHost,
  isBlockedValidationTarget,
  isBlockedValidationTargetResolved,
  type ResolveHostAddresses,
} from './ssrf';

describe('isBlockedValidationTarget — remote presets block private/metadata hosts', () => {
  const blocked = [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://192.168.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://169.254.169.254/', // cloud metadata
    'http://0.0.0.0/', // unspecified IPv4
    'http://[::1]/', // IPv6 loopback
    'http://[::]/', // IPv6 unspecified
    'http://[fc00::1]/', // IPv6 ULA
    'http://[fe80::1]/', // IPv6 link-local
    'http://[fe80::abcd]:11434/',
    'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback
    'http://[::ffff:7f00:1]/', // IPv4-mapped loopback (hex)
    'http://[::ffff:10.0.0.1]/', // IPv4-mapped private
    'http://[::ffff:169.254.169.254]/', // IPv4-mapped metadata
    'not-a-url',
  ];
  for (const url of blocked) {
    it(`blocks ${url} for openrouter`, () => {
      expect(isBlockedValidationTarget('openrouter', url)).toBe(true);
    });
  }

  const allowed = ['https://openrouter.ai/api/v1', 'https://api.example.com/v1', 'http://8.8.8.8/'];
  for (const url of allowed) {
    it(`allows public ${url} for openai-compatible`, () => {
      expect(isBlockedValidationTarget('openai-compatible', url)).toBe(false);
    });
  }

  it('does not block when no base URL override is given', () => {
    expect(isBlockedValidationTarget('openrouter', undefined)).toBe(false);
  });

  // Obfuscated IPv4 encodings normalize to dotted-decimal via the WHATWG URL
  // parser (`new URL(...).hostname`) BEFORE the host check sees them, so they are
  // already blocked. These pin that and guard against a future regression that
  // bypasses the parser.
  const obfuscated = [
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f000001/', // hex 127.0.0.1
    'http://0177.0.0.1/', // octal 127.x
    'http://127.1/', // short form 127.0.0.1
    'http://2852039166/', // decimal 169.254.169.254 (cloud metadata)
  ];
  for (const url of obfuscated) {
    it(`blocks obfuscated ${url} for openrouter`, () => {
      expect(isBlockedValidationTarget('openrouter', url)).toBe(true);
    });
  }

  // Non-global ranges beyond RFC1918: CGNAT (Tailscale device space), IETF
  // reserved, documentation, benchmarking, multicast/reserved/broadcast.
  const nonGlobal = [
    'http://100.64.0.1/', // CGNAT start
    'http://100.100.100.100/', // a typical Tailscale device address
    'http://100.127.255.255/', // CGNAT end
    'http://192.0.0.1/', // IETF protocol assignments
    'http://192.0.2.1/', // TEST-NET-1
    'http://198.18.0.1/', // benchmarking
    'http://198.51.100.7/', // TEST-NET-2
    'http://203.0.113.9/', // TEST-NET-3
    'http://224.0.0.1/', // multicast
    'http://240.0.0.1/', // reserved
    'http://255.255.255.255/', // broadcast
    'http://0.1.2.3/', // "this network"
    'http://[ff02::1]/', // IPv6 multicast
    'http://[2001:db8::1]/', // IPv6 documentation
  ];
  for (const url of nonGlobal) {
    it(`blocks non-global ${url} for openrouter`, () => {
      expect(isBlockedValidationTarget('openrouter', url)).toBe(true);
    });
  }

  it('keeps the CGNAT boundary tight (neighbors stay allowed)', () => {
    expect(isBlockedValidationTarget('openrouter', 'http://100.63.255.255/')).toBe(false);
    expect(isBlockedValidationTarget('openrouter', 'http://100.128.0.0/')).toBe(false);
  });

  // IPv6 special-purpose space beyond the obvious loopback/ULA/link-local set.
  const nonGlobalV6 = [
    'http://[fec0::1]/', // deprecated site-local fec0::/10
    'http://[100::1]/', // discard-only 100::/64
    'http://[64:ff9b::a00:5]/', // NAT64 well-known prefix (embeds 10.0.0.5)
    'http://[64:ff9b:1::1]/', // NAT64 local-use (RFC 8215)
    'http://[2001::1]/', // Teredo (inside IETF special assignments 2001::/23)
    'http://[2001:2::1]/', // benchmarking (inside 2001::/23)
    'http://[2002:a00:5::1]/', // 6to4 2002::/16
  ];
  for (const url of nonGlobalV6) {
    it(`blocks IPv6 special-purpose ${url} for openrouter`, () => {
      expect(isBlockedValidationTarget('openrouter', url)).toBe(true);
    });
  }

  it('allows real global IPv6 unicast', () => {
    expect(isBlockedValidationTarget('openrouter', 'http://[2606:4700:4700::1111]/')).toBe(false);
    expect(isBlockedValidationTarget('openrouter', 'http://[2620:fe::fe]/')).toBe(false);
  });

  it('fails closed on an unclassifiable IPv6-shaped literal (resolved-address path)', async () => {
    // A resolver could hand back a zone-scoped or malformed string; if it cannot
    // be classified it must be blocked, not fetched.
    expect(await isBlockedResolvedHost('fe80::1%eth0', { resolve: resolveFails })).toBe(true);
    expect(await isBlockedResolvedHost('not::an::address', { resolve: resolveFails })).toBe(true);
  });
});

describe('isBlockedValidationTarget — Ollama is loopback-only', () => {
  it('allows Ollama on loopback', () => {
    expect(isBlockedValidationTarget('ollama', 'http://localhost:11434')).toBe(false);
    expect(isBlockedValidationTarget('ollama', 'http://127.0.0.1:11434')).toBe(false);
    expect(isBlockedValidationTarget('ollama', 'http://[::1]:11434')).toBe(false);
    expect(isBlockedValidationTarget('ollama', 'http://[::ffff:127.0.0.1]:11434')).toBe(false);
  });

  it('blocks Ollama pointed at a non-loopback private/metadata host (no bypass)', () => {
    expect(isBlockedValidationTarget('ollama', 'http://169.254.169.254/')).toBe(true);
    expect(isBlockedValidationTarget('ollama', 'http://10.0.0.5:11434')).toBe(true);
    expect(isBlockedValidationTarget('ollama', 'http://[fe80::1]:11434')).toBe(true);
  });

  it('allows Ollama on a public host (treated like any preset)', () => {
    expect(isBlockedValidationTarget('ollama', 'http://8.8.8.8:11434')).toBe(false);
  });
});

// DNS is always injected — these tests never resolve real names.
const resolveTo =
  (...addresses: string[]): ResolveHostAddresses =>
  async () =>
    addresses;
const resolveFails: ResolveHostAddresses = async () => {
  throw new Error('NXDOMAIN');
};

describe('isBlockedResolvedHost — resolves names and vets every address', () => {
  it('blocks a public hostname resolving to a private IP (DNS rebinding)', async () => {
    expect(await isBlockedResolvedHost('evil.example', { resolve: resolveTo('10.0.0.5') })).toBe(
      true,
    );
    expect(
      await isBlockedResolvedHost('evil.example', { resolve: resolveTo('169.254.169.254') }),
    ).toBe(true);
    expect(await isBlockedResolvedHost('evil.example', { resolve: resolveTo('::1') })).toBe(true);
  });

  it('blocks when ANY resolved address is private (dual-horizon names)', async () => {
    expect(
      await isBlockedResolvedHost('dual.example', {
        resolve: resolveTo('93.184.216.34', '192.168.1.10'),
      }),
    ).toBe(true);
  });

  it('allows a hostname resolving only to public addresses', async () => {
    expect(
      await isBlockedResolvedHost('api.example', {
        resolve: resolveTo('93.184.216.34', '2606:2800:220:1::1'),
      }),
    ).toBe(false);
  });

  it('blocks when resolution fails or returns no addresses', async () => {
    expect(await isBlockedResolvedHost('gone.example', { resolve: resolveFails })).toBe(true);
    expect(await isBlockedResolvedHost('empty.example', { resolve: resolveTo() })).toBe(true);
  });

  it('checks IP literals directly without resolving', async () => {
    expect(await isBlockedResolvedHost('127.0.0.1', { resolve: resolveFails })).toBe(true);
    expect(await isBlockedResolvedHost('8.8.8.8', { resolve: resolveFails })).toBe(false);
  });

  it('honors the loopback exemption for resolved addresses only when asked', async () => {
    const resolve = resolveTo('127.0.0.1');
    expect(await isBlockedResolvedHost('my-ollama.example', { resolve })).toBe(true);
    expect(
      await isBlockedResolvedHost('my-ollama.example', { resolve, allowSameMachine: true }),
    ).toBe(false);
    // The exemption never extends past loopback.
    expect(
      await isBlockedResolvedHost('rebind.example', {
        resolve: resolveTo('10.0.0.5'),
        allowSameMachine: true,
      }),
    ).toBe(true);
  });
});

describe('isBlockedValidationTargetResolved — the setup-validation policy, rebinding-aware', () => {
  it('keeps the literal policy (private literal blocked, public name resolved and allowed)', async () => {
    expect(
      await isBlockedValidationTargetResolved('openrouter', 'http://10.0.0.5/', resolveFails),
    ).toBe(true);
    expect(
      await isBlockedValidationTargetResolved(
        'openrouter',
        'https://api.example/v1',
        resolveTo('93.184.216.34'),
      ),
    ).toBe(false);
  });

  it('blocks a rebinding hostname that the literal check would pass', async () => {
    expect(isBlockedValidationTarget('openrouter', 'https://rebind.example/v1')).toBe(false);
    expect(
      await isBlockedValidationTargetResolved(
        'openrouter',
        'https://rebind.example/v1',
        resolveTo('192.168.0.1'),
      ),
    ).toBe(true);
  });

  it('lets Ollama reach loopback by name, but never other private hosts', async () => {
    expect(
      await isBlockedValidationTargetResolved(
        'ollama',
        'http://localhost:11434',
        resolveTo('127.0.0.1'),
      ),
    ).toBe(false);
    expect(
      await isBlockedValidationTargetResolved(
        'ollama',
        'http://ollama.example:11434',
        resolveTo('10.0.0.5'),
      ),
    ).toBe(true);
  });

  it('lets Ollama reach the Docker host through host.docker.internal', async () => {
    // Docker Desktop and Linux `host-gateway` answer the host with a private address.
    for (const address of ['192.168.65.254', '172.17.0.1', 'fdc4:f303:9324::254']) {
      expect(
        await isBlockedValidationTargetResolved(
          'ollama',
          'http://host.docker.internal:11434',
          resolveTo(address),
        ),
      ).toBe(false);
    }
  });

  it('never lets host.docker.internal answer a metadata address', async () => {
    expect(
      await isBlockedValidationTargetResolved(
        'ollama',
        'http://host.docker.internal:11434',
        resolveTo('169.254.169.254'),
      ),
    ).toBe(true);
  });

  it('refuses host.docker.internal for every preset but Ollama', async () => {
    expect(
      await isBlockedValidationTargetResolved(
        'openai-compatible',
        'http://host.docker.internal:11434',
        resolveTo('192.168.65.254'),
      ),
    ).toBe(true);
  });

  it('refuses an Ollama on another LAN machine', async () => {
    expect(
      await isBlockedValidationTargetResolved(
        'ollama',
        'http://gpu-box.lan:11434',
        resolveTo('192.168.65.254'),
      ),
    ).toBe(true);
  });

  it('does not block when no base URL override is given', async () => {
    expect(await isBlockedValidationTargetResolved('openrouter', undefined, resolveFails)).toBe(
      false,
    );
  });
});
