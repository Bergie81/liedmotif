import { EMPTY_LISTENER_PROFILE, isEmailConfirmed } from '@liedmotif/db';
import { requireAppAccess } from '@/lib/auth/session';
import { getDb } from '@/lib/db';
import { isAccountEmailEnabled } from '@/lib/env';
import { cachedListenerProfile } from '@/lib/request-cache';
import { AvatarUploader } from '@/components/settings/avatar-uploader';
import { ProfileForm } from '@/components/settings/profile-form';
import { SignOutButton } from '@/components/settings/sign-out-button';
import {
  SettingsCard,
  SettingsColumns,
  SettingsControlRow,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-ui';
import { User, UsersRound } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function ProfileSettingsPage() {
  const { session, role } = await requireAppAccess();
  const db = getDb();
  const profile = (await cachedListenerProfile(db, session.user.id)) ?? EMPTY_LISTENER_PROFILE;
  const emailConfirmed = isAccountEmailEnabled()
    ? await isEmailConfirmed(db, session.user.id)
    : null;
  return (
    <section>
      <SettingsPageHeader
        title="Profile"
        description="Your account and listener details. City and country give your Sessions a sense of place."
      />
      <SettingsColumns>
        <SettingsSection title="Identity">
          <SettingsCard>
            <div className="space-y-4">
              <AvatarUploader name={profile.name} initialImageUrl={session.user.image ?? null} />
              <ProfileForm initial={profile} role={role} emailConfirmed={emailConfirmed} />
            </div>
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Users & invites">
          <SettingsCard>
            <SettingsControlRow label="You">
              <span className="inline-flex items-center gap-1.5 rounded-[5px] border border-lamp/45 px-2 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-lamp">
                <User className="h-3 w-3" aria-hidden /> {role === 'admin' ? 'Admin' : 'Member'}
              </span>
            </SettingsControlRow>
            <SettingsRow
              href="/settings/people"
              icon={<UsersRound />}
              label="People"
              summary={{ text: 'Covers and lyrics' }}
            />
            {role === 'admin' ? (
              <SettingsRow
                href="/settings/members"
                icon={<UsersRound />}
                label="Invite members"
                summary={{ text: 'Invites, budgets, access' }}
              />
            ) : null}
          </SettingsCard>
          <div className="mt-4">
            <SignOutButton />
          </div>
        </SettingsSection>
      </SettingsColumns>
    </section>
  );
}
