// The frame every one-shot-link screen renders in — invite claim, password
// reset, and email confirm, live token or dead one. It owns the token strip, so
// no branch of those pages can render without it: the refusal a rate-limited
// lookup shows is indistinguishable from a dead link, and the token behind it
// may still be live.

import { LiedmotifMark, LiedmotifWordmark } from '@/components/ui/design-system';
import { StripLinkToken } from './strip-link-token';

export function OneShotLinkPage({
  basePath,
  children,
}: {
  basePath: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-[460px] flex-col justify-center px-4 py-10 desk:px-10">
      <StripLinkToken basePath={basePath} />
      <div className="mb-10 flex items-center gap-3">
        <LiedmotifMark className="h-8 w-8" />
        <LiedmotifWordmark className="text-[22px]" />
      </div>
      {children}
    </main>
  );
}
