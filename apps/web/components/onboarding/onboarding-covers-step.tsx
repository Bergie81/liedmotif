// Step 6 — how Covers get painted, and how much of that the owner will pay for.
// Every Session wears a Cover whatever is chosen here; the switch only decides
// whether the image model paints it (`coverSource`).
//
// Choosing Tailored Cover Art asks for the image provider's key and model, saved the
// way the text LLM's are; a key or model in `.env` wins and is reported instead. The
// key is optional: without one the switch is kept, just inert. The ceilings are
// stored per instance. The music-provider source is reported, never offered: it
// needs no choice — it simply takes over whenever the image model is off or absent.

'use client';

import { Gauge, Image } from 'lucide-react';
import { CredentialMutationGroup } from '@/components/settings/credential-mutation-group';
import { SettingsControlRow } from '@/components/settings/settings-ui';
import { useCredentialEditor } from '@/components/settings/use-credential-editor';
import { Switch } from '@/components/ui/controls';
import { cn } from '@/lib/cn';
import { IMAGE_PROVIDERS, lockedImageModel } from '@/lib/configurable-providers';
import { coverSource, type CoverSource } from '@/lib/cover-source';
import type { OnboardingCredential } from '@/lib/onboarding-data';
import { OnboardingCredentialFields, OpenRouterKeyHowTo } from './onboarding-credential-fields';
import {
  OnboardingCard,
  OnboardingLimitRow,
  OnboardingNote,
  OnboardingSpendActions,
  OnboardingStepHeader,
  OnboardingSubhead,
} from './onboarding-layout';
import { coverBudgetPatch, stepLimit, type CoverBudget } from './onboarding-limits-model';
import { COVER_COST_CENTS, coverBudgetNote } from './onboarding-model';
import { useLimitSave } from './use-limit-save';

interface CoversStepProps {
  budget: CoverBudget;
  /** The image provider's key, as resolved when the flow loaded. */
  credential: OnboardingCredential;
  /** A key resolves now — as loaded, or saved on this step since. */
  imageConnected: boolean;
  /** The image model — as loaded, or saved on this step since. */
  imageModel: string;
  encryptionKeyConfigured: boolean;
  musicProviderCoverConfigured: boolean;
  onChange: (budget: CoverBudget) => void;
  onConnected: (model: string) => void;
  onDone: () => void;
}

// The mutation gate has to mount ABOVE the editor hook that reads it, so the step
// body is its own component.
export function OnboardingCoversStep(props: CoversStepProps) {
  return (
    <CredentialMutationGroup>
      <CoversStepBody {...props} />
    </CredentialMutationGroup>
  );
}

