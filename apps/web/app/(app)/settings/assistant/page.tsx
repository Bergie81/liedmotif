import { notFound } from 'next/navigation';
import { getAssistantTone } from '@liedmotif/db';
import { AssistantToneForm } from '@/components/settings/assistant-tone-form';
import {
  SettingsCard,
  SettingsColumns,
  SettingsFootnote,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/settings/settings-ui';
import { cachedAssistantAvailability } from '@/lib/assistant/availability';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';
import { getDb } from '@/lib/db';
import { requireAppAccess } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function AssistantTonePage() {
  const { session, role } = await requireAppAccess();
  const db = getDb();
  const { available } = await cachedAssistantAvailability(db, session.user.id, role);
  if (!available) notFound();
  const tone = await getAssistantTone(db, session.user.id);
  return (
    <section>
      <SettingsPageHeader
        title={ASSISTANT_NAME}
        description={`Choose how ${ASSISTANT_NAME}, the Assistant, talks to you.`}
      />
      <SettingsColumns>
        <SettingsSection title="Tone">
          <SettingsCard>
            <AssistantToneForm initial={tone} />
          </SettingsCard>
          <SettingsFootnote>
            A tone changes the wording only. What {ASSISTANT_NAME} can do stays the same, and it
            still asks before anything that costs.
          </SettingsFootnote>
        </SettingsSection>
      </SettingsColumns>
    </section>
  );
}
