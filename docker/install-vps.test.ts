import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { machine, SERVER_IP, type Machine } from './install-test-machine';

// One installer run spawns a few hundred short-lived processes, and an update
// test runs it twice: on a busy machine that passes Vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000 });

describe('installer: DNS check with --domain', () => {
  it('stops before starting anything while the domain has no DNS record, naming the record to add', async () => {
    const box = await machine({ dnsA: [] });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code).not.toBe(0);
    expect(output).toMatch(
      /Error during "Checking that music\.example\.com points at this server"/,
    );
    expect(output).toContain(
      `add this DNS record at your domain provider: type A, name @ (or the subdomain), value ${SERVER_IP}.`,
    );
    expect(output).toMatch(/minutes to hours\. Run the same command again when done/);
    expect(await box.composeCalls()).toEqual([]);
    await expect(stat(join(box.installDir, '.env'))).rejects.toThrow();
  });

  it.each([
    { records: 'an A record for an old server', dnsA: ['198.51.100.7'], elsewhere: '198.51.100.7' },
    {
      records: 'a parking-page AAAA record next to the right A record, on a server without IPv6',
      dnsA: [SERVER_IP],
      dnsAAAA: ['2001:db8::dead'],
      elsewhere: '2001:db8::dead',
    },
  ])(
    'stops before starting anything on $records, naming both addresses',
    async ({ dnsA, dnsAAAA, elsewhere }) => {
      const box = await machine({ dnsA, dnsAAAA });

      const { code, output } = await box.run('--domain', 'music.example.com');

      expect(code).not.toBe(0);
      expect(output).toContain(
        `music.example.com points at ${elsewhere}, but this server's address is ${SERVER_IP}.`,
      );
      expect(output).toMatch(/delete every other A or AAAA record/);
      expect(await box.composeCalls()).toEqual([]);
    },
  );

  it('carries on when every record points at this server, IPv6 included', async () => {
    const box = await machine({ publicIp6: '2001:db8::10', dnsAAAA: ['2001:db8::10'] });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(output).toContain('==> Checking that music.example.com points at this server');
  });

  it('follows a CNAME to the addresses it names', async () => {
    const box = await machine({ dnsCname: 'lb.example.net.', dnsA: [SERVER_IP] });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(output).not.toContain('lb.example.net');
  });

  it("warns and carries on when the domain's records cannot be looked up", async () => {
    const box = await machine({ dnsLookupFails: true });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(output).toMatch(
      /Warning: could not look up the DNS records for music\.example\.com, so whether it points here goes unchecked/,
    );
  });

  it('skips the check with LIEDMOTIF_SKIP_DNS_CHECK=1, for a domain behind a proxy', async () => {
    const box = await machine({
      dnsA: ['104.16.0.1'],
      installerEnv: { LIEDMOTIF_SKIP_DNS_CHECK: '1' },
    });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(output).toMatch(/Skipping the DNS check/);
    expect((await box.calls()).filter((call) => /dns-query|icanhazip/.test(call))).toEqual([]);
  });

  it("warns and carries on when this server's public address cannot be looked up", async () => {
    const box = await machine({ publicIp4: null });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(output).toMatch(/Warning: could not look up this server's public IP address/);
  });

  it.each([
    { mode: '--domain localhost', args: ['--domain', 'localhost'] },
    { mode: 'Tailscale mode', args: [] },
  ])('skips the check in $mode', async ({ args }) => {
    const box = await machine({ dnsA: [] });

    const { code, output } = await box.run(...args);

    expect(code, output).toBe(0);
    expect((await box.calls()).filter((call) => /dns-query|icanhazip/.test(call))).toEqual([]);
  });

  it('leaves the DNS alone on an update', async () => {
    const box = await machine();
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    const installCalls = (await box.calls()).length;
    await box.setDnsA(['198.51.100.7']);

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code, output).toBe(0);
    expect(
      (await box.calls()).slice(installCalls).filter((call) => /dns-query|icanhazip/.test(call)),
    ).toEqual([]);
  });
});

