'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Switch } from '@/components/ui/controls';
import { secondaryButtonClass } from '@/components/ui/form-styles';
import { resetLearnedTaste, savePersonalization } from '@/lib/api-client';
import { SettingsCard, SettingsControlRow, SettingsFeedback, SettingsSection } from './settings-ui';

const PERSONALIZE_DESCRIPTION_ID = 'personalize-suggestions-description';

/**
 * Learned taste's two controls. Neither changes anything Your Stats measures.
 */
export function PersonalizationSection({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null,
  );

  const toggle = async (next: boolean) => {
    setBusy(true);
    setEnabled(next);
    const saved = await savePersonalization(next);
    if (!saved.ok) setEnabled(!next);
    setFeedback(saved.ok ? null : { kind: 'error', text: 'The setting could not be saved.' });
    setBusy(false);
  };
  const reset = async () => {
    const done = await resetLearnedTaste();
    setFeedback(
      done.ok
        ? { kind: 'success', text: 'Learned taste reset.' }
        : { kind: 'error', text: 'Your learned taste could not be reset.' },
    );
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
      {feedback ? (
        <div className="mt-2">
          <SettingsFeedback kind={feedback.kind}>{feedback.text}</SettingsFeedback>
        </div>
      ) : null}
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
