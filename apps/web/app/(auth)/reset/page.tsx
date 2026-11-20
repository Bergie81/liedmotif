// Where the address bar points once the reset page has dropped its token, and
// so where a mid-flow refresh lands. Nothing was spent: the link is consumed by
// the new password, not by opening it, so the original link still works.

import { OneShotLinkPage } from '@/components/auth/one-shot-link-page';
import { displayHeadingClass, eyebrowClass } from '@/components/ui/design-system';
import { RESET_BASE_PATH } from '@/lib/auth/link-urls';

export default function ResetWithoutTokenPage() {
  return (
    <OneShotLinkPage basePath={RESET_BASE_PATH}>
      <p className={eyebrowClass}>Password Reset</p>
      <h1 className={`${displayHeadingClass} mt-3`}>Open Your Reset Link Again</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-muted">
        Your password has not changed yet. The link you were given still works.
      </p>
    </OneShotLinkPage>
  );
}
