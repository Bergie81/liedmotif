'use client';

// Owner playback settings acquisition (blend on/off + crossfade length),
// split from the controller hook. Fetched at mount, and again when a change
// was saved past the player (`adoptStoredSettings`); failures keep the safe
// defaults but still SETTLE — the blend is gated on the settle, so a saved
// `blendEnabled: false` can never lose a race against the first timeupdate.
// Settings are read from the ref at every edge decision, so a change landing
// mid-track applies to the next transition. The in-player blend toggle rides
// exactly that: it flips the ref first (the engine's live gate), then
// persists — a failed write reverts the gate to the last value the server
// confirmed, so the UI and the engine never disagree with the server.
//
// A toggle can outrun both the mount fetch and an earlier toggle, so the blend
// gate has ONE owner: the newest write. `blendWritesRef` counts writes; the
// mount fetch and every superseded response defer to it rather than restoring
// a value the user has already moved past. A write that failed owns nothing:
// a mount fetch landing after it still applies the saved value.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  DEFAULT_PLAYBACK_SETTINGS,
  playbackSettingsSchema,
  type PlaybackSettings,
} from '@liedmotif/shared';
import { getPlaybackSettings, updatePlaybackSettings } from '@/lib/api-client';
import { readBrowserPreference, writeBrowserPreference } from '@/lib/browser-preferences';

// The owner's settings as this device last had them from the server: what a
// player that may not read the server (the Offline Library's) plays with.
const DEVICE_COPY_KEY = 'liedmotif-playback-settings';

function readDeviceCopy(): PlaybackSettings {
  try {
    const parsed = playbackSettingsSchema.safeParse(
      JSON.parse(readBrowserPreference(DEVICE_COPY_KEY) ?? 'null'),
    );
    return parsed.success ? parsed.data : DEFAULT_PLAYBACK_SETTINGS;
  } catch {
    return DEFAULT_PLAYBACK_SETTINGS;
  }
}

function keepDeviceCopy(settings: PlaybackSettings): void {
  writeBrowserPreference(DEVICE_COPY_KEY, JSON.stringify(settings));
}

// Up to three player hosts mount within one handoff (draining, entry,
// pending) and each runs this hook: share one in-flight fetch between them
// instead of issuing identical concurrent requests. Only the promise is
// shared — a host mounting later still reads fresh.
let sharedSettingsFetch: ReturnType<typeof getPlaybackSettings> | null = null;
function fetchPlaybackSettingsShared(): ReturnType<typeof getPlaybackSettings> {
  sharedSettingsFetch ??= getPlaybackSettings().finally(() => {
    sharedSettingsFetch = null;
  });
  return sharedSettingsFetch;
}

