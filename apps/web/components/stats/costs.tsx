'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { CostComparisonData, UnitCosts } from '@liedmotif/shared';
import { PricedQuantity } from '@/components/settings/cost-readout';
import { SettingsCard, SettingsFootnote, SettingsSection } from '@/components/settings/settings-ui';
import { costGroups, splitRows, type CostGroup } from './costs-model';
import { CostSplitChart } from './stats-charts';
import { emptyClass, Figure, RangedBody } from './stats-parts';
import type { RangedRead } from './use-ranged-read';

function GroupRows({ groups, costs }: { groups: CostGroup[]; costs: UnitCosts }) {
  return (
    <ul>
      {groups.map((group) => (
        <li
          key={group.key}
          className="border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-[14.5px] font-semibold text-paper">
              {group.label}
            </span>
            {group.estimate ? (
              <span className="shrink-0 font-mono text-[13px] text-paper">{group.estimate}</span>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] tracking-[0.05em] text-muted">
            <span>
              Music{' '}
              <PricedQuantity
                quantity={group.counts.tracks}
                unit="Tracks"
                costs={costs}
                costFirst
              />
            </span>
            <span>
              Covers{' '}
              <PricedQuantity
                quantity={group.counts.covers}
                unit="Covers"
                costs={costs}
                costFirst
              />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The Admin's Costs tab: what the instance's generation is estimated to have cost, by payer. */
export function Costs({ read }: { read: RangedRead<CostComparisonData> }) {
  const { data, range, loading, error, load } = read;
  const groups = useMemo(() => costGroups(data), [data]);
  const ownVersusMembers = useMemo(
    () => splitRows([groups.own, groups.members], data.unitCosts),
    [groups, data.unitCosts],
  );
  const perMember = useMemo(
    () => splitRows(groups.perMember, data.unitCosts),
    [groups, data.unitCosts],
  );

  return (
    <div className="mt-6">
      <SettingsSection title="Estimated cost">
        <SettingsCard>
          <RangedBody
            error={error}
            loading={loading}
            loadingLabel="Loading costs"
            onRetry={() => void load(range)}
          >
            {groups.priced ? (
              <div className="mb-6 flex flex-wrap gap-6">
                <Figure label="Total" value={groups.total.estimate ?? ''} />
                <Figure label="You" value={groups.own.estimate ?? ''} />
                <Figure label="Members" value={groups.members.estimate ?? ''} />
              </div>
            ) : (
              <p className={`${emptyClass} mb-4`}>
                No Unit costs are set, so only counts show. Set your prices under{' '}
                <Link href="/settings/providers" className="font-semibold text-paper">
                  Settings → Providers
                </Link>
                .
              </p>
            )}
            <div className="mb-6">
              <CostSplitChart rows={ownVersusMembers} subject="you against Members" />
            </div>
            <GroupRows groups={[groups.total, groups.own, groups.members]} costs={data.unitCosts} />
            <SettingsFootnote>
              Estimates, not an invoice. Every music and Cover attempt that may have been billed
              counts, uncertain ones included, at today's Unit costs — so changing a price reprices
              the past. Writing AI usage is only roughly covered by those prices. Days start at
              midnight in the budget timezone ({data.timezone}).
            </SettingsFootnote>
          </RangedBody>
        </SettingsCard>
      </SettingsSection>

      {error || loading ? null : (
        <SettingsSection title="By Member">
          <SettingsCard>
            {groups.perMember.length === 0 ? (
              <p className={emptyClass}>No Members yet.</p>
            ) : (
              <>
                <div className="mb-6">
                  <CostSplitChart rows={perMember} subject="by Member" />
                </div>
                <GroupRows groups={groups.perMember} costs={data.unitCosts} />
              </>
            )}
            <SettingsFootnote>
              Counts only — a Member's music and listening stay private. A deleted account's music
              and Cover costs stay under Former members.
            </SettingsFootnote>
          </SettingsCard>
        </SettingsSection>
      )}
    </div>
  );
}
