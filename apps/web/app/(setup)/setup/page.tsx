import { SetupForm } from '@/components/setup/setup-form';
import { redirectAwayFromSetup } from '@/lib/session';

// The first-run screen. The guard sends the request away (to /login or /) the
// moment an admin exists — setup is locked after the first admin.
export const dynamic = 'force-dynamic';

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await redirectAwayFromSetup();

  // An instance with `SETUP_TOKEN` set is opened as `/setup?token=…`; the form
  // carries it to `/api/setup`, which is where it is checked. This screen never
  // asks for or reports the token, so an ungated install shows nothing extra
  // and a wrong one fails at the route like any other refusal.
  const token = (await searchParams).token;

  return <SetupForm setupToken={Array.isArray(token) ? token[0] : token} />;
}
