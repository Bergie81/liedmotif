'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Switch } from '@/components/ui/controls';
import { secondaryButtonClass } from '@/components/ui/form-styles';
import { resetLearnedTaste, savePersonalization } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { SettingsCard, SettingsControlRow, SettingsSection } from './settings-ui';

const PERSONALIZE_DESCRIPTION_ID = 'personalize-suggestions-description';
const SAVE_KEY = 'personalization-save';
const RESET_KEY = 'learned-taste-reset';

/**
 * Learned taste's two controls. Neither changes anything Your Stats measures.
 */
export function PersonalizationSection({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setEnabled(next);
    const saved = await savePersonalization(next);
    if (saved.ok) {
      toast.dismiss(SAVE_KEY);
    } else {
      setEnabled(!next);
      toast.error('The setting could not be saved.', { key: SAVE_KEY });
    }
    setBusy(false);
  };
  const reset = async () => {
    const done = await resetLearnedTaste();
    if (done.ok) toast.success('Learned taste reset.', { key: RESET_KEY });
    else toast.error('Your learned taste could not be reset.', { key: RESET_KEY });
    setConfirmingReset(false);
  };

  return (
    <SettingsSection title="Personalization">
      <SettingsCard>
        <SettingsControlRow
          label="Personalize suggestions"
          description="Learns from what you play, favorite and keep in Playlists to suggest For you genres. Off stops learning and its use; your stats keep recording."
          descriptionId={PERSONALIZE_DESCRIPTION_ID}
        >
          <Switch
            checked={enabled}
            onCheckedChange={(next) => void toggle(next)}
            disabled={busy}
            aria-label="Personalize suggestions"
            aria-describedby={PERSONALIZE_DESCRIPTION_ID}
          />
        </SettingsControlRow>
        <SettingsControlRow
          label="Reset learned taste"
          description="Starts learning afresh from what you do next. Your listening history and stats stay."
        >
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setConfirmingReset(true)}
          >
            Reset
          </button>
        </SettingsControlRow>
      </SettingsCard>
      {confirmingReset ? (
        <ConfirmDialog
          heading="Reset learned taste"
          body="What Liedmotif has learned about your taste is forgotten for good, and your current Favorites and Playlists will not refill it: only what you play and keep from now on teaches it again. Your listening history, stats and music are not touched."
          confirmLabel="Reset taste"
          onConfirm={reset}
          onClose={() => setConfirmingReset(false)}
        />
      ) : null}
    </SettingsSection>
  );
}
