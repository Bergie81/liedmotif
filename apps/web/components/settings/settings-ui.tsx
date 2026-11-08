import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { DocsPath } from '@/lib/docs-links';
import { OfflineBadge } from '@/components/offline-badge';
import { DocsLink } from '@/components/ui/docs-link';
import {
  Meter,
  displayHeadingClass,
  eyebrowClass,
  cardClass,
  sectionHeadingClass,
} from '@/components/ui/design-system';
import { Slider } from '@/components/ui/slider';
import type { SettingsStatus } from '@/lib/settings-hub-model';

export type SettingsFeedbackState = {
  kind: 'success' | 'error' | 'info';
  message: string;
} | null;

export function SettingsPageHeader({
  title,
  description,
  docs,
  root = false,
  parent,
  crumbLabel,
}: {
  title: string;
  description?: ReactNode;
  /** A link to this page's guide on the website, after the description. */
  docs?: { path: DocsPath; label: string };
  root?: boolean;
  parent?: { href: string; label: string };
  crumbLabel?: string;
}) {
  const parentPage = parent ?? { href: '/settings', label: 'Settings' };
  // The trail starts at Settings only for a page that sits inside it: a parent
  // elsewhere (Home) is the whole trail. Only Settings pages hide the app's
  // mobile header, so only they need their own back row.
  const underSettings = parentPage.href.startsWith('/settings');
  return (
    <header>
      {root ? null : (
        <>
          {underSettings ? (
            <div className="mb-5 flex items-center gap-3 desk:hidden">
              <Link
                href={parentPage.href}
                aria-label={`Back to ${parentPage.label}`}
                className="-ml-3 inline-flex h-[42px] w-[42px] items-center justify-center rounded-xl border border-transparent text-muted [-webkit-tap-highlight-color:transparent] hover:bg-paper/[0.05] hover:text-paper"
              >
                <ArrowLeft className="h-5 w-5" aria-hidden />
              </Link>
              <span className="min-w-0 flex-1 truncate font-display text-[17.5px] font-bold tracking-[-0.015em]">
                {title}
              </span>
              <OfflineBadge />
            </div>
          ) : null}
          <p className={eyebrowClass}>
            {parent && underSettings ? (
              <>
                <Link href="/settings" className="text-dim hover:text-lamp">
                  Settings
                </Link>{' '}
                <span className="px-1">›</span>{' '}
              </>
            ) : null}
            <Link href={parentPage.href} className="text-dim hover:text-lamp">
              {parentPage.label}
            </Link>{' '}
            <span className="px-1">›</span> {crumbLabel ?? title}
          </p>
        </>
      )}
      <h1 className={cn(displayHeadingClass, root ? 'mb-2' : 'my-2')}>{title}</h1>
      {description ? (
        <p className="text-[14.5px] text-muted">
          {description}
          {docs ? (
            <>
              {' '}
              <DocsLink path={docs.path}>{docs.label}</DocsLink>
            </>
          ) : null}
        </p>
      ) : null}
    </header>
  );
}

/** Two columns only once each gets ~450px, the width settings rows need. */
export function SettingsColumns({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 @container">
      <div className="@split:columns-2 @split:gap-x-12">{children}</div>
    </div>
  );
}

