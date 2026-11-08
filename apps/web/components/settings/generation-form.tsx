'use client';

import { useState } from 'react';
import {
  BUFFER_AHEAD_TRACKS_MAX,
  BUFFER_AHEAD_TRACKS_MIN,
  type GenerationSettings,
} from '@liedmotif/shared';
import { Switch } from '@/components/ui/controls';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { updateGenerationSettings } from '@/lib/api-client';
import {
  GatedSlider,
  SettingsControlRow,
  SettingsFeedback,
  SettingsFootnote,
  type SettingsFeedbackState,
} from './settings-ui';

const BUFFER_ENABLED_DESCRIPTION_ID = 'buffer-enabled-description';

export function GenerationForm({ initial }: { initial: GenerationSettings }) {
  const [bufferEnabled, setBufferEnabled] = useState(initial.bufferEnabled);
  const [bufferAheadTracks, setBufferAheadTracks] = useState(initial.bufferAheadTracks);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SettingsFeedbackState>(null);

  async function save() {
    if (saving) return;
    setFeedback(null);
    setSaving(true);
    const result = await updateGenerationSettings({ bufferEnabled, bufferAheadTracks });
    setSaving(false);
    setFeedback(
      result.ok
        ? { kind: 'success', message: 'Buffer settings saved.' }
        : { kind: 'error', message: result.error.message },
    );
  }

  return (
    <div>
      <SettingsControlRow
        label="Generate new Tracks by default"
        description="How new Sessions start — the player switches any Session either way"
        descriptionId={BUFFER_ENABLED_DESCRIPTION_ID}
      >
        <Switch
          checked={bufferEnabled}
          onCheckedChange={setBufferEnabled}
          disabled={saving}
          aria-label="Generate new Tracks by default"
          aria-describedby={BUFFER_ENABLED_DESCRIPTION_ID}
        />
      </SettingsControlRow>

      <GatedSlider
        label="Tracks generated in advance"
        value={bufferAheadTracks}
        onValueChange={setBufferAheadTracks}
        min={BUFFER_AHEAD_TRACKS_MIN}
        max={BUFFER_AHEAD_TRACKS_MAX}
        step={1}
        disabled={saving}
        enabled
        renderValue={(value) => `${value} trk`}
        valueTestId="buffer-ahead-value"
        ariaLabel="Tracks generated in advance"
        minLabel={BUFFER_AHEAD_TRACKS_MIN}
        maxLabel={BUFFER_AHEAD_TRACKS_MAX}
      />
      <SettingsFootnote>Changes reach a running Session within about a minute.</SettingsFootnote>
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
        {saving ? 'Saving…' : 'Save Buffer'}
      </button>
    </div>
  );
}
