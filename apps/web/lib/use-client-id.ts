import { useRef } from 'react';
import { makeUuid } from './uuid';

/**
 * A per-mount client id: a stable UUID minted once on first render and kept for the
 * component's lifetime. Tags a browser's session-control and playback calls (the
 * `clientId` the session/playback contracts carry) so the server can attribute them
 * to one client without ever reading state set after mount.
 */
export function useClientId(): string {
  const ref = useRef<string>('');
  if (ref.current === '') ref.current = makeUuid();
  return ref.current;
}