export function SettingsSection({
  title,
  action,
  children,
  id,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="mb-6 break-inside-avoid desk:pt-[2px]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className={sectionHeadingClass}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(cardClass, className)}>{children}</div>;
}

export function SettingsControlRow({
  label,
  description,
  descriptionId,
  children,
}: {
  label: string;
  description?: ReactNode;
  descriptionId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-paper">{label}</div>
        {description ? (
          <div id={descriptionId} className="mt-[2px] text-[12.5px] text-dim">
            {description}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function GatedSlider({
  label,
  value,
  onValueChange,
  min,
  max,
  step,
  disabled,
  enabled,
  renderValue,
  valueTestId,
  ariaLabel,
  minLabel,
  maxLabel,
  children,
}: {
  label: string;
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  enabled: boolean;
  renderValue: (value: number) => ReactNode;
  valueTestId: string;
  ariaLabel: string;
  minLabel: ReactNode;
  maxLabel: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cn('mt-4', !enabled && 'opacity-45')}>
      <label className="mb-2 flex items-baseline justify-between gap-3 text-[13px] font-semibold text-paper">
        {label}
        <span
          className="font-mono text-[13px] font-bold uppercase tracking-[0.06em] text-lamp"
          data-testid={valueTestId}
        >
          {renderValue(value)}
        </span>
      </label>
      <div className="flex h-9 items-center">
        <Slider
          value={[value]}
          onValueChange={(values) => {
            const nextValue = values[0];
            if (nextValue !== undefined) onValueChange(nextValue);
          }}
          min={min}
          max={max}
          step={step}
          disabled={disabled || !enabled}
          aria-label={ariaLabel}
        />
      </div>
      <div className="-mt-1 flex justify-between font-mono text-[9.5px] uppercase tracking-[0.16em] text-dim">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
      {children}
    </div>
  );
}

export function SettingsFootnote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 font-mono text-[10.5px] uppercase leading-[1.7] tracking-[0.05em] text-dim">
      {children}
    </p>
  );
}

export function SettingsUsageMeter({
  label,
  used,
  limit,
  suffix,
  readout,
}: {
  label: string;
  used: number;
  /** `null`: nothing caps this count, so there is no bar to fill. */
  limit: number | null;
  suffix: string;
  /** Stands in for the "used of limit" figure; the bar fills by `used` either way. */
  readout?: ReactNode;
}) {
  return (
    <div className="my-2">
      <div className="mb-2 flex items-baseline justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.05em] text-muted">
        <span>{label}</span>
        <span className="text-right">
          {readout ?? (
            <>
              <b className="font-bold text-paper">{used}</b>
              {limit === null ? '' : ` of ${limit}`} {suffix}
            </>
          )}
        </span>
      </div>
      {limit === null ? null : <Meter value={used} max={limit} label={`${label} usage`} />}
    </div>
  );
}

export function SettingsUnavailableMeter({ label }: { label: string }) {
  return (
    <div className="my-2">
      <div className="mb-2 flex items-baseline justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.05em] text-muted">
        <span>{label}</span>
        <span className="text-dim">Unavailable</span>
      </div>
      <div
        role="status"
        aria-label={`${label} unavailable`}
        className="h-[6px] overflow-hidden rounded-[3px] bg-[var(--meter-track)]"
      />
    </div>
  );
}

export function SettingsStatusBadge({ status }: { status: SettingsStatus }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] border px-2 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.1em]',
        status.tone === 'ok' && 'border-signal/40 text-signal',
        status.tone === 'warn' && 'border-warn/45 text-warn',
        status.tone === 'muted' && 'border-line-2 text-dim',
      )}
    >
      <span
        className={cn(
          'h-[6px] w-[6px] rounded-full',
          status.tone === 'ok' && 'bg-signal shadow-[0_0_6px_var(--signal)]',
          status.tone === 'warn' && 'bg-warn',
          status.tone === 'muted' && 'bg-dim',
        )}
      />
      {status.label}
    </span>
  );
}

export function SettingsRow({
  href,
  icon,
  label,
  summary,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  summary: { status?: SettingsStatus; text: string };
}) {
  return (
    <Link
      href={href}
      className="group -mx-2 flex items-center gap-3 rounded-[10px] border-b border-line px-2 py-3 [-webkit-tap-highlight-color:transparent] last:border-b-0 hover:bg-paper/[0.03]"
    >
      <span className="shrink-0 text-muted [&>svg]:h-[19px] [&>svg]:w-[19px]">{icon}</span>
      {/* The badge rides the label line so the summary keeps the row's full
          width — beside it, a phone truncates the summary to nothing. */}
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-[14.5px] font-semibold">{label}</span>
          {summary.status ? <SettingsStatusBadge status={summary.status} /> : null}
        </span>
        <span className="mt-[3px] block truncate font-mono text-[10.5px] uppercase tracking-[0.05em] text-dim">
          {summary.text}
        </span>
      </span>
      <ChevronRight className="h-[17px] w-[17px] shrink-0 text-dim group-hover:text-lamp" />
    </Link>
  );
}

export function SettingsFeedback({
  kind,
  children,
}: {
  kind: 'success' | 'error' | 'info';
  children: ReactNode;
}) {
  return (
    <p
      role="status"
      className={cn(
        'rounded-card-sm border px-3 py-2 text-[13px]',
        kind === 'success' && 'border-signal/35 bg-signal/[0.06] text-signal',
        kind === 'error' && 'border-warn/35 bg-warn/[0.06] text-warn',
        kind === 'info' && 'border-line-2 bg-paper/[0.03] text-muted',
      )}
    >
      {children}
    </p>
  );
}
