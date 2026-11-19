// Confirm a sign-in address from the one-shot link mailed to it. Reachable
// signed out, so the link works on whatever device reads the mail; a dead link
// gets the opaque refusal. Opening the page spends nothing — mail scanners open
// links before the reader does — the button does.

import { headers } from 'next/headers';
import { findClaimableLink } from '@liedmotif/db';
import { ConfirmEmailForm } from '@/components/auth/confirm-email-form';
import { OneShotLinkPage } from '@/components/auth/one-shot-link-page';
import { cardClass, displayHeadingClass, eyebrowClass } from '@/components/ui/design-system';
import { INVALID_LINK_MESSAGE } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { CONFIRM_BASE_PATH } from '@/lib/auth/link-urls';
import { linkTokenLookupAllowed } from '@/lib/http/request-limits';

export const dynamic = 'force-dynamic';

export default async function ConfirmEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Throttled like the submit — the render answers whether a token works —
  // and over budget it fails closed into the same opaque refusal.
  const link = linkTokenLookupAllowed(await headers())
    ? await findClaimableLink(getDb(), { kind: 'email_confirm', token })
    : null;

  return (
    <OneShotLinkPage basePath={CONFIRM_BASE_PATH}>
      <p className={eyebrowClass}>Confirm email</p>
      {link ? (
        <>
          <h1 className={`${displayHeadingClass} mt-3`}>Confirm your email</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            Confirm that <span className="text-paper">{link.label}</span> belongs to your Liedmotif
            account. This link works once.
          </p>
          <div className={`${cardClass} mt-7`}>
            <ConfirmEmailForm token={token} />
          </div>
        </>
      ) : (
        <>
          <h1 className={`${displayHeadingClass} mt-3`}>{INVALID_LINK_MESSAGE}</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            Send a fresh confirm link from Settings → Profile.
          </p>
        </>
      )}
    </OneShotLinkPage>
  );
}
