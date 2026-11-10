import {
  AudioLines,
  Gauge,
  HardDrive,
  ListMusic,
  Sparkles,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';
import type { MemberSettingsHubData } from '@/lib/settings-hub-data';
import { SignOutButton } from './sign-out-button';
import {
  SettingsCard,
  SettingsColumns,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from './settings-ui';

/**
 * The Member's settings hub: only the entries a Member owns. Instance
 * configuration (providers, limits, instance storage, diagnostics, cover-art
 * defaults, Voice, Members) is neither rendered nor present in the payload;
 * Storage shows a Member only the offline music on their own device. The
 * Assistant's row is there only for a Member who has the Assistant.
 */
export function MemberSettingsHub({ data }: { data: MemberSettingsHubData }) {
  return (
    <>
      <SettingsPageHeader
        root
        title="Make it yours"
        description="Your profile, how new Sessions sound, and how many Tracks you have left."
      />

      <SettingsColumns>
        <SettingsSection title="You">
          <SettingsCard>
            <SettingsRow
              href="/settings/profile"
              icon={<UserRound />}
              label="Profile"
              summary={data.profile}
            />
            <SettingsRow
              href="/settings/people"
              icon={<UsersRound />}
              label="People"
              summary={data.people}
            />
            <SettingsRow
              href="/settings/storage"
              icon={<HardDrive />}
              label="Storage"
              summary={{ text: 'Offline music on this device' }}
            />
            {data.assistant ? (
              <SettingsRow
                href="/settings/assistant"
                icon={<Sparkles />}
                label={ASSISTANT_NAME}
                summary={data.assistant}
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Generation &amp; sound">
          <SettingsCard>
            <SettingsRow
              href="/settings/generation"
              icon={<ListMusic />}
              label="Generation"
              summary={data.generation}
            />
            <SettingsRow
              href="/settings/playback"
              icon={<AudioLines />}
              label="Playback"
              summary={data.playback}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Usage">
          <SettingsCard>
            <SettingsRow
              href="/settings/my-budget"
              icon={<Gauge />}
              label="My budget"
              summary={{
                status: { label: 'Read-only', tone: 'muted' },
                text: 'Your Tracks and covers, and the shared budget',
              }}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Account">
          <SettingsCard>
            <SignOutButton />
          </SettingsCard>
        </SettingsSection>
      </SettingsColumns>
    </>
  );
}