export function usePlaybackSettings({ read }: { read: boolean }): {
  settingsRef: RefObject<PlaybackSettings>;
  settledRef: RefObject<boolean>;
  /** The blend gate as render state (the ref stays the engine's live read). */
  blendEnabled: boolean;
  /** Whether the settings fetch has answered. Anything that blends off the
   * render state must gate on this the way the engine gates on `settledRef` —
   * before it, `blendEnabled` is only the default, not the owner's choice. */
  blendSettled: boolean;
  /** Flip the blend gate live and persist it; resolves to a user-facing
   * message when the write did not land (the flip is reverted). */
  setBlendEnabled: (enabled: boolean) => Promise<string | null>;
  /** Re-read the stored settings and play with them, for a change saved past
   * the player. Writes nothing; a toggle made meanwhile keeps the gate. */
  adoptStoredSettings: () => Promise<void>;
} {
  // A player that may not read the server (an offline one) plays this
  // device's copy, settled from the start.
  const [initial] = useState(() => (read ? DEFAULT_PLAYBACK_SETTINGS : readDeviceCopy()));
  const settingsRef = useRef<PlaybackSettings>(initial);
  const settledRef = useRef<boolean>(!read);
  const blendWritesRef = useRef(0);
  const blendWritesInFlightRef = useRef(0);
  // The server's blend value as last confirmed (the mount fetch, or the newest
  // write that saved), and which write confirmed it (0: none has).
  const confirmedBlendRef = useRef<boolean | null>(null);
  const confirmedWriteRef = useRef(0);
  // Re-reads started for a change saved past the player; only the newest may land.
  const adoptedReadsRef = useRef(0);
  const [blendEnabled, setBlendEnabledState] = useState<boolean>(initial.blendEnabled);
  const [blendSettled, setBlendSettled] = useState(!read);

  const applyBlend = useCallback((enabled: boolean) => {
    settingsRef.current = { ...settingsRef.current, blendEnabled: enabled };
    setBlendEnabledState(enabled);
  }, []);

  useEffect(() => {
    if (!read) return;
    let cancelled = false;
    void fetchPlaybackSettingsShared().then((res) => {
      if (cancelled) return;
      // A re-read that answered first is the newer copy of the same settings.
      if (res.ok && adoptedReadsRef.current === 0) {
        // A toggle made while this was in flight already owns the gate; take
        // the rest of the server's answer but leave that choice standing.
        if (confirmedWriteRef.current === 0) confirmedBlendRef.current = res.data.blendEnabled;
        if (blendWritesInFlightRef.current > 0 || confirmedWriteRef.current > 0) {
          settingsRef.current = { ...res.data, blendEnabled: settingsRef.current.blendEnabled };
        } else {
          settingsRef.current = res.data;
          setBlendEnabledState(res.data.blendEnabled);
        }
        keepDeviceCopy(settingsRef.current);
      }
      settledRef.current = true;
      setBlendSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [read]);

  const setBlendEnabled = useCallback(
    async (enabled: boolean): Promise<string | null> => {
      const write = ++blendWritesRef.current;
      const previous = settingsRef.current.blendEnabled;
      applyBlend(enabled);
      blendWritesInFlightRef.current += 1;
      const result = await updatePlaybackSettings({ blendEnabled: enabled });
      blendWritesInFlightRef.current -= 1;
      // Only the newest write may still move the gate: an older response would
      // otherwise resurrect its own value over a toggle made while it was out.
      const newest = write === blendWritesRef.current;
      if (result.ok) {
        if (write > confirmedWriteRef.current) {
          confirmedWriteRef.current = write;
          confirmedBlendRef.current = result.data.blendEnabled;
        }
        if (newest) {
          settingsRef.current = result.data;
          setBlendEnabledState(result.data.blendEnabled);
          keepDeviceCopy(result.data);
        }
        return null;
      }
      if (newest) applyBlend(confirmedBlendRef.current ?? previous);
      const kept = settingsRef.current.blendEnabled;
      return `The blend change didn’t save — Tracks keep ${kept ? 'blending' : 'hard cuts'}. ${result.error.message}`;
    },
    [applyBlend],
  );

  // The read's blend value owns the gate only when no toggle was out or made
  // while it read: that toggle's own write answers for the gate.
  const adoptStoredSettings = useCallback(async (): Promise<void> => {
    if (!read) return;
    const reading = ++adoptedReadsRef.current;
    const writesBefore = blendWritesRef.current;
    const toggleOut = blendWritesInFlightRef.current > 0;
    const result = await getPlaybackSettings();
    if (!result.ok || reading !== adoptedReadsRef.current) return;
    if (toggleOut || writesBefore !== blendWritesRef.current) {
      settingsRef.current = { ...result.data, blendEnabled: settingsRef.current.blendEnabled };
    } else {
      confirmedBlendRef.current = result.data.blendEnabled;
      settingsRef.current = result.data;
      setBlendEnabledState(result.data.blendEnabled);
    }
    keepDeviceCopy(settingsRef.current);
    settledRef.current = true;
    setBlendSettled(true);
  }, [read]);

  return {
    settingsRef,
    settledRef,
    blendEnabled,
    blendSettled,
    setBlendEnabled,
    adoptStoredSettings,
  };
}
