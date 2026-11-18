import { describe, expect, it } from 'vitest';
import {
  SESSION_GENERATION_STATUSES,
  type SessionGenerationStatus,
} from '../state-machines/literals';
import { presentGenerationStatus, type GenerationStatusPresentation } from './generation-status';

// The player surfaces WHY generation is degraded WITHOUT ever stopping or pausing the
// session — `generationStatus` is a controller property, the lifecycle stays `active`.
// This pure mapping turns each controller status into the banner copy/tone
// the now-playing view renders.

describe('presentGenerationStatus', () => {
  it('surfaces nothing while generating normally (ok)', () => {
    const p = presentGenerationStatus('ok');
    expect(p.message).toBeNull();
    expect(p.title).toBeNull();
    expect(p.tone).toBe('ok');
    expect(p.isSessionRepeat).toBe(false);
    expect(p.showCostSettingsLink).toBe(false);
    expect(p.keepsPlaying).toBe(true);
  });

  it('renders the cost-limit case as Session Repeat with a cost-settings link', () => {
    const p = presentGenerationStatus('repeat_cost_limit');
    expect(p.title).toBe('Session Repeat');
    expect(p.message).toContain("repeating this session's own tracks");
    expect(p.message?.toLowerCase()).toContain('limit reached');
    expect(p.isSessionRepeat).toBe(true);
    expect(p.showCostSettingsLink).toBe(true);
    expect(p.tone).toBe('info');
    expect(p.keepsPlaying).toBe(true);
  });

  it('surfaces nothing for the buffer-complete case (advance generation off is not a problem)', () => {
    // With automatic top-ups disabled and the initial fill delivered, the session
    // quietly loops its own set. The owner chose this — unlike the cost-limit degrade it
    // is not a condition worth a banner, so it stays silent like `ok`, even when
    // a stale server safe-message lingers on the row.
    const p = presentGenerationStatus('repeat_buffer_complete', 'stale message');
    expect(p.title).toBeNull();
    expect(p.message).toBeNull();
    expect(p.tone).toBe('ok');
    expect(p.keepsPlaying).toBe(true);
  });

  it('gives provider-credit and rate-limit blocks distinct, non-repeat messages', () => {
    const credits = presentGenerationStatus('provider_credits');
    const rate = presentGenerationStatus('provider_rate_limited');
    expect(credits.message).not.toBeNull();
    expect(rate.message).not.toBeNull();
    expect(credits.message).not.toBe(rate.message);
    expect(credits.isSessionRepeat).toBe(false);
    expect(rate.isSessionRepeat).toBe(false);
    expect(credits.showCostSettingsLink).toBe(false);
  });

  it('leaves the session active for every degraded status (never a lifecycle change)', () => {
    for (const status of SESSION_GENERATION_STATUSES) {
      expect(presentGenerationStatus(status).keepsPlaying).toBe(true);
    }
  });

  it('produces a distinct message for every surfaced (non-silent) status', () => {
    const messages = SESSION_GENERATION_STATUSES.filter(
      (s) => s !== 'ok' && s !== 'repeat_buffer_complete',
    ).map((s) => presentGenerationStatus(s).message);
    expect(new Set(messages).size).toBe(messages.length);
    expect(messages.every((m) => typeof m === 'string' && m.length > 0)).toBe(true);
  });

  it('worker_stalled and provider_error carry warn/error tones', () => {
    expect(presentGenerationStatus('worker_stalled').tone).toBe('warn');
    expect(presentGenerationStatus('provider_error').tone).toBe('error');
  });

  it('prefers the server-provided safe message over the canonical copy (but never for ok)', () => {
    const safe = 'Provider credits ran out at 14:05 — playing your ready tracks.';
    const credits = presentGenerationStatus('provider_credits', safe);
    expect(credits.message).toBe(safe);
    // ok surfaces nothing even if a stale safe message lingers.
    expect(presentGenerationStatus('ok', safe).message).toBeNull();
  });

  it('falls back to the canonical copy when the safe message is null/empty', () => {
    const a = presentGenerationStatus('provider_error', null);
    const b = presentGenerationStatus('provider_error', '');
    expect(a.message).toBe(b.message);
    expect(a.message).not.toBeNull();
  });

  it('is total over the generation-status domain', () => {
    for (const status of SESSION_GENERATION_STATUSES) {
      const p: GenerationStatusPresentation = presentGenerationStatus(status);
      expect(p.status).toBe(status);
    }
  });
});

