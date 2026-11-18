'use client';

// Unit costs: the Admin's price per Track and per Cover that Estimated cost
// readouts multiply by. It sits with the
// providers because the prices describe what those providers charge. While both
// are 0 no estimate exists anywhere, so the panel says so instead of a price.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { unitCostsSet, type UnitCosts } from '@liedmotif/shared';
import { apiFetchJson } from '@/lib/api-fetch';
import { toast } from '@/lib/toast';
import { compactPrimaryButtonClass } from '@/components/ui/form-styles';
import {
  parseUnitCostsForm,
  unitCostsFormValues,
  type UnitCostsErrors,
  type UnitCostsFormValues,
} from './costs-panel-model';
import { ProfileField } from './profile-field';
import { SettingsCard, SettingsFeedback, SettingsFootnote } from './settings-ui';

export const UNIT_COSTS_HINT = 'Set unit costs to see estimates.';
const SAVE_KEY = 'unit-costs-save';

export function CostsPanel({ unitCosts }: { unitCosts: UnitCosts }) {
  const router = useRouter();
  const [values, setValues] = useState<UnitCostsFormValues>(() => unitCostsFormValues(unitCosts));
  const [errors, setErrors] = useState<UnitCostsErrors>({});
  const [saved, setSaved] = useState(unitCosts);
  const [busy, setBusy] = useState(false);

  function change(field: keyof UnitCosts, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  async function save() {
    if (busy) return;
    const parsed = parseUnitCostsForm(values);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setBusy(true);
    toast.dismiss(SAVE_KEY);
    const result = await apiFetchJson<{ unitCosts: UnitCosts }>(
      '/api/settings/unit-costs',
      'POST',
      parsed.patch,
    );
    if (result.ok) {
      setSaved(result.data.unitCosts);
      setValues(unitCostsFormValues(result.data.unitCosts));
      toast.success('Unit costs saved.', { key: SAVE_KEY });
      router.refresh();
    } else {
      toast.error(result.message, { key: SAVE_KEY });
    }
    setBusy(false);
  }

  return (
    <SettingsCard>
      <div className="space-y-4">
        <ProfileField
          label="Per Track"
          badge="USD"
          inputMode="decimal"
          value={values.perTrackUsd}
          maxLength={8}
          placeholder="0.00"
          error={errors.perTrackUsd}
          disabled={busy}
          onChange={(value) => change('perTrackUsd', value)}
        />
        <ProfileField
          label="Per Cover"
          badge="USD"
          inputMode="decimal"
          value={values.perCoverUsd}
          maxLength={8}
          placeholder="0.00"
          error={errors.perCoverUsd}
          disabled={busy}
          onChange={(value) => change('perCoverUsd', value)}
        />
      </div>

      {!unitCostsSet(saved) ? (
        <div className="mt-4">
          <SettingsFeedback kind="info">{UNIT_COSTS_HINT}</SettingsFeedback>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className={`${compactPrimaryButtonClass} mt-4`}
      >
        {busy ? 'Saving…' : 'Save unit costs'}
      </button>
      <SettingsFootnote>
        Whole cents, US dollars. Round up to absorb Writing AI tokens — estimates are count × price,
        never a bill.
      </SettingsFootnote>
    </SettingsCard>
  );
}
