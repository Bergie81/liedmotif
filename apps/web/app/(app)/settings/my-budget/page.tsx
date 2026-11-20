import { redirect } from 'next/navigation';
import { BudgetUsageMeters } from '@/components/settings/budget-meters';
import {
  SettingsCard,
  SettingsColumns,
  SettingsFootnote,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/settings/settings-ui';
import { oneTimeBudgetUsedUpMessage } from '@liedmotif/shared';
import { loadMyBudgetData, type MyBudgetPageData } from '@/lib/budget/my-budget-data';
import { requireAppAccess } from '@/lib/auth/session';

// Read-only: the Member's own usage and the shared Pool's, in Tracks and
// covers, plus who pays. No knob a Member can turn — nothing here may hint
// that they could raise a limit. The Admin's own usage lives on
// their Limits page instead.
export const dynamic = 'force-dynamic';

/** The Member's own budget, per its kind, with the one line that says what happens next. */
function YourBudget({ data }: { data: MyBudgetPageData }) {
  const { yours, payerName } = data;
  if (yours.kind === 'rolling') {
    return (
      <>
        <BudgetUsageMeters usage={yours} />
        <SettingsFootnote>
          New tracks and covers when a window resets — daily at midnight, monthly on the 1st (
          {data.resetTimezone}).
        </SettingsFootnote>
      </>
    );
  }
  // A One-time budget never resets: once the Tracks are gone the only way to
  // more is the Admin, so the footnote says so rather than promising a date.
  return (
    <>
      <BudgetUsageMeters usage={yours} />
      <SettingsFootnote>
        {yours.tracks.remaining === 0
          ? oneTimeBudgetUsedUpMessage(payerName)
          : `A one-time budget — it does not reset. When it runs out, ask ${payerName ?? 'the Admin'} for more.`}
      </SettingsFootnote>
    </>
  );
}

export default async function MyBudgetPage() {
  const { session } = await requireAppAccess();
  // Only a Member has the two bounds this page shows; the Admin's own usage
  // lives on their Limits page instead.
  const data = await loadMyBudgetData(session.user.id);
  if (!data) redirect('/settings/generation#cost-controls');

  return (
    <section>
      <SettingsPageHeader
        title="My budget"
        description="What you can generate right now — your own budget, and the shared one every member draws from."
      />
      <SettingsColumns>
        <SettingsSection title="Yours">
          <SettingsCard>
            <YourBudget data={data} />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Shared Budget">
          <SettingsCard>
            <BudgetUsageMeters usage={{ kind: 'rolling', figures: data.shared }} />
            <SettingsFootnote>
              The shared budget covers everyone&apos;s generations together, first come, first
              served. Your own budget applies within it.
            </SettingsFootnote>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Who Pays">
          <SettingsCard>
            <p className="text-[13px] leading-relaxed text-muted">
              Every generation here is paid for by{' '}
              <b className="font-semibold text-paper">{data.payerName ?? 'the instance owner'}</b>.
            </p>
          </SettingsCard>
        </SettingsSection>
      </SettingsColumns>
    </section>
  );
}
