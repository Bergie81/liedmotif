import type { ComponentProps, ReactNode } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MARK_BARS, MARK_VIEW_BOX } from './loading-presentation';

/** Card surface without padding — for cards whose media must sit flush with the edges. */
export const cardShellClass =
  'rounded-card border border-line [background:var(--gradient-card)] shadow-[var(--shadow-card)]';
export const cardClass = `${cardShellClass} p-4`;
export const eyebrowClass = 'font-mono text-[10px] uppercase tracking-[0.22em] text-dim';
export const displayHeadingClass =
  'font-display text-[clamp(26px,7vw,34px)] desk:text-[44px] font-extrabold leading-[1.12] tracking-[-0.025em]';
export const sectionHeadingClass = 'font-display text-[17px] font-bold tracking-[-0.01em]';
export const iconButtonClass =
  'inline-flex h-[42px] w-[42px] items-center justify-center rounded-xl border border-transparent text-muted [transition:transform_.06s_ease,background_.15s_ease,color_.15s_ease] hover:bg-[var(--control-bg-hover)] hover:text-paper active:scale-[0.985]';
/** A transport satellite — the round hit area flanking the play button. The
 *  colour belongs to the call site: each satellite states its own weight against
 *  the primary control. */
export const transportButtonClass =
  'grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full hover:bg-[var(--control-bg-hover)] active:scale-[0.97] disabled:opacity-40';
/** The Now Playing page's two columns on a wide screen. Every state of the page
 *  takes this one layout, the connecting frame included, so nothing shifts as
 *  one state hands over to the next. The cover always ends its column, so
 *  aligning both columns' bottoms keeps it level with the details whatever sits
 *  above it. */
export const nowPlayingLayoutClass =
  '@split:grid @split:min-h-[calc(100vh-120px)] @split:grid-cols-[440px_minmax(0,1fr)] @split:content-center @split:items-end @split:gap-[68px]';
/** The details column beside the cover: at least the cover's height (the 440px
 *  column above), so its first and last rows finish level with the art. Its rows
 *  keep a fixed height, so anything that comes and goes belongs above the cover. */
export const nowPlayingDetailsClass =
  'mt-5 min-w-0 @split:mt-0 @split:flex @split:min-h-[440px] @split:flex-col';
/** A details row that takes a share of the column's spare height above it. */
export const nowPlayingSpareRowClass = '@split:mt-auto @split:pt-4';
/** The icon button a menu hangs off — smaller than `iconButtonClass`, and lit
 *  while its menu is open so the trigger reads as pressed. */
export const menuTriggerClass =
  'grid h-8 w-8 flex-none place-items-center rounded-[9px] text-muted transition hover:bg-[var(--control-bg-hover)] hover:text-paper aria-expanded:bg-[var(--control-bg-hover)] aria-expanded:text-paper';
const dangerButtonBaseClass =
  'inline-flex items-center justify-center gap-2 border border-warn/40 bg-warn/[0.06] font-semibold text-warn [transition:transform_.06s_ease,background_.15s_ease] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50';
export const dangerButtonClass = `${dangerButtonBaseClass} rounded-[13px] px-5 py-3 text-[15px]`;
/** The destructive button at the size a banner or a dense row can carry. */
export const compactDangerButtonClass = `${dangerButtonBaseClass} rounded-[10px] px-4 py-2 text-[13.5px]`;
export const menuRowClass =
  'flex w-full items-center gap-3 border-b border-line px-1 py-3 text-left text-[14.5px] font-medium text-paper last:border-b-0 disabled:cursor-not-allowed disabled:opacity-45';
/** The line under a menu row's label that says what the row does or holds. */
export const menuRowDescriptionClass =
  'mt-0.5 block text-[11.5px] font-normal leading-[1.35] text-dim';
/** A menu entry sized as a target rather than a line — icon over label, hit without reading. */
export const menuTileClass =
  'flex min-h-20 flex-col items-center justify-center gap-2 rounded-[13px] border border-line-2 bg-[var(--control-bg)] shadow-[var(--shadow-control)] px-1.5 py-3 text-center text-[12px] font-medium leading-[1.25] text-paper [-webkit-tap-highlight-color:transparent] hover:bg-[var(--control-bg-hover)] disabled:cursor-not-allowed disabled:opacity-45';
export const chipClass =
  'rounded-full border border-line-2 bg-paper/[0.02] px-4 py-2 text-[13.5px] font-medium text-muted transition-[color,border-color,background-color,box-shadow] duration-[120ms] ease-[ease] [-webkit-tap-highlight-color:transparent] hover:text-paper aria-pressed:border-lamp/55 aria-pressed:bg-lamp/[0.09] aria-pressed:text-lamp light:aria-pressed:border-lamp-fill/55 light:aria-pressed:bg-lamp-fill/[0.13] aria-pressed:shadow-[0_0_14px_-4px_var(--lamp-glow)]';
export const segmentedListClass =
  'flex gap-[3px] rounded-xl border border-line bg-[var(--segment-bg)] p-[3px]';
