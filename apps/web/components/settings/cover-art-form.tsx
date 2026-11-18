'use client';

// Edit the viewer's own cover-art preferences (Settings → Cover art): the default cover
// style the create card preselects (each session can still override it), and
// the Custom cover style definition. The definition is a bounded style HINT for
// the cover pipeline, never the final image prompt, and is editable only while
// `Custom` is the selected default; an empty definition makes `Custom` fall
// back to Auto. Persists to /api/settings/cover-art.

import { useState } from 'react';
import type { CoverArtSettings } from '@liedmotif/db';
import { COVER_STYLE_CHOICES, MAX_COVER_STYLE_HINT_LENGTH } from '@liedmotif/shared';
import type { CoverStyleChoice } from '@liedmotif/shared';
import { COVER_STYLE_LABELS } from '@/lib/cover-styles';
import { Switch } from '@/components/ui/controls';
import { inputClass, labelClass, primaryButtonClass } from '@/components/ui/form-styles';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/lib/toast';

const SAVE_KEY = 'cover-art-save';

const PLACEHOLDER =
  'Example: hand-cut woodblock print, bold ink lines, rough paper grain, colors that fit the mood.';

// A definition naming fixed colors or objects repeats them on every cover;
// technique-only wording lets each Session's theme pick color and subject.
const CUSTOM_STYLE_TIP =
  'Describe medium, line, texture and contrast, not fixed colors or objects. Phrases like "colors that fit the mood" keep each cover different.';

export function CoverArtForm({
  initial,
  llmConfigured,
}: {
  initial: CoverArtSettings;
  llmConfigured: boolean;
}) {
  const [defaultStyle, setDefaultStyle] = useState<CoverStyleChoice>(initial.defaultStyle);
  const [definition, setDefinition] = useState(initial.customStyleDefinition);
  const [enhancementEnabled, setEnhancementEnabled] = useState(initial.promptEnhancementEnabled);
  const [useStandardCoverArt, setUseStandardCoverArt] = useState(initial.useStandardCoverArt);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    toast.dismiss(SAVE_KEY);
    const res = await fetch('/api/settings/cover-art', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultStyle,
        customStyleDefinition: definition,
        promptEnhancementEnabled: enhancementEnabled,
        useStandardCoverArt,
      }),
    }).catch(() => null);
    const data = (res ? await res.json().catch(() => ({})) : {}) as {
      ok?: boolean;
      error?: string | { message?: string };
      settings?: CoverArtSettings;
      enhancement?: { attempted: boolean; applied: boolean };
    };
    setSaving(false);
    if (!(res?.ok && data.ok)) {
      const message = typeof data.error === 'string' ? data.error : data.error?.message;
      toast.error(message ?? 'Could not save.', { key: SAVE_KEY });
      return;
    }
    // Visible write-back (decision D4): the stored definition — enhanced or
    // not — is exactly what the field shows after saving.
    if (data.settings) setDefinition(data.settings.customStyleDefinition);
    if (data.enhancement?.applied) {
      toast.success('Saved. Your definition was optimized by your Text AI.', { key: SAVE_KEY });
    } else if (data.enhancement?.attempted) {
      toast.warning('Saved. Enhancement was unavailable, so your definition was kept as written.', {
        key: SAVE_KEY,
      });
    } else {
      toast.success('Saved.', { key: SAVE_KEY });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-paper">
            Use Tailored Cover Art Generation
          </div>
          <p className="mt-1 text-[11.5px] leading-[1.5] text-dim">
            New Sessions get covers in your chosen style from your image provider, which costs per
            cover. Off, they use the basic cover art that comes with the music at no extra cost.
            Every Session can override this on the create card.
          </p>
        </div>
        <Switch
          checked={!useStandardCoverArt}
          onCheckedChange={(on) => setUseStandardCoverArt(!on)}
          aria-label="Use Tailored Cover Art Generation"
          data-testid="use-tailored-cover-art"
        />
      </div>
      <label className={`${labelClass} ${useStandardCoverArt ? 'opacity-40' : ''}`}>
        Default cover style
        <Select
          value={defaultStyle}
          onValueChange={(v) => setDefaultStyle(v as CoverStyleChoice)}
          disabled={useStandardCoverArt}
        >
          <SelectTrigger aria-label="Default cover style" data-testid="default-cover-style">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COVER_STYLE_CHOICES.map((value) => (
              <SelectItem key={value} value={value}>
                {COVER_STYLE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label
        className={`${labelClass} ${defaultStyle !== 'custom' || useStandardCoverArt ? 'opacity-40' : ''}`}
      >
        <span className="flex items-baseline justify-between gap-2">
          Custom style definition
          <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">
            {definition.length}/{MAX_COVER_STYLE_HINT_LENGTH}
          </span>
        </span>
        <textarea
          data-testid="cover-style-definition"
          rows={3}
          maxLength={MAX_COVER_STYLE_HINT_LENGTH}
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          placeholder={PLACEHOLDER}
          disabled={defaultStyle !== 'custom' || useStandardCoverArt}
          className={`${inputClass} resize-none disabled:cursor-not-allowed`}
        />
        <span className="text-[11.5px] font-normal leading-[1.5] text-dim">
          {defaultStyle === 'custom' ? CUSTOM_STYLE_TIP : 'Select Custom to edit your definition.'}
        </span>
      </label>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-paper">Enhance prompts</div>
          <p className="mt-1 text-[11.5px] leading-[1.5] text-dim">
            {llmConfigured
              ? 'Your Text AI rewrites cover guidance and custom style definitions into image-model-friendly phrasing before generation.'
              : 'Requires a Text AI under Settings → Providers.'}
          </p>
        </div>
        <Switch
          checked={llmConfigured && enhancementEnabled}
          onCheckedChange={setEnhancementEnabled}
          disabled={!llmConfigured}
          aria-label="Enhance prompts with the Text AI"
          data-testid="prompt-enhancement-toggle"
        />
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className={`${primaryButtonClass} w-full`}
      >
        {saving ? 'Saving…' : 'Save cover art'}
      </button>
    </div>
  );
}
