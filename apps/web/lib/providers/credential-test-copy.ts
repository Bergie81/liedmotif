// The Test button's message for a text-LLM or cover-image credential, naming the
// provider and the model so a wrong key reads apart from a mistyped model ID.
// Built only from the preset's label and the model the route resolved — never from
// a provider response.

import type { ValidationReason } from '@liedmotif/providers';

export function credentialTestMessage(input: {
  reason: ValidationReason;
  /** The adapter's fixed message, kept for the reasons this copy does not cover. */
  message?: string;
  providerLabel: string;
  needsKey: boolean;
  kind: 'llm' | 'image';
  model?: string;
}): string | undefined {
  const { reason, providerLabel, model } = input;
  const reached = input.needsKey ? 'Key works' : 'Connected';
  const modelNoun = input.kind === 'image' ? 'image model' : 'model';
  switch (reason) {
    case 'unauthorized':
      return input.needsKey
        ? `${providerLabel} rejected this API key.`
        : `${providerLabel} refused the connection.`;
    case 'unknown_model':
      return model
        ? `${reached}, but ${providerLabel} has no ${modelNoun} “${model}”. Check the model ID for typos.`
        : input.message;
    case 'model_unchecked':
      return model
        ? `${reached}. ${providerLabel} lists no models here, so “${model}” is unchecked.`
        : input.message;
    case 'ok':
      return model ? `${reached} and ${modelNoun} “${model}” found.` : input.message;
    default:
      return input.message;
  }
}
