'use client';

import { useCallback, useRef, useState } from 'react';
import type { ListeningRange } from '@liedmotif/shared';
import type { ApiResult } from '@/lib/http/api-client';

/**
 * One period-switched read: the answer on screen, the range being asked for,
 * and a `load` that may run a step first (saving a setting the answer depends on).
 */
export function useRangedRead<T extends { range: ListeningRange }>(
  initial: T,
  fetcher: (range: ListeningRange) => Promise<ApiResult<T>>,
  failureMessage: string,
) {
  const [data, setData] = useState(initial);
  const [range, setRange] = useState<ListeningRange>(initial.range);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request may land: a slow 30-day answer must not overwrite
  // the 7-day view chosen after it.
  const requestRef = useRef(0);

  const load = useCallback(
    async (next: ListeningRange, before?: () => Promise<string | null>) => {
      const request = ++requestRef.current;
      setRange(next);
      setLoading(true);
      setError(null);
      const failure = (await before?.()) ?? null;
      const result = failure === null ? await fetcher(next) : null;
      if (request !== requestRef.current) return;
      setLoading(false);
      if (result?.ok) setData(result.data);
      else setError(failure ?? failureMessage);
    },
    [fetcher, failureMessage],
  );

  return { data, range, loading, error, load };
}

export type RangedRead<T extends { range: ListeningRange }> = ReturnType<typeof useRangedRead<T>>;
