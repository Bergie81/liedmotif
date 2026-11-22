'use client';

// The Assistant's place in the app shell: the launcher in the bottom right
// corner and the panel it opens. From `desk` up the panel is a sidebar the page
// makes room for (`--assistant` in globals.css), so the page being asked about
// stays in view and in use. Below `desk` there is no room for both: the panel
// covers the screen and behaves as a modal dialog.
//
// The conversation is created here, once per shell, so it outlives the pages
// the user moves between and ends with a reload. Whether the panel is open is
// the shell's to hold: a page without the launcher opens it from its own header.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type {
  AssistantAction,
  AssistantPlayerState,
  AssistantReceipt,
  AssistantStanding,
} from '@liedmotif/shared';
import { AssistantGlyph } from '@/components/ui/glyphs';
import { DESK_MEDIA_QUERY } from '@/lib/constants';
import { WithTooltip } from '@/components/ui/tooltip';
import type { AnswerLinkTargets } from '@/lib/assistant/answer-links';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';
import { cn } from '@/lib/cn';
import { announceOutsideLibraryWrite } from '@/lib/offline/library-writes';
import { AnswerLinksContext, type AnswerLinks } from './assistant-markdown';
import { AssistantPanel } from './assistant-panel';
import type { ProposedChatAction } from './card';
import { confirmCard } from './confirm-card';
import { createAssistantConversation } from './conversation';
import { applyCover, followCover } from './cover-card';
import type { PlayerChatAction, PlayerCommands } from './player-command';
import { TapToPlayContext } from './player-command-line';
import { CardsContext, type Cards } from './proposal-card';
import { RECEIPT_REREADS } from './receipt';
import type { CardHost } from './use-card-host';

