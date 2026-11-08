import { describe, expect, it } from 'vitest';
import {
  diagnosticStatus,
  instanceDiagnosticHealth,
  musicDiagnosticHealth,
  optionalProviderDiagnostic,
  presentationSource,
  storageUsagePercent,
  unavailableValue,
} from './storage-diagnostics-model';

describe('storage diagnostics presentation', () => {
  it('derives a bounded quota percentage from measured bytes', () => {
    expect(storageUsagePercent(512 * 1024 ** 2, 10 * 1024 ** 3)).toBe(5);
    expect(storageUsagePercent(12 * 1024 ** 3, 10 * 1024 ** 3)).toBe(100);
    expect(storageUsagePercent(0, 0)).toBe(0);
    expect(storageUsagePercent(100, 0)).toBe(100);
  });

  it('keeps health states visually and textually distinct', () => {
    expect(diagnosticStatus('healthy')).toEqual({ label: 'Healthy', tone: 'ok' });
    expect(diagnosticStatus('degraded')).toEqual({ label: 'Degraded', tone: 'warn' });
    expect(diagnosticStatus('misconfigured')).toEqual({
      label: 'Misconfigured',
      tone: 'warn',
    });
    expect(diagnosticStatus('unavailable')).toEqual({
      label: 'Unavailable',
      tone: 'muted',
    });
  });

  it('does not turn missing diagnostics into plausible fixture values', () => {
    expect(unavailableValue(null)).toBe('Unavailable');
    expect(unavailableValue('')).toBe('Unavailable');
    expect(unavailableValue('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('derives instance and required music health from source resolution', () => {
    expect(instanceDiagnosticHealth('failed')).toBe('unavailable');
    expect(instanceDiagnosticHealth('missing')).toBe('misconfigured');
    expect(instanceDiagnosticHealth('resolved')).toBe('healthy');
    expect(musicDiagnosticHealth({ runtimeResolved: false })).toBe('misconfigured');
    expect(
      musicDiagnosticHealth({ runtimeResolved: true, providerKey: 'mock', sourceResolved: false }),
    ).toBe('healthy');
    expect(
      musicDiagnosticHealth({
        runtimeResolved: true,
        providerKey: 'suno',
        sourceResolved: false,
      }),
    ).toBe('degraded');
    expect(
      musicDiagnosticHealth({
        runtimeResolved: true,
        providerKey: 'suno',
        sourceResolved: true,
        tone: 'warn',
      }),
    ).toBe('misconfigured');
  });

  it('distinguishes an absent optional provider from a failed provider read', () => {
    expect(optionalProviderDiagnostic({ sourceResolved: false, selected: false })).toEqual({
      health: 'unavailable',
      emptyLabel: 'Unavailable',
    });
    expect(optionalProviderDiagnostic({ sourceResolved: true, selected: false })).toEqual({
      health: 'unavailable',
      emptyLabel: 'Not configured',
    });
    expect(
      optionalProviderDiagnostic({ sourceResolved: true, selected: true, tone: 'warn' }),
    ).toEqual({ health: 'misconfigured', emptyLabel: 'Unavailable' });
  });

  it('maps resolved keyless-provider configuration sources to badges', () => {
    expect(presentationSource('Environment')).toBe('env');
    expect(presentationSource('Database')).toBe('database');
    expect(presentationSource(null)).toBeNull();
  });
});
