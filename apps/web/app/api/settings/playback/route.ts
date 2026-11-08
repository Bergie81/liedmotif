// Owner-scoped playback settings: blend on/off
// + crossfade length, stored in `user_settings` under the `playback` key. Each
// signed-in user reads and writes their own; the settings screen's blend section
// and the player's edge policy read the same object.

import { NextResponse } from 'next/server';
import { getPlaybackSettings, updatePlaybackSettings } from '@liedmotif/db';
import { updatePlaybackSettingsRequestSchema } from '@liedmotif/shared';
import { getDb } from '@/lib/db';
import { apiOk, parseJsonBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;
  return apiOk(await getPlaybackSettings(getDb(), ownerUserId));
}

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  // The shared schema is the single validation boundary (Zod-bounded 2–12 s
  // crossfade); the repo stores only values that parsed here.
  const patch = await parseJsonBody(
    request,
    updatePlaybackSettingsRequestSchema,
    'Invalid playback settings.',
  );
  if (patch instanceof NextResponse) return patch;

  return apiOk(await updatePlaybackSettings(getDb(), { ownerUserId, patch }));
}
