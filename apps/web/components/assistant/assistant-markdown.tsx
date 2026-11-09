'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { ArrowRight, ExternalLink } from 'lucide-react';
import Markdown, { type MarkdownToJSX } from 'markdown-to-jsx/react';
import { resolveAnswerLink, type AnswerLinkTargets } from '@/lib/assistant/answer-links';
import { cn } from '@/lib/cn';

export interface AnswerLinks {
  /** Where this user's answers may lead. */
  targets: AnswerLinkTargets;
  /** Go to a page of the app, by its path. */
  onOpenAppPage: (path: string) => void;
}

/** Without a provider no link is followed: every link shows as its text. */
export const AnswerLinksContext = createContext<AnswerLinks | null>(null);

/**
 * A link the model wrote. The model can write any target, so a link is
 * followed only where `resolveAnswerLink` finds it among the user's targets: a
 * page of the app becomes a button that goes there, a docs page opens on the
 * website. Any other link shows as its text. This component is the one place
 * that decides what a link in an answer becomes.
 */
function AnswerLink({ href, children }: { href?: string; children?: ReactNode }) {
  const links = useContext(AnswerLinksContext);
  const link = links ? resolveAnswerLink(href, links.targets) : null;
  if (links && link?.kind === 'app') {
    return (
      <button
        type="button"
        onClick={() => links.onOpenAppPage(link.path)}
        className="mx-0.5 inline-flex items-center gap-1 rounded-full border border-line-2 bg-[var(--control-bg)] px-2.5 py-0.5 align-baseline text-[13px] font-medium text-lamp [-webkit-tap-highlight-color:transparent] hover:bg-[var(--control-bg-hover)]"
      >
        {children}
        <ArrowRight className="h-3 w-3 flex-none" aria-hidden />
      </button>
    );
  }
  if (link?.kind === 'docs') {
    return (
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-line-2 underline-offset-[3px] hover:decoration-current"
      >
        {children}
        <ExternalLink className="ml-1 inline h-3 w-3 align-[-1px] text-muted" aria-hidden />
      </a>
    );
  }
  return <span>{children}</span>;
}

/** An image would load from an address the model chose; only its description shows. */
function AnswerImage({ alt }: { alt?: string }) {
  return alt ? <span>{alt}</span> : null;
}

const BASE_OPTIONS: MarkdownToJSX.Options = {
  // HTML in an answer stays the text it is; nothing the model writes becomes an
  // element except through Markdown.
  disableParsingRawHTML: true,
  forceBlock: true,
  forceWrapper: true,
  wrapper: 'div',
  overrides: { a: AnswerLink, img: AnswerImage },
};
// Half-written syntax (an unclosed `**`) stays hidden until its other end arrives.
const STREAMING_OPTIONS: MarkdownToJSX.Options = { ...BASE_OPTIONS, optimizeForStreaming: true };

const answerClass = cn(
  'min-w-0 break-words text-[14.5px] leading-[1.55] text-paper',
  '[&>div>*:first-child]:mt-0 [&>div>*:last-child]:mb-0',
  '[&_p]:my-2 [&_strong]:font-semibold',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
  '[&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:font-display [&_h1]:text-[16px] [&_h1]:font-bold',
  '[&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:font-display [&_h2]:text-[15.5px] [&_h2]:font-bold',
  '[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-[14.5px] [&_h3]:font-semibold',
  '[&_code]:rounded-[5px] [&_code]:bg-[var(--control-bg-hover)] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[13px]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-card-sm [&_pre]:border [&_pre]:border-line [&_pre]:bg-[var(--field-bg)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-line-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted',
  '[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border-t [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold',
  '[&_hr]:my-3 [&_hr]:border-line',
);

/** An Assistant answer, formatted from the Markdown the model wrote. */
export function AssistantMarkdown({
  children,
  streaming = false,
}: {
  children: string;
  /** The answer is still being written. */
  streaming?: boolean;
}) {
  return (
    <div className={answerClass}>
      <Markdown options={streaming ? STREAMING_OPTIONS : BASE_OPTIONS}>{children}</Markdown>
    </div>
  );
}
