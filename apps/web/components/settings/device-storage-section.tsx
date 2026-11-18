'use client';

// Settings → Storage, "On this device": the offline music this browser keeps
// against its cap, each Available-offline collection with its size and sync
// state, and the ways to free space. It manages this browser's storage, not
// the server's, so every User sees it and it works offline. Over plain HTTP it
// says why offline is missing instead; where offline is not offered at all
// (a browser without IndexedDB) it renders nothing.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { compactDangerButtonClass } from '@/components/ui/design-system';
import { Stepper } from '@/components/ui/controls';
import { offlineCollectionNoun } from '@/components/offline/offline-library-model';
import { statusLine } from '@/components/offline/offline-menu-row';
import { formatBinaryBytes } from '@/lib/format-bytes';
import {
  deviceOffline,
  offlineStatusSnapshot,
  subscribeOfflineStatus,
} from '@/lib/offline/device-offline';
import { offlineSupported } from '@/lib/offline/offline-support';
import type { OfflineSync } from '@/lib/offline/offline-sync';
import { toast } from '@/lib/toast';
import {
  deviceStorage,
  needsHomeScreenHint,
  nextCapStep,
  offlineAvailability,
  type DeviceStorageItem,
  type OfflineAvailability,
} from './device-storage-model';
import {
  SettingsCard,
  SettingsControlRow,
  SettingsFeedback,
  SettingsFootnote,
  SettingsSection,
  SettingsUsageMeter,
} from './settings-ui';

const CHANGE_KEY = 'device-storage-change';

