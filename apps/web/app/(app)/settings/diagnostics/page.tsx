import { Database, Server } from 'lucide-react';
import type { CredentialSource } from '@liedmotif/db';
import { getInstanceSettings, getUsageLimits } from '@liedmotif/db';
import { DefinitionRows } from '@/components/settings/definition-rows';
import { SourceBadge } from '@/components/settings/source-badge';
import {
  RecentEventsSection,
  WorkerDiagnosticsProvider,
  WorkerStatusSection,
} from '@/components/settings/worker-diagnostics-section';
import {
  SettingsCard,
  SettingsPageHeader,
  SettingsSection,
  SettingsStatusBadge,
} from '@/components/settings/settings-ui';
import { APP_VERSION } from '@/lib/app-version';
import { getDb } from '@/lib/db';
import { loadProviderSettingsData } from '@/lib/provider-settings-data';
import { getMusicProvider, getStorageProvider } from '@/lib/providers';
import { requireAdmin } from '@/lib/session';
import {
  diagnosticStatus,
  type DiagnosticHealth,
  musicDiagnosticHealth,
  optionalProviderDiagnostic,
  presentationSource,
  unavailableValue,
} from '@/lib/storage-diagnostics-model';
import { getWorkerDiagnostics } from '@/lib/worker-diagnostics';

export const dynamic = 'force-dynamic';

function fulfilledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

