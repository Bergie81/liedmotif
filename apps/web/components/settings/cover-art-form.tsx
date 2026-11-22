'use client';

// Edit the viewer's own cover-art preferences (Settings → Cover art): the default cover
// style the create card preselects (each session can still override it), and
// the Custom cover style definition. The definition is a bounded style HINT for
// the cover pipeline, never the final image prompt; an empty definition makes
// `Custom` fall back to Auto. Nothing here locks another control: the
// definition also serves Custom picked per Session, on cover regeneration and
// by Random, and the default style still seeds the create card while Tailored
// Cover Art is off. Persists to /api/settings/cover-art.

import Image from 'next/image';
import { useId, useState } from 'react';
import { PenLine, Shuffle, WandSparkles } from 'lucide-react';
import type { CoverArtSettings } from '@liedmotif/db';
import {
  COVER_STYLE_CHOICES,
  COVER_STYLE_PRESETS,
  MAX_COVER_STYLE_HINT_LENGTH,
} from '@liedmotif/shared';
import type { CoverStyleChoice } from '@liedmotif/shared';
import {
  COVER_STYLE_EXPLANATIONS,
  COVER_STYLE_LABELS,
  coverStyleExampleSrc,
} from '@/lib/covers/cover-styles';
import { Switch } from '@/components/ui/controls';
import { inputClass, labelClass, primaryButtonClass } from '@/components/ui/form-styles';
import { toast } from '@/lib/toast';

const SAVE_KEY = 'cover-art-save';

const PLACEHOLDER =
  'Example: hand-cut woodblock print, bold ink lines, rough paper grain, colors that fit the mood.';

// A definition naming fixed colors or objects repeats them on every cover;
// technique-only wording lets each Session's theme pick color and subject.
const CUSTOM_STYLE_TIP =
  'Describe medium, line, texture and contrast, not fixed colors or objects. Phrases like "colors that fit the mood" keep each cover different.';

const TILE_CLASS = 'relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-[10px]';

/**
 * A choice's example tile, pure decoration (empty alt) so a screen reader hears
 * only the style's name and explanation. Auto and Random can land on any
 * preset, so both show all six examples, told apart by the glyph on top;
 * Custom has no example because its look is whatever the user writes.
 */
