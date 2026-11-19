import { SettingsPageHeader } from '@/components/settings/settings-ui';
import { BackupsPanel } from '@/components/settings/backups-panel';
import { readBackupsOverview } from '@/lib/admin/backups';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function BackupsPage() {
  await requireAdmin();
  const overview = await readBackupsOverview(getDb(), Date.now());

  return (
    <section>
      <SettingsPageHeader
        title="Backups"
        description="Set when your database, music and covers are backed up, how many copies to keep, and run a backup now."
        docs={{ path: 'backups', label: 'How backups and restore work' }}
      />
      <BackupsPanel initial={overview} />
    </section>
  );
}
