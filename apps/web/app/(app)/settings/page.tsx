import { MemberSettingsHub } from '@/components/settings/member-settings-hub';
import { SettingsHub } from '@/components/settings/settings-hub';
import { loadMemberSettingsHubData, loadSettingsHubData } from '@/lib/settings/settings-hub-data';
import { requireAppAccess } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function SettingsIndexPage() {
  const { session, role } = await requireAppAccess();
  // The hub payload is filtered by role at the data layer — a Member's request
  // never loads instance-scoped sources, let alone renders them.
  if (role !== 'admin') {
    return <MemberSettingsHub data={await loadMemberSettingsHubData(session.user.id)} />;
  }
  return <SettingsHub data={await loadSettingsHubData(session.user.id)} />;
}