function CoversStepBody({
  budget,
  credential,
  imageConnected,
  imageModel,
  encryptionKeyConfigured,
  musicProviderCoverConfigured,
  onChange,
  onConnected,
  onDone,
}: CoversStepProps) {
  const { saving, error, save } = useLimitSave(onDone);
  const lockedModel = lockedImageModel(credential);
  const initialModel = lockedModel ? undefined : imageModel;
  const editor = useCredentialEditor({
    providerType: 'image',
    options: IMAGE_PROVIDERS,
    initialProviderKey: credential.providerKey,
    currentMasked: credential.masked,
    configured: imageConnected,
    databaseWritesEnabled: encryptionKeyConfigured,
    showModel: true,
    initialModel,
    // The key is stored first, and the Cover budget follows it in the same commit.
    onSaved: (saved) => {
      onConnected(saved.model ?? '');
      void save(coverBudgetPatch(budget));
    },
  });
  const sourceInput = {
    imageProviderConfigured: imageConnected,
    musicProviderCoverConfigured,
    tailoredCoverArtEnabled: budget.tailoredCoverArtEnabled,
  };
  const source = coverSource(sourceInput);
  // What the switch actually falls back TO. The music provider wins that spot
  // whenever it is configured, so the explainer must not promise the placeholder.
  const withoutImageModel = coverSource({ ...sourceInput, tailoredCoverArtEnabled: false });
  const busy = saving || editor.operationPending;
  const keyProvider = editor.selected?.label ?? credential.displayName;
  // A changed model alone is saved only beside a key that already resolves: the
  // credentials route refuses a model with no key anywhere.
  const modelChanged = editor.model.trim() !== (initialModel ?? '');
  const savesCredential =
    budget.tailoredCoverArtEnabled &&
    encryptionKeyConfigured &&
    (Boolean(editor.secret.trim()) || (imageConnected && modelChanged));
  // A key typed here paints once Save stores it, so its caps can be set beforehand.
  const painting = source === 'image' || savesCredential;
  // The switch follows the caps it governs: both are live only while Covers are painted.
  const capped = painting && budget.ceilingEnabled;

  function commit() {
    const built = coverBudgetPatch(budget);
    if (savesCredential && built.ok) void editor.save();
    else void save(built);
  }

  return (
    <section>
      <OnboardingStepHeader eyebrow="Optional" title="Choose your Cover art">
        Every Session gets a free Cover. For art in your Cover style, with your People on it, turn
        on Tailored Cover Art and add an image key. No key? Just continue.
      </OnboardingStepHeader>

      <OnboardingSubhead icon={<Image className="h-[17px] w-[17px]" aria-hidden />}>
        How Covers are made
      </OnboardingSubhead>

      <OnboardingCard className="mt-0">
        <SettingsControlRow
          label="Generate Tailored Cover Art"
          description={
            imageConnected
              ? `Uses ${credential.displayName}${imageModel ? ` · ${imageModel}` : ''} · about ${COVER_COST_CENTS} cents a Cover`
              : `Needs your own ${credential.displayName} key · about ${COVER_COST_CENTS} cents a Cover`
          }
        >
          <Switch
            checked={budget.tailoredCoverArtEnabled}
            disabled={busy}
            onCheckedChange={(checked) => onChange({ ...budget, tailoredCoverArtEnabled: checked })}
            aria-label="Generate Tailored Cover Art"
          />
        </SettingsControlRow>
      </OnboardingCard>

      {budget.tailoredCoverArtEnabled ? (
        <>
          <OnboardingCard className="mt-3">
            <OnboardingCredentialFields
              editor={editor}
              options={IMAGE_PROVIDERS}
              environmentManaged={credential.environmentManaged}
              environmentVariable="IMAGE_API_KEY"
              showModel
              lockedModel={lockedModel}
              providerLabel={`The ${keyProvider} image key`}
              keyLabel={`${keyProvider} API key`}
              keyPlaceholder="sk-…"
              testLabel={
                credential.environmentManaged
                  ? 'Test the configured key and model'
                  : 'Test the key and model'
              }
              currentMasked={credential.masked}
              encryptionKeyConfigured={encryptionKeyConfigured}
            />
          </OnboardingCard>
          {credential.environmentManaged || editor.providerKey !== 'openrouter' ? null : (
            <OpenRouterKeyHowTo note="Already added an OpenRouter key for the Text AI? The same key works here." />
          )}
        </>
      ) : null}

      <OnboardingNote>
        <CoverSourceExplainer
          source={source}
          withoutImageModel={withoutImageModel}
          awaitingKey={budget.tailoredCoverArtEnabled && !imageConnected}
        />
      </OnboardingNote>

      <OnboardingSubhead icon={<Gauge className="h-[17px] w-[17px]" aria-hidden />}>
        Limits
      </OnboardingSubhead>

      <OnboardingCard className={cn('mt-0', !painting && 'opacity-45')}>
        <SettingsControlRow
          label="Limit my Covers"
          description="Only affects you. Members have their own budgets."
        >
          <Switch
            checked={budget.ceilingEnabled}
            disabled={busy || !painting}
            onCheckedChange={(ceilingEnabled) => onChange({ ...budget, ceilingEnabled })}
            aria-label="Limit my Covers"
          />
        </SettingsControlRow>
      </OnboardingCard>

      <OnboardingCard className={cn('mt-3', !capped && 'opacity-45')}>
        <OnboardingLimitRow
          label="Covers per day"
          description="Includes Covers you regenerate"
          value={budget.coversPerDay}
          unit="cov"
          step={5}
          disabled={busy || !capped}
          onStep={(amount) =>
            onChange({ ...budget, coversPerDay: stepLimit(budget.coversPerDay, amount) })
          }
        />
        <OnboardingLimitRow
          label="Covers per month"
          description="Resets on the 1st of each month"
          value={budget.coversPerMonth}
          unit="cov"
          step={50}
          disabled={busy || !capped}
          onStep={(amount) =>
            onChange({ ...budget, coversPerMonth: stepLimit(budget.coversPerMonth, amount) })
          }
        />
      </OnboardingCard>

      {/* The caps bind only painted Covers, so with nothing painting there is no cap or
          cost to state; the dimmed section above already says it is inert. */}
      {painting ? (
        <OnboardingNote>
          <CoverBudgetExplainer
            uncapped={!budget.ceilingEnabled}
            coversPerDay={Number(budget.coversPerDay)}
          />
        </OnboardingNote>
      ) : null}

      <OnboardingSpendActions
        label="Save and continue"
        saving={saving || editor.saving}
        error={error}
        onCommit={commit}
      />
    </section>
  );
}

