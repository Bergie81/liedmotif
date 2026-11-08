'use client';

import { useState } from 'react';
import {
  CROSSFADE_SECONDS_MAX,
  CROSSFADE_SECONDS_MIN,
  type PlaybackSettings,
  type UpdatePlaybackSettingsRequest,
} from '@liedmotif/shared';
import { Switch } from '@/components/ui/controls';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { updatePlaybackSettings } from '@/lib/api-client';
import {
  GatedSlider,
  SettingsCard,
  SettingsControlRow,
  SettingsFeedback,
  SettingsFootnote,
  SettingsSection,
  type SettingsFeedbackState,
} from './settings-ui';

const SEAM_PREVIEW_WINDOW_SECONDS = 30;
const SEAM_FIRST_TRACK_WIDTH_PERCENT = 58;

export function PlaybackForm({ initial }: { initial: PlaybackSettings }) {
  // What the server last told us, so a save can send only what the owner
  // actually moved here. The player's blend toggle writes the same record live
  // and the mini player is on this page — posting the whole form would push a
  // seeded value back over a toggle made since the page rendered.
  const [persisted, setPersisted] = useState(initial);
  const [blendEnabled, setBlendEnabled] = useState(initial.blendEnabled);
  const [crossfadeSeconds, setCrossfadeSeconds] = useState(initial.crossfadeSeconds);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SettingsFeedbackState>(null);

  async function save() {
    if (saving) return;
    setFeedback(null);
    setSaving(true);
    const patch: UpdatePlaybackSettingsRequest = {};
    if (blendEnabled !== persisted.blendEnabled) patch.blendEnabled = blendEnabled;
    if (crossfadeSeconds !== persisted.crossfadeSeconds) patch.crossfadeSeconds = crossfadeSeconds;
    const result = await updatePlaybackSettings(patch);
    setSaving(false);
    if (result.ok) {
      // The response carries the full effective settings, so the form lands on
      // the server's truth — including a blend flip made from the player.
      setPersisted(result.data);
      setBlendEnabled(result.data.blendEnabled);
      setCrossfadeSeconds(result.data.crossfadeSeconds);
    }
    setFeedback(
      result.ok
        ? { kind: 'success', message: 'Playback settings saved.' }
        : { kind: 'error', message: result.error.message },
    );
  }

  return (
    <>
      <SettingsSection title="Blending">
        <SettingsCard>
          <SettingsControlRow
            label="Blend consecutive Tracks"
            description="Crossfades between Tracks; off plays them back to back"
          >
            <Switch
              checked={blendEnabled}
              onCheckedChange={setBlendEnabled}
              disabled={saving}
              aria-label="Blend consecutive Tracks"
            />
          </SettingsControlRow>

          <GatedSlider
            label="Crossfade length"
            value={crossfadeSeconds}
            onValueChange={setCrossfadeSeconds}
            min={CROSSFADE_SECONDS_MIN}
            max={CROSSFADE_SECONDS_MAX}
            step={1}
            disabled={saving}
            enabled={blendEnabled}
            renderValue={(value) => `${value} s`}
            valueTestId="crossfade-value"
            ariaLabel="Crossfade length (seconds)"
            minLabel={`${CROSSFADE_SECONDS_MIN} s`}
            maxLabel={`${CROSSFADE_SECONDS_MAX} s`}
          >
            <BlendSeam enabled={blendEnabled} seconds={crossfadeSeconds} />
          </GatedSlider>
          <SettingsFootnote>
            Fades snap to the beat, so they can run a little shorter or longer.
          </SettingsFootnote>
        </SettingsCard>
        {feedback ? (
          <div className="mt-4">
            <SettingsFeedback kind={feedback.kind}>{feedback.message}</SettingsFeedback>
          </div>
        ) : null}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className={`${primaryButtonClass} mt-4 w-full`}
        >
          {saving ? 'Saving…' : 'Save playback'}
        </button>
        <SettingsFootnote>
          The player reads these settings once when it starts. Reload or begin a new browser visit
          before the saved change affects playback.
        </SettingsFootnote>
      </SettingsSection>
    </>
  );
}

function BlendSeam({ enabled, seconds }: { enabled: boolean; seconds: number }) {
  // The preview uses a fictional window so a 2–12 second target stays visibly distinct;
  // it illustrates overlap and does not model either Track's real duration.
  const overlap = Math.max(7, Math.round((seconds / SEAM_PREVIEW_WINDOW_SECONDS) * 100));
  const secondTrackStart = SEAM_FIRST_TRACK_WIDTH_PERCENT - overlap;
  return (
    <div className="mt-4 rounded-card-sm border border-line bg-paper/[0.02] p-3">
      <div className="relative h-[22px]" aria-hidden>
        <div
          className="absolute left-0 top-0 h-[10px] rounded-[5px] bg-paper/[0.14]"
          style={{ width: `${SEAM_FIRST_TRACK_WIDTH_PERCENT}%` }}
        />
        <div
          className="absolute bottom-0 right-0 h-[10px] rounded-[5px] bg-lamp/35"
          style={{ left: enabled ? `${secondTrackStart}%` : '60%' }}
        />
        {enabled ? (
          <div
            className="absolute -bottom-1.5 -top-1.5 border-x border-dashed border-lamp/50"
            style={{ left: `${secondTrackStart}%`, width: `${overlap}%` }}
          />
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.14em] text-dim">
        <span>Track A</span>
        <span>{enabled ? `Blend · ${seconds} s` : 'No blend'}</span>
        <span>Track B</span>
      </div>
    </div>
  );
}