function CoverStyleTile({ choice }: { choice: CoverStyleChoice }) {
  if (choice === 'custom') {
    return (
      <span className={`${TILE_CLASS} grid place-items-center border border-line-2 bg-panel`}>
        <PenLine className="h-6 w-6 text-muted" aria-hidden />
      </span>
    );
  }
  if (choice === 'auto' || choice === 'random') {
    const Glyph = choice === 'auto' ? WandSparkles : Shuffle;
    return (
      <span className={`${TILE_CLASS} bg-panel-2`}>
        <span className="grid h-full w-full grid-cols-3 grid-rows-2">
          {COVER_STYLE_PRESETS.map((preset) => (
            <span key={preset} className="relative">
              <Image
                src={coverStyleExampleSrc(preset)}
                alt=""
                fill
                sizes="24px"
                className="object-cover"
              />
            </span>
          ))}
        </span>
        <span className="absolute left-1/2 top-1/2 grid h-[30px] w-[30px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-ink/70 text-paper backdrop-blur-[4px]">
          <Glyph className="h-4 w-4" aria-hidden />
        </span>
      </span>
    );
  }
  return (
    <span className={`${TILE_CLASS} bg-panel-2`}>
      <Image src={coverStyleExampleSrc(choice)} alt="" fill sizes="72px" className="object-cover" />
    </span>
  );
}

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
  const idPrefix = useId();
  const showEmptyDefinitionHint = defaultStyle === 'custom' && definition.trim() === '';

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
      toast.success('Saved. Your definition was optimized by your text AI.', { key: SAVE_KEY });
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
            Use Tailored Cover Art generation
          </div>
          <p className="mt-1 text-[11.5px] leading-[1.5] text-dim">
            New sessions get covers in your chosen style from your image provider, which costs per
            cover. Off, they use the basic cover art that comes with the music at no extra cost.
            Every session can override this on the create card.
          </p>
        </div>
        <Switch
          checked={!useStandardCoverArt}
          onCheckedChange={(on) => setUseStandardCoverArt(!on)}
          aria-label="Use Tailored Cover Art generation"
          data-testid="use-tailored-cover-art"
        />
      </div>
      <fieldset data-testid="default-cover-style" className="space-y-2">
        <legend className="mb-2 text-[13px] font-semibold text-paper">Default cover style</legend>
        {COVER_STYLE_CHOICES.map((value) => (
          <div
            key={value}
            className="rounded-[13px] border border-line-2 bg-[var(--control-bg)] has-[input[type=radio]:checked]:border-lamp/55 has-[input[type=radio]:checked]:bg-lamp/[0.08] light:has-[input[type=radio]:checked]:border-lamp-fill/55 light:has-[input[type=radio]:checked]:bg-lamp-fill/[0.13]"
          >
            <label className="group flex cursor-pointer items-center gap-3 rounded-[12px] px-3 py-3 [-webkit-tap-highlight-color:transparent] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-lamp">
              <input
                type="radio"
                name={`${idPrefix}-default-cover-style`}
                value={value}
                checked={defaultStyle === value}
                onChange={() => setDefaultStyle(value)}
                aria-labelledby={`${idPrefix}-${value}-name`}
                aria-describedby={`${idPrefix}-${value}-explanation`}
                className="sr-only"
              />
              <CoverStyleTile choice={value} />
              <span className="min-w-0">
                <span
                  id={`${idPrefix}-${value}-name`}
                  className="block text-[14px] font-semibold text-paper group-has-[:checked]:text-lamp light:group-has-[:checked]:text-lamp-fill"
                >
                  {COVER_STYLE_LABELS[value]}
                </span>
                <span
                  id={`${idPrefix}-${value}-explanation`}
                  className="block text-[12px] leading-[1.45] text-muted"
                >
                  {COVER_STYLE_EXPLANATIONS[value]}
                </span>
              </span>
            </label>
            {value === 'custom' ? (
              <div className={`${labelClass} px-4 pb-4 pt-1`}>
                <span className="flex items-baseline justify-between gap-2">
                  <label htmlFor={`${idPrefix}-definition`}>Custom style definition</label>
                  <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">
                    {definition.length}/{MAX_COVER_STYLE_HINT_LENGTH}
                  </span>
                </span>
                <textarea
                  id={`${idPrefix}-definition`}
                  data-testid="cover-style-definition"
                  rows={3}
                  maxLength={MAX_COVER_STYLE_HINT_LENGTH}
                  value={definition}
                  onChange={(e) => setDefinition(e.target.value)}
                  placeholder={PLACEHOLDER}
                  aria-describedby={
                    showEmptyDefinitionHint
                      ? `${idPrefix}-definition-tip ${idPrefix}-definition-hint`
                      : `${idPrefix}-definition-tip`
                  }
                  className={`${inputClass} resize-none`}
                />
                <span
                  id={`${idPrefix}-definition-tip`}
                  className="text-[11.5px] font-normal leading-[1.5] text-dim"
                >
                  {CUSTOM_STYLE_TIP}
                </span>
                {showEmptyDefinitionHint ? (
                  <span
                    id={`${idPrefix}-definition-hint`}
                    className="text-[11.5px] font-normal leading-[1.5] text-muted"
                  >
                    Without a definition, Custom works like Auto.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </fieldset>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-paper">Enhance prompts</div>
          <p className="mt-1 text-[11.5px] leading-[1.5] text-dim">
            {llmConfigured
              ? 'Your text AI rewrites cover guidance and custom style definitions into image-model-friendly phrasing before generation.'
              : 'Requires a text AI under Settings → Providers.'}
          </p>
        </div>
        <Switch
          checked={llmConfigured && enhancementEnabled}
          onCheckedChange={setEnhancementEnabled}
          disabled={!llmConfigured}
          aria-label="Enhance prompts with the text AI"
          data-testid="prompt-enhancement-toggle"
        />
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className={`${primaryButtonClass} w-full`}
      >
        {saving ? 'Saving…' : 'Save Cover Art'}
      </button>
    </div>
  );
}
