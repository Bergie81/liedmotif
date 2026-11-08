'use client';

// The Track Data sheet: everything descriptive Liedmotif knows about the current
// Track (identity, both prompts, vibe, provenance), fetched on open so the
// queue payload stays slim — the same lazy pattern as the Lyrics sheet, and
// parent-owned like it so two sheets never stack.

import { useEffect, useState } from 'react';
import type { TrackDetails } from '@liedmotif/shared';
import { Sheet, SheetContent, SheetHeader } from '@/components/ui/sheet';
import { LiedmotifLoader } from '@/components/ui/loading';
import { useTrackMedia } from './track-media';
import { buildTrackDataSections, type TrackDataSection } from './track-data-view';

type TrackDataPhase = 'loading' | 'error' | 'ready';

/** Fetch-on-open; re-runs when the Track changes so the sheet can never show
 *  the previous Track's data. A failed read shows the error line — reopening
 *  (or the next Track) retries naturally. */
function useTrackDetails(trackId: string | null, enabled: boolean): TrackDetails | 'error' | null {
  const [state, setState] = useState<{
    trackId: string;
    details: TrackDetails | 'error';
  } | null>(null);
  const { details: readDetails } = useTrackMedia();

  useEffect(() => {
    if (!enabled || !trackId) return;
    let cancelled = false;
    void readDetails(trackId).then((result) => {
      if (cancelled) return;
      setState({ trackId, details: result.ok ? result.data : 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [trackId, enabled, readDetails]);

  return state && state.trackId === trackId ? state.details : null;
}

const PHASE_COPY: Record<Exclude<TrackDataPhase, 'ready'>, string> = {
  loading: 'Loading Track data…',
  error: 'Track data is unavailable right now',
};

function detailsPhase(details: TrackDetails | 'error' | null): TrackDataPhase {
  if (details == null) return 'loading';
  if (details === 'error') return 'error';
  return 'ready';
}

export function TrackDataSheet({
  open,
  onOpenChange,
  trackId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackId: string | null;
}) {
  const details = useTrackDetails(trackId, open);
  const phase = detailsPhase(details);
  const sections = details != null && details !== 'error' ? buildTrackDataSections(details) : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex flex-col">
        <SheetHeader title="Track Data" description="Everything this Track was generated from" />

        <div className="-mx-5 mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-5">
          {phase !== 'ready' ? (
            <p
              role="status"
              aria-live="polite"
              className="mt-6 flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-dim"
            >
              {phase === 'loading' ? <LiedmotifLoader size="xs" /> : null}
              {PHASE_COPY[phase]}
            </p>
          ) : (
            sections.map((section) => <DataSection key={section.title} section={section} />)
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DataSection({ section }: { section: TrackDataSection }) {
  return (
    <section className="mt-5 first:mt-4">
      <div className="flex items-center gap-3">
        <h3 className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-dim">
          {section.title}
        </h3>
        <span
          aria-hidden
          className="h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--line-2)_0_1px,transparent_1px_7px)]"
        />
      </div>
      <dl className="mt-2">
        {section.fields.map((field) =>
          field.block ? (
            <div key={field.label} className="py-2">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                {field.label}
              </dt>
              <dd className="mt-1 whitespace-pre-wrap break-words rounded-card-sm border border-line-2 bg-[var(--control-bg)] px-3 py-2.5 font-mono text-[12px] leading-relaxed">
                {field.value}
              </dd>
            </div>
          ) : (
            <div
              key={field.label}
              className="flex items-baseline justify-between gap-4 border-b border-line-2/60 py-2 last:border-b-0"
            >
              <dt className="flex-none text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                {field.label}
              </dt>
              <dd className="min-w-0 break-words text-right text-[13.5px]">{field.value}</dd>
            </div>
          ),
        )}
      </dl>
    </section>
  );
}
