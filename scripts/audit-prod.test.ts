import { describe, expect, it } from 'vitest';
import { auditVerdict } from './audit-prod.mjs';

const PICOMATCH = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const OTHER = 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz';

function advisory(url: string, severity: string) {
  return { source: 1, name: 'pkg', title: 'advisory', url, severity, range: '*' };
}

function report(vulnerabilities: Record<string, { severity: string; via: unknown[] }>) {
  return { vulnerabilities };
}

describe('the production audit gate', () => {
  it('passes when every high advisory is an accepted one, also through packages that depend on it', () => {
    const verdict = auditVerdict(
      report({
        picomatch: { severity: 'high', via: [advisory(PICOMATCH, 'high')] },
        vitest: { severity: 'high', via: ['picomatch', 'tinyglobby'] },
        tinyglobby: { severity: 'high', via: ['picomatch'] },
      }),
      [PICOMATCH],
    );

    expect(verdict).toEqual({ blocking: [], stale: [] });
  });

  it('blocks a high or critical advisory that is not accepted', () => {
    const verdict = auditVerdict(
      report({
        picomatch: { severity: 'high', via: [advisory(PICOMATCH, 'high')] },
        tar: { severity: 'critical', via: [advisory(OTHER, 'critical')] },
      }),
      [PICOMATCH],
    );

    expect(verdict.blocking).toEqual([OTHER]);
  });

  it('ignores advisories below high, as --audit-level=high does', () => {
    const verdict = auditVerdict(
      report({
        picomatch: { severity: 'high', via: [advisory(PICOMATCH, 'high')] },
        next: { severity: 'moderate', via: [advisory(OTHER, 'moderate')] },
      }),
      [PICOMATCH],
    );

    expect(verdict.blocking).toEqual([]);
  });

  it('reports an accepted advisory the audit no longer finds, so the exception is removed once fixed', () => {
    const verdict = auditVerdict(report({}), [PICOMATCH]);

    expect(verdict.stale).toEqual([PICOMATCH]);
  });
});
