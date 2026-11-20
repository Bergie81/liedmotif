'use client';

import type { ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { LISTENING_RANGES, type ListeningRange } from '@liedmotif/shared';
import { segmentedListClass, segmentedTriggerClass } from '@/components/ui/design-system';
import { LoadingRow } from '@/components/ui/loading';
import { cn } from '@/lib/cn';
import { RANGE_LABELS } from './your-stats-model';

export const emptyClass = 'text-[13px] leading-relaxed text-muted';

/** The type a headline reading is set in, wherever one is shown. */
export const figureValueClass =
  'font-display text-[28px] font-bold leading-none tracking-[-0.02em] text-paper';

export function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-dim">{label}</div>
      <div className={`mt-2 ${figureValueClass}`}>{value}</div>
    </div>
  );
}

/** One labelled reading in a list beside a chart; `swatch` is the CSS color of its mark. */
export function ReadingRow({
  swatch,
  label,
  value,
  detail,
}: {
  swatch?: string;
  label: string;
  value: string;
  /** A second, quieter reading ahead of the value. */
  detail?: string;
}) {
  return (
    <li className="flex items-center gap-2 border-b border-line py-2 text-[13px] first:pt-0 last:border-b-0 last:pb-0">
      {swatch ? (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: swatch }}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-muted">{label}</span>
      {detail ? (
        <span className="shrink-0 font-mono text-[11px] tracking-[0.05em] text-muted">
          {detail}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-[13px] text-paper">{value}</span>
    </li>
  );
}

export function PeriodPicker({
  range,
  onChange,
  className,
}: {
  range: ListeningRange;
  onChange: (range: ListeningRange) => void;
  className?: string;
}) {
  return (
    <div className={cn(segmentedListClass, className)} role="group" aria-label="Period">
      {LISTENING_RANGES.map((option) => (
        <button
          key={option}
          type="button"
          data-state={option === range ? 'active' : 'inactive'}
          aria-pressed={option === range}
          onClick={() => onChange(option)}
          className={segmentedTriggerClass}
        >
          {RANGE_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

/** The calendar the figures below it are cut by. */
export function PeriodLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-dim">{children}</p>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="text-[13px] text-warn">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex items-center gap-2 font-semibold text-paper"
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Try Again
      </button>
    </div>
  );
}

/** A period-switched panel's body: the failure, the wait, or the answer. */
export function RangedBody({
  error,
  loading,
  loadingLabel,
  onRetry,
  children,
}: {
  error: string | null;
  loading: boolean;
  loadingLabel: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (error) return <LoadError message={error} onRetry={onRetry} />;
  if (loading) return <LoadingRow label={loadingLabel} className="py-4" />;
  return <>{children}</>;
}
