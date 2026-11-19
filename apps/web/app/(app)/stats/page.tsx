import { DEFAULT_LISTENING_RANGE } from '@liedmotif/shared';
import { SettingsFrame } from '@/components/settings/settings-frame';
import { SettingsPageHeader } from '@/components/settings/settings-ui';
import { StatsTabs } from '@/components/stats/stats-tabs';
import { loadCostComparison } from '@/lib/stats/cost-comparison-data';
import { loadListeningStats } from '@/lib/stats/listening-stats-data';
import { requireAppAccess } from '@/lib/auth/session';

// Your Stats: the signed-in User's own listening to their own Tracks.
// Reached from the account menu, for Admin and Members alike; the Admin sees
// their own listening here and nobody else's. The Admin alone also gets the
// Costs tab — the one cross-user read, and aggregates only.
export const dynamic = 'force-dynamic';

export default async function YourStatsPage() {
  const { session, role } = await requireAppAccess();
  const [listening, costs] = await Promise.all([
    loadListeningStats(session.user.id, DEFAULT_LISTENING_RANGE),
    role === 'admin' ? loadCostComparison(session.user.id, DEFAULT_LISTENING_RANGE) : null,
  ]);

  return (
    <SettingsFrame>
      <section>
        <SettingsPageHeader
          title="Your music in numbers"
          crumbLabel="Your Stats"
          description="How much you listen to your own music. Only you can see this."
          parent={{ href: '/', label: 'Home' }}
        />
        <StatsTabs listening={listening} costs={costs} />
      </section>
    </SettingsFrame>
  );
}
