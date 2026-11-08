import { MemberOnboardingWizard } from '@/components/onboarding/member-onboarding-wizard';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { loadMemberOnboardingData } from '@/lib/member-onboarding-data';
import { loadOnboardingData } from '@/lib/onboarding-data';
import { requireOnboardingAccess } from '@/lib/session';

// First-login onboarding, for both roles behind the same guard and the same
// completion stamp. The Admin walks the full setup; a Member gets the short
// welcome (profile → People → budget) — their flow loads no instance data and
// contains no credential or ceiling step to reach. The guard sends an
// already-onboarded user to the app, so neither flow can be replayed by URL.
export const dynamic = 'force-dynamic';

export default async function WelcomePage() {
  const { session, role } = await requireOnboardingAccess();
  const avatarUrl = session.user.image ?? null;

  // A Member's welcome shows their two budget bounds, so it resolves only for a
  // Member; anything else is the Admin's flow.
  const memberData = role === 'member' ? await loadMemberOnboardingData(session.user.id) : null;
  if (memberData) return <MemberOnboardingWizard data={memberData} avatarUrl={avatarUrl} />;

  const data = await loadOnboardingData(session.user.id);
  return <OnboardingWizard data={data} avatarUrl={avatarUrl} />;
}
