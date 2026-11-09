'use client';

// What is inside the Assistant's panel: the conversation, and the field to ask
// from. Where the panel sits and how it opens belongs to `AssistantDock`.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowUp, Sparkles, Square, SquarePen, X } from 'lucide-react';
import {
  ASSISTANT_MAX_MESSAGE_LENGTH,
  type AssistantMessage,
  type AssistantStanding,
} from '@liedmotif/shared';
import { AlertBanner, chipClass, iconButtonClass } from '@/components/ui/design-system';
import { LiedmotifLoader } from '@/components/ui/loading';
import { WithTooltip } from '@/components/ui/tooltip';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';
import { cn } from '@/lib/cn';
import { AllowanceNotice, useAllowance } from './allowance-notice';
import { AssistantMarkdown } from './assistant-markdown';
import type { AssistantConversation } from './conversation';

const GREETING = `Hi, I'm ${ASSISTANT_NAME}. Ask me anything about your Liedmotif.`;

const SUGGESTED_QUESTIONS = [
  'What does New music do?',
  'How do I change the vibe of a Session?',
  'How do I keep a Track?',
  'How do I listen offline?',
];

/** The field stops growing here and scrolls instead. */
const INPUT_MAX_HEIGHT_PX = 140;

/** How close to the end of the conversation still counts as reading along. */
const FOLLOW_DISTANCE_PX = 80;

export function AssistantPanel({
  conversation,
  inputRef,
  standing,
}: {
  conversation: AssistantConversation;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Where the viewer stands with their daily allowance, as far as is known. */
  standing: AssistantStanding | null;
}) {
  const { messages, answering, draft, notice } = useSyncExternalStore(
    conversation.subscribe,
    conversation.getState,
    conversation.getState,
  );

  const allowance = useAllowance(standing);
  const usedUp = allowance?.remaining === 0;

  const ask = (text?: string) => {
    conversation.send(text);
    inputRef.current?.focus();
  };

  return (
    <>
      <header className="flex flex-none items-center gap-1 border-b border-line py-2 pl-4 pr-2 pt-[calc(8px+env(safe-area-inset-top,0px))]">
        <DialogPrimitive.Title className="flex min-w-0 flex-1 items-center gap-2 font-display text-[18px] font-bold tracking-[-0.01em]">
          <Sparkles className="h-[18px] w-[18px] flex-none text-lamp" aria-hidden />
          {ASSISTANT_NAME}
        </DialogPrimitive.Title>
        <WithTooltip label="New chat" side="bottom">
          <button
            type="button"
            aria-label="New chat"
            disabled={messages.length === 0}
            onClick={() => {
              conversation.newChat();
              inputRef.current?.focus();
            }}
            className={cn(iconButtonClass, 'disabled:opacity-35 disabled:hover:bg-transparent')}
          >
            <SquarePen className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </WithTooltip>
        <DialogPrimitive.Close aria-label={`Close ${ASSISTANT_NAME}`} className={iconButtonClass}>
          <X className="h-[19px] w-[19px]" aria-hidden />
        </DialogPrimitive.Close>
      </header>

      {messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-y-auto overscroll-contain px-4 py-5">
          <p className="font-display text-[19px] font-bold leading-[1.3] tracking-[-0.01em]">
            {GREETING}
          </p>
          <ul className="flex flex-col items-start gap-2">
            {SUGGESTED_QUESTIONS.map((question) => (
              <li key={question}>
                <button
                  type="button"
                  disabled={usedUp}
                  onClick={() => ask(question)}
                  className={cn(chipClass, 'text-left disabled:opacity-35')}
                >
                  {question}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Transcript messages={messages} answering={answering} />
      )}

      <footer className="flex flex-none flex-col gap-2 px-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] pt-2">
        {/* Where lines about asking show: why an answer did not arrive, and how
            much of today's allowance is left. */}
        {notice ? <AlertBanner>{notice}</AlertBanner> : null}
        <AllowanceNotice allowance={allowance} />
        <Composer
          inputRef={inputRef}
          draft={draft}
          answering={answering}
          disabled={usedUp}
          onDraftChange={conversation.setDraft}
          onSend={() => ask()}
          onStop={() => {
            conversation.stop();
            // The Stop button is gone with the answer; focus must not go with it.
            inputRef.current?.focus();
          }}
        />
      </footer>
    </>
  );
}

function Transcript({
  messages,
  answering,
}: {
  messages: readonly AssistantMessage[];
  answering: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Follows the answer as it is written, until the user scrolls up to read.
  const followingRef = useRef(true);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller && followingRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={scrollerRef}
      role="log"
      aria-label="Conversation"
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        followingRef.current = scrollHeight - scrollTop - clientHeight < FOLLOW_DISTANCE_PX;
      }}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4"
    >
      {messages.map((message, index) => {
        if (message.role === 'user') {
          return (
            <p
              key={index}
              className="max-w-[88%] self-end whitespace-pre-wrap break-words rounded-[16px] rounded-br-[5px] border border-line bg-panel-2 px-3.5 py-2 text-[14.5px] leading-[1.5]"
            >
              {message.content}
            </p>
          );
        }
        const writing = answering && index === messages.length - 1;
        return message.content ? (
          <AssistantMarkdown key={index} streaming={writing}>
            {message.content}
          </AssistantMarkdown>
        ) : (
          <p key={index} role="status" className="flex items-center gap-2 text-[13px] text-muted">
            <LiedmotifLoader />
            {ASSISTANT_NAME} is looking it up…
          </p>
        );
      })}
    </div>
  );
}

function Composer({
  inputRef,
  draft,
  answering,
  disabled,
  onDraftChange,
  onSend,
  onStop,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  answering: boolean;
  /** Nothing can be asked right now: the field and Send are closed. */
  disabled: boolean;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX_HEIGHT_PX)}px`;
  }, [draft, inputRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter is a new line. An Enter that confirms an input
    // method's suggestion belongs to the suggestion.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSend();
  };

  return (
    <form
      className="flex items-end gap-2 rounded-[16px] border border-line-2 bg-[var(--field-bg)] p-1.5 pl-3.5 shadow-[var(--shadow-field)] focus-within:border-lamp/60 focus-within:shadow-[0_0_0_3px_var(--lamp-glow)]"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <textarea
        ref={inputRef}
        rows={1}
        value={draft}
        disabled={disabled}
        maxLength={ASSISTANT_MAX_MESSAGE_LENGTH}
        aria-label={`Ask ${ASSISTANT_NAME}`}
        placeholder="Ask about Liedmotif"
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 resize-none self-center bg-transparent py-1.5 text-[15px] leading-[1.45] text-paper outline-none placeholder:text-dim disabled:cursor-not-allowed disabled:opacity-50"
      />
      {answering ? (
        <button
          type="button"
          aria-label="Stop the answer"
          onClick={onStop}
          className="grid h-9 w-9 flex-none place-items-center rounded-full border border-line-2 bg-[var(--control-bg)] text-paper hover:bg-[var(--control-bg-hover)]"
        >
          <Square className="h-[13px] w-[13px] fill-current" aria-hidden />
        </button>
      ) : (
        <button
          type="submit"
          aria-label="Send"
          disabled={disabled || !draft.trim()}
          className="grid h-9 w-9 flex-none place-items-center rounded-full text-[var(--on-lamp)] [background:var(--gradient-primary)] disabled:cursor-not-allowed disabled:opacity-35 disabled:grayscale-[0.7]"
        >
          <ArrowUp className="h-[18px] w-[18px]" aria-hidden />
        </button>
      )}
    </form>
  );
}
