import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ENV_EXAMPLE, machine, parseEnv, SECRET_KEYS, type Machine } from './install-test-machine';

// One installer run spawns a few hundred short-lived processes, and an update
// test runs it twice: on a busy machine that passes Vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('installer: fresh install with --domain', () => {
  it('writes .env with every secret generated, distinct, mode 600 and a matching database URL', async () => {
    const box = await machine();

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    const env = await box.env();
    const example = parseEnv(await readFile(ENV_EXAMPLE, 'utf8'));
    for (const key of SECRET_KEYS) {
      expect(env[key], key).toMatch(/^\S{32,}$/);
      expect(env[key], key).not.toBe(example[key]);
      expect(env[key], key).not.toMatch(/change-me/);
    }
    expect(new Set(SECRET_KEYS.map((key) => env[key])).size).toBe(SECRET_KEYS.length);
    expect(Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY ?? '', 'base64')).toHaveLength(32);
    expect(env.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(env.DOCKER_DATABASE_URL).toBe(
      `postgres://liedmotif:${env.POSTGRES_PASSWORD}@postgres:5432/liedmotif`,
    );
    expect((await stat(join(box.installDir, '.env'))).mode & 0o777).toBe(0o600);
  });

  it('never rewrites an existing .env, and prints no setup link for it', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com');
    const before = await box.envFile();
    const { SETUP_TOKEN: token } = await box.env();

    const { code, output } = await box.run('--domain', 'other.example.com');

    expect(code, output).toBe(0);
    expect(await box.envFile()).toBe(before);
    expect(output).not.toContain(token);
    expect(output).not.toContain('/setup');
    expect(output).toContain('https://music.example.com');
    expect(output).toMatch(/Warning: keeping APP_DOMAIN=music\.example\.com/);
  });

  it('serves the --domain over https and runs the latest release', async () => {
    const box = await machine();

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    const env = await box.env();
    expect(env.APP_DOMAIN).toBe('music.example.com');
    expect(env.APP_PUBLIC_URL).toBe('https://music.example.com');
    expect(env.LIEDMOTIF_VERSION).toBe('9.9.9');
  });

  it('publishes Caddy on plain ports for a real domain, or the world never reaches it', async () => {
    const box = await machine();

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(await box.env()).toMatchObject({ CADDY_HTTP_PORT: '80', CADDY_HTTPS_PORT: '443' });
  });

  it('keeps --domain localhost on this machine alone', async () => {
    const box = await machine();

    const { code, output } = await box.run('--domain', 'localhost');

    expect(code, output).toBe(0);
    const env = await box.env();
    expect(env.CADDY_HTTP_PORT).toBeUndefined();
    expect(env.CADDY_HTTPS_PORT).toBeUndefined();
  });

  it('refuses a --domain that is a URL instead of a bare name, before installing anything', async () => {
    const box = await machine();

    const { code, output } = await box.run('--domain', 'https://music.example.com/');

    expect(code).not.toBe(0);
    expect(output).toContain('--domain music.example.com');
    expect(await box.calls()).toEqual([]);
  });

  it('installs the release --version names', async () => {
    const box = await machine();

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.4.0');

    expect(code, output).toBe(0);
    expect((await box.env()).LIEDMOTIF_VERSION).toBe('1.4.0');
    const downloads = (await box.calls()).filter((call) => call.includes('/archive/'));
    expect(downloads).toEqual([
      expect.stringContaining(
        'https://github.com/bergie81/liedmotif/archive/refs/tags/v1.4.0.tar.gz',
      ),
    ]);
  });
});

