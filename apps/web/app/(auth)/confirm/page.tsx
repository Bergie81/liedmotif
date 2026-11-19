// Where the address bar points once the confirm page has dropped its token, and
// so where a mid-flow refresh lands. Nothing was spent: the link is consumed by
// the Confirm button, not by opening it, so the original link still works.

import { OneShotLinkPage } from '@/components/auth/one-shot-link-page';
import { displayHeadingClass, eyebrowClass } from '@/components/ui/design-system';
import { CONFIRM_BASE_PATH } from '@/lib/auth/link-urls';

export default function ConfirmWithoutTokenPage() {
  return (
    <OneShotLinkPage basePath={CONFIRM_BASE_PATH}>
      <p className={eyebrowClass}>Confirm email</p>
      <h1 className={`${displayHeadingClass} mt-3`}>Open your confirm link again</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-muted">
        Nothing is confirmed yet. The link in the mail still works.
      </p>
    </OneShotLinkPage>
  );
}
