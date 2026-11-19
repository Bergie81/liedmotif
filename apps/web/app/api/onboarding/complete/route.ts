// Signed-in profile: stamp first-login onboarding as finished. Every profile has
// its own onboarding to finish, so the guard is `requireOwnerId`, not the admin
// one. The app guards divert to `/welcome` until this is set, so this route is
// what releases the profile into the app — deliberately the only write the last
// screen makes.

import { NextResponse } from 'next/server';
import { completeOnboarding } from '@liedmotif/db';
import { apiOk, requireOwnerId } from '@/lib/http/api-response';
import { getDb } from '@/lib/db';
import { markOnboardingComplete } from '@/lib/onboarding/onboarding-memo';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  const state = await completeOnboarding(getDb(), ownerUserId);
  markOnboardingComplete(ownerUserId);
  return apiOk(state);
}