describe('installer: rerun is the update', () => {
  it('moves LIEDMOTIF_VERSION to the new release and leaves every other byte of .env alone', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    const before = await box.envFile();
    expect(before).toContain('\nLIEDMOTIF_VERSION=1.4.0\n');

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', 'v1.5.0');

    expect(code, output).toBe(0);
    expect(await box.envFile()).toBe(
      before.replace('\nLIEDMOTIF_VERSION=1.4.0\n', '\nLIEDMOTIF_VERSION=1.5.0\n'),
    );
  });

  // Compose reads the last assignment, so that is the one the update must move.
  it('moves the LIEDMOTIF_VERSION that Compose reads when .env sets it twice', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    const envPath = join(box.installDir, '.env');
    await writeFile(envPath, `${await box.envFile()}LIEDMOTIF_VERSION=1.4.1\n`);

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code, output).toBe(0);
    expect((await box.envFile()).match(/^LIEDMOTIF_VERSION=.*$/gm)).toEqual([
      'LIEDMOTIF_VERSION=1.4.0',
      'LIEDMOTIF_VERSION=1.5.0',
    ]);
  });

  it('pulls while the old app plays, stops it, migrates to completion, then starts the new one', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    const installCalls = (await box.calls()).length;

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code, output).toBe(0);
    const compose = await box.composeCalls(installCalls);
    // No web or worker start before migrate succeeds: the only `up` that can
    // start them is the last call.
    expect(compose).toEqual([
      `docker compose pull (in ${box.installDir})`,
      `docker compose stop web caddy (in ${box.installDir})`,
      `docker compose stop worker (in ${box.installDir})`,
      `docker compose up --no-build --exit-code-from migrate migrate (in ${box.installDir})`,
      `docker compose up -d --no-build (in ${box.installDir})`,
    ]);
    expect(await box.imageVersions()).toEqual(['pull 1.4.0', 'pull 1.5.0']);
  });

  it('keeps .env as it was and the old app playing when the new images cannot be pulled', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    const before = await box.envFile();
    const installCalls = (await box.calls()).length;
    await box.failDocker('compose pull');

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code).not.toBe(0);
    expect(await box.envFile()).toBe(before);
    expect(await box.composeCalls(installCalls)).toEqual([
      `docker compose pull (in ${box.installDir})`,
    ]);
    expect((await box.imageVersions()).at(-1)).toBe('pull 1.5.0');
    expect(output).toMatch(/could not pull the Liedmotif images for 1\.5\.0\. Nothing was stopped/);
    expect(output).not.toMatch(/LIEDMOTIF_VERSION/);
  });

  it('pulls the new version through sudo for a user outside the docker group', async () => {
    const box = await machine({ dockerGroup: false });
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code, output).toBe(0);
    expect(await box.calls()).toContainEqual(expect.stringMatching(/^sudo .*docker compose pull$/));
    expect(await box.imageVersions()).toEqual(['pull 1.4.0', 'pull 1.5.0']);
  });

  it('still names the version to go back to when migrate fails on the rerun after a failed pull', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    await box.failDocker('compose pull');
    await box.run('--domain', 'music.example.com', '--version', '1.5.0');
    await box.failDocker('migrate');

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code).not.toBe(0);
    expect(output).toMatch(/LIEDMOTIF_VERSION .*from 1\.4\.0 to 1\.5\.0/);
    expect(output).toMatch(
      /restore the last backup from before this update and go back to 1\.4\.0/,
    );
  });

  it('still names the version to go back to when migrate fails again on the rerun', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    await box.failDocker('migrate');
    await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code).not.toBe(0);
    expect(output).toMatch(
      /restore the last backup from before this update and go back to 1\.4\.0/,
    );
  });

  it('leaves the app stopped and points at the backup when migrate fails', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    const installCalls = (await box.calls()).length;
    await box.failDocker('migrate');

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code).not.toBe(0);
    const compose = await box.composeCalls(installCalls);
    expect(compose.at(-1)).toMatch(/^docker compose up .*migrate/);
    expect(compose).toContain(`docker compose stop web caddy (in ${box.installDir})`);
    expect(output).toMatch(/Error during "Updating the database"/);
    expect(output).toMatch(/stays stopped/);
    expect(output).toContain('docker compose logs migrate');
    expect(output).toMatch(
      /restore the last backup from before this update and go back to 1\.4\.0/,
    );
    expect(output).toContain('https://liedmotif.com/docs/updates/#if-an-update-fails');
    expect(output).not.toMatch(/is running at/);
  });

  it('finishes a first install cut off after .env was written, with the same secrets', async () => {
    const box = await machine();
    await box.failDocker('compose pull');
    const cut = await box.run('--domain', 'music.example.com');
    expect(cut.code).not.toBe(0);
    const before = await box.envFile();
    await box.healDocker();

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(await box.envFile()).toBe(before);
    expect(output).toContain(
      `https://music.example.com/setup?token=${(await box.env()).SETUP_TOKEN}`,
    );
  });

  it('ends with only the new version and the app URL', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    const env = await box.env();

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code, output).toBe(0);
    expect(output).toMatch(/Liedmotif 1\.5\.0 is running at https:\/\/music\.example\.com\n*$/);
    for (const key of SECRET_KEYS) expect(output, key).not.toContain(env[key]);
    expect(output).not.toContain('/setup');
    expect(output).not.toMatch(/somewhere safe/);
  });
});

