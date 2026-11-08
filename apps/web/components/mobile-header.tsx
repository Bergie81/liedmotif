import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { OfflineBadge } from './offline-badge';
import { LiedmotifRoundMark } from './ui/design-system';

/** The phone header: the round mark and the page name on the left, the page's
 *  controls on the right. Desk has the rail instead. */
export function MobileHeader({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <header className={cn('flex items-center justify-between gap-3 desk:hidden', className)}>
      <div className="flex min-w-0 items-center gap-3">
        <LiedmotifRoundMark />
        <span className="truncate font-display text-[17.5px] font-bold tracking-[-0.015em]">
          {title}
        </span>
      </div>
      <div className="flex flex-none items-center gap-2">
        <OfflineBadge />
        {children}
      </div>
    </header>
  );
}