export const segmentedTriggerClass =
  'flex-1 rounded-[9px] px-2 py-2 text-[13.5px] font-medium text-muted [-webkit-tap-highlight-color:transparent] data-[state=active]:bg-[var(--segment-active-bg)] data-[state=active]:text-paper data-[state=active]:shadow-[var(--shadow-segment)]';
export const switchClass =
  "relative h-[27px] w-[46px] flex-none rounded-full bg-[var(--switch-bg)] transition-[background] duration-150 ease-[ease] after:absolute after:left-[3px] after:top-[3px] after:h-[21px] after:w-[21px] after:rounded-full after:bg-[var(--switch-thumb)] after:content-[''] after:transition-transform after:duration-150 after:ease-[ease] aria-checked:bg-[var(--switch-checked-bg)] aria-checked:after:translate-x-[19px] aria-checked:after:bg-[var(--switch-checked-thumb)]";
export const stepperClass =
  'inline-flex items-center gap-[2px] overflow-hidden rounded-[11px] border border-line-2';
export const stepperButtonClass =
  'grid h-9 w-9 place-items-center text-[18px] text-muted [-webkit-tap-highlight-color:transparent] hover:bg-[var(--stepper-hover)] hover:text-lamp disabled:cursor-not-allowed disabled:opacity-35';
export const stepperValueClass = 'min-w-[52px] text-center font-mono text-[13px] text-paper';
export const meterBarClass = 'h-[6px] overflow-hidden rounded-[3px] bg-[var(--meter-track)]';
export const meterFillClass =
  'h-full rounded-[3px] [background:var(--gradient-meter)] shadow-[var(--shadow-meter)]';
export const overlayClass = 'bg-[var(--overlay)] backdrop-blur-[3px]';
export const floatingSurfaceClass = 'border-line-2 text-paper shadow-[var(--shadow-float)]';

export function Meter({
  value,
  max = 100,
  label,
  className,
}: {
  value: number;
  max?: number;
  label: string;
  className?: string;
}) {
  const normalizedMax = Math.max(max, 0);
  const boundedValue = Math.min(Math.max(value, 0), normalizedMax);
  const width = normalizedMax > 0 ? `${(boundedValue / normalizedMax) * 100}%` : '0%';

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={normalizedMax}
      aria-valuenow={boundedValue}
      className={cn(meterBarClass, className)}
    >
      <div className={meterFillClass} style={{ width }} />
    </div>
  );
}

/** The static brand mark, drawn from the same bar table the loader animates. */
export function LiedmotifMark({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg className={cn('h-6 w-6', className)} viewBox={MARK_VIEW_BOX} aria-hidden {...props}>
      {MARK_BARS.map((bar) => (
        <rect
          key={bar.toneClass}
          className={bar.toneClass}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          rx={bar.rx}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

/** The round chip behind `AvatarBadge` and `LiedmotifRoundMark`, so the two read
 *  as a pair at either end of the mobile header. */
export const roundChipClass =
  'grid flex-none place-items-center rounded-full border border-line-2 bg-[radial-gradient(130%_130%_at_30%_15%,var(--panel-2),var(--chassis))]';

export function LiedmotifRoundMark() {
  return (
    <span className={cn(roundChipClass, 'h-[34px] w-[34px]')}>
      <LiedmotifMark className="h-[18px] w-[18px]" />
    </span>
  );
}

export function LiedmotifWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-display text-[20px] font-extrabold tracking-[-0.02em]', className)}>
      Lied
      <em className="not-italic text-lamp [text-shadow:0_0_18px_var(--lamp-glow)] light:[text-shadow:none]">
        motif
      </em>
    </span>
  );
}

/** The mark a `menuRowClass` checklist row carries at its end. Decorative: the
 *  row itself is the `role="checkbox"` that reports the state. */
export function CheckIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-[22px] w-[22px] items-center justify-center rounded-[7px] border',
        checked ? 'border-lamp bg-lamp/15 text-lamp' : 'border-line-2 text-transparent',
      )}
    >
      <Check className="h-[14px] w-[14px]" />
    </span>
  );
}

/** An inline failure the owner must read. `role="alert"` belongs to the
 *  primitive so no surface can render this look without announcing it. The body
 *  beside the icon stays a block, so a retry composed as a child flows with the
 *  message. */
export function AlertBanner({
  children,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'role'>) {
  return (
    <div
      {...props}
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-card border border-warn/35 bg-warn/[0.06] p-3 text-[13px] text-warn',
        className,
      )}
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  titleAs: Title = 'div',
  children,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  titleAs?: 'div' | 'h1' | 'h2';
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('rounded-card border border-dashed border-line-2 p-8 text-center', className)}
    >
      <span className="mx-auto mb-4 grid h-[58px] w-[58px] place-items-center rounded-full border border-dashed border-line-2 text-dim">
        {icon}
      </span>
      <Title className="font-display text-[19px] font-bold">{title}</Title>
      <div className="mx-auto mt-2 max-w-[440px] text-[13.5px] text-muted">{children}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
