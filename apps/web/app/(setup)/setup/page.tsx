import { headers } from 'next/headers';
import { SetupForm } from '@/components/setup/setup-form';
import { setupAddressNotice } from '@/components/setup/setup-model';
import { getPublicUrl } from '@/lib/env';
import { redirectAwayFromSetup } from '@/lib/auth/session';

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
  // `Host` carries the address the browser opened, on the direct web port and
  // behind Caddy alike: Caddy forwards it unchanged, and never forwards a host
  // that matches no site block.
  const addressNotice = setupAddressNotice((await headers()).get('host'), getPublicUrl());

  return (
    <SetupForm setupToken={Array.isArray(token) ? token[0] : token} addressNotice={addressNotice} />
  );
}
