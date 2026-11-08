'use client';

// Owner default for the session language (Settings → Generation): the language
// used for session titles, track titles, and vocals. The create card preselects
// it for every new Session (each Session can override it in Fine Tune). "Auto
// Detect" derives the language from the create prompt. Persists as a partial
// patch to /api/settings/generation.

import { useState } from 'react';
import type { GenerationSettings } from '@liedmotif/shared';
import { labelClass, primaryButtonClass } from '@/components/ui/form-styles';
import { SessionLanguageSelect } from '@/components/session-language-select';
import { updateGenerationSettings } from '@/lib/api-client';
import type { SessionLanguageChoice } from '@/lib/session-languages';
import { SettingsFeedback, type SettingsFeedbackState } from './settings-ui';

export function LanguageForm({ initial }: { initial: GenerationSettings }) {
  const [defaultLanguage, setDefaultLanguage] = useState<SessionLanguageChoice>(
    initial.defaultLanguage,
  );
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SettingsFeedbackState>(null);

  async function save() {
    if (saving) return;
    setFeedback(null);
    setSaving(true);
    const result = await updateGenerationSettings({ defaultLanguage });
    setSaving(false);
    setFeedback(
      result.ok
        ? { kind: 'success', message: 'Language setting saved.' }
        : { kind: 'error', message: result.error.message },
    );
  }

  return (
    <div className="space-y-4">
      <label className={labelClass}>
        <span className="flex items-baseline justify-between gap-2">
          Default language
          <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">
            Every Session can override it
          </span>
        </span>
        <SessionLanguageSelect
          value={defaultLanguage}
          onChange={setDefaultLanguage}
          ariaLabel="Default language"
          testId="default-language"
        />
        <span className="text-[11.5px] font-normal leading-[1.5] text-dim">
          Titles and vocals follow this language. Auto Detect follows the language of your prompt.
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
        {saving ? 'Saving…' : 'Save language'}
      </button>
    </div>
  );
}
