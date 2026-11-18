// Step 5 — the optional text LLM (never mandatory). It runs once per
// Session, not once per Track, and without it prompts pass through to the music
// model deterministically — so skipping costs nothing that cannot be added later.

'use client';

import { CredentialMutationGroup } from '@/components/settings/credential-mutation-group';
import { useCredentialEditor } from '@/components/settings/use-credential-editor';
import { largeSecondaryButtonClass } from '@/components/ui/form-styles';
import { cn } from '@/lib/cn';
import { LLM_PROVIDERS } from '@/lib/llm-providers';
import type { OnboardingCredential } from '@/lib/onboarding-data';
import {
  GeminiKeyHowTo,
  OnboardingCredentialFields,
  OpenRouterKeyHowTo,
} from './onboarding-credential-fields';
import {
  EnvVar,
  OnboardingActions,
  OnboardingCard,
  OnboardingPrimaryAction,
  OnboardingStepHeader,
} from './onboarding-layout';

interface LlmStepProps {
  credential: OnboardingCredential;
  encryptionKeyConfigured: boolean;
  onConnected: (model: string) => void;
  onDone: () => void;
}

// The mutation gate has to mount ABOVE the editor hook that reads it, so the step
// body is its own component.
export function OnboardingLlmStep(props: LlmStepProps) {
  return (
    <CredentialMutationGroup>
      <LlmStepBody {...props} />
    </CredentialMutationGroup>
  );
}

function LlmStepBody({ credential, encryptionKeyConfigured, onConnected, onDone }: LlmStepProps) {
  const { environmentManaged } = credential;
  const editor = useCredentialEditor({
    providerType: 'llm',
    options: LLM_PROVIDERS,
    initialProviderKey: credential.providerKey,
    currentMasked: credential.masked,
    configured: credential.configured,
    hasExistingSelection: credential.configured,
    databaseWritesEnabled: encryptionKeyConfigured,
    showModel: true,
    initialBaseUrl: credential.baseUrl,
    initialModel: credential.model,
    onSaved: (saved) => {
      onConnected(saved.model ?? '');
      onDone();
    },
  });

  return (
    <section>
      <OnboardingStepHeader eyebrow="Optional · recommended" title="Add a Text AI">
        It turns what you type into a detailed music style and writes Session names, Track titles,
        and lyric ideas.
        {credential.configured
          ? null
          : ' Skip it and your words go to the music model as written. You can add it later in Settings › Providers.'}
      </OnboardingStepHeader>

      <OnboardingCard>
        <OnboardingCredentialFields
          editor={editor}
          options={LLM_PROVIDERS}
          showModel
          environmentManaged={environmentManaged}
          environmentVariable="LLM_API_KEY"
          providerLabel={credential.displayName}
          keyLabel={`${editor.selected?.label ?? credential.displayName} API key`}
          keyPlaceholder="sk-…"
          testLabel={environmentManaged ? 'Test the configured connection' : 'Test the connection'}
          currentMasked={credential.masked}
          encryptionKeyConfigured={encryptionKeyConfigured}
          environmentNote={
            <>
              The provider and model come from <EnvVar>LLM_PROVIDER</EnvVar> and{' '}
              <EnvVar>LLM_MODEL</EnvVar>.
            </>
          }
        />
      </OnboardingCard>

      {environmentManaged ? null : <KeyHowTo providerKey={editor.providerKey} />}

      <OnboardingActions>
        {environmentManaged ? (
          <OnboardingPrimaryAction label="Continue" onClick={onDone} />
        ) : (
          <>
            <OnboardingPrimaryAction
              label="Save and continue"
              busyLabel="Saving…"
              busy={editor.saving}
              disabled={editor.operationPending || !encryptionKeyConfigured}
              onClick={() => void editor.save()}
            />
            {/* Skipping declines to ADD one; it never claims a stored key is gone. */}
            <button
              type="button"
              onClick={onDone}
              disabled={editor.operationPending}
              className={cn(largeSecondaryButtonClass, 'w-full')}
            >
              {credential.configured ? 'Leave it as it is' : 'Skip for now'}
            </button>
          </>
        )}
      </OnboardingActions>
    </section>
  );
}

/** Where to get the selected preset's key, for the presets people usually search for. */
function KeyHowTo({ providerKey }: { providerKey: string }) {
  switch (providerKey) {
    case 'openrouter':
      return <OpenRouterKeyHowTo />;
    case 'gemini':
      return <GeminiKeyHowTo />;
    default:
      return null;
  }
}