describe('installer: preflight', () => {
  it.each([
    { system: '32-bit ARM', arch: 'armv7l', longBit: '32' },
    { system: '32-bit x86', arch: 'i686', longBit: '32' },
    // 32-bit Raspberry Pi OS boots a 64-bit kernel on a Pi 4 or 5.
    { system: '32-bit Raspberry Pi OS on a 64-bit kernel', arch: 'aarch64', longBit: '32' },
  ])('stops on $system with the 64-bit message before installing anything', async (system) => {
    const box = await machine({ arch: system.arch, longBit: system.longBit, docker: false });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code).not.toBe(0);
    expect(output).toMatch(/64-bit/);
    expect(output).toMatch(/Raspberry Pi OS \(64-bit\)/);
    expect(await box.calls()).toEqual([]);
    await expect(stat(box.installDir)).rejects.toThrow();
  });

  it('warns below about 3.5 GB of RAM and installs anyway', async () => {
    const box = await machine({ memMiB: 1_850 });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(output).toMatch(/Warning: .*RAM.*4 GB/);
    expect(output).toContain('Liedmotif 9.9.9 is running');
  });

  it('stays quiet about RAM on a 4 GB board', async () => {
    // A 4 GB Raspberry Pi reports about 3.7 GiB once the firmware takes its share.
    const box = await machine({ memMiB: 3_796 });

    const { output } = await box.run('--domain', 'music.example.com');

    expect(output).not.toMatch(/RAM/);
  });

  it('warns when the data sits on a microSD card and installs anyway', async () => {
    const box = await machine({ rootSource: '/dev/mmcblk0p2' });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(output).toMatch(/Warning: .*microSD/);
    expect(output).toMatch(/SSD/);
    expect(output).toMatch(/High Endurance/);
    expect(output).toContain('Liedmotif 9.9.9 is running');
  });

  it('stays quiet about storage on an SSD', async () => {
    const box = await machine({ rootSource: '/dev/nvme0n1p2' });

    const { output } = await box.run('--domain', 'music.example.com');

    expect(output).not.toMatch(/microSD/);
  });
});

describe('installer: finish', () => {
  it('ends with the setup link, the .env reminder and the update command', async () => {
    const box = await machine();

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    const env = await box.env();
    expect(output).toContain(`https://music.example.com/setup?token=${env.SETUP_TOKEN}`);
    expect(output).toContain(`${box.installDir}/.env`);
    expect(output).toMatch(/somewhere safe/);
    expect(output).toContain(
      'curl -fsSL https://github.com/bergie81/liedmotif/releases/latest/download/install.sh' +
        ` | bash -s -- --domain music.example.com --dir ${box.installDir}`,
    );
  });

  it('prints the update command with the install folder as an absolute path', async () => {
    const box = await machine();

    const { code, output } = await box.run(
      '--domain',
      'music.example.com',
      '--dir',
      relative(process.cwd(), box.installDir),
    );

    expect(code, output).toBe(0);
    const dir = /\| bash -s -- --domain music\.example\.com --dir (\S+)/.exec(output)?.[1] ?? '';
    expect(isAbsolute(dir), output).toBe(true);
    expect(resolve(dir)).toBe(box.installDir);
  });

  it('prints no secret apart from the setup token inside the one setup link', async () => {
    const box = await machine({ docker: false, memMiB: 1_850, rootSource: '/dev/mmcblk0p2' });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    const env = await box.env();
    for (const key of SECRET_KEYS.filter((key) => key !== 'SETUP_TOKEN')) {
      expect(output, key).not.toContain(env[key]);
    }
    expect(output).not.toContain(env.DOCKER_DATABASE_URL);
    expect(output.split(env.SETUP_TOKEN ?? '')).toHaveLength(2);
  });
});

