'use client';

import { useEffect } from 'react';

/**
 * A link is how a one-shot token is delivered, so it arrives as a path
 * segment — and there it outlives the visit: browser history keeps it, and a
 * CDN or load balancer in front logs whole request paths by default, where a
 * live invite is a claimable account. The page holds the token in props for
 * the submit and shows `basePath` in the address bar from hydration onwards.
 */
export function StripLinkToken({ basePath }: { basePath: string }) {
  useEffect(() => {
    if (window.location.pathname === basePath) return;
    // Deferred past the commit: the App Router installs its own
    // `history.replaceState` from an effect at the root of the tree, which runs
    // after this one. A call that lands first bypasses the router, leaving its
    // canonical URL on the token — which the router then writes back into the
    // address bar the next time its state changes. `replaceState`, never
    // `pushState`: the entry holding the token has to be overwritten, not left
    // one Back press away.
    const deferred = setTimeout(() => window.history.replaceState(null, '', basePath));
    return () => clearTimeout(deferred);
  }, [basePath]);
  return null;
}
