// The release gate: no high or critical advisory in the production tree, as
// `npm audit --omit=dev --audit-level=high` reports it. An advisory can be
// accepted only when npm counts a package as production that no image ships
// and the advisory has no fixed release to move to. Each one names its reason,
// and the gate fails once the audit stops finding it, so the exception leaves
// with the problem.
import { execFileSync } from 'node:child_process';

const ACCEPTED = [
  {
    url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
    reason:
      'picomatch <= 4.0.7 (ReDoS), no fixed release yet. It reaches the production tree only ' +
      "through vitest, which better-auth lists as an optional peer; the images ship Next's " +
      'traced output, the bundled worker and sharp, none of which contain it.',
  },
];

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

/** The advisory URLs an audit entry rests on, following package-to-package links. */
function advisoriesOf(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const entry = vulnerabilities[name];
  if (!entry) return [];
  return entry.via.flatMap((via) =>
    typeof via === 'string' ? advisoriesOf(via, vulnerabilities, seen) : [via.url],
  );
}

export function auditVerdict(report, acceptedUrls) {
  const vulnerabilities = report.vulnerabilities ?? {};
  const found = new Set();
  const blocking = new Set();
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    for (const url of advisoriesOf(name, vulnerabilities)) found.add(url);
    if (!BLOCKING_SEVERITIES.has(entry.severity)) continue;
    for (const via of entry.via) {
      if (typeof via === 'string' || !BLOCKING_SEVERITIES.has(via.severity)) continue;
      if (!acceptedUrls.includes(via.url)) blocking.add(via.url);
    }
  }
  return {
    blocking: [...blocking].sort(),
    stale: acceptedUrls.filter((url) => !found.has(url)),
  };
}

function runAudit() {
  try {
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
  } catch (error) {
    // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.trim()) return error.stdout;
    throw error;
  }
}

if (import.meta.main) {
  const report = JSON.parse(runAudit());
  if (report.error) {
    console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
    process.exit(1);
  }
  const { blocking, stale } = auditVerdict(
    report,
    ACCEPTED.map((accepted) => accepted.url),
  );
  for (const accepted of ACCEPTED) {
    if (!stale.includes(accepted.url)) console.log(`accepted ${accepted.url}: ${accepted.reason}`);
  }
  for (const url of stale) {
    console.error(`${url} is accepted in scripts/audit-prod.mjs but no longer found; remove it.`);
  }
  for (const url of blocking) console.error(`high or critical advisory in production: ${url}`);
  if (blocking.length > 0) {
    console.error('Run `npm audit --omit=dev` for the full report.');
  }
  process.exit(blocking.length > 0 || stale.length > 0 ? 1 : 0);
}
