// Boot-time posture checks for `DATABASE_URL`, run by both processes next to
// `assertNotTestDatabase`.
//
// The shipped deployment reaches Postgres over the Compose network, where TLS
// buys nothing and the default password is unreachable from outside the stack.
// A cloud move keeps the same connection string shape while the wire becomes
// public, so both trade-offs expire silently — which is exactly the class of
// misconfiguration a boot check exists for.

/** The password `docker-compose.yml` falls back to when `.env` sets none. */
const DEFAULT_POSTGRES_PASSWORD = 'liedmotif';

/** `sslmode` values that verify the server's certificate chain. */
const VERIFYING_SSL_MODES = new Set(['verify-ca', 'verify-full']);

/**
 * `require` encrypts but its verification behavior is driver-version-dependent:
 * `pg-connection-string` currently treats it as `verify-full` and has announced
 * a move to libpq semantics (encrypt, verify nothing) in its next major.
 */
const ENCRYPTED_UNVERIFIED_SSL_MODE = 'require';

const IPV4_LITERAL = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** `URL` serializes `::ffff:a.b.c.d` into this two-group hex form. */
const IPV4_MAPPED_IPV6 = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/;

/**
 * Names that resolve only inside a network the operator runs: Docker's
 * `host.docker.internal` and other `.internal` names, mDNS `.local` (which
 * covers Kubernetes `*.svc.cluster.local`), the router-default `.lan`, and the
 * RFC 8375 home zone `.home.arpa`.
 */
const PRIVATE_NAME_SUFFIXES = ['.internal', '.local', '.lan', '.home.arpa'];

/**
 * How far the connection travels, which is what decides how loud a missing TLS
 * mode should be: `same-host` is loopback or a Compose/Kubernetes service name
 * (bytes never leave the machine or the container network), `private-network` is
 * a LAN or VPC the operator runs, and `public` crosses the internet.
 *
 * Deliberately not the egress guard's `isPrivateHost`: that one answers "may
 * this be an SSRF target?" and is maximal and fail-closed by design, so tying a
 * boot check to it would let a tightening of SSRF policy silently start refusing
 * an operator's database.
 */
type DatabaseReach = 'same-host' | 'private-network' | 'public';

function databaseReach(hostname: string): DatabaseReach {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'same-host';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'same-host';
  // A Compose/Kubernetes service name, never routable off the cluster network.
  if (!host.includes('.') && !host.includes(':')) return 'same-host';
  if (host.includes(':')) {
    if (host === '::1') return 'same-host';
    const mapped = IPV4_MAPPED_IPV6.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16);
      return ipv4Reach([high >> 8, high & 0xff]);
    }
    // ULA (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return 'private-network';
    return 'public';
  }
  if (IPV4_LITERAL.test(host)) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    return ipv4Reach([a, b]);
  }
  if (PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'private-network';
  return 'public';
}

function ipv4Reach([a, b]: [number, number]): DatabaseReach {
  if (a === 127) return 'same-host';
  if (a === 10) return 'private-network';
  if (a === 192 && b === 168) return 'private-network';
  if (a === 172 && b >= 16 && b <= 31) return 'private-network';
  if (a === 100 && b >= 64 && b <= 127) return 'private-network'; // CGNAT (incl. Tailscale)
  return 'public';
}

/**
 * Assert the connection posture of `databaseUrl`, warning through `warn` for
 * the weak-but-deliberate cases and throwing for the ones no deployment wants.
 *
 * Fatal: a public host without a verifying `sslmode`. The check reads only
 * the explicit `sslmode` spelling, so a driver-specific form such as
 * `ssl=true` is refused too, whether or not the driver would have encrypted.
 * Warned: a LAN or VPC host without a verifying `sslmode`, `sslmode=require`
 * (encrypted, verification not guaranteed), and the Compose default password
 * (a sparse `.env` yields a known-password database). Blank and unparseable
 * values pass through — presence and shape are each validated by their own
 * caller.
 *
 * No message ever echoes the URL: it carries the password.
 */
export function assertDatabaseUrlPosture(
  databaseUrl: string,
  warn: (message: string) => void = console.warn,
): void {
  if (!databaseUrl) return;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return;
  }

  if (decodeURIComponent(url.password) === DEFAULT_POSTGRES_PASSWORD) {
    warn(
      'The database password is the shipped compose default. Set POSTGRES_PASSWORD ' +
        '(and the matching DOCKER_DATABASE_URL) to a generated value: any process ' +
        'that reaches the database network can log in with a password published in ' +
        'this repository.',
    );
  }

  const reach = databaseReach(url.hostname);
  if (reach === 'same-host') return;

  const sslMode = url.searchParams.get('sslmode')?.trim().toLowerCase() ?? '';
  if (VERIFYING_SSL_MODES.has(sslMode)) return;
  if (sslMode === ENCRYPTED_UNVERIFIED_SSL_MODE) {
    warn(
      'DATABASE_URL reaches a remote host with sslmode=require, which encrypts ' +
        'but does not guarantee certificate verification across driver versions. ' +
        'Use sslmode=verify-full where the provider supports it.',
    );
    return;
  }
  const variable = 'DATABASE_URL (DOCKER_DATABASE_URL in Docker)';
  const remedy =
    'Add sslmode=verify-full (or sslmode=verify-ca). If the address uses ssl=true, ' +
    'replace it with sslmode=verify-full.';
  // A private address is a network the operator runs, so an unverified
  // connection there is their call to make; a public one is not.
  if (reach === 'private-network') {
    warn(`${variable} reaches a LAN or VPC host without a verifying sslmode. ${remedy}`);
    return;
  }
  throw new Error(`${variable} points at a public host without a verifying sslmode. ${remedy}`);
}