describe('installer: health check', () => {
  it('stops naming the step and what to try when the app never answers', async () => {
    const box = await machine({ healthy: false });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code).not.toBe(0);
    expect(output).toMatch(
      /Error during "Waiting for Liedmotif.*https:\/\/music\.example\.com\/api\/health/,
    );
    expect(output).toMatch(/DNS/);
    expect(output).toMatch(/80 and 443/);
    expect(output).toMatch(/docker compose logs/);
    expect(output).toMatch(/run the same command again/);
    expect(output).not.toContain('/setup');
  });

  it('shows the setup link on the rerun that finishes a failed first install', async () => {
    const box = await machine({ healthy: false });
    await box.run('--domain', 'music.example.com');
    const before = await box.envFile();
    await box.setHealthy(true);

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(await box.envFile()).toBe(before);
    expect(output).toContain(
      `https://music.example.com/setup?token=${(await box.env()).SETUP_TOKEN}`,
    );
    expect(output).toMatch(/somewhere safe/);
  });

  it("accepts Caddy's internal certificate for --domain localhost and verifies a public domain", async () => {
    const local = await machine();
    const domain = await machine();

    await local.run('--domain', 'localhost');
    await domain.run('--domain', 'music.example.com');

    const health = async (box: Machine) =>
      (await box.calls()).filter((call) => call.includes('/api/health'));
    expect(await health(local)).toEqual([
      expect.stringMatching(/--insecure .*https:\/\/localhost\/api\/health/),
    ]);
    expect(await health(domain)).toEqual([expect.not.stringContaining('--insecure')]);
  });

  // The phone-access guide moves an installed app to a home network address by
  // editing APP_DOMAIN and APP_PUBLIC_URL in `.env`; the next update keeps it.
  const updateServing = async (box: Machine, name: string, healthy = true) => {
    await box.run('--domain', 'music.example.com');
    const env = join(box.installDir, '.env');
    await writeFile(
      env,
      (await readFile(env, 'utf8'))
        .replace(/^APP_DOMAIN=.*$/m, `APP_DOMAIN=${name}`)
        .replace(/^APP_PUBLIC_URL=.*$/m, `APP_PUBLIC_URL=https://${name}`),
    );
    await box.setHealthy(healthy);
    const since = (await box.calls()).length;
    const result = await box.run();
    const health = (await box.calls()).slice(since).filter((call) => call.includes('/api/health'));
    return { ...result, health };
  };

  it("an update of a LAN-address install accepts Caddy's internal certificate", async () => {
    const box = await machine();
    const { code, output, health } = await updateServing(box, '192.168.1.20');

    expect(code, output).toBe(0);
    expect(health).toEqual([
      expect.stringMatching(/--insecure .*https:\/\/192\.168\.1\.20\/api\/health/),
    ]);
    const downloads = (await box.calls()).filter(
      (call) => call.startsWith('curl ') && !call.includes('/api/health'),
    );
    expect(downloads.length).toBeGreaterThan(0);
    for (const call of downloads) expect(call).not.toContain('--insecure');
  });

  // Caddy's own list of names it serves with its internal certificate.
  it.each([
    '10.0.0.5',
    'localhost',
    'music.localhost',
    'nas.local',
    'music.internal',
    'nas.home.arpa',
    'NAS.Local.',
    'fd00::20',
  ])("an update serving %s accepts Caddy's internal certificate", async (name) => {
    const { code, output, health } = await updateServing(await machine(), name);

    expect(code, output).toBe(0);
    expect(health).toEqual([expect.stringContaining('--insecure')]);
  });

  it.each([
    'music.example.com',
    'nas.fritz.box',
    'music.example.com:8443',
    'nas.local.example.com',
    '192.168.1.20.nip.io',
    'localhost.example.com',
  ])('an update serving %s verifies the certificate', async (name) => {
    const { code, output, health } = await updateServing(await machine(), name);

    expect(code, output).toBe(0);
    expect(health).toEqual([expect.not.stringContaining('--insecure')]);
  });

  it('sends a home network address to the logs when the app never answers, never to the internet', async () => {
    const internet = /open to the internet/;
    const publicDomain = await machine({ healthy: false });

    const atHome = await updateServing(await machine(), '192.168.1.20', false);
    const online = await publicDomain.run('--domain', 'music.example.com');

    expect(atHome.code).not.toBe(0);
    expect(atHome.output).not.toMatch(internet);
    expect(atHome.output).not.toMatch(/DNS/);
    expect(atHome.output).toMatch(/docker compose ps.*docker compose logs caddy web/);
    expect(online.output).toMatch(internet);
  });
});

