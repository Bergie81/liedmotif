// The credential body both provider steps share, in its two states.
//
// An environment key always wins over one saved here, so when there is one there is
// no field to type into: the step names the variable that configured it and offers a
// test of what will actually run. Otherwise the preset's own requirements decide which
// fields appear, from the same primitives Settings → Providers uses.

'use client';

import type { ReactNode } from 'react';
import { Check, CircleHelp } from 'lucide-react';
import {
  BaseUrlField,
  ModelField,
  ProviderChoice,
  SecretField,
} from '@/components/settings/credential-fields';
import { SettingsFeedback } from '@/components/settings/settings-ui';
import type {
  CredentialEditorState,
  ProviderOption,
} from '@/components/settings/use-credential-editor';
import { secondaryButtonClass } from '@/components/ui/form-styles';
import { LiedmotifLoader } from '@/components/ui/loading';
import { cn } from '@/lib/cn';
import { EnvVar } from './onboarding-layout';

export function OnboardingCredentialFields({
  editor,
  options,
  showModel,
  lockedProvider,
  baseUrlOptional,
  environmentManaged,
  environmentVariable,
  providerLabel,
  keyLabel,
  keyPlaceholder,
  testLabel,
  currentMasked,
  encryptionKeyConfigured,
  environmentNote,
  providerNote,
}: {
  editor: CredentialEditorState;
  options: readonly ProviderOption[];
  showModel?: boolean;
  /** The env variable that picks the provider; the picker shows it and is locked. */
  lockedProvider?: string;
  /**
   * The preset works without a base URL, so the field hides behind a disclosure
   * instead of adding a decision to a screen that does not need one.
   */
  baseUrlOptional?: boolean;
  /** The active key comes from `.env`, so this step is read-only. */
  environmentManaged: boolean;
  environmentVariable: string;
  providerLabel: string;
  keyLabel: string;
  keyPlaceholder: string;
  testLabel: string;
  currentMasked: string | null;
  encryptionKeyConfigured: boolean;
  environmentNote?: ReactNode;
  /** A line under the provider picker about the selected provider. */
  providerNote?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      {environmentManaged ? (
        <div className="flex items-start gap-3">
          <Check className="mt-[3px] h-[19px] w-[19px] flex-none text-signal" aria-hidden />
          <div className="min-w-0">
            <b className="block text-[14.5px] font-semibold">{providerLabel} is already set up</b>
            <p className="mt-1 text-[13px] leading-[1.55] text-muted">
              It comes from <EnvVar>{environmentVariable}</EnvVar>, so there is nothing to enter.
            </p>
            {environmentNote ? (
              <p className="mt-2 text-[13px] leading-[1.55] text-muted">{environmentNote}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <ProviderChoice editor={editor} options={options} locked={lockedProvider} />
          {providerNote ? (
            <p className="-mt-2 text-[13px] leading-[1.55] text-muted">{providerNote}</p>
          ) : null}
          <SecretField
            editor={editor}
            label={keyLabel}
            placeholder={keyPlaceholder}
            currentMasked={currentMasked}
          />
          {baseUrlOptional ? (
            <details className="rounded-card-sm border border-line bg-[var(--segment-bg)] px-3.5 py-3">
              <summary className="cursor-pointer list-none text-[13px] font-semibold text-muted [-webkit-tap-highlight-color:transparent] hover:text-paper">
                Use a different endpoint
              </summary>
              <div className="pt-3">
                <BaseUrlField editor={editor} />
              </div>
            </details>
          ) : (
            <BaseUrlField editor={editor} />
          )}
          {showModel ? <ModelField editor={editor} /> : null}

          {!encryptionKeyConfigured ? (
            <SettingsFeedback kind="error">
              Liedmotif cannot store keys safely yet. Set <EnvVar>CREDENTIAL_ENCRYPTION_KEY</EnvVar>{' '}
              in <EnvVar>.env</EnvVar> and restart, or set <EnvVar>{environmentVariable}</EnvVar>{' '}
              there instead.
            </SettingsFeedback>
          ) : null}
        </>
      )}

      <button
        type="button"
        onClick={editor.test}
        disabled={editor.operationPending || !editor.canTest}
        aria-busy={editor.testing}
        className={cn(secondaryButtonClass, 'w-full')}
      >
        {editor.testing ? <LiedmotifLoader size="xs" /> : null}
        {editor.testing ? 'Testing…' : testLabel}
      </button>
    </div>
  );
}

/** The step that usually sends people to a search engine, answered in place. */
export function OnboardingHowTo({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="mt-4 overflow-hidden rounded-card-sm border border-line bg-[var(--segment-bg)]">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-3 text-[13.5px] font-semibold text-muted [-webkit-tap-highlight-color:transparent] hover:text-paper">
        <CircleHelp className="h-4 w-4 flex-none text-lamp" aria-hidden />
        {question}
      </summary>
      <div className="border-t border-line px-3.5 py-3.5 text-[13px] leading-[1.75] text-muted [&_a]:font-semibold [&_a]:text-lamp [&_a]:underline [&_a]:underline-offset-2 [&_b]:font-semibold [&_b]:text-paper [&_ol]:ml-4 [&_ol]:list-decimal">
        {children}
      </div>
    </details>
  );
}

/** Where to get the selected preset's key, for the presets people usually search for. */
export function ProviderKeyHowTo({ providerKey }: { providerKey: string }) {
  switch (providerKey) {
    case 'openai':
      return <OpenAiKeyHowTo />;
    case 'gemini':
      return <GeminiKeyHowTo />;
    case 'openrouter':
      return <OpenRouterKeyHowTo />;
    default:
      return null;
  }
}

/** OpenAI's key, created on its developer platform. */
function OpenAiKeyHowTo() {
  return (
    <OnboardingHowTo question="Where do I get an OpenAI key?">
      <ol>
        <li>
          Open{' '}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
            platform.openai.com/api-keys
          </a>{' '}
          and sign in.
        </li>
        <li>
          Add credit under <b>Settings › Billing</b>.
        </li>
        <li>
          Click <b>Create new secret key</b>.
        </li>
        <li>Copy it and paste it above.</li>
      </ol>
    </OnboardingHowTo>
  );
}

/** OpenRouter's key, which the text LLM and the cover images can both run on. */
function OpenRouterKeyHowTo() {
  return (
    <OnboardingHowTo question="Where do I get an OpenRouter key?">
      <ol>
        <li>
          Create an account at{' '}
          <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer">
            openrouter.ai
          </a>
          .
        </li>
        <li>
          Add credit under <b>Settings › Credits</b>.
        </li>
        <li>
          Open <b>Keys</b> and create a key.
        </li>
        <li>Copy it and paste it above.</li>
      </ol>
    </OnboardingHowTo>
  );
}

/** Google's key for Gemini, created in AI Studio. */
function GeminiKeyHowTo() {
  return (
    <OnboardingHowTo question="Where do I get a Gemini key?">
      <ol>
        <li>
          Open{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
            aistudio.google.com/apikey
          </a>{' '}
          and sign in with your Google account.
        </li>
        <li>
          Click <b>Create API key</b>.
        </li>
        <li>Copy it and paste it above.</li>
      </ol>
    </OnboardingHowTo>
  );
}
