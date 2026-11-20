// Settings → Members, Admin-only: mint invites, see each Member's
// aggregate usage, adjust budgets and Assistant access, reset passwords,
// disable — never a window into anyone's music.

import { formatUsd } from '@liedmotif/shared';
import { AssistantDefaultPanel } from '@/components/settings/members/assistant-access-controls';
import { InviteMembersSection } from '@/components/settings/members/invite-members-section';
import { MemberCards } from '@/components/settings/members/member-cards';
import { membersCostSummary } from '@/components/settings/members/members-admin-model';
import { PoolPanel } from '@/components/settings/members/pool-panel';
import {
  SettingsCard,
  SettingsColumns,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/settings/settings-ui';
import { isAccountEmailEnabled } from '@/lib/env';
import { loadMembersAdminData } from '@/lib/settings/members-admin-data';
import { getLlmProvider } from '@/lib/providers/providers';
import { requireAdmin } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function MembersSettingsPage() {
  await requireAdmin();
  const [data, llm] = await Promise.all([
    loadMembersAdminData(),
    getLlmProvider().catch(() => null),
  ]);
  // The Assistant runs on the text LLM: without one there is no access to set.
  const assistantDefault = llm ? data.assistantDefault : null;
  const costSummary = membersCostSummary(data.members, data.unitCosts);

  return (
    <section>
      <SettingsPageHeader
        title="Members"
        description="Invite family and friends to their own private space, using your provider keys within budgets you set."
        docs={{ path: 'members', label: 'How members and budgets work' }}
      />
      {costSummary ? (
        <SettingsCard className="mt-6">
          <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-dim">
            Estimated Cost
          </p>
          {costSummary.rolling ? (
            <p className="text-[13px] leading-relaxed text-muted">
              Rolling: up to {formatUsd(costSummary.rolling.maxPerMonth)} / month, used{' '}
              {formatUsd(costSummary.rolling.usedThisMonth)} this month
            </p>
          ) : null}
          {costSummary.oneTime ? (
            <p className="text-[13px] leading-relaxed text-muted">
              One-time: {formatUsd(costSummary.oneTime.outstanding)} outstanding, used{' '}
              {formatUsd(costSummary.oneTime.used)}
            </p>
          ) : null}
        </SettingsCard>
      ) : null}
      <SettingsColumns>
        <SettingsSection title="Invite Someone">
          <InviteMembersSection
            invites={data.invites}
            inviteByEmail={isAccountEmailEnabled()}
            defaultBudget={data.defaultBudget}
            tracksPerCall={data.tracksPerCall}
            minHeadroomTracks={data.minHeadroomTracks}
            unitCosts={data.unitCosts}
            timezone={data.timezone}
          />
        </SettingsSection>

        <SettingsSection title="Members">
          <MemberCards
            members={data.members}
            tracksPerCall={data.tracksPerCall}
            minHeadroomTracks={data.minHeadroomTracks}
            unitCosts={data.unitCosts}
            assistantDefault={assistantDefault}
            timezone={data.timezone}
          />
        </SettingsSection>

        <SettingsSection title="Shared Budget">
          <PoolPanel
            pool={data.pool}
            poolFigures={data.poolFigures}
            overSubscription={data.overSubscription}
            tracksPerCall={data.tracksPerCall}
            minHeadroomTracks={data.minHeadroomTracks}
            unitCosts={data.unitCosts}
          />
        </SettingsSection>

        <SettingsSection title="Assistant">
          <AssistantDefaultPanel access={assistantDefault} />
        </SettingsSection>
      </SettingsColumns>
    </section>
  );
}
