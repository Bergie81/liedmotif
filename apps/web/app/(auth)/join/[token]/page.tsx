// The invite claim page. Reachable signed out — the setup/login
// ladder never diverts it. A signed-in visitor is refused rather than having
// the account swapped underneath them; a dead link gets the one opaque
// refusal, whatever the reason it is dead.

import { headers } from 'next/headers';
import Link from 'next/link';
import { findClaimableLink } from '@liedmotif/db';
import { ClaimForm } from '@/components/auth/claim-form';
import { OneShotLinkPage } from '@/components/auth/one-shot-link-page';
import { cardClass, displayHeadingClass, eyebrowClass } from '@/components/ui/design-system';
import { INVALID_LINK_MESSAGE } from '@/lib/constants';
import { getDb } from '@/lib/db';
import { JOIN_BASE_PATH } from '@/lib/auth/link-urls';
import { linkTokenLookupAllowed } from '@/lib/http/request-limits';
import { getServerSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (await getServerSession()) {
    return (
      <OneShotLinkPage basePath={JOIN_BASE_PATH}>
        <p className={eyebrowClass}>Invite</p>
        <h1 className={`${displayHeadingClass} mt-3`}>You are already signed in</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          This invite link creates a new account, and you already have one open here. Sign out first
          if the invite is meant for you, or open the link on the invitee&apos;s own device.
        </p>
        <Link
          href="/"
          className="mt-6 text-[13.5px] font-semibold text-lamp underline-offset-4 hover:underline"
        >
          Back to your music
        </Link>
      </OneShotLinkPage>
    );
  }

  // The render answers whether a token works, so it is throttled like the
  // submit; over budget it fails closed into the same opaque refusal.
  const lookupBudget = linkTokenLookupAllowed(await headers());
  const invite = lookupBudget
    ? await findClaimableLink(getDb(), { kind: 'member_invite', token })
    : null;
  if (!invite) {
    return (
      <OneShotLinkPage basePath={JOIN_BASE_PATH}>
        <p className={eyebrowClass}>Invite</p>
        <h1 className={`${displayHeadingClass} mt-3`}>{INVALID_LINK_MESSAGE}</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          Ask the person who invited you for a fresh link.
        </p>
      </OneShotLinkPage>
    );
  }

  return (
    <OneShotLinkPage basePath={JOIN_BASE_PATH}>
      <p className={eyebrowClass}>You&apos;re invited</p>
      <h1 className={`${displayHeadingClass} mt-3`}>Welcome, {invite.label}</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-muted">
        This is your own space on Liedmotif: describe what the music is for, and it generates and
        keeps playing. Pick how you&apos;ll sign in from now on.
      </p>
      <div className={`${cardClass} mt-7`}>
        <ClaimForm token={token} invitedEmail={invite.email} />
      </div>
      <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
        Private by design · Only you can see your music
      </p>
    </OneShotLinkPage>
  );
}
