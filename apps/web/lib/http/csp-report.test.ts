import { describe, expect, it } from 'vitest';
import { readCspViolation } from './csp-report';

// The report sink is only useful if it reads what browsers actually post, and
// only safe if what it logs can never be replayed: invite and reset links carry
// their token in the PATH, which the logger's redaction does not reach.

const report = (fields: Record<string, unknown>) => ({ 'csp-report': fields });

describe('readCspViolation', () => {
  it('reads the fields a browser posts', () => {
    expect(
      readCspViolation(
        report({
          'document-uri': 'http://localhost:2206/player',
          'violated-directive': 'script-src',
          'effective-directive': 'script-src-elem',
          'blocked-uri': 'inline',
          'source-file': 'http://localhost:2206/player',
          'line-number': 42,
          disposition: 'enforce',
          'script-sample': 'const secret = ...',
        }),
      ),
    ).toEqual({
      directive: 'script-src-elem',
      blockedUri: 'inline',
      documentUri: 'http://localhost:2206/player',
      sourceFile: 'http://localhost:2206/player',
      line: 42,
      disposition: 'enforce',
    });
  });

  it('drops the token from an invite, reset, or confirm page URL', () => {
    const violation = readCspViolation(
      report({
        'document-uri': 'https://music.example/join/2f6c1b9e-secret-token',
        'violated-directive': 'style-src',
        'blocked-uri': 'https://music.example/reset/another-token?x=1',
        'source-file': 'https://music.example/confirm/third-token',
      }),
    );
    expect(violation?.documentUri).toBe('https://music.example/join/');
    expect(violation?.blockedUri).toBe('https://music.example/reset/');
    expect(violation?.sourceFile).toBe('https://music.example/confirm/');
  });

  it('refuses a body that is not a violation document', () => {
    expect(readCspViolation(null)).toBeNull();
    expect(readCspViolation({ 'csp-report': {} })).toBeNull();
    expect(readCspViolation({ hello: 'world' })).toBeNull();
  });
});
