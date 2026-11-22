import { getCoverArtSettings } from '@liedmotif/db';
import { CoverArtForm } from '@/components/settings/cover-art-form';
import {
  SettingsCard,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/settings/settings-ui';
import { getDb } from '@/lib/db';
import { requireAppAccess } from '@/lib/auth/session';
import { getLlmProvider } from '@/lib/providers/providers';

export const dynamic = 'force-dynamic';

export default async function CoverArtPage() {
  const { session } = await requireAppAccess();
  const db = getDb();
  const [settings, llmProvider] = await Promise.all([
    getCoverArtSettings(db, session.user.id),
    getLlmProvider().catch(() => null),
  ]);

  return (
    <section>
      <SettingsPageHeader
        title="Cover Art"
        description="Choose the look of generated session covers."
      />

      <div className="mt-6">
        <SettingsSection title="Default Style">
          <SettingsCard>
            <CoverArtForm initial={settings} llmConfigured={llmProvider !== null} />
          </SettingsCard>
        </SettingsSection>
      </div>
    </section>
  );
}
