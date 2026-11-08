'use client';

// The personal-analytics meter of one playing surface: created on
// first use, observed once a second while the surface plays, saved when the
// page hides, and ended when the surface unmounts.

import { useCallback, useEffect, useRef } from 'react';
import { isOnline } from '@/lib/online-state';
import { createAudibleAdvanceProbe, type ListeningMeter } from './listening-meter';
import { createReportingMeter, flushOnPageHide } from './listening-sender';

/**
 * Listening is credited only while `read`'s position moves and the app itself
 * is audible: `playing` over a stalled fetch is buffering, not listening.
 * Leaving `playing` observes the stop at once, so a pause saves what was heard.
 * Nor is it credited while the app is offline: listening offline is never
 * recorded, and reports are cumulative, so time credited then would reach the
 * server with the first report after the connection returns.
 */
export function useListeningMeter(
  playing: boolean,
  read: () => { position: number | null; audible: boolean },
): () => ListeningMeter {
  const meterRef = useRef<ListeningMeter | null>(null);
  const meter = useCallback(() => (meterRef.current ??= createReportingMeter()), []);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });

  useEffect(() => {
    if (!playing) return;
    const advancing = createAudibleAdvanceProbe(() => readRef.current());
    const id = setInterval(() => meterRef.current?.observe(advancing() && isOnline()), 1000);
    return () => {
      clearInterval(id);
      meterRef.current?.observe(false);
    };
  }, [playing]);

  useEffect(() => {
    const stopFlushing = flushOnPageHide(() => meterRef.current);
    return () => {
      stopFlushing();
      meterRef.current?.end('stopped');
    };
  }, []);

  return meter;
}
