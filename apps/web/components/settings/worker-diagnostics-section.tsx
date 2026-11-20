'use client';

// The live region of `/settings/diagnostics`: server-rendered initial data,
// re-polled through the existing `getDiagnostics` endpoint while the tab is
// visible. Split into a provider plus two section components so the page can
// place the Worker card and the Recent events card in different layout columns
// while both read the same polled state. Relative times tick with the poll —
// no per-second timer.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Activity } from 'lucide-react';
import type { WorkerDiagnostics } from '@liedmotif/shared';
import { DefinitionRows } from '@/components/settings/definition-rows';
import {
  SettingsCard,
  SettingsSection,
  SettingsStatusBadge,
} from '@/components/settings/settings-ui';
import { getDiagnostics } from '@/lib/http/api-client';
import { diagnosticStatus } from '@/lib/admin/storage-diagnostics-model';
import { workerEventRows, workerHealth, workerRows } from '@/lib/admin/worker-diagnostics-model';

const POLL_INTERVAL_MS = 15_000;

interface WorkerDiagnosticsState {
  /** Null when the server-side read failed; a later poll can still recover. */
  worker: WorkerDiagnostics | null;
  nowMs: number;
}

const WorkerDiagnosticsContext = createContext<WorkerDiagnosticsState | null>(null);

function useWorkerDiagnostics(): WorkerDiagnosticsState {
  const state = useContext(WorkerDiagnosticsContext);
  if (!state) throw new Error('useWorkerDiagnostics requires WorkerDiagnosticsProvider');
  return state;
}

export function WorkerDiagnosticsProvider({
  initial,
  children,
}: {
  initial: WorkerDiagnostics | null;
  children: ReactNode;
}) {
  const [worker, setWorker] = useState(initial);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    // First client render recomputes the relative times (the server rendered
    // with its own clock/timezone; `suppressHydrationWarning` covers the gap).
    setNowMs(Date.now());
    let cancelled = false;
    const controller = new AbortController();
    async function refresh(): Promise<void> {
      if (document.hidden) return;
      const result = await getDiagnostics(controller.signal);
      if (!cancelled && result.ok) {
        setWorker(result.data.worker);
        setNowMs(Date.now());
      }
    }
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    // Catch up immediately when the tab comes back instead of waiting a tick.
    const onVisibilityChange = () => void refresh();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return (
    <WorkerDiagnosticsContext.Provider value={{ worker, nowMs }}>
      {children}
    </WorkerDiagnosticsContext.Provider>
  );
}

export function WorkerStatusSection() {
  const { worker, nowMs } = useWorkerDiagnostics();
  return (
    <SettingsSection title="Worker">
      <SettingsCard>
        {worker ? (
          <>
            <div className="mb-3 flex items-center gap-3">
              <Activity className="h-[19px] w-[19px] text-muted" aria-hidden />
              <span className="min-w-0 flex-1 text-[15px] font-semibold">Graphile Worker</span>
              <SettingsStatusBadge status={diagnosticStatus(workerHealth(worker))} />
            </div>
            <DefinitionRows rows={workerRows(worker, nowMs)} />
          </>
        ) : (
          <p className="py-3 text-center text-[13px] text-dim">Worker status could not be read.</p>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

export function RecentEventsSection() {
  const { worker } = useWorkerDiagnostics();
  const events = worker ? workerEventRows(worker) : [];
  return (
    <SettingsSection title="Recent Events">
      <SettingsCard className={events.length === 0 ? 'border-dashed' : undefined}>
        {events.length === 0 ? (
          <p className="py-3 text-center text-[13px] text-dim">No recent worker activity.</p>
        ) : (
          events.map((event, index) => (
            <div
              key={`${event.time}-${index}`}
              className="flex gap-3 border-b border-line py-2 font-mono text-[10.5px] tracking-[0.05em] last:border-b-0"
            >
              <time suppressHydrationWarning className="flex-none text-dim">
                {event.time}
              </time>
              <span className={`min-w-0 ${event.warn ? 'text-lamp' : 'text-muted'}`}>
                {event.message}
              </span>
            </div>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
