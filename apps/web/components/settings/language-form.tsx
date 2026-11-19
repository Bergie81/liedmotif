'use client';

// Owner default for the session language (Settings → Generation): the language
// used for session titles, track titles, and vocals. The create card preselects
// it for every new Session (each Session can override it in Fine Tune). "Auto
// Detect" derives the language from the create prompt. Persists as a partial
// patch to /api/settings/generation.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GenerationSettings } from '@liedmotif/shared';
import { labelClass, primaryButtonClass } from '@/components/ui/form-styles';
import { SessionLanguageSelect } from '@/components/session-language-select';
import { updateGenerationSettings } from '@/lib/http/api-client';
import type { SessionLanguageChoice } from '@/lib/sessions/session-languages';
import { toast } from '@/lib/toast';
import { useStoredValue } from './use-stored-value';

const SAVE_KEY = 'language-save';

export function LanguageForm({ initial }: { initial: GenerationSettings }) {
  const router = useRouter();
  const [defaultLanguage, setDefaultLanguage] = useStoredValue<SessionLanguageChoice>(
    initial.defaultLanguage,
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    if (saving) return;
    setSaving(true);
    toast.dismiss(SAVE_KEY);
    const result = await updateGenerationSettings({ defaultLanguage });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error.message, { key: SAVE_KEY });
      return;
    }
    router.refresh();
    toast.success('Language setting saved.', { key: SAVE_KEY });
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
