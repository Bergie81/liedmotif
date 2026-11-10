'use client';

import { useEffect, useRef } from 'react';
import { onOutsideLibraryWrite } from '@/lib/offline/library-writes';

/**
 * Runs `reload` when the Library was written to from outside the page on
 * screen (`announceOutsideLibraryWrite`). For a list that keeps what it loaded
 * in its own state: its own buttons patch that state, and a write it did not
 * make is one it can only read again.
 */
export function useOutsideLibraryWrite(reload: () => void): void {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  useEffect(() => onOutsideLibraryWrite(() => latest.current()), []);
}