function standalone(): boolean {
  return (
    (navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

/** `publicUrl`: the instance's `APP_PUBLIC_URL`, offered when this page was opened over plain HTTP. */
export function DeviceStorageSection({ publicUrl }: { publicUrl: string }) {
  const [availability, setAvailability] = useState<OfflineAvailability | null>(null);
  const [homeScreenHint, setHomeScreenHint] = useState(false);

  useEffect(() => {
    setAvailability(
      offlineAvailability(
        { secureContext: window.isSecureContext, supported: offlineSupported() },
        publicUrl,
      ),
    );
    setHomeScreenHint(
      needsHomeScreenHint({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        standalone: standalone(),
      }),
    );
  }, [publicUrl]);

  if (!availability || availability.kind === 'unavailable') return null;

  return (
    <SettingsSection title="On this device">
      {availability.kind === 'needs-https' ? (
        <SettingsCard>
          <p className="text-[14px] font-semibold text-paper">Offline music needs HTTPS.</p>
          <p className="mt-[2px] text-[12.5px] text-dim">
            This page was opened over plain HTTP, so music can&apos;t be kept on this device.
          </p>
          {availability.secureAddress ? (
            <a
              href={availability.secureAddress}
              className="mt-3 inline-block font-mono text-[11px] uppercase tracking-[0.05em] text-lamp hover:text-paper"
            >
              Open the secure address
            </a>
          ) : null}
        </SettingsCard>
      ) : (
        <>
          <DeviceOfflineCard />
          {homeScreenHint ? (
            <div className="mt-3">
              <SettingsFeedback kind="info">
                Add Liedmotif to your Home Screen, or iOS may clear offline music after a few days.
              </SettingsFeedback>
            </div>
          ) : null}
          <SettingsFootnote>
            Kept in this browser for your account only; signing out removes it. Nothing is removed
            to make room.
          </SettingsFootnote>
        </>
      )}
    </SettingsSection>
  );
}

interface DeviceView {
  capBytes: number;
  usedBytes: number;
  items: DeviceStorageItem[];
}

function DeviceOfflineCard() {
  // Undefined while the store opens; null when this browser cannot open it.
  const [offline, setOffline] = useState<OfflineSync | null | undefined>(undefined);
  const [view, setView] = useState<DeviceView | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const statuses = useSyncExternalStore(
    subscribeOfflineStatus,
    offlineStatusSnapshot,
    offlineStatusSnapshot,
  );

  useEffect(() => {
    void deviceOffline().then(setOffline);
  }, []);

  // Every status change (a Track landing, a mark added or dropped) re-reads the store.
  useEffect(() => {
    if (!offline) return;
    let current = true;
    void offline.contents().then(({ marks, copies, capBytes }) => {
      if (current) setView({ capBytes, ...deviceStorage(marks, copies) });
    });
    return () => {
      current = false;
    };
  }, [offline, statuses, revision]);

  if (offline === null) {
    return (
      <SettingsCard>
        <p className="text-[13px] text-muted">This browser can&apos;t keep music offline.</p>
      </SettingsCard>
    );
  }
  if (!offline || !view) {
    return (
      <SettingsCard>
        <p className="text-[13px] text-muted">Reading this device…</p>
      </SettingsCard>
    );
  }

  /** `change` resolves to why it was refused, or null once it is made. */
  async function act(change: (offline: OfflineSync) => Promise<string | null>) {
    if (!offline) return;
    setBusy(true);
    toast.dismiss(CHANGE_KEY);
    try {
      const refusal = await change(offline);
      if (refusal) toast.error(refusal, { key: CHANGE_KEY });
    } catch {
      toast.error('This device’s offline storage could not be changed. Try again.', {
        key: CHANGE_KEY,
      });
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  }

  function stepCap(direction: 'up' | 'down') {
    const next = view && nextCapStep(view.capBytes, direction);
    if (!next) return;
    void act(async (offline) => {
      const result = await offline.setCap(next);
      return result.set
        ? null
        : `${formatBinaryBytes(result.usedBytes)} is stored on this device, more than ${formatBinaryBytes(next)}. Remove at least ${formatBinaryBytes(result.usedBytes - next)} of offline music below first.`;
    });
  }

  function clearAll() {
    if (!window.confirm('Remove all offline music from this device?')) return;
    void act(async (offline) => {
      await offline.clear();
      return null;
    });
  }

  const down = nextCapStep(view.capBytes, 'down');
  const up = nextCapStep(view.capBytes, 'up');

  return (
    <SettingsCard>
      <SettingsUsageMeter
        label="Offline music"
        used={view.usedBytes}
        limit={view.capBytes}
        suffix=""
        readout={
          <>
            <b className="font-bold text-paper">{formatBinaryBytes(view.usedBytes)}</b> of{' '}
            {formatBinaryBytes(view.capBytes)}
          </>
        }
      />
      <SettingsControlRow label="Cap" description="The most offline music this device keeps">
        <Stepper
          value={formatBinaryBytes(view.capBytes)}
          onDecrement={() => stepCap('down')}
          onIncrement={() => stepCap('up')}
          canDecrement={!busy && down !== null}
          canIncrement={!busy && up !== null}
          decrementLabel="Lower the cap"
          incrementLabel="Raise the cap"
        />
      </SettingsControlRow>

      <div>
        {view.items.length === 0 ? (
          <p className="py-3 text-[13px] text-muted">Nothing is kept offline on this device.</p>
        ) : (
          view.items.map((item) => {
            const status = statuses.get(item.key);
            return (
              <div
                key={item.key}
                data-testid="device-storage-item"
                className="flex items-center gap-3 border-b border-line py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14.5px] font-semibold">{item.name}</div>
                  <div className="mt-[2px] text-[12.5px] text-dim">
                    {offlineCollectionNoun(item)} · {formatBinaryBytes(item.bytes)}
                    {status ? ` · ${statusLine(status)}` : null}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${item.name} from this device`}
                  className="font-mono text-[11px] uppercase tracking-[0.05em] text-muted hover:text-warn disabled:opacity-45"
                  onClick={() =>
                    void act((offline) => offline.unmark(item.kind, item.id).then(() => null))
                  }
                >
                  Remove
                </button>
              </div>
            );
          })
        )}
      </div>
      {view.usedBytes > 0 || view.items.length > 0 ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={busy}
            className={compactDangerButtonClass}
            onClick={clearAll}
          >
            Clear all
          </button>
        </div>
      ) : null}
    </SettingsCard>
  );
}
