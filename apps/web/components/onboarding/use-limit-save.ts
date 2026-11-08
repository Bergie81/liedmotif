'use client';

import { useState } from 'react';
import { saveUsageLimits } from '@/lib/settings-client';
import type { LimitPatch } from './onboarding-limits-model';

/**
 * The write both spend screens make. It owns the failure message too, so neither
 * screen keeps its own copy of the same error state — and a screen advances only
 * when the ceiling actually stored.
 */
export function useLimitSave(onSaved: () => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(built: LimitPatch): Promise<void> {
    if (saving) return;
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    setSaving(true);
    const result = await saveUsageLimits(built.patch);
    setSaving(false);
    if (result.ok) onSaved();
    else setError(result.error);
  }

  return { saving, error, save };
}
