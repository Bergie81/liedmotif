'use client';

// One act in a menu. Keeping every menu on one row means an act reads the same
// wherever it is reached from, and a roadmap row looks like the act it will
// become rather than like nothing at all.
//
// A row is a button unless the act is a navigation; the class and the contents
// are exported separately so the handful of rows that must be some other
// element still wear exactly this one.

import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useOnline } from '@/lib/online-state';
import { menuRowClass, menuRowDescriptionClass } from './design-system';
import { LiedmotifLoader } from './loading';
import { OFFLINE_HINT } from './online-only';

/** `danger` tints the row: this one destroys something. */
export type MenuRowTone = 'neutral' | 'danger';

export function menuRowClassName({ tone = 'neutral' }: { tone?: MenuRowTone } = {}): string {
  return cn(menuRowClass, tone === 'danger' && 'text-warn');
}

interface MenuRowFace {
  icon: ReactNode;
  label: ReactNode;
  /** What the act does, on the row itself: a phone has no hover to reveal it. */
  description: string;
  /** The row's state right now — time left, why it is dark, a roadmap marker. */
  note?: string;
  tone?: MenuRowTone;
  /** The act is in flight — the loader takes the icon's slot, in place. */
  busy?: boolean;
}

export function MenuRowContent({
  icon,
  label,
  description,
  note,
  tone = 'neutral',
  busy = false,
}: MenuRowFace) {
  return (
    <>
      {busy ? (
        <LiedmotifLoader />
      ) : (
        <span
          className={cn(
            'flex-none [&>svg]:h-[18px] [&>svg]:w-[18px]',
            tone === 'danger' ? '[&>svg]:text-warn' : '[&>svg]:text-muted',
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        <span className={menuRowDescriptionClass}>{description}</span>
      </span>
      {note ? (
        <span className="flex-none font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-dim">
          {note}
        </span>
      ) : null}
    </>
  );
}

export function MenuRow({
  icon,
  label,
  description,
  note,
  tone = 'neutral',
  busy = false,
  onlineOnly = false,
  disabled,
  className,
  ...props
}: MenuRowFace & {
  /** The act needs the server: offline, the row is disabled and says why. */
  onlineOnly?: boolean;
} & Omit<ComponentProps<'button'>, 'children'>) {
  const offline = !useOnline() && onlineOnly;
  return (
    <button
      type="button"
      className={cn(menuRowClassName({ tone }), className)}
      disabled={busy || disabled || offline}
      aria-busy={busy}
      {...props}
    >
      <MenuRowContent
        icon={icon}
        label={label}
        description={description}
        note={offline ? OFFLINE_HINT : note}
        tone={tone}
        busy={busy}
      />
    </button>
  );
}
