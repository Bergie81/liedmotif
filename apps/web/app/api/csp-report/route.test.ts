import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The enforcing policy is only as good as its report path: a violation has to
// reach the log, a foreign page must not be able to write into it, and one
// broken page must not be able to flood it.

vi.stubEnv('LOG_LEVEL', 'info');
const { POST } = await import('./route');

const VIOLATION = {
  'csp-report': {
    'document-uri': 'http://localhost:2206/player',
    'violated-directive': 'script-src',
    'blocked-uri': 'inline',
  },
};

function reportRequest(opts: { origin?: string; ip?: string } = {}): Request {
  return new Request('http://localhost/api/csp-report', {
    method: 'POST',
    headers: {
      'content-type': 'application/csp-report',
      ...(opts.origin ? { origin: opts.origin } : {}),
      'x-forwarded-for': opts.ip ?? '203.0.113.1',
    },
    body: JSON.stringify(VIOLATION),
  });
}

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/csp-report', () => {
  it('logs a posted violation and answers empty', async () => {
    const response = await POST(reportRequest({ ip: '203.0.113.10' }));

    expect(response.status).toBe(204);
    expect(lines.join('')).toContain('csp violation reported');
    expect(lines.join('')).toContain('script-src');
  });

  it('refuses a report claiming another origin, without logging it', async () => {
    const response = await POST(
      reportRequest({ origin: 'https://attacker.example', ip: '203.0.113.11' }),
    );

    expect(response.status).toBe(403);
    expect(lines).toEqual([]);
  });

  it('stops logging once one caller exhausts its budget', async () => {
    let last = await POST(reportRequest({ ip: '203.0.113.12' }));
    for (let attempt = 0; attempt < 40 && last.status === 204; attempt += 1) {
      last = await POST(reportRequest({ ip: '203.0.113.12' }));
    }

    expect(last.status).toBe(429);
    expect(last.headers.get('Retry-After')).toBeTruthy();
  });
});
