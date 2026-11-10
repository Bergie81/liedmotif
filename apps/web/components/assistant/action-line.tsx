'use client';

// What the Assistant did, as the chat shows it: one quiet line per action,
// under the answer it happened in. The line is worded here from the action's
// structured values, so nothing the model writes can label an action as
// something else.

import { useContext } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { AssistantReceipt } from '@liedmotif/shared';
import { AnswerLinksContext, appPageButtonClass } from './assistant-markdown';
import type { ChatAction } from './chat-actions';
import { receiptLine } from './receipt';

export function ActionLine({ action }: { action: ChatAction }) {
  switch (action.status) {
    case 'done':
      return <ReceiptLine receipt={action.receipt} />;
  }
}

/**
 * A receipt for something the server did. Its link goes to where the thing now
 * is: a path built here from the receipt's own id, so it may lead to a page
 * with an id in it, which a link in an answer never does.
 */
function ReceiptLine({ receipt }: { receipt: AssistantReceipt }) {
  const links = useContext(AnswerLinksContext);
  const { text, link } = receiptLine(receipt);
  return (
    <div className="flex items-center gap-2 text-[13px] leading-[1.45] text-muted">
      <Check className="h-3.5 w-3.5 flex-none text-lamp" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
      {links ? (
        <button
          type="button"
          aria-label={`Open ${link.place}`}
          onClick={() => links.onOpenAppPage(link.path)}
          className={`${appPageButtonClass} flex-none`}
        >
          Open
          <ArrowRight className="h-3 w-3 flex-none" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