// Every status's copy for a session that HAS tracks — the steady state the
// banner was written for, pinned literally so the zero-track variants can only
// ever be an alternative to it, never a replacement.
const COPY_WITH_TRACKS: Record<SessionGenerationStatus, string | null> = {
  ok: null,
  repeat_cost_limit:
    "Daily/monthly generation limit reached — repeating this session's own tracks.",
  repeat_buffer_complete: null,
  provider_credits:
    'The music provider is out of credits — playing your ready tracks until the Admin tops it up.',
  provider_rate_limited:
    'The music provider is busy — playing your ready tracks until generation resumes automatically in a few minutes.',
  worker_stalled: 'Generation is catching up — playing your ready tracks in the meantime.',
  provider_error: 'Generation hit a problem — playing your ready tracks while it recovers.',
};

/** The four statuses whose steady-state copy promises "your ready tracks". */
const BLOCKED_STATUSES = [
  'provider_credits',
  'provider_rate_limited',
  'worker_stalled',
  'provider_error',
] as const;

/** The two the controller lifts by itself — slow, never a dead end. */
const SELF_CLEARING_STATUSES = ['provider_rate_limited', 'worker_stalled'] as const;

/** A session with nothing to play and nothing on the way. */
const EMPTY_AND_IDLE = { readyTrackCount: 0, generationInFlight: false } as const;

/** The same session with a generation under way. */
const EMPTY_AND_WORKING = { readyTrackCount: 0, generationInFlight: true } as const;

