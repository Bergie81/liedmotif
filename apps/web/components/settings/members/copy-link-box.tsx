'use client';

// A one-shot link the Admin copies by hand, for a link the app does not mail.
// The URL is `APP_PUBLIC_URL` verbatim; whether it is a domain or a LAN IP is
// the deployer's business.

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { secondaryButtonClass } from '@/components/ui/form-styles';

export function CopyLinkBox({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard can be unavailable (http on LAN); the field below stays selectable.
    }
  }

  return (
    <div className="mt-3 rounded-card-sm border border-lamp/35 bg-lamp/[0.07] p-3">
      <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-lamp">
        {label}
      </p>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          aria-label={label}
          className="min-w-0 flex-1 rounded-[9px] border border-line bg-[var(--control-bg)] px-3 py-2 font-mono text-[12px] text-paper"
        />
        <button
          type="button"
          onClick={() => void copy()}
          className={cn(secondaryButtonClass, 'shrink-0')}
        >
          {copied ? (
            <Check className="h-4 w-4" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-2 text-[11.5px] leading-[1.5] text-dim">
        Copy it now — this link is shown once and works once.
      </p>
    </div>
  );
}
