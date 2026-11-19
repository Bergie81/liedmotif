import type { SettingsStatus } from '../settings/settings-hub-model';
import type { CredentialSource } from '@liedmotif/db';

export type DiagnosticHealth = 'healthy' | 'degraded' | 'misconfigured' | 'unavailable';

const DIAGNOSTIC_STATUSES: Record<DiagnosticHealth, SettingsStatus> = {
  healthy: { label: 'Healthy', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'warn' },
  misconfigured: { label: 'Misconfigured', tone: 'warn' },
  unavailable: { label: 'Unavailable', tone: 'muted' },
};

export function diagnosticStatus(health: DiagnosticHealth): SettingsStatus {
  return DIAGNOSTIC_STATUSES[health];
}

export function storageUsagePercent(usedBytes: number, quotaBytes: number): number {
  if (quotaBytes <= 0) return usedBytes > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, (usedBytes / quotaBytes) * 100));
}

export function unavailableValue(value: string | null | undefined): string {
  return value?.trim() || 'Unavailable';
}

export function instanceDiagnosticHealth(
  state: 'failed' | 'missing' | 'resolved',
): DiagnosticHealth {
  if (state === 'failed') return 'unavailable';
  return state === 'missing' ? 'misconfigured' : 'healthy';
}

export function providerToneHealth(
  tone: SettingsStatus['tone'] | undefined,
  required: boolean,
): DiagnosticHealth {
  if (tone === 'ok') return 'healthy';
  if (tone === 'warn') return 'misconfigured';
  return required ? 'misconfigured' : 'unavailable';
}

export function musicDiagnosticHealth(input: {
  runtimeResolved: boolean;
  providerKey?: string;
  sourceResolved?: boolean;
  tone?: SettingsStatus['tone'];
}): DiagnosticHealth {
  if (!input.runtimeResolved) return 'misconfigured';
  if (input.providerKey === 'mock') return 'healthy';
  if (!input.sourceResolved) return 'degraded';
  return providerToneHealth(input.tone, true);
}

export function optionalProviderDiagnostic(input: {
  sourceResolved: boolean;
  selected: boolean;
  tone?: SettingsStatus['tone'];
}): { health: DiagnosticHealth; emptyLabel: string } {
  if (!input.sourceResolved) return { health: 'unavailable', emptyLabel: 'Unavailable' };
  if (!input.selected) return { health: 'unavailable', emptyLabel: 'Not configured' };
  return {
    health: providerToneHealth(input.tone, false),
    emptyLabel: 'Unavailable',
  };
}

export function presentationSource(
  source: 'Environment' | 'Database' | null | undefined,
): CredentialSource | null {
  if (source === 'Environment') return 'env';
  if (source === 'Database') return 'database';
  return null;
}