const SIDEBAR_QUERY = DESK_MEDIA_QUERY;

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
  open,
  onOpenChange: setOpen,
  pageCarriesPhoneLauncher = false,
  standing: renderedStanding = null,
  player,
  onReceipt,
  playerCommands,
  cards: cardHost,
}: {
  /** The app pages and docs pages an answer may link this user to. */
  links: AnswerLinkTargets;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * On a phone the page has controls where the launcher sits, and carries its
   * own (`AssistantLauncherButton`). Beside the page that corner is free.
   */
  pageCarriesPhoneLauncher?: boolean;
  /** Where the viewer stood with their allowance when the server rendered the page. */
  standing?: AssistantStanding | null;
  /** What the player has engaged right now; every question takes it along. */
  player?: AssistantPlayerState;
  /** The Assistant did something on the server: what the shell shows of it may have to follow. */
  onReceipt?: (receipt: AssistantReceipt) => void;
  /** The player's own actions, for the commands the Assistant hands over. */
  playerCommands?: PlayerCommands;
  /** What the app lends a card. Without it a card can be read and not confirmed. */
  cards?: CardHost;
}) {
  // The newest word on the allowance: the server's render, then whatever each
  // response reports, then a later render again.
  const [standing, setStanding] = useState(renderedStanding);
  const [seenStanding, setSeenStanding] = useState(renderedStanding);
  if (seenStanding !== renderedStanding) {
    setSeenStanding(renderedStanding);
    setStanding(renderedStanding);
  }
  // The conversation outlives every render, so it reads the player through a
  // ref: a question carries what is engaged when it is sent.
  const playerRef = useRef(player);
  useEffect(() => {
    playerRef.current = player;
  }, [player]);
  const router = useRouter();
  // What the app around the chat does the moment an action arrives. The chat
  // itself only shows the action; this is where the rest of the app follows.
  const followActionRef = useRef<(action: AssistantAction) => void>(() => {});
  // Sending is the one gesture a command's audio can ride on: the player's
  // audio is unlocked inside it, before the answer that may start it exists.
  const playerCommandsRef = useRef(playerCommands);
  useEffect(() => {
    playerCommandsRef.current = playerCommands;
  }, [playerCommands]);
  const [conversation] = useState(() =>
    createAssistantConversation({
      onStanding: setStanding,
      onAction: (action) => followActionRef.current(action),
      onSend: () => playerCommandsRef.current?.prime(),
      getPlayer: () => playerRef.current,
    }),
  );
  useEffect(() => {
    followActionRef.current = (action) => {
      switch (action.status) {
        case 'done': {
          // What the app's own buttons do after a write: the router drops the
          // pages it cached, and the page on screen reloads.
          const rereads = RECEIPT_REREADS[action.receipt.action];
          if (rereads !== 'nothing') router.refresh();
          if (rereads === 'library') announceOutsideLibraryWrite();
          onReceipt?.(action.receipt);
          break;
        }
        case 'player':
          void playerCommands
            ?.run(action.command)
            .then((outcome) => conversation.settleAction(action, outcome));
          break;
        case 'proposed':
          cardHost?.refreshHeadroom();
          // Preparing a Surprise Me replaced the pending suggestion on the
          // server, which Home shows too.
          if (action.card.kind === 'surprise') router.refresh();
          break;
      }
    };
  }, [router, onReceipt, playerCommands, cardHost, conversation]);
  const tapToPlay = useCallback(
    (action: PlayerChatAction) =>
      void playerCommands
        ?.tapToPlay()
        .then((outcome) => conversation.settleAction(action, outcome)),
    [playerCommands, conversation],
  );
  const besidePage = usePanelBesidePage();
  const answerLinks = useMemo<AnswerLinks>(
    () => ({
      targets: links,
      onOpenAppPage(path) {
        router.push(path);
        // Over the page, the panel would hide the page the link led to.
        if (!besidePage) setOpen(false);
      },
    }),
    [links, router, besidePage, setOpen],
  );
  const confirm = useCallback(
    (action: ProposedChatAction, targetDurationMinutes?: number | null) => {
      if (!cardHost) return;
      confirmCard(
        action,
        {
          conversation,
          host: cardHost,
          onPlayerShown() {
            if (!besidePage) setOpen(false);
          },
        },
        targetDurationMinutes,
      );
    },
    [conversation, cardHost, besidePage, setOpen],
  );
  const cards = useMemo<Cards | null>(
    () =>
      cardHost
        ? {
            headroom: cardHost.headroom,
            vibeChangeInFlight: cardHost.vibeChangeInFlight,
            coverStatus: cardHost.coverStatus,
            confirm,
            followCover: (action, signal) =>
              followCover(action, { conversation, host: cardHost }, signal),
            applyCover: (action) => applyCover(action, { conversation, host: cardHost }),
          }
        : null,
    [cardHost, confirm, conversation],
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
      {pageCarriesPhoneLauncher && !besidePage ? null : (
        <WithTooltip label={launcherLabel} side="left">
          <DialogPrimitive.Trigger
            aria-label={launcherLabel}
            className={cn(
              'fixed right-4 z-30 grid h-16 w-16 place-items-center rounded-full border border-line-2 [background:var(--gradient-mini)] shadow-[var(--shadow-mini)] [transition:transform_.06s_ease,right_.15s_ease] active:scale-[0.97]',
              // Above the tab bar, and above the mini player when it is up.
              'bottom-[calc(var(--tab-h)+env(safe-area-inset-bottom,0px)+12px)] max-desk:rail-player:bottom-[calc(var(--tab-h)+var(--mini-h)+env(safe-area-inset-bottom,0px)+20px)]',
              // Beside the sidebar while it is open, in the page's own corner.
              'desk:bottom-6 desk:right-[calc(var(--assistant)+24px)]',
              open ? 'text-muted hover:text-paper' : 'text-lamp',
            )}
          >
            {open ? (
              <X className="h-[27px] w-[27px]" aria-hidden />
            ) : (
              <AssistantGlyph className="h-[29px] w-[29px]" />
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
            <TapToPlayContext.Provider value={tapToPlay}>
              <CardsContext.Provider value={cards}>
                <AssistantPanel
                  conversation={conversation}
                  inputRef={inputRef}
                  standing={standing}
                />
              </CardsContext.Provider>
            </TapToPlayContext.Provider>
          </AnswerLinksContext.Provider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