describe('presentGenerationStatus — a session with no tracks yet', () => {
  it('reads as its steady-state self unless the queue is described as empty', () => {
    for (const status of SESSION_GENERATION_STATUSES) {
      for (const queue of [undefined, { readyTrackCount: 3, generationInFlight: false }]) {
        const p = presentGenerationStatus(status, null, null, queue);
        expect(p.message).toBe(COPY_WITH_TRACKS[status]);
        expect(p.isStuck).toBe(false);
      }
    }
  });

  it('names the absence instead of promising ready tracks when there are none', () => {
    for (const status of BLOCKED_STATUSES) {
      const p = presentGenerationStatus(status, null, null, EMPTY_AND_IDLE);
      expect(p.message).toContain('No Tracks yet');
      expect(p.message).not.toContain('ready tracks');
      // Same severity and headline — only the promise changes.
      expect(p.tone).toBe(presentGenerationStatus(status).tone);
      expect(p.title).toBe(presentGenerationStatus(status).title);
    }
  });

  it('gives each blocked status its own zero-track reason', () => {
    const messages = BLOCKED_STATUSES.map(
      (status) => presentGenerationStatus(status, null, null, EMPTY_AND_IDLE).message,
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('reports a dead end for an empty session behind a block nothing will lift', () => {
    for (const status of ['provider_credits', 'provider_error'] as const) {
      expect(presentGenerationStatus(status, null, null, EMPTY_AND_IDLE).isStuck).toBe(true);
    }
  });

  it('reports a stuck Session as a dead end with its zero-Track failure copy', () => {
    // What the controller stores for a Session whose paid batch gave nothing:
    // the failure status and no server message, for as long as it is stuck.
    const p = presentGenerationStatus('provider_error', null, null, EMPTY_AND_IDLE);
    expect(p.message).toBe('No Tracks yet — generation hit a problem before the first one landed.');
    expect(p.isStuck).toBe(true);
  });

  it('never calls a rate-limited or catching-up session a dead end', () => {
    // The controller backs off and retries within a minute (rate limit), or is
    // still polling a live submit (stall) — a session seconds from working must
    // never be offered up for deletion, however empty it is.
    for (const status of SELF_CLEARING_STATUSES) {
      expect(presentGenerationStatus(status, null, null, EMPTY_AND_IDLE).isStuck).toBe(false);
    }
  });

  it('never calls a session with work in flight, or with a track, a dead end', () => {
    for (const status of BLOCKED_STATUSES) {
      expect(presentGenerationStatus(status, null, null, EMPTY_AND_WORKING).isStuck).toBe(false);
      expect(
        presentGenerationStatus(status, null, null, {
          readyTrackCount: 1,
          generationInFlight: false,
        }).isStuck,
      ).toBe(false);
    }
  });

  it('leaves the silent statuses untouched at zero tracks', () => {
    for (const status of ['ok', 'repeat_buffer_complete'] as const) {
      const p = presentGenerationStatus(status, null, null, EMPTY_AND_IDLE);
      expect(p.message).toBe(COPY_WITH_TRACKS[status]);
      expect(p.isStuck).toBe(false);
    }
  });

  it('still lets the server’s safe message override the zero-track copy', () => {
    const safe = 'Generation failed while starting your session.';
    const p = presentGenerationStatus('provider_error', safe, null, EMPTY_AND_IDLE);
    expect(p.message).toBe(safe);
    // The way out does not depend on which body won.
    expect(p.isStuck).toBe(true);
  });
});

// Every replay message the worker can store for a cost-limit stop, one per
// bound it records (admin rolling, Member, Pool, One-time).
const SERVER_REPLAY_MESSAGES = [
  'Generation limit reached — replaying this session until it resets.',
  'You have used your tracks for now — replaying this session until your budget resets.',
  'The shared budget is used up — replaying this session until it resets.',
  'Your budget is used up. Ask John for more.',
] as const;

describe('presentGenerationStatus — a cost limit hit before the first Track', () => {
  it('says the limit came before the first Track, whatever replay the server promised', () => {
    for (const safe of [null, ...SERVER_REPLAY_MESSAGES]) {
      for (const scope of [null, 'member', 'pool'] as const) {
        const p = presentGenerationStatus('repeat_cost_limit', safe, scope, EMPTY_AND_IDLE);
        expect(p.message).toContain('No Tracks yet');
        expect(p.message).not.toMatch(/replay|repeating/i);
        // A One-time budget never resets, and the client cannot tell which window bound.
        expect(p.message).not.toMatch(/reset/i);
        expect(p.showCostSettingsLink).toBe(true);
      }
    }
  });

  it('offers the way out once nothing is in flight', () => {
    expect(presentGenerationStatus('repeat_cost_limit', null, null, EMPTY_AND_IDLE).isStuck).toBe(
      true,
    );
    expect(
      presentGenerationStatus('repeat_cost_limit', null, null, EMPTY_AND_WORKING).isStuck,
    ).toBe(false);
  });

  it('keeps the server’s replay message for a Session that has tracks to replay', () => {
    for (const safe of SERVER_REPLAY_MESSAGES) {
      const p = presentGenerationStatus('repeat_cost_limit', safe, 'pool', {
        readyTrackCount: 2,
        generationInFlight: false,
      });
      expect(p.message).toBe(safe);
      expect(p.isStuck).toBe(false);
    }
  });
});

describe('presentGenerationStatus — cost-limit scope', () => {
  it('links the admin to cost limits and a member to their read-only budget page', () => {
    const admin = presentGenerationStatus('repeat_cost_limit', null, null);
    expect(admin.costSettingsPath).toBe('/settings/limits');
    expect(admin.costSettingsLabel).toBe('Adjust cost limits');

    for (const scope of ['member', 'pool'] as const) {
      const member = presentGenerationStatus('repeat_cost_limit', null, scope);
      // A Member must never be invited to "adjust" a limit they cannot touch.
      expect(member.costSettingsPath).toBe('/settings/my-budget');
      expect(member.costSettingsLabel).toBe('See your budget');
    }
  });
});
