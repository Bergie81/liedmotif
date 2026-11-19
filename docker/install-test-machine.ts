import { execFile, spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { onTestFinished } from 'vitest';

/**
 * `docker/install.sh`, the one-command installer, run under `bash` against stubs
 * of every system command it drives (`uname`, `getconf`, `free`, `findmnt`,
 * `id`, `sudo`, `curl`, `docker`, `tailscale`, `apt-get`, `sysctl`,
 * `systemctl`) and a temp install directory and `/etc`. The stubs log each call
 * so a test can assert what was installed, downloaded and started. The stubbed
 * `docker` keeps the machine's containers: `compose up` adds the stack's, labeled
 * with its Compose project and folder as Compose labels them, and `ps` lists
 * them. The stubbed `curl` also answers the public-IP lookup and the DNS-over-HTTPS lookup of
 * the domain's records, so the DNS check never goes to the network.
 *
 * The release tarball the stubbed `curl` serves carries the real `.env.example`,
 * so the generated `.env` is proven against the file that actually ships.
 */
const INSTALL_SCRIPT = fileURLToPath(new URL('./install.sh', import.meta.url));
export const ENV_EXAMPLE = fileURLToPath(new URL('../.env.example', import.meta.url));

const LATEST_TAG = 'v9.9.9';

const execFileAsync = promisify(execFile);

/** The machine's name and address on the stubbed tailnet. */
export const TS_NAME = 'liedmotif.tail1234.ts.net';
export const TS_IP = '100.101.102.103';
export const TS_OVERRIDE = 'docker-compose.yml:docker-compose.tailscale.yml';

/** This machine's public IPv4 address, as the stubbed lookup reports it. */
export const SERVER_IP = '203.0.113.10';

export const SECRET_KEYS = [
  'APP_SECRET',
  'BETTER_AUTH_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
  'POSTGRES_PASSWORD',
  'SETUP_TOKEN',
  'BACKUP_ENCRYPTION_PASSPHRASE',
] as const;

/** A container on the machine, as Compose labels it. */
export interface Container {
  /** Its `com.docker.compose.project` label. */
  project?: string;
  /** Its `com.docker.compose.project.working_dir` label: the folder it was started from; none when unset. */
  workingDir?: string;
  running?: boolean;
}

export interface MachineOptions {
  /** What `uname -m` reports. */
  arch?: string;
  /** What `getconf LONG_BIT` reports: the userland's word size. */
  longBit?: string;
  /** Total RAM in MiB, as `free -m` reports it. */
  memMiB?: number;
  /** The device `findmnt` names for every mount point asked about. */
  rootSource?: string;
  /** Whether a working `docker compose` exists before the installer runs. */
  docker?: boolean;
  /**
   * Whether this user reaches Docker without sudo. Docker's install script adds
   * nobody to the `docker` group.
   */
  dockerGroup?: boolean;
  /** Whether `https://<domain>/api/health` answers. */
  healthy?: boolean;
  /** How the health check fails when the app does not answer. */
  healthFailure?: 'connect' | 'certificate';
  /** `missing`: no Tailscale; `logged-out`: installed, never signed in. */
  tailscale?: 'missing' | 'logged-out' | 'logged-in';
  /** Whether the tailnet has HTTPS certificates turned on. */
  tailnetHttps?: boolean;
  /** Whether `tailscale set --auto-update` works here, as it does on a Debian-family system. */
  tailscaleAutoUpdate?: boolean;
  /** What `docker compose version --short` reports. */
  composeVersion?: string;
  /** The public IPv4 address the lookup reports; `null`: the lookup fails. */
  publicIp4?: string | null;
  /** The public IPv6 address the lookup reports; none by default. */
  publicIp6?: string;
  /** The domain's A records. */
  dnsA?: string[];
  /** The domain's AAAA records. */
  dnsAAAA?: string[];
  /** The name a CNAME record points the domain at, ahead of its A and AAAA records. */
  dnsCname?: string;
  /** Whether the DNS-over-HTTPS lookup of the domain's records fails. */
  dnsLookupFails?: boolean;
  /** Extra environment for every installer run. */
  installerEnv?: Record<string, string>;
  /** A Debian-family system: `/etc/debian_version` exists. */
  debian?: boolean;
  /** An `/etc/apt/apt.conf.d/20auto-upgrades` already in place. */
  autoUpgrades?: string;
  /** Install from `checkout` (`LIEDMOTIF_SOURCE_DIR`) instead of a release download. */
  fromCheckout?: boolean;
}

export interface Machine {
  installDir: string;
  /** A source checkout holding the same files as the release tarball. */
  checkout: string;
  /** Stands in for `/etc`. */
  etcDir: string;
  run: (...args: string[]) => Promise<{ code: number | null; output: string }>;
  calls: () => Promise<string[]>;
  /** The `docker compose` calls after the first `since` calls of any kind. */
  composeCalls: (since?: number) => Promise<string[]>;
  /**
   * The version each `docker compose pull` or `build` asked for, as `pull 1.5.0`,
   * picked the way Compose picks it: `LIEDMOTIF_VERSION` from the environment,
   * else from `.env`.
   */
  imageVersions: () => Promise<string[]>;
  setHealthy: (healthy: boolean) => Promise<void>;
  /** Makes every `docker` call whose arguments contain `args` fail. */
  failDocker: (args: string) => Promise<void>;
  healDocker: () => Promise<void>;
  /** Gives this machine another name and address on the tailnet. */
  moveOnTailnet: (name: string, ip: string) => Promise<void>;
  /** Makes `tailscale up` fail, as when the person stops the wait for sign-in. */
  failTailscaleUp: (fails: boolean) => Promise<void>;
  /** Points the domain's A records somewhere else. */
  setDnsA: (records: string[]) => Promise<void>;
  /** Puts a container on the machine, as another install would have. */
  addContainer: (container: Container) => Promise<void>;
  envFile: () => Promise<string>;
  env: () => Promise<Record<string, string>>;
}

export async function machine(options: MachineOptions = {}): Promise<Machine> {
  const {
    arch = 'aarch64',
    longBit = '64',
    memMiB = 7_820,
    rootSource = '/dev/nvme0n1p2',
    docker = true,
    dockerGroup = true,
    healthy = true,
    healthFailure = 'connect',
    tailscale = 'logged-in',
    tailnetHttps = true,
    tailscaleAutoUpdate = true,
    composeVersion = '2.29.1',
    publicIp4 = SERVER_IP,
    publicIp6,
    dnsA = [SERVER_IP],
    dnsAAAA = [],
    dnsCname = '',
    dnsLookupFails = false,
    installerEnv = {},
    debian = false,
    autoUpgrades,
    fromCheckout = false,
  } = options;

  const root = await mkdtemp(join(tmpdir(), 'liedmotif-install-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const release = join(root, 'release', 'liedmotif-9.9.9');
  const installDir = join(root, 'opt', 'liedmotif');
  const etcDir = join(root, 'etc');
  await mkdir(bin);
  await mkdir(release, { recursive: true });

  const callsFile = join(root, 'calls');
  const imageVersionsFile = join(root, 'image-versions');
  const dockerInstalled = join(root, 'docker-installed');
  const healthyFile = join(root, 'healthy');
  const dockerFails = join(root, 'docker-fails');
  const tailscaleInstalled = join(root, 'tailscale-installed');
  const tailscaleLoggedIn = join(root, 'tailscale-logged-in');
  const tailscaleUpFails = join(root, 'tailscale-up-fails');
  const tailscaleName = join(root, 'tailscale-name');
  const tailscaleIp = join(root, 'tailscale-ip');
  const tarball = join(root, 'release.tar.gz');
  const getDocker = join(root, 'get-docker.sh');
  const getTailscale = join(root, 'get-tailscale.sh');
  const publicIp4File = join(root, 'public-ip4');
  const publicIp6File = join(root, 'public-ip6');
  const dnsAFile = join(root, 'dns-a');
  const dnsAAAAFile = join(root, 'dns-aaaa');
  // One line per container: project, `running` or `exited`, then its folder, last
  // because it may be empty.
  const containersFile = join(root, 'containers');

  await copyFile(ENV_EXAMPLE, join(release, '.env.example'));
  await writeFile(join(release, 'docker-compose.yml'), 'name: liedmotif\n');
  await execFileAsync('tar', ['-czf', tarball, '-C', join(root, 'release'), 'liedmotif-9.9.9']);
  if (docker) await writeFile(dockerInstalled, '');
  if (healthy) await writeFile(healthyFile, '');
  if (tailscale !== 'missing') await writeFile(tailscaleInstalled, '');
  if (tailscale === 'logged-in') await writeFile(tailscaleLoggedIn, '');
  await writeFile(tailscaleName, TS_NAME);
  await writeFile(tailscaleIp, TS_IP);
  if (publicIp4 !== null) await writeFile(publicIp4File, publicIp4);
  if (publicIp6 !== undefined) await writeFile(publicIp6File, publicIp6);
  await writeFile(dnsAFile, lines(dnsA));
  await writeFile(dnsAAAAFile, lines(dnsAAAA));
  if (debian) {
    await mkdir(join(etcDir, 'apt', 'apt.conf.d'), { recursive: true });
    await writeFile(join(etcDir, 'debian_version'), '13.1\n');
  }
  if (autoUpgrades !== undefined) {
    await writeFile(join(etcDir, 'apt', 'apt.conf.d', '20auto-upgrades'), autoUpgrades);
  }

  await writeFile(
    getDocker,
    `#!/bin/sh
echo "get-docker.sh" >>'${callsFile}'
touch '${dockerInstalled}'
`,
  );
  await writeFile(
    getTailscale,
    `#!/bin/sh
echo "get-tailscale.sh" >>'${callsFile}'
touch '${tailscaleInstalled}'
`,
  );

  // Shaped like `tailscale status --json`: two-space indented, with a peer
  // whose name must not be mistaken for this machine's.
  const tailscaleStatus = `{
  "Version": "1.90.0-t0000000-g0000000",
  "TUN": true,
  "BackendState": "$state",
  "HaveNodeKey": true,
  "AuthURL": "",
  "TailscaleIPs": [
    "$ts_ip",
    "fd7a:115c:a1e0::1234:5678"
  ],
  "Self": {
    "ID": "nAbCdEf1CNTRL",
    "PublicKey": "nodekey:0000000000000000000000000000000000000000000000000000000000000001",
    "HostName": "liedmotif",
    "DNSName": "$dns_name",
    "OS": "linux",
    "TailscaleIPs": [
      "$ts_ip"
    ],
    "Online": true
  },
  "Health": [],
  "MagicDNSSuffix": "tail1234.ts.net",
  "CurrentTailnet": {
    "Name": "someone@example.com",
    "MagicDNSSuffix": "tail1234.ts.net",
    "MagicDNSEnabled": true
  },
  "CertDomains": $cert_domains,
  "Peer": {
    "nodekey:0000000000000000000000000000000000000000000000000000000000000002": {
      "ID": "nXyZ1CNTRL",
      "HostName": "phone",
      "DNSName": "phone.tail1234.ts.net.",
      "OS": "android"
    }
  }
}`;

  const stubs: Record<string, string> = {
    uname: `[ "$1" = -m ] && echo '${arch}' || echo Linux`,
    getconf: `echo '${longBit}'`,
    free: `echo '               total        used        free      shared  buff/cache   available'
echo 'Mem:     ${memMiB}         900        5000          20        1900        6800'
echo 'Swap:             0           0           0'`,
    findmnt: `echo '${rootSource}'`,
    // `id -u` / `id -g`: a normal user, as the installer is meant to run, even
    // when the tests run as root.
    id: `echo 1000`,
    // Like the real one, it resets the environment.
    sudo: `echo "sudo $*" >>'${callsFile}'
exec env -i PATH="$PATH" SUDO_USER=liedmotif "$@"`,
    // Like the real one, a missing Docker fails every call, and a user outside
    // the `docker` group gets only the client's own `compose version`.
    docker: `[ -f '${dockerInstalled}' ] || { echo 'docker: command not found' >&2; exit 127; }
${dockerGroup ? '' : `[ "$1 $2" = 'compose version' ] || [ -n "$SUDO_USER" ] || { echo 'permission denied while trying to connect to the docker API' >&2; exit 1; }`}
echo "docker $* (in $(pwd))" >>'${callsFile}'
case "$1 $2" in
  'compose pull' | 'compose build')
    echo "$2 \${LIEDMOTIF_VERSION:-$(sed -n 's/^LIEDMOTIF_VERSION=//p' .env 2>/dev/null | tail -n 1)}" >>'${imageVersionsFile}'
    ;;
esac
if [ -f '${dockerFails}' ] && printf '%s\\n' "$*" | grep -qF -f '${dockerFails}'; then
  echo "docker: simulated failure of: $*" >&2
  exit 1
fi
[ "$1 $2" = 'info --format' ] && echo /var/lib/docker
if [ "$1 $2" = 'compose up' ]; then
  project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env 2>/dev/null | tail -n 1)
  printf '%s\\trunning\\t%s\\n' "\${project:-liedmotif}" "$(pwd)" >>'${containersFile}'
fi
if [ "$1" = ps ]; then
  all=false project=''
  for arg; do
    case $arg in
      -a | --all) all=true ;;
      label=com.docker.compose.project=*) project=\${arg#label=com.docker.compose.project=} ;;
    esac
  done
  [ -f '${containersFile}' ] && while IFS="$(printf '\\t')" read -r p state dir; do
    [ "$p" = "$project" ] && { [ "$all" = true ] || [ "$state" = running ]; } && printf '0123456789ab %s\\n' "$dir"
  done <'${containersFile}'
fi
[ "$1 $2 $3" = 'compose version --short' ] && echo '${composeVersion}'
exit 0`,
    tailscale: `[ -f '${tailscaleInstalled}' ] || { echo 'tailscale: command not found' >&2; exit 127; }
echo "tailscale $*" >>'${callsFile}'
case $1 in
  version) echo 1.90.0 ;;
  ip) [ -f '${tailscaleLoggedIn}' ] && cat '${tailscaleIp}' ;;
  up)
    printf '\\nTo authenticate, visit:\\n\\n\\thttps://login.tailscale.com/a/1a2b3c4d5e\\n\\n' >&2
    [ -f '${tailscaleUpFails}' ] && { echo 'context canceled' >&2; exit 1; }
    touch '${tailscaleLoggedIn}'
    echo 'Success.' >&2
    ;;
  set)
    ${tailscaleAutoUpdate ? ':' : `echo 'Auto-updates are not supported on this platform.' >&2; exit 1`}
    ;;
  status)
    state=NeedsLogin dns_name='' cert_domains=null ts_ip=''
    if [ -f '${tailscaleLoggedIn}' ]; then
      name=$(cat '${tailscaleName}')
      state=Running dns_name="$name." ts_ip=$(cat '${tailscaleIp}')
      ${tailnetHttps ? `cert_domains="[\n    \\"$name\\"\n  ]"` : ':'}
    fi
    cat <<EOF
${tailscaleStatus}
EOF
    ;;
esac`,
    'apt-get': `echo "apt-get $*" >>'${callsFile}'`,
    sysctl: `echo "sysctl $*" >>'${callsFile}'`,
    systemctl: `echo "systemctl $*" >>'${callsFile}'`,
    curl: `echo "curl $*" >>'${callsFile}'
out=''
url=''
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift ;;
    -w | --max-time | --resolve) shift ;;
    http*) url=$1 ;;
  esac
  shift
done
case $url in
  https://github.com/bergie81/liedmotif/releases/latest)
    printf '%s' 'https://github.com/bergie81/liedmotif/releases/tag/${LATEST_TAG}' ;;
  https://github.com/bergie81/liedmotif/archive/refs/tags/*.tar.gz) cp '${tarball}' "$out" ;;
  https://get.docker.com) cp '${getDocker}' "$out" ;;
  https://tailscale.com/install.sh) cp '${getTailscale}' "$out" ;;
  https://ipv4.icanhazip.com)
    [ -f '${publicIp4File}' ] || { echo 'curl: (7) Failed to connect' >&2; exit 7; }
    cat '${publicIp4File}'; echo ;;
  https://ipv6.icanhazip.com)
    [ -f '${publicIp6File}' ] || { echo 'curl: (7) Failed to connect' >&2; exit 7; }
    cat '${publicIp6File}'; echo ;;
  # Shaped like Cloudflare's JSON answers: the question, then the CNAME and the
  # records it leads to, and no "Answer" at all for a name without records.
  https://cloudflare-dns.com/dns-query?*)
    ${dnsLookupFails ? `echo 'curl: (28) Connection timed out' >&2; exit 28` : ':'}
    name=\${url#*name=}
    name=\${name%%&*}
    case $url in
      *'type=AAAA') type=28 records='${dnsAAAAFile}' ;;
      *) type=1 records='${dnsAFile}' ;;
    esac
    answer='' owner=$name
    if [ -n '${dnsCname}' ]; then
      answer=$(printf '{"name":"%s","type":5,"TTL":300,"data":"%s"}' "$name" '${dnsCname}')
      owner='${dnsCname}'
    fi
    while read -r ip; do
      answer="$answer\${answer:+,}$(printf '{"name":"%s","type":%s,"TTL":300,"data":"%s"}' "$owner" "$type" "$ip")"
    done <"$records"
    printf '{"Status":0,"TC":false,"RD":true,"RA":true,"AD":false,"CD":false,"Question":[{"name":"%s","type":%s}]' "$name" "$type"
    [ -z "$answer" ] || printf ',"Answer":[%s]' "$answer"
    echo '}' ;;
  */api/health)
    [ -f '${healthyFile}' ] && exit 0
    ${
      healthFailure === 'certificate'
        ? `echo 'curl: (35) OpenSSL/3.0.15: error:0A000438:SSL routines::tlsv1 alert internal error' >&2; exit 35`
        : `echo 'curl: (7) Failed to connect' >&2; exit 7`
    }
    ;;
  *) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
esac`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  const env = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    TMPDIR: root,
    LIEDMOTIF_ETC: etcDir,
    LIEDMOTIF_HEALTH_TIMEOUT: '0',
    LIEDMOTIF_HEALTH_INTERVAL: '0',
    ...(fromCheckout ? { LIEDMOTIF_SOURCE_DIR: release } : {}),
    ...installerEnv,
  };

  const envFile = () => readFile(join(installDir, '.env'), 'utf8');
  const calls = async () =>
    (await readFile(callsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return {
    installDir,
    checkout: release,
    etcDir,
    run: (...args) => runInstaller(env, ['--dir', installDir, ...args]),
    calls,
    composeCalls: async (since = 0) =>
      (await calls()).slice(since).filter((call) => /^docker compose (?!version)/.test(call)),
    imageVersions: async () =>
      (await readFile(imageVersionsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    setHealthy: (value) => (value ? writeFile(healthyFile, '') : rm(healthyFile, { force: true })),
    failDocker: (args) => writeFile(dockerFails, `${args}\n`),
    healDocker: () => rm(dockerFails, { force: true }),
    moveOnTailnet: async (name, ip) => {
      await writeFile(tailscaleName, name);
      await writeFile(tailscaleIp, ip);
    },
    failTailscaleUp: (fails) =>
      fails ? writeFile(tailscaleUpFails, '') : rm(tailscaleUpFails, { force: true }),
    setDnsA: (records) => writeFile(dnsAFile, lines(records)),
    addContainer: ({ project = 'liedmotif', workingDir = '', running = true }) =>
      appendFile(containersFile, `${project}\t${running ? 'running' : 'exited'}\t${workingDir}\n`),
    envFile,
    env: async () => parseEnv(await envFile()),
  };
}

/** The active `KEY=value` lines; a key set twice is a test failure, not a merge. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key = '', value = ''] = match;
    if (key in values) throw new Error(`${key} is set twice in .env`);
    values[key] = value;
  }
  return values;
}

function lines(values: string[]): string {
  return values.map((value) => `${value}\n`).join('');
}

function runInstaller(
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [INSTALL_SCRIPT, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}