describe('installer: Docker', () => {
  it('uses the Docker that is already there', async () => {
    const box = await machine({ docker: true });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    const calls = await box.calls();
    expect(calls.filter((call) => call.includes('get.docker.com'))).toEqual([]);
    expect(calls).not.toContain('get-docker.sh');
  });

  it("installs Docker with Docker's official script when it is missing", async () => {
    const box = await machine({ docker: false });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    const calls = await box.calls();
    expect(calls).toContainEqual(expect.stringMatching(/^curl .*https:\/\/get\.docker\.com$/));
    expect(calls).toContainEqual(expect.stringMatching(/^sudo sh .*get-docker\.sh$/));
    expect(calls).toContain('get-docker.sh');
  });

  it('pulls the images, then starts the stack from the install directory', async () => {
    const box = await machine();

    await box.run('--domain', 'music.example.com');

    const compose = await box.composeCalls();
    expect(compose).toEqual([
      `docker compose pull (in ${box.installDir})`,
      `docker compose up -d --no-build (in ${box.installDir})`,
    ]);
  });
});

// Every install runs as the Compose project `liedmotif` unless its `.env` names
// another, so a second folder for the same project would replace the running
// app's containers and meet its database with a new password.
describe('installer: Liedmotif already installed in another folder', () => {
  /** The folder the other install runs from, next to this machine's install folder. */
  async function otherFolder(box: Machine) {
    const folder = join(box.installDir, '..', 'srv-liedmotif');
    await mkdir(folder, { recursive: true });
    return folder;
  }
  /** Every Docker call that could change a container, a volume or an image. */
  const dockerChanges = async (box: Machine) =>
    (await box.calls()).filter(
      (call) => /^docker /.test(call) && !/^docker (compose version|info|ps)\b/.test(call),
    );

  it('refuses a first install while Liedmotif runs from another folder, before installing anything', async () => {
    const box = await machine();
    const other = await otherFolder(box);
    await box.addContainer({ workingDir: other });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code).not.toBe(0);
    expect(output).toContain(`Liedmotif is already installed on this machine, in ${other}.`);
    expect(output).toContain(`run the same command with --dir ${other}`);
    expect(await exists(box.installDir)).toBe(false);
    expect(await dockerChanges(box)).toEqual([]);
    expect((await box.calls()).filter((call) => call.includes('github.com'))).toEqual([]);
  });

  it('counts a stopped install too', async () => {
    const box = await machine();
    const other = await otherFolder(box);
    await box.addContainer({ workingDir: other, running: false });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code).not.toBe(0);
    expect(output).toContain(`--dir ${other}`);
    expect(await exists(box.installDir)).toBe(false);
  });

  it.each([
    ['names no folder', () => ''],
    ['names a folder that is gone', (box: Machine) => join(box.installDir, '..', 'gone')],
  ])('refuses, and says how to find it, when the install %s', async (_, folder) => {
    const box = await machine();
    await box.addContainer({ workingDir: folder(box) });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code).not.toBe(0);
    expect(output).toContain('Liedmotif is already installed on this machine');
    expect(output).toContain('docker compose ls -a');
    // Removing it keeps its volumes, so a fresh install would meet its database
    // with a new password: the message never suggests that.
    expect(output).not.toMatch(/compose -p \S+ down/);
    expect(await exists(box.installDir)).toBe(false);
    expect(await dockerChanges(box)).toEqual([]);
  });

  it('updates through a symlink to the install folder', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    const link = join(box.installDir, '..', 'liedmotif-link');
    await symlink(box.installDir, link);

    const { code, output } = await box.run('--dir', link, '--version', '1.5.0');

    expect(code, output).toBe(0);
    expect((await box.env()).LIEDMOTIF_VERSION).toBe('1.5.0');
  });

  it('installs a second stack whose .env names its own Compose project', async () => {
    const box = await machine();
    await box.addContainer({ workingDir: await otherFolder(box) });
    await mkdir(box.installDir, { recursive: true });
    await writeFile(
      join(box.installDir, '.env'),
      'COMPOSE_PROJECT_NAME=liedmotif-prod\nAPP_DOMAIN=music.example.com\n',
    );

    const { code, output } = await box.run();

    expect(code, output).toBe(0);
  });

  it("refuses to take over a second stack's Compose project from another folder", async () => {
    const box = await machine();
    const other = await otherFolder(box);
    await box.addContainer({ project: 'liedmotif-prod', workingDir: other });
    await mkdir(box.installDir, { recursive: true });
    const env = 'COMPOSE_PROJECT_NAME=liedmotif-prod\nAPP_DOMAIN=music.example.com\n';
    await writeFile(join(box.installDir, '.env'), env);

    const { code, output } = await box.run();

    expect(code).not.toBe(0);
    expect(output).toContain(`--dir ${other}`);
    expect(await readdir(box.installDir)).toEqual(['.env']);
    expect(await box.envFile()).toBe(env);
    expect(await dockerChanges(box)).toEqual([]);
  });
});

