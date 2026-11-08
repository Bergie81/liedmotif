// Boot posture for `DATABASE_URL`: the two ways a cloud move
// silently ships a weak database connection — an external host reached without
// TLS, and the compose default password left in place by a sparse `.env`.

import { describe, expect, it, vi } from 'vitest';
import { assertDatabaseUrlPosture } from './database-posture';

const EXTERNAL = 'postgres://app:s3cret@db.example.com:5432/liedmotif';

describe('assertDatabaseUrlPosture', () => {
  it('is silent on the shipped deployments (compose service name, loopback)', () => {
    const warn = vi.fn();
    for (const url of [
      'postgres://liedmotif:strong@postgres:5432/liedmotif',
      'postgres://liedmotif:strong@localhost:5433/liedmotif_dev',
      'postgres://liedmotif:strong@127.0.0.1:5432/liedmotif',
      '',
    ]) {
      assertDatabaseUrlPosture(url, warn);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns rather than refuses for a LAN or VPC host, whose network the operator runs', () => {
    for (const host of ['192.168.1.20', '10.2.0.4', '172.20.1.5', '[fd00::1]']) {
      const warn = vi.fn();
      assertDatabaseUrlPosture(`postgres://liedmotif:strong@${host}:5432/liedmotif`, warn);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sslmode=verify-full'));
    }
  });

  it('warns rather than refuses for a well-known private name or an IPv4-mapped private address', () => {
    for (const host of [
      'host.docker.internal',
      'db.corp.internal',
      'nas.local',
      'NAS.LAN',
      'db.home.arpa',
      'postgres.default.svc.cluster.local',
      '[::ffff:192.168.1.20]',
      '[::ffff:10.0.0.4]',
    ]) {
      const warn = vi.fn();
      expect(() =>
        assertDatabaseUrlPosture(`postgres://liedmotif:strong@${host}:5432/liedmotif`, warn),
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sslmode=verify-full'));
    }
  });

  it('refuses an IPv4-mapped public address or a lookalike public name with no TLS mode', () => {
    for (const host of ['[::ffff:8.8.8.8]', 'db.lan.example.com', 'internal.example.com']) {
      expect(() =>
        assertDatabaseUrlPosture(`postgres://liedmotif:strong@${host}:5432/liedmotif`, vi.fn()),
      ).toThrow(/sslmode/);
    }
  });

  it('refuses a public database host with no TLS mode', () => {
    // Without `sslmode` pg leaves `ssl` undefined and connects in the clear —
    // credentials and every row cross the public internet unencrypted.
    expect(() => assertDatabaseUrlPosture(EXTERNAL, vi.fn())).toThrow(/sslmode/);
  });

  it('refuses external TLS modes that do not verify', () => {
    for (const mode of ['disable', 'allow', 'prefer', 'no-verify']) {
      expect(() => assertDatabaseUrlPosture(`${EXTERNAL}?sslmode=${mode}`, vi.fn())).toThrow(
        /sslmode/,
      );
    }
  });

  it('accepts verifying modes without a word', () => {
    const warn = vi.fn();
    for (const mode of ['verify-ca', 'verify-full', 'VERIFY-FULL']) {
      assertDatabaseUrlPosture(`${EXTERNAL}?sslmode=${mode}`, warn);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns on sslmode=require, whose verification is driver-version-dependent', () => {
    const warn = vi.fn();
    assertDatabaseUrlPosture(`${EXTERNAL}?sslmode=require`, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('verify-full'));
  });

  it('warns when the compose default password is still in use', () => {
    const warn = vi.fn();
    assertDatabaseUrlPosture('postgres://liedmotif:liedmotif@postgres:5432/liedmotif', warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('POSTGRES_PASSWORD'));
  });

  it('never echoes the password', () => {
    const warn = vi.fn();
    assertDatabaseUrlPosture(`${EXTERNAL}?sslmode=require`, warn);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('s3cret');
  });

  it('ignores an unparseable value (presence and shape are validated elsewhere)', () => {
    const warn = vi.fn();
    expect(() => assertDatabaseUrlPosture('not a url', warn)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
