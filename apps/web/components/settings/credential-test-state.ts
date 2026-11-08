export type CredentialTestState =
  { status: 'idle' | 'busy' } | { status: 'success' | 'error'; message: string };

interface CredentialTestResponse {
  status: number;
  body: CredentialTestBody;
}

// The probe answers `{ ok, message }`, and its refusals answer `error` in two
// shapes: a plain string from the route's own 400/429, the API error envelope's
// nested object from the admin guard. Both have to resolve to a STRING — an
// object reaching `message` is rendered as a React child.
export interface CredentialTestBody {
  ok?: boolean;
  message?: string;
  error?: string | { message?: string };
  /** Non-secret probe detail; a provider that lists its models (Ollama) puts them here. */
  detail?: Record<string, unknown>;
}

/** The model names a test listed, for the model picker — also when the chosen model is not among them. */
export function listedModels(body: CredentialTestBody): string[] {
  const models = body.detail?.models;
  return Array.isArray(models) ? models.filter((m): m is string => typeof m === 'string') : [];
}

export function beginCredentialTest(): CredentialTestState {
  return { status: 'busy' };
}

export function resolveCredentialTest(
  response: CredentialTestResponse | null,
): CredentialTestState {
  if (!response) return { status: 'error', message: 'Could not reach the server.' };
  if (response.status === 429) {
    return { status: 'error', message: 'Too many attempts — wait a moment.' };
  }
  if (response.body.ok) {
    return { status: 'success', message: response.body.message ?? 'Connection verified.' };
  }
  const { error } = response.body;
  return {
    status: 'error',
    message:
      response.body.message ??
      (typeof error === 'string' ? error : error?.message) ??
      (response.status === 401 ? 'Authentication required.' : 'The provider test failed.'),
  };
}

export function isCredentialTestResultCurrent(input: {
  requestId: number;
  currentRequestId: number;
  testedProviderKey: string;
  currentProviderKey: string;
}): boolean {
  return (
    input.requestId === input.currentRequestId &&
    input.testedProviderKey === input.currentProviderKey
  );
}