describe('installer: automatic security updates', () => {
  const AUTO_UPGRADES =
    'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n';
  const autoUpgradesFile = (box: Machine) =>
    join(box.etcDir, 'apt', 'apt.conf.d', '20auto-upgrades');
  const aptInstalls = async (box: Machine, since = 0) =>
    (await box.calls()).slice(since).filter((call) => /^apt-get .*install/.test(call));

  it('turns on unattended-upgrades on Debian when nothing has set it, in one printed line', async () => {
    const box = await machine({ debian: true });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect(await box.calls()).toContainEqual(
      expect.stringMatching(
        /^sudo env DEBIAN_FRONTEND=noninteractive apt-get .*install unattended-upgrades$/,
      ),
    );
    expect(await readFile(autoUpgradesFile(box), 'utf8')).toBe(AUTO_UPGRADES);
    expect(output.split('\n').filter((line) => /unattended-upgrades/.test(line))).toHaveLength(1);
  });

  it.each([
    { system: 'Debian with automatic updates on', debian: true, setting: '"1"' },
    { system: 'Debian with automatic updates turned off', debian: true, setting: '"0"' },
    { system: 'a system without apt', debian: false, setting: undefined },
  ])('leaves $system alone', async ({ debian, setting }) => {
    const existing = setting && `APT::Periodic::Unattended-Upgrade ${setting};\n`;
    const box = await machine({ debian, autoUpgrades: existing });

    const { code, output } = await box.run('--domain', 'music.example.com');

    expect(code, output).toBe(0);
    expect((await box.calls()).filter((call) => call.includes('apt-get'))).toEqual([]);
    if (existing) expect(await readFile(autoUpgradesFile(box), 'utf8')).toBe(existing);
    else await expect(stat(autoUpgradesFile(box))).rejects.toThrow();
    expect(output).not.toMatch(/unattended-upgrades/);
  });

  it('turns it on once, never again on a rerun', async () => {
    const box = await machine({ debian: true });
    await box.run('--domain', 'music.example.com', '--version', '1.4.0');
    const installCalls = (await box.calls()).length;

    const { code, output } = await box.run('--domain', 'music.example.com', '--version', '1.5.0');

    expect(code, output).toBe(0);
    expect(await aptInstalls(box)).toHaveLength(1);
    expect(await aptInstalls(box, installCalls)).toEqual([]);
    expect(await readFile(autoUpgradesFile(box), 'utf8')).toBe(AUTO_UPGRADES);
    expect(output).not.toMatch(/unattended-upgrades/);
  });
});

describe('installer: SSH', () => {
  it.each([
    { mode: '--domain', args: ['--domain', 'music.example.com'] },
    { mode: 'Tailscale mode', args: [] },
  ])('never changes the SSH settings in $mode', async ({ args }) => {
    const box = await machine({ debian: true });
    const ssh = join(box.etcDir, 'ssh');
    await mkdir(join(ssh, 'sshd_config.d'), { recursive: true });
    await writeFile(join(ssh, 'sshd_config'), 'Include /etc/ssh/sshd_config.d/*.conf\n');
    await writeFile(
      join(ssh, 'sshd_config.d', '50-cloud-init.conf'),
      'PasswordAuthentication yes\n',
    );

    const { code, output } = await box.run(...args);

    expect(code, output).toBe(0);
    expect((await readdir(ssh, { recursive: true })).sort()).toEqual([
      'sshd_config',
      'sshd_config.d',
      join('sshd_config.d', '50-cloud-init.conf'),
    ]);
    expect(await readFile(join(ssh, 'sshd_config'), 'utf8')).toBe(
      'Include /etc/ssh/sshd_config.d/*.conf\n',
    );
    expect(await readFile(join(ssh, 'sshd_config.d', '50-cloud-init.conf'), 'utf8')).toBe(
      'PasswordAuthentication yes\n',
    );
    expect((await box.calls()).filter((call) => /\bsshd?\b|--ssh|\/ssh\//.test(call))).toEqual([]);
  });
});
