import Link from 'next/link';
import { Clock3, HardDrive } from 'lucide-react';
import { getStorageUsage, getUsageLimits, REJECT_GRACE_MS } from '@liedmotif/db';
import type { StorageProviderKey } from '@liedmotif/storage';
import { DeviceStorageSection } from '@/components/settings/device-storage-section';
import {
  SettingsCard,
  SettingsColumns,
  SettingsFootnote,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/settings/settings-ui';
import { OnlineOnly } from '@/components/ui/online-only';
import { getDb } from '@/lib/db';
import { getPublicUrl } from '@/lib/env';
import { formatBinaryBytes } from '@/lib/format-bytes';
import { getStorageProvider } from '@/lib/providers';
import { requireAppAccess } from '@/lib/session';
import { storageUsagePercent } from '@/lib/storage-diagnostics-model';

export const dynamic = 'force-dynamic';

const cleanupIconClass = 'h-[19px] w-[19px] flex-none text-muted';

// Every User manages this device's offline music here; only the Admin also sees
// the instance's volume and cleanup, and only an Admin's request reads them.
// The Settings frame leaves this page's online-only region to it, and the
// region holds everything but the device section, which manages this
// browser's storage and so keeps working offline.
export default async function StoragePage() {
  const { role } = await requireAppAccess();
  const deviceSection = <DeviceStorageSection publicUrl={getPublicUrl()} />;
  if (role !== 'admin') {
    return (
      <section>
        <SettingsPageHeader title="Storage" description="The offline music kept on this device." />
        <SettingsColumns>{deviceSection}</SettingsColumns>
      </section>
    );
  }

  const db = getDb();
  const [limitsResult, usageResult] = await Promise.allSettled([
    getUsageLimits(db),
    getStorageUsage(db),
  ]);
  const limits = limitsResult.status === 'fulfilled' ? limitsResult.value : null;
  // The periodically measured total the quota is enforced against; null until
  // the worker has measured once.
  const usage = usageResult.status === 'fulfilled' ? usageResult.value : null;
  const dataDir = process.env.DATA_DIR?.trim() || '/data';
  const storageBackend = readStorageBackend();
  const quotaBytes = limits?.storageQuotaBytes ?? null;
  const usedPercent =
    usage && quotaBytes !== null ? storageUsagePercent(usage.totalBytes, quotaBytes) : null;
  const rejectHours = REJECT_GRACE_MS / (60 * 60 * 1000);

  return (
    <section>
      <SettingsPageHeader
        title="Storage"
        description="Where your audio and covers are kept, what cleanup deletes, and the offline music on this device."
      />

      <SettingsColumns>
        <OnlineOnly>
          <SettingsSection title="Volume">
            <SettingsCard>
              <div className="mb-2 flex items-baseline justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.05em] text-muted">
                <span>{storageBackend === 's3' ? 'S3 bucket' : dataDir}</span>
                <span className="text-right">
                  {usage && quotaBytes !== null ? (
                    <>
                      <b className="font-bold text-paper">{formatBinaryBytes(usage.totalBytes)}</b>{' '}
                      stored of {formatBinaryBytes(quotaBytes)} quota
                    </>
                  ) : (
                    'Usage unavailable'
                  )}
                </span>
              </div>
              <div
                role="meter"
                aria-label="Measured stored bytes against configured quota"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={usedPercent ?? undefined}
                className="h-[10px] overflow-hidden rounded-[5px] bg-[var(--meter-track)]"
              >
                {usedPercent !== null ? (
                  <div
                    className="h-full bg-dim transition-[width]"
                    style={{ width: `${usedPercent}%` }}
                  />
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-4">
                {/* The key names what the bar above it fills with, so it follows
                  the meter's series. */}
                <VolumeKey
                  label="Stored"
                  value={usage ? formatBinaryBytes(usage.totalBytes) : 'Unavailable'}
                />
              </div>
              <div className="mt-4 flex items-center gap-3 border-t border-line py-3">
                <HardDrive className={cleanupIconClass} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="text-[14.5px] font-semibold">Quota</div>
                  <div className="mt-[2px] text-[12.5px] text-dim">
                    Uploads and new generation are refused at this ceiling. Nothing is ever deleted
                    to make room.
                  </div>
                </div>
                <Link
                  href="/settings/generation"
                  className="font-mono text-[11px] uppercase tracking-[0.05em] text-lamp hover:text-paper"
                >
                  {quotaBytes !== null ? formatBinaryBytes(quotaBytes) : 'Unavailable'}
                </Link>
              </div>
            </SettingsCard>
            <SettingsFootnote>
              Stored bytes — track audio, covers, reference photos, and voice recordings — are
              measured hourly, so this total trails recent changes.
            </SettingsFootnote>
          </SettingsSection>

          <SettingsSection title="Cleanup">
            <SettingsCard>
              <CleanupRow
                icon={<Clock3 className={cleanupIconClass} aria-hidden />}
                label="Ephemeral audio"
                description="Unsaved audio is deleted along with its Session."
                value="Every minute"
              />
              <CleanupRow
                icon={<Clock3 className={cleanupIconClass} aria-hidden />}
                label="Rejected tracks"
                description="Disliked tracks are hidden immediately and deleted after their grace window."
                value={`After ${rejectHours} h`}
              />
            </SettingsCard>
            <SettingsFootnote>
              Saved and Favorited Tracks are never touched by cleanup.
            </SettingsFootnote>
          </SettingsSection>
        </OnlineOnly>

        {deviceSection}
      </SettingsColumns>
    </section>
  );
}

function readStorageBackend(): StorageProviderKey | null {
  try {
    return getStorageProvider().providerKey;
  } catch {
    return null;
  }
}

function VolumeKey({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-dim">
      <i className="h-2 w-2 flex-none rounded-[2px] bg-dim" aria-hidden />
      {label} · {value}
    </span>
  );
}

function CleanupRow({
  icon,
  label,
  description,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-[14.5px] font-semibold">{label}</div>
        <div className="mt-[2px] text-[12.5px] text-dim">{description}</div>
      </div>
      <span className="whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
        {value}
      </span>
    </div>
  );
}
