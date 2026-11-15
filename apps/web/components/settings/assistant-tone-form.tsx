'use client';

// The tone a user gives the Assistant (Settings → the Assistant's page): free
// text, with ready-made tones that fill the field for the user to keep or
// rewrite. An empty field is the Assistant's own voice. Persists to
// /api/settings/assistant-tone and holds from the user's next message.

import { useState } from 'react';
import { ASSISTANT_TONE_MAX_LENGTH, type AssistantTone } from '@liedmotif/shared';
import {
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '@/components/ui/form-styles';
import { updateAssistantTone } from '@/lib/api-client';
import { ASSISTANT_NAME, TONE_PRESETS } from '@/lib/assistant/persona';
import { SettingsFeedback, type SettingsFeedbackState } from './settings-ui';

const PLACEHOLDER = 'Write your own, for example "Talk like a ship captain."';

export function AssistantToneForm({ initial }: { initial: AssistantTone }) {
  const [tone, setTone] = useState(initial.tone);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SettingsFeedbackState>(null);

  function edit(next: string) {
    setTone(next);
    setFeedback(null);
  }

  // The field and the ready-made tones are held still while a save is on its
  // way: the answer puts the tone as stored into the field, and would otherwise
  // write over what the user typed in the meantime.
  async function save() {
    if (saving) return;
    setFeedback(null);
    setSaving(true);
    const result = await updateAssistantTone({ tone });
    setSaving(false);
    if (result.ok) setTone(result.data.tone);
    setFeedback(
      result.ok
        ? { kind: 'success', message: 'Tone saved.' }
        : { kind: 'error', message: result.error.message },
    );
  }

  return (
    <div className="space-y-4">
      {/* Roadie's own voice on a row of its own; the ready-made tones together below it. */}
      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={() => edit('')}
          disabled={saving}
          className={secondaryButtonClass}
        >
          {ASSISTANT_NAME}&apos;s own
        </button>
        <div className="flex flex-wrap gap-2">
          {TONE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => edit(preset.tone)}
              disabled={saving}
              className={secondaryButtonClass}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
      <label className={labelClass}>
        <span className="flex items-baseline justify-between gap-2">
          Tone
          <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">
            {tone.length}/{ASSISTANT_TONE_MAX_LENGTH}
          </span>
        </span>
        <textarea
          aria-label="Tone"
          rows={5}
          maxLength={ASSISTANT_TONE_MAX_LENGTH}
          value={tone}
          onChange={(event) => edit(event.target.value)}
          placeholder={PLACEHOLDER}
          disabled={saving}
          className={`${inputClass} resize-none`}
        />
        <span className="text-[11.5px] font-normal leading-[1.5] text-dim">
          Describe how {ASSISTANT_NAME} should talk to you. Leave it empty for {ASSISTANT_NAME}
          &apos;s own tone. It holds from your next message.
        </span>
      </label>
      {feedback ? (
        <SettingsFeedback kind={feedback.kind}>{feedback.message}</SettingsFeedback>
      ) : null}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className={`${primaryButtonClass} w-full`}
      >
        {saving ? 'Saving…' : 'Save tone'}
      </button>
    </div>
  );
}
