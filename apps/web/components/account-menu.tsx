'use client';

import type { ComponentType, ReactNode } from 'react';
import Link from 'next/link';
import {
  ChartNoAxesColumn,
  ChevronDown,
  CircleHelp,
  ExternalLink,
  LogOut,
  Moon,
  SlidersHorizontal,
  Sun,
  UserRound,
} from 'lucide-react';
import { AvatarBadge } from '@/components/avatar-badge';
import { useSignOut } from '@/components/settings/use-sign-out';
import { docsLinkTarget } from '@/components/ui/docs-link';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/cn';
import { docsUrl } from '@/lib/docs-links';

export type Listener = {
  name: string;
  email: string;
  /** Public-facing Artist Name from the listener profile, or null when unset. */
  artistName: string | null;
  /** App-routed avatar URL (`user.image`), or null for the initial-letter chip. */
  imageUrl: string | null;
};

export function AccountMenu({
  listener,
  mode,
  onToggleMode,
  expandedRail = false,
}: {
  listener: Listener;
  mode: 'night' | 'light';
  onToggleMode: () => void;
  expandedRail?: boolean;
}) {
  const { busy, signOut } = useSignOut();
  const subtitle = listener.artistName || listener.email;

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Account Menu"
        className={cn(
          'group flex min-h-[42px] min-w-[42px] items-center justify-center gap-2 rounded-xl text-left hover:bg-[var(--control-bg-hover)]',
          expandedRail ? 'w-full justify-center p-2 rail-exp:justify-start' : 'flex-none',
        )}
      >
        <AvatarBadge
          name={listener.name}
          imageUrl={listener.imageUrl}
          className="h-[34px] w-[34px] text-[14px] transition-[border-color,box-shadow] duration-150 ease-[ease] group-hover:border-lamp/50 group-aria-expanded:border-lamp/75 group-aria-expanded:shadow-[0_0_0_3px_var(--lamp-glow)]"
        />
        {expandedRail ? (
          <>
            <span className="hidden min-w-0 flex-1 rail-exp:block">
              <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[13.5px] font-semibold">
                {listener.name}
              </span>
              <span className="mt-px block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[9.5px] uppercase tracking-[0.14em] text-dim">
                {subtitle}
              </span>
            </span>
            <ChevronDown className="hidden h-[15px] w-[15px] flex-none text-dim rail-exp:block" />
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align={expandedRail ? 'start' : 'end'}
        sideOffset={8}
        className="w-[236px] p-2"
      >
        <div className="mb-1 flex items-center gap-2 border-b border-line p-2">
          <AvatarBadge
            name={listener.name}
            imageUrl={listener.imageUrl}
            className="h-[34px] w-[34px] text-[14px]"
          />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold">{listener.name}</div>
            <div className="mt-[3px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] tracking-[0.06em] text-dim">
              {subtitle}
            </div>
          </div>
        </div>
        <AccountLink href="/settings/profile" icon={UserRound}>
          Profile
        </AccountLink>
        <AccountLink href="/settings" icon={SlidersHorizontal}>
          Settings
        </AccountLink>
        <AccountLink href="/stats" icon={ChartNoAxesColumn}>
          Your Stats
        </AccountLink>
        <button type="button" onClick={onToggleMode} className={accountRowClass}>
          {mode === 'light' ? (
            <Sun className="h-[18px] w-[18px] text-muted" />
          ) : (
            <Moon className="h-[18px] w-[18px] text-muted" />
          )}
          Mode
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.08em] text-dim">
            {mode === 'light' ? 'Light' : 'Night'}
          </span>
        </button>
        <PopoverClose asChild>
          <a href={docsUrl()} {...docsLinkTarget} className={accountRowClass}>
            <CircleHelp className="h-[18px] w-[18px] text-muted" />
            Docs
            <ExternalLink className="ml-auto h-[14px] w-[14px] text-dim" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </PopoverClose>
        <div className="mx-2 my-1 h-px bg-line" role="separator" />
        <button type="button" onClick={signOut} disabled={busy} className={accountRowClass}>
          <LogOut className="h-[18px] w-[18px] text-muted" />
          {busy ? 'Signing Out…' : 'Sign Out'}
        </button>
      </PopoverContent>
    </Popover>
  );
}

const accountRowClass =
  'flex w-full items-center gap-3 rounded-[10px] p-2 text-left text-[14px] font-medium text-paper [-webkit-tap-highlight-color:transparent] hover:bg-[var(--control-bg-hover)] disabled:opacity-50';

function AccountLink({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  // PopoverClose collapses the menu on selection; navigation alone would leave
  // it open because the shell (and the popover with it) survives route changes.
  return (
    <PopoverClose asChild>
      <Link href={href} className={accountRowClass}>
        <Icon className="h-[18px] w-[18px] text-muted" />
        {children}
      </Link>
    </PopoverClose>
  );
}
