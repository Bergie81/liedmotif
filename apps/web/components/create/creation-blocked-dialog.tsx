'use client';

// Creation-blocked popup.
//
// When the creation-time headroom gate refuses a new session, NO session
// is created; instead of failing silently the user is offered the two zero-cost ways
// forward — Resume a Stopped session (My Sessions; never gated) or browse the Library.
// Reuses the shared Radix dialog primitive.

import { useRouter } from 'next/navigation';
import { Gauge, ListMusic, Library as LibraryIcon, Wallet } from 'lucide-react';
import { COST_SETTINGS_PATH, MY_BUDGET_PATH } from '@liedmotif/shared';
import { useAppChrome } from '@/components/app-chrome-context';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { cn } from '@/lib/cn';

export function CreationBlockedDialog({
  open,
  onOpenChange,
  message,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string;
}) {
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="creation-blocked-dialog" aria-describedby="creation-blocked-desc">
        <div className="flex items-center gap-2 text-warn">
          <Wallet className="h-5 w-5" aria-hidden />
          <DialogTitle className="font-display text-[18px] font-bold text-paper">
            No generation headroom right now
          </DialogTitle>
        </div>
        <DialogDescription
          id="creation-blocked-desc"
          className="mt-2 text-[13.5px] leading-relaxed text-muted"
        >
          {message}
        </DialogDescription>

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            data-testid="blocked-resume"
            onClick={() => {
              onOpenChange(false);
              router.push('/sessions');
            }}
            className={primaryButtonClass}
          >
            <ListMusic className="h-4 w-4" aria-hidden />
            Resume a Session
          </button>
          <button
            type="button"
            data-testid="blocked-library"
            onClick={() => {
              onOpenChange(false);
              router.push('/library');
            }}
            className={cn(secondaryButtonClass, 'flex items-center justify-center gap-2 py-2.5')}
          >
            <LibraryIcon className="h-4 w-4" aria-hidden />
            Browse Library
          </button>
          <CostSettingsButton
            onNavigate={(path) => {
              onOpenChange(false);
              router.push(path);
            }}
          />
          <DialogClose className="mt-1 text-center text-[12px] text-dim hover:text-muted">
            Not now
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Only the Admin can change cost limits; a Member's way out is their own
 * read-only budget page, worded like the generation banner's link. Read inside
 * the dialog content so the role is resolved only once the dialog opens. */
function CostSettingsButton({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { viewerRole } = useAppChrome();
  const isMember = viewerRole === 'member';
  return (
    <button
      type="button"
      onClick={() => onNavigate(isMember ? MY_BUDGET_PATH : COST_SETTINGS_PATH)}
      className={cn(secondaryButtonClass, 'flex items-center justify-center gap-2 py-2.5')}
    >
      <Gauge className="h-4 w-4" aria-hidden />
      {isMember ? 'See your budget' : 'Adjust cost limits'}
    </button>
  );
}
