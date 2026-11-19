'use client';

// The shared Members Pool: current usage against the caps, the four editable
// windows, and the over-subscription warning — a warning, never a refusal.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PoolOverSubscription, UnitCosts } from '@liedmotif/shared';
import { apiFetchJson } from '@/lib/http/api-fetch';
import { compactPrimaryButtonClass } from '@/components/ui/form-styles';
import type { MembersAdminData } from '@/lib/settings/members-admin-data';
import { toast } from '@/lib/toast';
import { BudgetUsageMeters, MEMBER_TRACK_LABELS } from '../budget-meters';
import { SettingsCard, SettingsFeedback, SettingsFootnote } from '../settings-ui';
import { MemberBudgetFields } from './member-budget-fields';
import {
  buildMemberBudgetPatch,
  memberBudgetFormValues,
  overSubscriptionMessage,
} from './members-admin-model';
import { useMemberBudgetForm } from './use-member-budget-form';

const SAVE_KEY = 'pool-save';

export function PoolPanel({
  pool,
  poolFigures,
  overSubscription,
  tracksPerCall,
  minHeadroomTracks,
  unitCosts,
}: {
  pool: MembersAdminData['pool'];
  poolFigures: MembersAdminData['poolFigures'];
  overSubscription: PoolOverSubscription[];
  tracksPerCall: number;
  minHeadroomTracks: number;
  unitCosts: UnitCosts;
}) {
  const router = useRouter();
  // The Pool shares the Member budget's four window fields, so the same form
  // model applies; maxConcurrentJobs stays a stored default, not edited here.
  const { values, errors, change, setErrors } = useMemberBudgetForm(() =>
    memberBudgetFormValues(pool, tracksPerCall),
  );
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState(overSubscription);
  // A Member budget save or delete elsewhere on the page changes the Pool's
  // over-subscription and arrives here only as a new prop from router.refresh().
  const [seenOverSubscription, setSeenOverSubscription] = useState(overSubscription);
  if (seenOverSubscription !== overSubscription) {
    setSeenOverSubscription(overSubscription);
    setWarnings(overSubscription);
  }

  async function save() {
    if (busy) return;
    const parsed = buildMemberBudgetPatch(values, tracksPerCall);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setBusy(true);
    toast.dismiss(SAVE_KEY);
    const result = await apiFetchJson<{ overSubscription: PoolOverSubscription[] }>(
      '/api/settings/members/pool',
      'POST',
      parsed.patch,
    );
    if (result.ok) {
      setWarnings(result.data.overSubscription ?? []);
      toast.success('Shared budget saved.');
      router.refresh();
    } else {
      toast.error(result.message, { key: SAVE_KEY });
    }
    setBusy(false);
  }

  return (
    <SettingsCard>
      <BudgetUsageMeters
        usage={{ kind: 'rolling', figures: poolFigures }}
        trackLabels={MEMBER_TRACK_LABELS}
        unitCosts={unitCosts}
      />

      <div className="mt-2 border-t border-line pt-1">
        <MemberBudgetFields
          values={values}
          errors={errors}
          disabled={busy}
          unitCosts={unitCosts}
          tracksPerCall={tracksPerCall}
          minHeadroomTracks={minHeadroomTracks}
          onChange={change}
        />
      </div>

      {warnings.map((warning) => (
        <div key={warning.field} className="mt-3">
          <SettingsFeedback kind="error">
            {overSubscriptionMessage(warning, tracksPerCall)}
          </SettingsFeedback>
        </div>
      ))}

      <button
        type="button"
        onClick={() => void save()}
        disabled={busy}
        className={`${compactPrimaryButtonClass} mt-4`}
      >
        {busy ? 'Saving…' : 'Save shared budget'}
      </button>
      <SettingsFootnote>
        Every Member generation needs headroom in their own budget AND here. The Admin&apos;s own
        listening never draws from this pool.
      </SettingsFootnote>
    </SettingsCard>
  );
}
