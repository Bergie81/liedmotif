import type { ReactNode } from 'react';
import { getActiveSession } from '@liedmotif/db';
import { AppShell } from '@/components/app-shell';
import { OfflineSyncHost } from '@/components/offline/offline-sync-host';
import { PlayerProvider } from '@/components/player/player-provider';
import { cachedAssistantAvailability } from '@/lib/assistant/availability';
import { answerLinkTargets } from '@/lib/assistant/link-targets';
import { getDb } from '@/lib/db';
import { getLlmProvider, getTypicalTracksPerMusicRequest } from '@/lib/providers/providers';
import { cachedListenerProfile } from '@/lib/request-cache';
import { requireAppAccess } from '@/lib/auth/session';
import { cachedOwnerUsageTracks, toSessionSummary } from '@/lib/sessions/sessions';
import { ownVoiceOfferedTo } from '@/lib/voice/voice';

// Protected route group: the app shell + settings. The guard reads the session and
// setup state on every request and redirects to /setup or /login as needed, so a
// signed-out (or pre-setup) visitor never renders the app.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { session, role } = await requireAppAccess();
  const db = getDb();
  const [activeSession, profile, assistant, llmConfigured] = await Promise.all([
    getActiveSession(db, { ownerUserId: session.user.id }),
    cachedListenerProfile(db, session.user.id),
    // Whether this viewer has the Assistant, and what is left of today's
    // allowance. A failed read hides it rather than failing the shell.
    cachedAssistantAvailability(db, session.user.id, role),
    // Decides whether free text only a text LLM can read is offered at all. A
    // failed read offers none, as if no text LLM were configured.
    getLlmProvider()
      .then((provider) => provider !== null)
      .catch(() => false),
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
        llmConfigured={llmConfigured}
        listener={{
          name: session.user.name || session.user.email.split('@')[0] || 'Admin',
          email: session.user.email,
          artistName: profile?.artistName.trim() || null,
          imageUrl: session.user.image ?? null,
        }}
        initialActiveSession={activeSession ? toSessionSummary(activeSession) : null}
        usagePromise={usagePromise}
        assistantAvailable={assistant.available}
        assistantLinks={answerLinkTargets(role)}
        assistantStanding={assistant.standing}
      >
        {children}
      </AppShell>
    </PlayerProvider>
  );
}
