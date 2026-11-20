// Step 3 — the music model, the one hard-required provider. Nothing
// generates without it, so this is the only credential screen that gates the flow.
//
// The gate is "a resolvable credential nothing has since changed": an environment
// key, or a stored one left alone, passes as-is; anything edited here has to pass a
// real provider call first, and is saved before the flow moves on.

'use client';

import { CredentialMutationGroup } from '@/components/settings/credential-mutation-group';
import { useCredentialEditor } from '@/components/settings/use-credential-editor';
import { DocsLink } from '@/components/ui/docs-link';
import type { OnboardingCredential } from '@/lib/onboarding/onboarding-data';
import { OnboardingCredentialFields, OnboardingHowTo } from './onboarding-credential-fields';
import {
  OnboardingActions,
  OnboardingCard,
  OnboardingPrimaryAction,
  OnboardingStepHeader,
} from './onboarding-layout';
import { TRACK_COST_CENTS } from './onboarding-model';

interface MusicStepProps {
  credential: OnboardingCredential;
  encryptionKeyConfigured: boolean;
  /** A credential is now resolvable, for the rail's running record. */
  onConnected: () => void;
  onDone: () => void;
}

// The mutation gate has to mount ABOVE the editor hook that reads it, so the step
// body is its own component.
export function OnboardingMusicStep(props: MusicStepProps) {
  return (
    <CredentialMutationGroup>
      <MusicStepBody {...props} />
    </CredentialMutationGroup>
  );
}

function MusicStepBody({
  credential,
  encryptionKeyConfigured,
  onConnected,
  onDone,
}: MusicStepProps) {
  const { environmentManaged } = credential;
  // One socket, not a preset list: a Suno-compatible endpoint is selected by base
  // URL rather than by choosing a different provider, so the URL is an optional
  // detail rather than a required field.
  const options = [
    {
      value: credential.providerKey,
      label: credential.displayName,
      needsKey: true,
      needsBaseUrl: true,
    },
  ];
  const editor = useCredentialEditor({
    providerType: 'music',
    options,
    initialProviderKey: credential.providerKey,
    currentMasked: credential.masked,
    configured: credential.configured,
    databaseWritesEnabled: encryptionKeyConfigured,
    initialBaseUrl: credential.baseUrl,
    envLocks: credential.envLocks,
    onSaved: () => {
      onConnected();
      onDone();
    },
  });

  const edited =
    Boolean(editor.secret.trim()) || editor.baseUrl.trim() !== (credential.baseUrl ?? '').trim();
  // An edit is only proven by a real provider call. An untouched credential — from
  // `.env` or already stored — is proven by already working.
  const proven = editor.testState.status === 'success' || (credential.configured && !edited);

  return (
    <section>
      <OnboardingStepHeader
        eyebrow="Required"
        eyebrowTone="required"
        title="Connect Your Music Model"
      >
        It makes every track, billed to your own account at about {TRACK_COST_CENTS} cents each.
        {credential.configured ? null : ' Paste your key and test it to continue.'}
      </OnboardingStepHeader>

      <OnboardingCard>
        <OnboardingCredentialFields
          editor={editor}
          options={options}
          baseUrlOptional
          environmentManaged={environmentManaged}
          environmentVariable="SUNO_API_KEY"
          providerLabel="The music model"
          keyLabel={`${credential.displayName} API key`}
          keyPlaceholder="Paste it here"
          testLabel={environmentManaged ? 'Test the Configured Key' : 'Test the Key'}
          currentMasked={credential.masked}
          encryptionKeyConfigured={encryptionKeyConfigured}
        />
      </OnboardingCard>

      {environmentManaged ? null : (
        <OnboardingHowTo question="Where do I get a SunoAPI key?">
          <ol>
            <li>
              Create an account at{' '}
              <a href="https://sunoapi.org" target="_blank" rel="noopener noreferrer">
                sunoapi.org
              </a>
              .
            </li>
            <li>
              Buy credits. Generation is prepaid, and <b>$5 is plenty to start</b>.
            </li>
            <li>
              Open <b>Dashboard › API Keys</b> and create a key.
            </li>
            <li>Copy it and paste it above.</li>
          </ol>
          <p className="mt-2">
            <DocsLink path="providers-and-keys#when-credits-run-out">
              What happens when credits run out
            </DocsLink>
          </p>
        </OnboardingHowTo>
      )}

      <OnboardingActions>
        <OnboardingPrimaryAction
          label={edited ? 'Save and Continue' : 'Continue'}
          busyLabel="Saving…"
          busy={editor.saving}
          disabled={!proven || editor.operationPending}
          onClick={() => {
            if (edited) void editor.save();
            else onDone();
          }}
        />
      </OnboardingActions>
    </section>
  );
}
