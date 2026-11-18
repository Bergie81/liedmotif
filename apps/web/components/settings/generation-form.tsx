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
import { toast } from '@/lib/toast';
import { GatedSlider, SettingsControlRow, SettingsFootnote } from './settings-ui';

const BUFFER_ENABLED_DESCRIPTION_ID = 'buffer-enabled-description';
const SAVE_KEY = 'buffer-save';

export function GenerationForm({ initial }: { initial: GenerationSettings }) {
  const [bufferEnabled, setBufferEnabled] = useState(initial.bufferEnabled);
  const [bufferAheadTracks, setBufferAheadTracks] = useState(initial.bufferAheadTracks);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    toast.dismiss(SAVE_KEY);
    const result = await updateGenerationSettings({ bufferEnabled, bufferAheadTracks });
    setSaving(false);
    if (result.ok) toast.success('Buffer settings saved.', { key: SAVE_KEY });
    else toast.error(result.error.message, { key: SAVE_KEY });
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
