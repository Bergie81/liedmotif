import { notFound } from 'next/navigation';
import { getVoiceProfile } from '@liedmotif/db';
import { MyVoiceSetup } from '@/components/settings/voice/my-voice-setup';
import {
  SettingsColumns,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/settings/settings-ui';
import { getDb } from '@/lib/db';
import { requireAdmin } from '@/lib/session';
import { ownVoiceEnabled } from '@/lib/env';
import { buildVoiceProfileView } from '@/lib/voice';

export const dynamic = 'force-dynamic';

export default async function VoiceSettingsPage() {
  const session = await requireAdmin();
  if (!ownVoiceEnabled()) notFound();
  const db = getDb();
  const profile = await getVoiceProfile(db, session.user.id);
  const view = await buildVoiceProfileView(db, profile);
  return (
    <section>
      <SettingsPageHeader
        title="My voice"
        description="Record your own voice once, verify it with the music provider, and let vocal Sessions sing with it."
      />
      <SettingsColumns>
        <SettingsSection title="Voice profile">
          <MyVoiceSetup initial={view} />
        </SettingsSection>
      </SettingsColumns>
    </section>
  );
}