describe('installer: from a checkout (LIEDMOTIF_SOURCE_DIR)', () => {
  async function put(dir: string, path: string, content = '') {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }

  // Copying the checkout into a directory inside it would copy every earlier
  // install along, one level deeper on each run.
  it('refuses an install directory inside the checkout', async () => {
    const box = await machine({ fromCheckout: true });

    const { code, output } = await box.run('--dir', join(box.checkout, 'install'));

    expect(code).toBe(2);
    expect(output).toContain('inside the checkout');
    expect(await exists(join(box.checkout, 'install'))).toBe(false);
  });

  it('copies the checkout without its git data, dependencies, build output, local data or secrets', async () => {
    const box = await machine({ fromCheckout: true });
    for (const path of [
      '.git/HEAD',
      'node_modules/zod/index.js',
      'apps/web/.next/cache/page.js',
      'packages/db/dist/index.js',
      'packages/db/tsconfig.tsbuildinfo',
      'data/audio/track.mp3',
      '.env.local',
      '.mcp.json',
      'packages/db/data/client.ts',
    ]) {
      await put(box.checkout, path, 'x\n');
    }
    await put(box.checkout, '.env', 'APP_SECRET=the-checkout-own-secret\n');

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    for (const path of ['docker-compose.yml', '.env.example', 'packages/db/data/client.ts']) {
      expect(await exists(join(box.installDir, path)), path).toBe(true);
    }
    for (const path of [
      '.git',
      'node_modules',
      'apps/web/.next',
      'packages/db/dist',
      'packages/db/tsconfig.tsbuildinfo',
      'data',
      '.env.local',
      '.mcp.json',
    ]) {
      expect(await exists(join(box.installDir, path)), path).toBe(false);
    }
    expect(await box.envFile()).not.toContain('the-checkout-own-secret');
    expect((await box.env()).APP_SECRET).toMatch(/^\S{32,}$/);
  });

  it.each([
    { version: 'local, the tag Compose builds by default', args: [], expected: 'local' },
    { version: 'the --version given', args: ['--version', 'v1.4.0'], expected: '1.4.0' },
  ])('runs $version and never asks GitHub', async ({ args, expected }) => {
    const box = await machine({ fromCheckout: true });

    const { code, output } = await box.run('--domain', 'music.example.com', ...args);

    expect(code, output).toBe(0);
    expect((await box.env()).LIEDMOTIF_VERSION).toBe(expected);
    expect((await box.calls()).filter((call) => call.includes('github.com'))).toEqual([]);
    expect(output).toContain(`Liedmotif ${expected} is running at https://music.example.com`);
  });

  it('leaves .env alone on a rerun, whatever .env the checkout holds', async () => {
    const box = await machine({ fromCheckout: true });
    await box.run('--domain', 'music.example.com');
    const before = await box.envFile();
    await put(box.checkout, '.env', 'APP_SECRET=the-checkout-own-secret\n');

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(await box.envFile()).toBe(before);
  });

  it('builds the app images while the old app plays, pulling only Postgres and Caddy', async () => {
    const box = await machine({ fromCheckout: true });
    await box.run('--domain', 'music.example.com');
    const installCalls = (await box.calls()).length;
    const firstInstall = await box.composeCalls();

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    const at = `(in ${box.installDir})`;
    expect(firstInstall).toEqual([
      `docker compose pull --ignore-buildable ${at}`,
      `docker compose build ${at}`,
      `docker compose up -d --no-build ${at}`,
    ]);
    expect(await box.composeCalls(installCalls)).toEqual([
      `docker compose pull --ignore-buildable ${at}`,
      `docker compose build ${at}`,
      `docker compose stop web caddy ${at}`,
      `docker compose stop worker ${at}`,
      `docker compose up --no-build --exit-code-from migrate migrate ${at}`,
      `docker compose up -d --no-build ${at}`,
    ]);
  });

  it('stops before stopping anything or moving .env when the build fails', async () => {
    const box = await machine({ fromCheckout: true });
    await box.run('--domain', 'music.example.com');
    const before = await box.envFile();
    const installCalls = (await box.calls()).length;
    await box.failDocker('compose build');

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', 'v1.5.0');

    expect(code).not.toBe(0);
    expect(output).toMatch(/Nothing was stopped or started/);
    expect(
      (await box.composeCalls(installCalls)).filter((call) => / (stop|up) /.test(call)),
    ).toEqual([]);
    expect((await box.imageVersions()).at(-1)).toBe('build 1.5.0');
    expect(await box.envFile()).toBe(before);
  });

  it('ends with the command that installs from the same checkout again', async () => {
    const box = await machine({ fromCheckout: true });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(output).toContain(
      `LIEDMOTIF_SOURCE_DIR=${box.checkout} bash ${box.checkout}/docker/install.sh` +
        ` --domain music.example.com --dir ${box.installDir}\n`,
    );
    expect(output).not.toContain('curl -fsSL');
  });

  it('uses a checkout that is the install directory as it is', async () => {
    const box = await machine({ fromCheckout: true });

    const { code, output } = await box.run('--domain', 'music.example.com', '--dir', box.checkout);

    expect(code, output).toBe(0);
    const env = parseEnv(await readFile(join(box.checkout, '.env'), 'utf8'));
    expect(env.APP_DOMAIN).toBe('music.example.com');
    expect(await exists(join(box.checkout, 'docker-compose.yml'))).toBe(true);
  });

  it('refuses a LIEDMOTIF_SOURCE_DIR that is not a Liedmotif checkout, before installing anything', async () => {
    const box = await machine({ installerEnv: { LIEDMOTIF_SOURCE_DIR: '/nowhere/liedmotif' } });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code).not.toBe(0);
    expect(output).toContain('/nowhere/liedmotif');
    expect(await box.calls()).toEqual([]);
  });
});
