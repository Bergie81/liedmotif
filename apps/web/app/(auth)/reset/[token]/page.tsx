// Set a new password from a one-shot reset link the Admin copied over
//. Reachable signed out; a dead link gets the opaque refusal.

import { headers } from 'next/headers';
import { findClaimableLink } from '@liedmotif/db';
import { OneShotLinkPage } from '@/components/auth/one-shot-link-page';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { cardClass, displayHeadingClass, eyebrowClass } from '@/components/ui/design-system';
import { INVALID_LINK_MESSAGE } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { RESET_BASE_PATH } from '@/lib/auth/link-urls';
import { linkTokenLookupAllowed } from '@/lib/http/request-limits';

export const dynamic = 'force-dynamic';

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Throttled like the submit — the render answers whether a token works —
  // and over budget it fails closed into the same opaque refusal.
  const link = linkTokenLookupAllowed(await headers())
    ? await findClaimableLink(getDb(), { kind: 'password_reset', token })
    : null;

  return (
    <OneShotLinkPage basePath={RESET_BASE_PATH}>
      <p className={eyebrowClass}>Password reset</p>
      {link ? (
        <>
          <h1 className={`${displayHeadingClass} mt-3`}>Pick a new password</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            This link works exactly once. Set the new password, then sign in with it.
          </p>
          <div className={`${cardClass} mt-7`}>
            <ResetPasswordForm token={token} />
          </div>
        </>
      ) : (
        <>
          <h1 className={`${displayHeadingClass} mt-3`}>{INVALID_LINK_MESSAGE}</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">Ask for a fresh reset link.</p>
        </>
      )}
    </OneShotLinkPage>
  );
}
