import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * The shipped `Caddyfile`, adapted and validated by the Caddy that
 * `docker-compose.yml` pins, with the environment Compose hands the `caddy`
 * service for a given `.env`. One short container per case, without a network:
 * no stack starts. Needs a reachable Docker daemon, and skips without one.
 */
const CADDYFILE = fileURLToPath(new URL('../Caddyfile', import.meta.url));
const COMPOSE = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const CADDY_IMAGE = /^ {2}caddy:\n {4}image: (\S+)$/m.exec(COMPOSE)?.[1] ?? '';

const dockerReachable = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

/** The `caddy` service's `environment:` block, interpolated against `.env` as Compose does. */
function caddyEnvironment(dotenv: Record<string, string>): Record<string, string> {
  const service = /^ {2}caddy:\n((?: {4}.*\n|\s*\n)*)/m.exec(COMPOSE)?.[1] ?? '';
  const block = /^ {4}environment:\n((?: {6}.*\n)*)/m.exec(service)?.[1] ?? '';
  const environment: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const entry = /^ {6}([A-Z0-9_]+): (.*)$/.exec(line);
    if (!entry) continue;
    const [, key = '', template = ''] = entry;
    environment[key] = template.replace(
      /\$\{([A-Z0-9_]+)(?::([-+])([^}]*))?\}/g,
      (_, name: string, operator?: string, word = '') => {
        const value = dotenv[name] ?? '';
        if (operator === '-') return value || word;
        if (operator === '+') return value ? word : '';
        return value;
      },
    );
  }
  return environment;
}

interface AdaptedConfig {
  apps: {
    http: { servers: Record<string, { trusted_proxies?: { source: string; ranges?: string[] } }> };
    tls?: { automation?: { policies?: { subjects?: string[]; issuers?: { module: string }[] }[] } };
  };
}

const execFileAsync = promisify(execFile);

/** `caddy adapt --validate` on the shipped file, for an install whose `.env` holds `dotenv`. */
async function adapt(dotenv: Record<string, string>): Promise<AdaptedConfig> {
  const environment = caddyEnvironment({ APP_DOMAIN: 'music.example.com', ...dotenv });
  const envArgs = Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  try {
    const { stdout } = await execFileAsync('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${CADDYFILE}:/etc/caddy/Caddyfile:ro`,
      ...envArgs,
      CADDY_IMAGE,
      'caddy',
      'adapt',
      '--config',
      '/etc/caddy/Caddyfile',
      '--adapter',
      'caddyfile',
      '--validate',
    ]);
    return JSON.parse(stdout) as AdaptedConfig;
  } catch (error) {
    const { stderr = '' } = error as { stderr?: string };
    throw new Error(`Caddy rejected the Caddyfile for ${JSON.stringify(environment)}:\n${stderr}`, {
      cause: error,
    });
  }
}

const trustedProxies = (config: AdaptedConfig) =>
  Object.values(config.apps.http.servers).map((server) => server.trusted_proxies);
const issuers = (config: AdaptedConfig) =>
  (config.apps.tls?.automation?.policies ?? []).map((policy) => ({
    subjects: policy.subjects,
    issuers: policy.issuers?.map((issuer) => issuer.module),
  }));

const PRIVATE_RANGES = [
  '192.168.0.0/16',
  '172.16.0.0/12',
  '10.0.0.0/8',
  '127.0.0.1/8',
  'fd00::/8',
  '::1',
];

describe.skipIf(!dockerReachable)('Caddyfile: the two Caddy options in .env', () => {
  it.each([
    ['unset', {}],
    ['empty', { CADDY_TLS: '', CADDY_TRUSTED_PROXIES: '' }],
  ])(
    'with both %s, Caddy picks the certificate by its own rules and trusts no proxy',
    async (_, dotenv) => {
      const config = await adapt(dotenv);

      expect(issuers(config)).toEqual([]);
      expect(trustedProxies(config)).toEqual([undefined]);
    },
    60_000,
  );

  it('CADDY_TLS=internal signs the site with the internal certificate authority', async () => {
    const config = await adapt({ CADDY_TLS: 'internal' });

    expect(issuers(config)).toEqual([{ subjects: ['music.example.com'], issuers: ['internal'] }]);
    expect(trustedProxies(config)).toEqual([undefined]);
  }, 60_000);

  it.each([
    ['private_ranges', PRIVATE_RANGES],
    ['10.0.0.0/8', ['10.0.0.0/8']],
    ['10.0.0.0/8 172.16.0.0/12', ['10.0.0.0/8', '172.16.0.0/12']],
  ])(
    'CADDY_TRUSTED_PROXIES=%s trusts exactly those proxies',
    async (value, ranges) => {
      const config = await adapt({ CADDY_TRUSTED_PROXIES: value });

      expect(trustedProxies(config)).toEqual([{ source: 'static', ranges }]);
      expect(issuers(config)).toEqual([]);
    },
    60_000,
  );

  it('both together put each directive in its own place', async () => {
    const config = await adapt({ CADDY_TLS: 'internal', CADDY_TRUSTED_PROXIES: 'private_ranges' });

    expect(issuers(config)).toEqual([{ subjects: ['music.example.com'], issuers: ['internal'] }]);
    expect(trustedProxies(config)).toEqual([{ source: 'static', ranges: PRIVATE_RANGES }]);
  }, 60_000);

  it('refuses to start on a CADDY_TLS it does not know', async () => {
    await expect(adapt({ CADDY_TLS: 'yes' })).rejects.toThrow(/tls-yes/);
  }, 60_000);
});
