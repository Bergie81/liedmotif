'use client';

// The Assistant's place in the app shell: the launcher in the bottom right
// corner and the panel it opens. From `desk` up the panel is a sidebar the page
// makes room for (`--assistant` in globals.css), so the page being asked about
// stays in view and in use. Below `desk` there is no room for both: the panel
// covers the screen and behaves as a modal dialog.
//
// The conversation is created here, once per shell, so it outlives the pages
// the user moves between and ends with a reload.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Sparkles, X } from 'lucide-react';
import type { AssistantStanding } from '@liedmotif/shared';
import { WithTooltip } from '@/components/ui/tooltip';
import type { AnswerLinkTargets } from '@/lib/assistant/answer-links';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';
import { cn } from '@/lib/cn';
import { AnswerLinksContext, type AnswerLinks } from './assistant-markdown';
import { AssistantPanel } from './assistant-panel';
import { createAssistantConversation } from './conversation';

/** Tailwind's `desk` breakpoint (globals.css). */
const SIDEBAR_QUERY = '(min-width: 920px)';

function subscribeSidebarQuery(listener: () => void): () => void {
  const query = window.matchMedia(SIDEBAR_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** Whether the panel sits beside the page rather than over it. */
function usePanelBesidePage(): boolean {
  return useSyncExternalStore(
    subscribeSidebarQuery,
    () => window.matchMedia(SIDEBAR_QUERY).matches,
    () => false,
  );
}

export function AssistantDock({
  links,
  launcherHidden = false,
  standing: renderedStanding = null,
}: {
  /** The app pages and docs pages an answer may link this user to. */
  links: AnswerLinkTargets;
  /** The page has controls where the launcher sits. An open panel stays, and closes from its header. */
  launcherHidden?: boolean;
  /** Where the viewer stood with their allowance when the server rendered the page. */
  standing?: AssistantStanding | null;
}) {
  // The newest word on the allowance: the server's render, then whatever each
  // response reports, then a later render again.
  const [standing, setStanding] = useState(renderedStanding);
  const [seenStanding, setSeenStanding] = useState(renderedStanding);
  if (seenStanding !== renderedStanding) {
    setSeenStanding(renderedStanding);
    setStanding(renderedStanding);
  }
  const [conversation] = useState(() => createAssistantConversation({ onStanding: setStanding }));
  const [open, setOpen] = useState(false);
  const besidePage = usePanelBesidePage();
  const router = useRouter();
  const answerLinks = useMemo<AnswerLinks>(
    () => ({
      targets: links,
      onOpenAppPage(path) {
        router.push(path);
        // Over the page, the panel would hide the page the link led to.
        if (!besidePage) setOpen(false);
      },
    }),
    [links, router, besidePage],
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('assistant-open', open);
    return () => root.classList.remove('assistant-open');
  }, [open]);

  // Leaving the shell (signing out) ends an answer nobody will read.
  useEffect(() => () => conversation.stop(), [conversation]);

  const launcherLabel = open ? `Close ${ASSISTANT_NAME}` : `Ask ${ASSISTANT_NAME}`;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={!besidePage}>
      {launcherHidden ? null : (
        <WithTooltip label={launcherLabel} side="left">
          <DialogPrimitive.Trigger
            aria-label={launcherLabel}
            className={cn(
              'fixed right-4 z-30 grid h-12 w-12 place-items-center rounded-full border border-line-2 [background:var(--gradient-mini)] shadow-[var(--shadow-mini)] [transition:transform_.06s_ease,right_.15s_ease] active:scale-[0.97]',
              // Above the tab bar, and above the mini player when it is up.
              'bottom-[calc(var(--tab-h)+env(safe-area-inset-bottom,0px)+12px)] max-desk:rail-player:bottom-[calc(var(--tab-h)+var(--mini-h)+env(safe-area-inset-bottom,0px)+20px)]',
              // Beside the sidebar while it is open, in the page's own corner.
              'desk:bottom-6 desk:right-[calc(var(--assistant)+24px)]',
              open ? 'text-muted hover:text-paper' : 'text-lamp',
            )}
          >
            {open ? (
              <X className="h-5 w-5" aria-hidden />
            ) : (
              <Sparkles className="h-[22px] w-[22px]" aria-hidden />
            )}
          </DialogPrimitive.Trigger>
        </WithTooltip>
      )}
      <DialogPrimitive.Portal>
        {/* Rendered only while the panel is modal: it holds the page still under the full-screen panel. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-44" />
        <DialogPrimitive.Content
          ref={panelRef}
          aria-describedby={undefined}
          className={cn(
            'fixed inset-0 z-45 flex animate-pop-in flex-col bg-night text-paper outline-none',
            'desk:left-auto desk:z-30 desk:w-(--assistant-w) desk:border-l desk:border-line desk:bg-[var(--nav-bg)]',
          )}
          // Beside the page the user is here to type. Over the page, focusing
          // the field would raise the on-screen keyboard across the greeting.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (besidePage ? inputRef.current : panelRef.current)?.focus();
          }}
          // The sidebar stays open while the page beside it is used, and Escape
          // closes it only from inside: pressed in the page, it belongs to the page.
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (!panelRef.current?.contains(document.activeElement)) event.preventDefault();
          }}
        >
          <AnswerLinksContext.Provider value={answerLinks}>
            <AssistantPanel conversation={conversation} inputRef={inputRef} standing={standing} />
          </AnswerLinksContext.Provider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
