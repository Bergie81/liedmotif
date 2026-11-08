import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { docsUrl, type DocsPath } from '@/lib/docs-links';

// `noreferrer` matters: the app's Referrer-Policy would otherwise hand the
// website this private instance's origin on every click.
export const docsLinkTarget = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** An inline link to a page of the Liedmotif docs, opened in a new tab. */
export function DocsLink({
  path,
  children,
  className,
}: {
  path: DocsPath;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={docsUrl(path)}
      {...docsLinkTarget}
      className={cn(
        'inline-flex items-center gap-1 font-semibold text-lamp underline underline-offset-2 hover:text-paper',
        className,
      )}
    >
      {children}
      <ExternalLink className="h-3 w-3 flex-none" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