/** What the Cover caps above it buy, in words. */
function CoverBudgetExplainer({
  uncapped,
  coversPerDay,
}: {
  uncapped: boolean;
  coversPerDay: number;
}) {
  if (uncapped) {
    return (
      <>
        <b className="font-semibold text-paper">No cap on your own Covers.</b> Each new Session gets
        one, plus any you regenerate, at about{' '}
        <span className="text-lamp">{COVER_COST_CENTS} cents</span> each.
      </>
    );
  }
  const note = coverBudgetNote(coversPerDay);
  if (note.covers === 0) {
    return (
      <>
        <b className="font-semibold text-paper">No generated Covers.</b> Sessions use the free{' '}
        <span className="text-lamp">Liedmotif Cover</span> instead.
      </>
    );
  }
  return (
    <>
      <b className="font-semibold text-paper">{note.covers} Covers a day</b> costs at most{' '}
      <span className="text-lamp">${note.dailyCostUsd} a day</span>.
    </>
  );
}

/** What the switch above it actually resolved to, in words. */
function CoverSourceExplainer({
  source,
  withoutImageModel,
  awaitingKey,
}: {
  source: CoverSource;
  /** Where Covers would come from with the switch off — not always the placeholder. */
  withoutImageModel: CoverSource;
  /** Tailored Cover Art is chosen, but no image key resolves yet. */
  awaitingKey: boolean;
}) {
  switch (source) {
    case 'image':
      return (
        <>
          Covers use your Cover style and can show your People. Turn it off and{' '}
          {withoutImageModel === 'music-provider'
            ? 'your music provider makes them for free, from the music alone'
            : 'Sessions use the free Liedmotif Cover instead'}
          .
        </>
      );
    case 'music-provider':
      return (
        <>
          Covers come from <b className="font-semibold text-paper">your music provider</b>, for
          free. They are based on the music alone, so they cannot use your Cover style or show your
          People.
          {awaitingKey ? ' Add the image key above for Tailored Cover Art.' : null}
        </>
      );
    case 'none':
      return (
        <>
          Sessions use the free <b className="font-semibold text-paper">Liedmotif Cover</b>. It
          cannot use your Cover style or show your People.
          {awaitingKey ? ' Add the image key above for Tailored Cover Art.' : null}
        </>
      );
  }
}
