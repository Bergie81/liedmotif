import type { ReactNode } from 'react';
import { getActiveSession } from '@liedmotif/db';
import { AppShell } from '@/components/app-shell';
import { OfflineSyncHost } from '@/components/offline/offline-sync-host';
import { PlayerProvider } from '@/components/player/player-provider';
import { getDb } from '@/lib/db';
import { getLlmProvider, getTypicalTracksPerMusicRequest } from '@/lib/providers';
import { cachedListenerProfile } from '@/lib/request-cache';
import { requireAppAccess } from '@/lib/session';
import { cachedOwnerUsageTracks, toSessionSummary } from '@/lib/sessions';
import { ownVoiceOfferedTo } from '@/lib/voice';

// Protected route group: the app shell + settings. The guard reads the session and
// setup state on every request and redirects to /setup or /login as needed, so a
// signed-out (or pre-setup) visitor never renders the app.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { session, role } = await requireAppAccess();
  const db = getDb();
  const [activeSession, profile, llmProvider] = await Promise.all([
    getActiveSession(db, { ownerUserId: session.user.id }),
    cachedListenerProfile(db, session.user.id),
    // The Assistant answers with the text LLM; a failed read hides it rather
    // than failing the shell.
    getLlmProvider().catch(() => null),
  ]);
  // Deliberately NOT awaited: the usage tile streams in after the shell paints,
  // so the 5–9 query budget computation never blocks first paint. Settings pages
  // that need it too share this request-cached computation. A failed read
  // resolves null — the headroom chip stays absent until the next navigation's
  // refetch, which beats failing the whole shell over one advisory readout.
  const usagePromise = cachedOwnerUsageTracks(
    db,
    session.user.id,
    getTypicalTracksPerMusicRequest(),
  ).catch(() => null);

  return (
    <PlayerProvider>
      <OfflineSyncHost userId={session.user.id} />
      <AppShell
        viewerRole={role}
        ownVoiceOffered={ownVoiceOfferedTo(role)}
        listener={{
          name: session.user.name || session.user.email.split('@')[0] || 'Admin',
          email: session.user.email,
          artistName: profile?.artistName.trim() || null,
          imageUrl: session.user.image ?? null,
        }}
        initialActiveSession={activeSession ? toSessionSummary(activeSession) : null}
        usagePromise={usagePromise}
        assistantAvailable={llmProvider !== null}
      >
        {children}
      </AppShell>
    </PlayerProvider>
  );
}
