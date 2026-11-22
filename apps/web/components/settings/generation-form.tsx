'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BUFFER_AHEAD_TRACKS_MAX,
  BUFFER_AHEAD_TRACKS_MIN,
  type GenerationSettings,
} from '@liedmotif/shared';
import { segmentedListClass, segmentedTriggerClass } from '@/components/ui/design-system';
import { primaryButtonClass } from '@/components/ui/form-styles';
import { cn } from '@/lib/cn';
import { updateGenerationSettings } from '@/lib/http/api-client';
import {
  DEFAULT_SESSION_DURATION_OPTIONS,
  defaultSessionDurationLabel,
} from '@/lib/settings/default-session-duration';
import { toast } from '@/lib/toast';
import { GatedSlider, SettingsFootnote } from './settings-ui';

const DURATION_DESCRIPTION_ID = 'default-session-duration-description';
const SAVE_KEY = 'new-music-save';

export function GenerationForm({ initial }: { initial: GenerationSettings }) {
  const router = useRouter();
  const [defaultSessionDurationMinutes, setDefaultSessionDurationMinutes] = useState(
    initial.defaultSessionDurationMinutes,
  );
  const [bufferAheadTracks, setBufferAheadTracks] = useState(initial.bufferAheadTracks);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    toast.dismiss(SAVE_KEY);
    const result = await updateGenerationSettings({
      defaultSessionDurationMinutes,
      bufferAheadTracks,
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error.message, { key: SAVE_KEY });
      return;
    }
    // Home's create card names the saved default on its Auto stop, and the
    // router cache would replay its old props for a while.
    router.refresh();
    toast.success('New music settings saved.', { key: SAVE_KEY });
  }

  return (
    <div>
      <fieldset aria-describedby={DURATION_DESCRIPTION_ID} className="border-b border-line pb-3">
        <legend className="text-[14px] font-semibold text-paper">New music per Session</legend>
        <div className={cn(segmentedListClass, 'mt-3 overflow-x-auto')}>
          {DEFAULT_SESSION_DURATION_OPTIONS.map((minutes) => (
            <label
              key={minutes ?? 'no-limit'}
              data-state={defaultSessionDurationMinutes === minutes ? 'active' : 'inactive'}
              className={cn(
                segmentedTriggerClass,
                'cursor-pointer whitespace-nowrap text-center has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-lamp',
              )}
            >
              <input
                type="radio"
                name="default-session-duration"
                value={minutes ?? 'no-limit'}
                checked={defaultSessionDurationMinutes === minutes}
                disabled={saving}
                onChange={() => setDefaultSessionDurationMinutes(minutes)}
                className="sr-only"
              />
              {defaultSessionDurationLabel(minutes)}
            </label>
          ))}
        </div>
        <p id={DURATION_DESCRIPTION_ID} className="mt-2 text-[12.5px] text-dim">
          How much new music a new session generates when you give it no duration. Once reached, the
          session repeats for free. You can change any session in the player.
        </p>
      </fieldset>

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
      <SettingsFootnote>Changes reach a running session within about a minute.</SettingsFootnote>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className={`${primaryButtonClass} mt-4 w-full`}
      >
        {saving ? 'Saving…' : 'Save New Music'}
      </button>
    </div>
  );
}
