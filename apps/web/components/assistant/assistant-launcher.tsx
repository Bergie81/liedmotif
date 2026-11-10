'use client';

// The Assistant's launcher for a page that keeps its own controls where the
// floating one sits: the page places this button among them. Whether the panel
// is open belongs to the app shell, which hands it to the dock and, through
// this context, to the page.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { iconButtonClass } from '@/components/ui/design-system';
import { WithTooltip } from '@/components/ui/tooltip';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';
import { cn } from '@/lib/cn';

export interface AssistantLauncher {
  open: boolean;
  toggle: () => void;
}

/** `null` where the viewer has no Assistant: the button renders nothing. */
export const AssistantLauncherContext = createContext<AssistantLauncher | null>(null);

/** The shell's side: the panel's open state, for the dock and for the context. */
export function useAssistantLauncher() {
  const [open, setOpen] = useState(false);
  const launcher = useMemo<AssistantLauncher>(
    () => ({ open, toggle: () => setOpen((current) => !current) }),
    [open],
  );
  return { open, setOpen, launcher };
}

export function AssistantLauncherButton() {
  const launcher = useContext(AssistantLauncherContext);
  const open = launcher?.open ?? false;
  const buttonRef = useRef<HTMLButtonElement>(null);
  // A panel opened from here gives focus back here when it closes, however it
  // was closed: the dock has no trigger of its own on this page to return to.
  const openedHere = useRef(false);
  useEffect(() => {
    if (open || !openedHere.current) return;
    openedHere.current = false;
    buttonRef.current?.focus();
  }, [open]);

  if (!launcher) return null;
  const label = open ? `Close ${ASSISTANT_NAME}` : `Ask ${ASSISTANT_NAME}`;
  return (
    <WithTooltip label={label}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          openedHere.current = !open;
          launcher.toggle();
        }}
        className={cn(
          iconButtonClass,
          'flex-none',
          open ? 'bg-[var(--control-bg-hover)] text-paper' : 'text-lamp',
        )}
      >
        <Sparkles className="h-5 w-5" aria-hidden />
      </button>
    </WithTooltip>
  );
}
