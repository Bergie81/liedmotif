import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  machine,
  SECRET_KEYS,
  TS_IP,
  TS_NAME,
  TS_OVERRIDE,
  type Machine,
} from './install-test-machine';

// One installer run spawns a few hundred short-lived processes, and an update
// test runs it twice: on a busy machine that passes Vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000 });

describe('installer: Tailscale mode (no --domain)', () => {
  it("serves the machine's MagicDNS name over https through the Tailscale override", async () => {
    const box = await machine();

    const { code, output } = await box.run();

    expect(code, output).toBe(0);
    const env = await box.env();
    expect(env.APP_DOMAIN).toBe(TS_NAME);
    expect(env.APP_PUBLIC_URL).toBe(`https://${TS_NAME}`);
    expect(env.COMPOSE_FILE).toBe(TS_OVERRIDE);
    expect(env.TAILSCALE_IP).toBe(TS_IP);
    for (const key of SECRET_KEYS) expect(env[key], key).toMatch(/^\S{32,}$/);
    expect((await box.calls()).filter((call) => call.startsWith('sudo tailscale up'))).toEqual([]);
  });

  it("leaves Caddy's ports to the Tailscale override", async () => {
    const box = await machine();

    const { code, output } = await box.run();

    expect(code, output).toBe(0);
    const env = await box.env();
    expect(env.CADDY_HTTP_PORT).toBeUndefined();
    expect(env.CADDY_HTTPS_PORT).toBeUndefined();
  });

  it('signs in with tailscale up, showing its login link, when this machine is not on a tailnet yet', async () => {
    const box = await machine({ tailscale: 'logged-out' });

    const { code, output } = await box.run();

    expect(code, output).toBe(0);
    expect((await box.calls()).filter((call) => call.startsWith('sudo tailscale up'))).toEqual([
      'sudo tailscale up',
    ]);
    expect(output).toContain('https://login.tailscale.com/a/1a2b3c4d5e');
    expect((await box.env()).APP_DOMAIN).toBe(TS_NAME);
  });

  it("installs Tailscale with Tailscale's official script when it is missing", async () => {
    const box = await machine({ tailscale: 'missing' });

    const { code, output } = await box.run();

    expect(code, output).toBe(0);
    const calls = await box.calls();
    expect(calls).toContainEqual(
      expect.stringMatching(/^curl .*https:\/\/tailscale\.com\/install\.sh$/),
    );
    expect(calls).toContainEqual(expect.stringMatching(/^sudo sh .*install-tailscale\.sh$/));
    expect(calls).toContain('get-tailscale.sh');
    expect((await box.env()).APP_DOMAIN).toBe(TS_NAME);
  });

  it('uses the Tailscale that is already there', async () => {
    const box = await machine({ tailscale: 'logged-in' });

    await box.run();

    expect((await box.calls()).filter((call) => call.includes('tailscale.com/install.sh'))).toEqual(
      [],
    );
  });

  it("turns on Tailscale's own automatic updates on every run, in one printed line", async () => {
    const box = await machine();

    const install = await box.run('--version', '1.4.0');
    const installCalls = (await box.calls()).length;
    const update = await box.run('--version', '1.5.0');

    expect(install.code, install.output).toBe(0);
    expect(update.code, update.output).toBe(0);
    const calls = await box.calls();
    const autoUpdate = (some: string[]) =>
      some.filter((call) => call.startsWith('sudo tailscale set'));
    expect(autoUpdate(calls.slice(0, installCalls))).toEqual(['sudo tailscale set --auto-update']);
    expect(autoUpdate(calls.slice(installCalls))).toEqual(['sudo tailscale set --auto-update']);
    for (const { output } of [install, update]) {
      expect(output.split('\n').filter((line) => /automatic updates/.test(line))).toHaveLength(1);
    }
  });

  it('only warns when Tailscale cannot turn on its automatic updates', async () => {
    const box = await machine({ tailscaleAutoUpdate: false });

    const { code, output } = await box.run();

    expect(code, output).toBe(0);
    expect(output).toMatch(/Warning: could not turn on Tailscale's automatic updates/);
    expect(output).toContain('sudo apt update && sudo apt upgrade');
    expect(output).toContain(`https://${TS_NAME}/setup?token=`);
  });

  it('stops before writing .env or starting anything while the tailnet has HTTPS certificates off', async () => {
    const box = await machine({ tailnetHttps: false });

    const { code, output } = await box.run();

    expect(code).not.toBe(0);
    expect(output).toMatch(/Error during "Checking Tailscale"/);
    expect(output).toContain('https://console.tailscale.com/admin/dns');
    expect(output).toMatch(/MagicDNS/);
    expect(output).toMatch(/Enable HTTPS/);
    expect(output).toMatch(/run the same command again/);
    await expect(stat(join(box.installDir, '.env'))).rejects.toThrow();
    expect(await box.composeCalls()).toEqual([]);
  });

  it('ends with the setup link, the phone reminder and an update command without --domain', async () => {
    const box = await machine();

    const { code, output } = await box.run();

    expect(code, output).toBe(0);
    const env = await box.env();
    expect(output).toContain(`https://${TS_NAME}/setup?token=${env.SETUP_TOKEN}`);
    expect(output).toMatch(/install Tailscale on your phone/i);
    expect(output).toMatch(/same tailnet/);
    expect(output).toContain(
      'curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh' +
        ` | bash -s -- --dir ${box.installDir}\n`,
    );
  });

  it('never touches Tailscale with --domain', async () => {
    const box = await machine({ tailscale: 'logged-out' });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect((await box.calls()).filter((call) => /tailscale|sysctl|systemctl/.test(call))).toEqual(
      [],
    );
    const env = await box.env();
    expect(env.COMPOSE_FILE).toBeUndefined();
    expect(env.TAILSCALE_IP).toBeUndefined();
    await expect(stat(box.etcDir)).rejects.toThrow();
  });

  it('sets the machine up to bind the Tailscale address at any boot and keep the tailscaled socket across restarts', async () => {
    const box = await machine();

    const { code, output } = await box.run();

    expect(code, output).toBe(0);
    expect(
      await readFile(join(box.etcDir, 'sysctl.d', '99-liedmotif-tailscale.conf'), 'utf8'),
    ).toMatch(/^net\.ipv4\.ip_nonlocal_bind = 1$/m);
    expect(
      await readFile(
        join(box.etcDir, 'systemd', 'system', 'tailscaled.service.d', 'liedmotif.conf'),
        'utf8',
      ),
    ).toMatch(/^\[Service\]\n(#.*\n)*RuntimeDirectoryPreserve=yes$/m);
    const calls = await box.calls();
    expect(calls).toContainEqual(
      expect.stringMatching(/^sudo sysctl -q -p .*\/sysctl\.d\/99-liedmotif-tailscale\.conf$/),
    );
    expect(calls).toContain('sudo systemctl daemon-reload');
  });

  describe('tailnet only, even for a home-network device that routes the Tailscale address here', () => {
    const unitFile = (box: Machine) =>
      join(box.etcDir, 'systemd', 'system', 'liedmotif-tailnet-only.service');

    /**
     * Runs the unit's `ExecStart` lines the way systemd does on each start,
     * against an `iptables` that keeps the raw table's rules in a file:
     * `-C` succeeds only for a rule already there, `-I` puts a rule first.
     */
    async function startUnit(unit: string, starts: number): Promise<string[]> {
      const dir = await mkdtemp(join(tmpdir(), 'liedmotif-iptables-'));
      onTestFinished(() => rm(dir, { recursive: true, force: true }));
      const table = join(dir, 'raw');
      await writeFile(table, '');
      await writeFile(
        join(dir, 'iptables'),
        `#!/bin/sh
[ "$1" = -w ] && shift
[ "$1 $2" = '-t raw' ] || { echo "not the raw table: $*" >&2; exit 2; }
shift 2
op=$1
shift
case $op in
  -C) grep -qxF -- "$*" '${table}' ;;
  -I) { printf '%s\\n' "$*"; cat '${table}'; } >'${table}.new' && mv '${table}.new' '${table}' ;;
  *) echo "unexpected: $op" >&2; exit 2 ;;
esac
`,
        { mode: 0o755 },
      );
      const commands = [...unit.matchAll(/^ExecStart=(.*)$/gm)].map(([, command = '']) => command);
      expect(commands.length).toBeGreaterThan(0);
      for (let start = 0; start < starts; start++) {
        for (const command of commands) {
          const result = spawnSync('sh', ['-c', command], {
            encoding: 'utf8',
            env: { PATH: `${dir}:${process.env.PATH ?? ''}` },
          });
          expect(result.status, result.stderr).toBe(0);
        }
      }
      return (await readFile(table, 'utf8')).split('\n').filter(Boolean);
    }

    it('drops what reaches the Tailscale address on any other interface, keeping this machine and its containers', async () => {
      const box = await machine();

      const { code, output } = await box.run();

      expect(code, output).toBe(0);
      const unit = await readFile(unitFile(box), 'utf8');
      // First match wins. `lo` carries this machine's own connections to the
      // address; Docker sends the host's own connection to a published port,
      // the health check's, to the container and its answers back over the
      // Compose network's `br-` bridge.
      expect(await startUnit(unit, 2)).toEqual([
        `PREROUTING -d ${TS_IP} -i lo -j ACCEPT`,
        `PREROUTING -d ${TS_IP} -i br-+ -j ACCEPT`,
        `PREROUTING -d ${TS_IP} ! -i tailscale0 -j DROP`,
      ]);
    });

    it('is in place before Docker publishes a port, at every boot', async () => {
      const box = await machine();

      const { code, output } = await box.run();

      expect(code, output).toBe(0);
      const unit = await readFile(unitFile(box), 'utf8');
      expect(unit).toMatch(/^Before=docker\.service$/m);
      expect(unit).toMatch(/^Type=oneshot$/m);
      expect(unit).toMatch(/^RemainAfterExit=yes$/m);
      expect(unit).toMatch(/^WantedBy=docker\.service$/m);
      const systemctl = (await box.calls()).filter((call) => call.startsWith('sudo systemctl'));
      expect(systemctl).toEqual([
        'sudo systemctl daemon-reload',
        'sudo systemctl enable liedmotif-tailnet-only.service',
        'sudo systemctl restart liedmotif-tailnet-only.service',
      ]);
    });

    it('stays in place on an update', async () => {
      const box = await machine();
      await box.run('--version', '1.4.0');
      const unit = await readFile(unitFile(box), 'utf8');
      const installCalls = (await box.calls()).length;

      const { code, output } = await box.run('--version', '1.5.0');

      expect(code, output).toBe(0);
      expect(await readFile(unitFile(box), 'utf8')).toBe(unit);
      expect((await box.calls()).slice(installCalls)).toContain(
        'sudo systemctl restart liedmotif-tailnet-only.service',
      );
    });
  });

  it('stops before writing .env on a Docker Compose too old to replace the published ports', async () => {
    const box = await machine({ composeVersion: '2.24.3' });

    const { code, output } = await box.run();

    expect(code).not.toBe(0);
    expect(output).toMatch(/Docker Compose 2\.24\.4 or newer/);
    expect(output).toContain('2.24.3');
    await expect(stat(join(box.installDir, '.env'))).rejects.toThrow();
    expect(await box.composeCalls()).toEqual([]);
  });

  it("checks health on the Tailscale address with the certificate's real name", async () => {
    const box = await machine();

    await box.run();

    const health = (await box.calls()).filter((call) => call.includes('/api/health'));
    expect(health).toEqual([
      expect.stringContaining(`--resolve ${TS_NAME}:443:${TS_IP} https://${TS_NAME}/api/health`),
    ]);
    expect(health[0]).not.toContain('--insecure');
  });

  it('names the admin-console switches when the health check fails on the certificate', async () => {
    const box = await machine({ healthy: false, healthFailure: 'certificate' });

    const { code, output } = await box.run();

    expect(code).not.toBe(0);
    expect(output).toMatch(/Error during "Waiting for Liedmotif/);
    expect(output).toContain('https://console.tailscale.com/admin/dns');
    expect(output).toMatch(/Enable HTTPS/);
    expect(output).not.toMatch(/open to the internet/);
  });

  it('never suggests opening ports when the app does not answer on the tailnet', async () => {
    const box = await machine({ healthy: false, healthFailure: 'connect' });

    const { code, output } = await box.run();

    expect(code).not.toBe(0);
    expect(output).toMatch(/docker compose logs caddy web/);
    expect(output).not.toMatch(/open to the internet|DNS record/);
    expect(output).not.toContain('/setup');
  });
});

describe('installer: rerun on the tailnet', () => {
  it('moves only LIEDMOTIF_VERSION in .env and keeps serving the stored name', async () => {
    const box = await machine();
    await box.run('--version', '1.4.0');
    const before = await box.envFile();
    const installCalls = (await box.calls()).length;

    const { code, output } = await box.run('--version', '1.5.0');

    expect(code, output).toBe(0);
    expect(await box.envFile()).toBe(
      before.replace('\nLIEDMOTIF_VERSION=1.4.0\n', '\nLIEDMOTIF_VERSION=1.5.0\n'),
    );
    expect((await box.calls()).slice(installCalls)).toContain('tailscale status --json');
    expect(output).toMatch(new RegExp(`Liedmotif 1\\.5\\.0 is running at https://${TS_NAME}\\n*$`));
  });

  it('stops before stopping the app when the machine has a new tailnet name or address', async () => {
    const box = await machine();
    await box.run('--version', '1.4.0');
    const before = await box.envFile();
    const installCalls = (await box.calls()).length;
    await box.moveOnTailnet('liedmotif-1.tail1234.ts.net', '100.64.0.9');

    const { code, output } = await box.run('--version', '1.5.0');

    expect(code).not.toBe(0);
    expect(await box.envFile()).toBe(before);
    expect(await box.composeCalls(installCalls)).toEqual([]);
    expect(output).toContain('liedmotif-1.tail1234.ts.net');
    expect(output).toMatch(/Nothing was stopped/);
    expect(output).toContain(
      'APP_DOMAIN=liedmotif-1.tail1234.ts.net, APP_PUBLIC_URL=https://liedmotif-1.tail1234.ts.net and TAILSCALE_IP=100.64.0.9',
    );
  });

  it('reads a hand-quoted or commented .env value the way Compose does', async () => {
    const box = await machine();
    await box.run('--version', '1.4.0');
    const envPath = join(box.installDir, '.env');
    const quoted = (await box.envFile())
      .replace(`\nAPP_DOMAIN=${TS_NAME}\n`, `\nAPP_DOMAIN='${TS_NAME}' # this box\n`)
      .replace(`\nTAILSCALE_IP=${TS_IP}\n`, `\nTAILSCALE_IP=${TS_IP}  # tailscale ip -4\n`);
    await writeFile(envPath, quoted);

    const { code, output } = await box.run('--version', '1.5.0');

    expect(code, output).toBe(0);
    expect(output).toMatch(new RegExp(`Liedmotif 1\\.5\\.0 is running at https://${TS_NAME}\\n*$`));
  });

  it('finishes a first install cut off while waiting for the Tailscale sign-in', async () => {
    const box = await machine({ tailscale: 'logged-out' });
    await box.failTailscaleUp(true);
    const cut = await box.run();
    expect(cut.code).not.toBe(0);
    await expect(stat(join(box.installDir, '.env'))).rejects.toThrow();
    await box.failTailscaleUp(false);

    const { code, output } = await box.run();

    expect(code, output).toBe(0);
    const env = await box.env();
    expect(env.APP_DOMAIN).toBe(TS_NAME);
    expect(output).toContain(`https://${TS_NAME}/setup?token=${env.SETUP_TOKEN}`);
  });
});

/**
 * The override itself, merged by the real `docker compose config` (it starts
 * nothing). Only Compose can prove the merge replaces Caddy's ports instead of
 * adding to them, so these skip where no `docker compose` is installed.
 */
const HAS_COMPOSE = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function caddyConfig(env: Record<string, string>, composeFiles: string[]) {
  // An empty --env-file and a bare environment keep the developer's own
  // `.env` out of the merge.
  const dir = await mkdtemp(join(tmpdir(), 'liedmotif-compose-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const envFile = join(dir, 'empty.env');
  await writeFile(envFile, '');
  const result = spawnSync(
    'docker',
    [
      'compose',
      ...composeFiles.flatMap((file) => ['-f', file]),
      '--env-file',
      envFile,
      'config',
      '--format',
      'json',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, ...env },
    },
  );
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

/** Caddy's published ports as `host_ip:published`, `*` when no address narrows them. */
function caddyBindings(stdout: string) {
  const { caddy } = (JSON.parse(stdout) as { services: Record<string, ComposeService> }).services;
  return caddy?.ports?.map((port) => `${port.host_ip ?? '*'}:${port.published}`);
}

describe.skipIf(!HAS_COMPOSE)('docker-compose.yml', () => {
  it.each([
    ['unset: this machine only', {}, ['127.0.0.1:80', '127.0.0.1:443']],
    [
      'blank: this machine only',
      { CADDY_HTTP_PORT: '', CADDY_HTTPS_PORT: '' },
      ['127.0.0.1:80', '127.0.0.1:443'],
    ],
    [
      'plain ports: every interface',
      { CADDY_HTTP_PORT: '80', CADDY_HTTPS_PORT: '443' },
      ['*:80', '*:443'],
    ],
    [
      'moved but still private',
      { CADDY_HTTP_PORT: '127.0.0.1:8080', CADDY_HTTPS_PORT: '127.0.0.1:8443' },
      ['127.0.0.1:8080', '127.0.0.1:8443'],
    ],
  ])('publishes Caddy with the ports %s', async (_name, env, bindings) => {
    const { status, stderr, stdout } = await caddyConfig(env as Record<string, string>, [
      'docker-compose.yml',
    ]);

    expect(status, stderr).toBe(0);
    expect(caddyBindings(stdout)).toEqual(bindings);
  });
});

describe.skipIf(!HAS_COMPOSE)('docker-compose.tailscale.yml', () => {
  const TAILSCALE_FILES = ['docker-compose.yml', 'docker-compose.tailscale.yml'];

  it('publishes Caddy on the Tailscale address alone and mounts the tailscaled socket directory', async () => {
    const { status, stderr, stdout } = await caddyConfig({ TAILSCALE_IP: TS_IP }, TAILSCALE_FILES);

    expect(status, stderr).toBe(0);
    const caddy = (JSON.parse(stdout) as { services: Record<string, ComposeService> }).services
      .caddy;
    expect(caddy?.ports).toEqual([
      expect.objectContaining({ host_ip: TS_IP, target: 80, published: '80' }),
      expect.objectContaining({ host_ip: TS_IP, target: 443, published: '443' }),
    ]);
    expect(caddy?.volumes).toContainEqual(
      expect.objectContaining({
        type: 'bind',
        source: '/var/run/tailscale',
        target: '/var/run/tailscale',
        read_only: true,
      }),
    );
  });

  it('stays on the Tailscale address even when .env sets plain ports', async () => {
    const { status, stderr, stdout } = await caddyConfig(
      { TAILSCALE_IP: TS_IP, CADDY_HTTP_PORT: '80', CADDY_HTTPS_PORT: '443' },
      TAILSCALE_FILES,
    );

    expect(status, stderr).toBe(0);
    expect(caddyBindings(stdout)).toEqual([`${TS_IP}:80`, `${TS_IP}:443`]);
  });

  it('refuses to run without TAILSCALE_IP instead of opening every interface', async () => {
    const { status, stderr } = await caddyConfig({}, TAILSCALE_FILES);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/TAILSCALE_IP/);
  });
});

interface ComposeService {
  ports?: { host_ip?: string; target: number; published: string }[];
  volumes?: { type: string; source: string; target: string; read_only?: boolean }[];
}
