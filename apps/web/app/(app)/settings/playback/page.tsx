import { getPersonalization, getPlaybackSettings } from '@liedmotif/db';
import { PersonalizationSection } from '@/components/settings/personalization-section';
import { PlaybackForm } from '@/components/settings/playback-form';
import { SettingsColumns, SettingsPageHeader } from '@/components/settings/settings-ui';
import { getDb } from '@/lib/db';
import { requireAppAccess } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function PlaybackSettingsPage() {
  const { session } = await requireAppAccess();
  const [settings, personalization] = await Promise.all([
    getPlaybackSettings(getDb(), session.user.id),
    getPersonalization(getDb(), session.user.id),
  ]);
  return (
    <section>
      <SettingsPageHeader
        title="Playback"
        description="Choose how one Track blends into the next."
      />
      <SettingsColumns>
        <PlaybackForm initial={settings} />
        <PersonalizationSection initialEnabled={personalization.enabled} />
      </SettingsColumns>
    </section>
  );
}
