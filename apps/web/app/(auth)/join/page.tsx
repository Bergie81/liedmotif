// Where the address bar points once the claim page has dropped its token, and
// so where a mid-flow refresh lands. Nothing was spent: the invite is consumed
// by the claim submit, not by opening it, so the original link still works.

import { OneShotLinkPage } from '@/components/auth/one-shot-link-page';
import { displayHeadingClass, eyebrowClass } from '@/components/ui/design-system';
import { JOIN_BASE_PATH } from '@/lib/link-urls';

export default function JoinWithoutTokenPage() {
  return (
    <OneShotLinkPage basePath={JOIN_BASE_PATH}>
      <p className={eyebrowClass}>Invite</p>
      <h1 className={`${displayHeadingClass} mt-3`}>Open your invite link again</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-muted">
        Your invite is not used yet. The link you were sent still works.
      </p>
    </OneShotLinkPage>
  );
}