export default async function DiagnosticsPage() {
  await requireAdmin();
  const [instanceResult, limitsResult, providerResult, musicResult, storageResult, workerResult] =
    await Promise.allSettled([
      Promise.resolve().then(() => getInstanceSettings(getDb())),
      // The reset zone belongs to the cost limits, not the instance record: it is what
      // the daily and monthly windows actually roll over on.
      Promise.resolve().then(() => getUsageLimits(getDb())),
      loadProviderSettingsData(),
      getMusicProvider().then((provider) => ({
        providerKey: provider.providerKey,
        tracksPerRequest: provider.getCapabilities().typicalTracksPerRequest,
      })),
      Promise.resolve().then(() => getStorageProvider().providerKey),
      getWorkerDiagnostics(getDb()),
    ]);
  const instance = fulfilledValue(instanceResult);
  const worker = fulfilledValue(workerResult);
  const limits = fulfilledValue(limitsResult);
  const providers = fulfilledValue(providerResult);
  const music = fulfilledValue(musicResult);
  const storageKey = fulfilledValue(storageResult);
  const sourceResolved = providerResult.status === 'fulfilled';
  const musicHealth = musicDiagnosticHealth({
    runtimeResolved: music !== null,
    providerKey: music?.providerKey,
    sourceResolved,
    tone: providers?.music.status.tone,
  });
  const llmDiagnostic = optionalProviderDiagnostic({
    sourceResolved,
    selected: Boolean(providers?.llm.credential),
    tone: providers?.llm.presentation.status.tone,
  });
  const coverDiagnostic = optionalProviderDiagnostic({
    sourceResolved,
    selected: Boolean(providers?.cover.name && providers.cover.name !== 'Not configured'),
    tone: providers?.cover.status.tone,
  });

  return (
    <section>
      <SettingsPageHeader
        title="Diagnostics"
        description="Check that providers, storage and the background worker are running properly."
        docs={{ path: 'alerts', label: 'Get an alert when something stops' }}
      />

      {/* Explicit column wrappers (not the masonry SettingsColumns) pin the
          desktop layout: Instance, Providers, and Worker stack on the left,
          Recent events fills the right. When the content area is too narrow
          for two columns, the wrappers become plain blocks in that same order. */}
      <WorkerDiagnosticsProvider initial={worker}>
        <div className="mt-6 @container">
          <div className="@split:flex @split:items-start @split:gap-x-12">
            <div className="min-w-0 @split:flex-1">
              <WorkerStatusSection />

              <SettingsSection title="Instance">
                <SettingsCard>
                  <div className="mb-2 flex items-center gap-3 text-muted">
                    <Server className="h-[19px] w-[19px]" aria-hidden />
                    <span className="text-[13px] font-semibold text-paper">Runtime</span>
                  </div>
                  <DefinitionRows
                    rows={[
                      {
                        label: 'Public URL',
                        value: unavailableValue(instance?.publicUrl),
                        tone: 'muted',
                      },
                      {
                        label: 'Instance timezone',
                        value: unavailableValue(limits?.resetTimezone),
                        tone: 'muted',
                      },
                      {
                        label: 'Setup completed',
                        value: instance?.setupCompletedAt?.slice(0, 10) || 'Unavailable',
                        tone: 'muted',
                      },
                      {
                        label: 'Encryption key',
                        value: encryptionKeyValue(providers?.encryptionKeyConfigured),
                        tone: providers?.encryptionKeyConfigured ? 'ok' : 'muted',
                      },
                      { label: 'App version', value: APP_VERSION, tone: 'muted' },
                    ]}
                  />
                </SettingsCard>
              </SettingsSection>

              <SettingsSection title="Providers and Storage">
                <SettingsCard>
                  <div className="mb-2 flex items-center gap-3 text-muted">
                    <Database className="h-[19px] w-[19px]" aria-hidden />
                    <span className="text-[13px] font-semibold text-paper">
                      Active configuration
                    </span>
                  </div>
                  <ProviderRow
                    label="Music"
                    value={
                      music
                        ? `${music.providerKey} · ${music.tracksPerRequest} tracks/request`
                        : null
                    }
                    source={
                      music?.providerKey === 'mock' ? null : providers?.music.credential.source
                    }
                    health={musicHealth}
                  />
                  <ProviderRow
                    label="Writing AI"
                    value={
                      providers?.llm.credential
                        ? `${providers.llm.providerKey} · ${providers.llm.effectiveModel || 'model not configured'}`
                        : null
                    }
                    source={presentationSource(providers?.llm.presentation.source)}
                    health={llmDiagnostic.health}
                    unavailableLabel={llmDiagnostic.emptyLabel}
                  />
                  <ProviderRow
                    label="Cover images"
                    value={
                      providers?.cover.name && providers.cover.name !== 'Not configured'
                        ? [providers.cover.name, providers.cover.model].filter(Boolean).join(' · ')
                        : null
                    }
                    source={presentationSource(providers?.cover.source)}
                    health={coverDiagnostic.health}
                    unavailableLabel={coverDiagnostic.emptyLabel}
                  />
                  <ProviderRow
                    label="Storage"
                    value={storageKey}
                    health={storageKey ? 'healthy' : 'misconfigured'}
                  />
                </SettingsCard>
              </SettingsSection>
            </div>

            <div className="min-w-0 @split:flex-1">
              <RecentEventsSection />
            </div>
          </div>
        </div>
      </WorkerDiagnosticsProvider>
    </section>
  );
}

/** `undefined` means the provider settings themselves could not be read. */
function encryptionKeyValue(configured: boolean | undefined): string {
  if (configured === undefined) return 'Unavailable';
  return configured ? 'Configured' : 'Not configured';
}

function ProviderRow({
  label,
  value,
  source = null,
  health,
  unavailableLabel = 'Unavailable',
}: {
  label: string;
  value: string | null;
  source?: CredentialSource | null;
  health: DiagnosticHealth;
  unavailableLabel?: string;
}) {
  return (
    // The badges ride the label line so the resolved value keeps the row's full
    // width — beside them, a provider · model line truncates to nothing.
    <div className="border-b border-line py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[13.5px] font-semibold">{label}</span>
        <span className="flex shrink-0 items-center gap-2">
          {source ? <SourceBadge source={source} /> : null}
          <SettingsStatusBadge status={diagnosticStatus(health)} />
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[10.5px] uppercase tracking-[0.05em] text-muted">
        {value ?? unavailableLabel}
      </div>
    </div>
  );
}
